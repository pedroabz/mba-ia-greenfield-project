import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { DataSource } from 'typeorm';
import { QUEUES } from '../queue/queue.constants';
import {
  QueueService,
  type VideoProcessingPayload,
} from '../queue/queue.service';
import { buildThumbnailKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService, type VideoMetadata } from './ffmpeg.service';
import { MAX_PROCESSING_ATTEMPTS } from './worker.constants';

/** States from which processing may legitimately start. */
const STARTABLE = [
  VideoStatus.DRAFT,
  VideoStatus.PROCESSING,
  VideoStatus.ERROR,
];

@Injectable()
export class VideoProcessingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
    private readonly queue: QueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.registerWorker<VideoProcessingPayload>(
      QUEUES.VIDEO_PROCESSING,
      (payload) => this.handle(payload),
    );
    this.logger.log(`Worker registered on "${QUEUES.VIDEO_PROCESSING}"`);
  }

  /**
   * Handles one job. Delivery is at-least-once, so this must tolerate being called
   * twice for the same video (per phase-03-videos/TD-11).
   *
   * Note it does NOT rethrow on a processing failure — it records the failure and
   * returns. Rethrowing from a queue handler is how the retry budget is consumed;
   * see `recordFailure` for where that line is drawn.
   */
  async handle(payload: VideoProcessingPayload): Promise<void> {
    const claimed = await this.claim(payload.videoId);
    if (!claimed) {
      // Zero affected rows: another delivery already took this video. Returning
      // makes the duplicate a no-op rather than a second FFmpeg run.
      this.logger.log(`Video ${payload.videoId} already handled — skipping`);
      return;
    }

    // The payload is deliberately thin, so current state comes from the DB rather
    // than from a possibly stale message (per TD-07).
    const video = await this.dataSource
      .getRepository(Video)
      .findOneBy({ id: payload.videoId });
    if (!video) {
      this.logger.warn(`Video ${payload.videoId} vanished before processing`);
      return;
    }

    const workDir = await fs.mkdtemp(join(tmpdir(), `video-${video.id}-`));
    const sourcePath = join(workDir, 'source');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.download(video, sourcePath);

      const metadata = await this.ffmpeg.probe(sourcePath);
      await this.dataSource
        .getRepository(Video)
        .update({ id: video.id }, metadata);

      const thumbnail = await this.generateThumbnail(
        video,
        sourcePath,
        thumbnailPath,
        metadata,
      );

      await this.dataSource.getRepository(Video).update(
        { id: video.id },
        {
          status: VideoStatus.READY,
          processing_error: null,
          thumbnail_bucket: thumbnail.bucket,
          thumbnail_key: thumbnail.key,
        },
      );

      this.logger.log(`Video ${video.id} is ready`);
    } catch (error) {
      await this.recordFailure(video.id, error);
    } finally {
      // Always: a 10 GB temp file left behind fills the worker's disk within a few
      // jobs, and the failure then looks unrelated to processing.
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Conditional claim. The `status IN (...)` predicate is the idempotency guard: the
   * first delivery flips the row to `processing` and every later one sees zero
   * affected rows. `error` is included so reprocessing (SI-03.7) can re-enter.
   */
  private async claim(videoId: string): Promise<boolean> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update(Video)
      .set({ status: VideoStatus.PROCESSING })
      .where('id = :id AND status IN (:...states)', {
        id: videoId,
        states: STARTABLE,
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /**
   * Streams the object to disk rather than buffering it. The whole point of this
   * phase is supporting files up to 10 GB; `Buffer.concat` on one would exceed
   * Node's max buffer length long before it exhausted memory.
   */
  private async download(video: Video, destination: string): Promise<void> {
    const { stream } = await this.storage.getObjectStream(
      video.video_bucket,
      video.video_key,
    );
    await pipeline(stream, createWriteStream(destination));
  }

  private async generateThumbnail(
    video: Video,
    sourcePath: string,
    thumbnailPath: string,
    metadata: VideoMetadata,
  ): Promise<{ bucket: string; key: string }> {
    await this.ffmpeg.extractThumbnail(
      sourcePath,
      thumbnailPath,
      this.ffmpeg.thumbnailOffset(metadata),
    );

    // ffmpeg can exit 0 and write NOTHING (e.g. a seek past the end of a stream
    // with no timestamps). Without this check the next line fails with a bare
    // ENOENT, which reads like a filesystem problem rather than a thumbnail one.
    const stats = await fs.stat(thumbnailPath).catch(() => null);
    if (!stats || stats.size === 0) {
      throw new Error(
        `ffmpeg exited successfully but wrote no thumbnail for video ${video.id}`,
      );
    }

    const bucket = this.storage.bucketThumbnails;
    const key = buildThumbnailKey(video.id);
    await this.storage.putObject(
      bucket,
      key,
      await fs.readFile(thumbnailPath),
      'image/jpeg',
    );

    return { bucket, key };
  }

  /**
   * Records a failed attempt. Below the retry budget the row is put back in `error`
   * with the attempt counter advanced; the queue's own retry will redeliver and the
   * `error` state is in STARTABLE so the next attempt can claim it. Catching rather
   * than rethrowing is deliberate — this is a background handler, and rethrowing
   * would crash the worker process (see `.claude/rules/nestjs-services.md`).
   */
  private async recordFailure(videoId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Processing failed for video ${videoId}: ${message}`);

    const repository = this.dataSource.getRepository(Video);
    const current = await repository.findOneBy({ id: videoId });
    const attempts = Math.min(
      (current?.processing_attempts ?? 0) + 1,
      MAX_PROCESSING_ATTEMPTS,
    );

    await repository.update(
      { id: videoId },
      {
        status: VideoStatus.ERROR,
        processing_error: message.slice(0, 2000),
        processing_attempts: attempts,
      },
    );
  }
}
