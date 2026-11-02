import { randomUUID } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { QUEUES } from '../queue/queue.constants';
import {
  QueueService,
  type VideoProcessingPayload,
} from '../queue/queue.service';
import { buildThumbnailKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createTestStorage,
  destroyTestStorageClient,
} from '../storage/storage.test-harness';
import { waitForQueueSize } from '../test/queue';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { ProcessRunner } from './process-runner';
import { VideoProcessingService } from './video-processing.service';
import { MAX_PROCESSING_ATTEMPTS } from './worker.constants';

/**
 * Exercises the real binaries, the real storage and the real queue. ffmpeg is
 * installed only in the `video-worker` image, so this suite must run inside that
 * container — see nestjs-project/CLAUDE.md § "Test execution".
 */
const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURES = join(__dirname, '..', 'test', 'fixtures');
const FIXTURE = readFileSync(join(FIXTURES, 'sample.mp4'));
/**
 * A raw H.264 elementary stream: `ffprobe` genuinely omits `duration` and
 * `bit_rate` for it. See src/test/fixtures/README.md.
 */
const FIXTURE_NO_METADATA = readFileSync(
  join(FIXTURES, 'sample-no-metadata.h264'),
);

describe('Video processing handler (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let queue: QueueService;
  let handler: VideoProcessingService;
  const testStorage = createTestStorage('video-processing');

  let channelId: string;
  const writtenKeys: { bucket: string; key: string }[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);

    storage = new StorageService(storageConfig());
    queue = new QueueService(databaseConfig());
    await queue.onModuleInit();

    handler = new VideoProcessingService(
      dataSource,
      storage,
      new FfmpegService(new ProcessRunner()),
      queue,
    );
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(QUEUES.VIDEO_PROCESSING);
    for (const { bucket, key } of writtenKeys) {
      await testStorage.remove(bucket, key);
    }
    await testStorage.cleanup();
    destroyTestStorageClient();
    storage.onModuleDestroy();
    await queue.onApplicationShutdown();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(QUEUES.VIDEO_PROCESSING);

    const user = await dataSource.getRepository(User).save({
      email: `worker-${randomUUID()}@streamtube.test`,
      password: 'hashed',
    } as Partial<User>);
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Canal',
      nickname: `canal_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    } as Partial<Channel>);
    channelId = channel.id;
  });

  /** Seeds a video row plus its stored object, mimicking a completed upload. */
  async function seedUploadedVideo(
    body: Buffer = FIXTURE,
    status: VideoStatus = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const id = randomUUID();
    const key = `videos/${id}/original.mp4`;

    await testStorage.put(storage.bucketVideos, key, body);
    writtenKeys.push({ bucket: storage.bucketVideos, key });
    writtenKeys.push({
      bucket: storage.bucketThumbnails,
      key: buildThumbnailKey(id),
    });

    return videos.save({
      id,
      slug: randomUUID().slice(0, 11),
      channel_id: channelId,
      title: 'Meu vídeo',
      status,
      video_bucket: storage.bucketVideos,
      video_key: key,
      declared_size_bytes: String(body.byteLength),
      content_type: 'video/mp4',
    } as Partial<Video> as Video);
  }

  const payloadFor = (video: Video): VideoProcessingPayload => ({
    videoId: video.id,
    videoBucket: video.video_bucket,
    videoKey: video.video_key,
  });

  it('should take a video to ready with metadata read from the real file', async () => {
    const video = await seedUploadedVideo();

    await handler.handle(payloadFor(video));

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(Number(row.duration_seconds)).toBeCloseTo(2.0, 2);
    expect(row.width).toBe(320);
    expect(row.height).toBe(240);
    expect(row.codec_name).toBe('h264');
    expect(row.size_bytes).toBe(String(FIXTURE.byteLength));
    expect(row.processing_error).toBeNull();
  });

  it('should write the thumbnail object and persist its bucket and key', async () => {
    const video = await seedUploadedVideo();

    await handler.handle(payloadFor(video));

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.thumbnail_bucket).toBe(storage.bucketThumbnails);
    expect(row.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);

    // The row pointing at a key is not enough — the object has to be there.
    const size = await testStorage.size(
      row.thumbnail_bucket as string,
      row.thumbnail_key as string,
    );
    expect(size).toBeGreaterThan(0);
  });

  it('should claim a draft row as well, not only one already in processing', async () => {
    const video = await seedUploadedVideo(FIXTURE, VideoStatus.DRAFT);

    await handler.handle(payloadFor(video));

    expect((await videos.findOneByOrFail({ id: video.id })).status).toBe(
      VideoStatus.READY,
    );
  });

  it('should treat a duplicated delivery as a no-op', async () => {
    const video = await seedUploadedVideo();
    await handler.handle(payloadFor(video));
    const first = await videos.findOneByOrFail({ id: video.id });

    // At-least-once delivery means this really happens. The claim's conditional
    // update is what makes the second run skip rather than re-probe (per TD-11).
    await handler.handle(payloadFor(video));

    const second = await videos.findOneByOrFail({ id: video.id });
    expect(second.status).toBe(VideoStatus.READY);
    expect(second.updated_at.getTime()).toBe(first.updated_at.getTime());
  });

  it('should not reprocess a video that is already ready', async () => {
    const video = await seedUploadedVideo(FIXTURE, VideoStatus.READY);

    await handler.handle(payloadFor(video));

    // `ready` is NOT in the startable set, so the claim finds zero rows.
    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.duration_seconds).toBeNull();
    expect(row.thumbnail_key).toBeNull();
  });

  it('should persist absent ffprobe fields as NULL and still finish successfully', async () => {
    // The real AC: a field MISSING from the probe output must become NULL rather
    // than fail the job. Exercised with a genuine container-less stream, not a
    // mocked probe — mocking this would test the mock, not ffprobe.
    const video = await seedUploadedVideo(FIXTURE_NO_METADATA);

    await handler.handle(payloadFor(video));

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.processing_error).toBeNull();

    // Absent from the probe output → NULL.
    expect(row.duration_seconds).toBeNull();
    expect(row.bitrate_bps).toBeNull();

    // Present in the probe output → persisted.
    expect(row.width).toBe(160);
    expect(row.height).toBe(120);
    expect(row.codec_name).toBe('h264');
    expect(row.container_format).toBe('h264');
    expect(row.size_bytes).toBe(String(FIXTURE_NO_METADATA.byteLength));
  });

  it('should still write a thumbnail when the duration is unknown', async () => {
    // With no duration there is no "10% in" to seek to, so the offset falls back
    // to 0 — which is the whole reason THUMBNAIL_FALLBACK_SECONDS exists.
    const video = await seedUploadedVideo(FIXTURE_NO_METADATA);

    await handler.handle(payloadFor(video));

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.thumbnail_key).toBe(buildThumbnailKey(video.id));
    expect(
      await testStorage.size(
        row.thumbnail_bucket as string,
        row.thumbnail_key as string,
      ),
    ).toBeGreaterThan(0);
  });

  it('should land on error with the binary stderr when the file is not a video', async () => {
    const video = await seedUploadedVideo(Buffer.from('not a media container'));

    await handler.handle(payloadFor(video));

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.ERROR);
    expect(row.processing_error).toBeTruthy();
    expect(row.processing_attempts).toBe(1);
  });

  it('should cap the attempt counter at the retry budget after repeated failures', async () => {
    const video = await seedUploadedVideo(Buffer.from('not a media container'));

    // `error` is in the startable set, so each redelivery can re-claim the row —
    // which is exactly how the queue's retries reach the handler.
    for (let i = 0; i < MAX_PROCESSING_ATTEMPTS + 2; i++) {
      await handler.handle(payloadFor(video));
    }

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.ERROR);
    expect(row.processing_attempts).toBe(MAX_PROCESSING_ATTEMPTS);
  });

  it('should not throw out of the handler on a processing failure', async () => {
    const video = await seedUploadedVideo(Buffer.from('not a media container'));

    // A background handler that rethrows crashes the worker process
    // (see .claude/rules/nestjs-services.md § background tasks).
    await expect(handler.handle(payloadFor(video))).resolves.toBeUndefined();
  });

  it('should return quietly when the video row no longer exists', async () => {
    const video = await seedUploadedVideo();
    await videos.delete({ id: video.id });

    await expect(handler.handle(payloadFor(video))).resolves.toBeUndefined();
  });

  it('should leave no temp files behind for the processed video', async () => {
    const video = await seedUploadedVideo();

    await handler.handle(payloadFor(video));

    // A 10 GB temp file left behind fills the worker's disk within a few jobs, and
    // the resulting failure looks unrelated to processing.
    const leftovers = readdirSync(tmpdir()).filter((name) =>
      name.startsWith(`video-${video.id}-`),
    );
    expect(leftovers).toEqual([]);
  });

  // Registered last: a pg-boss worker cannot be unregistered, so once it is live it
  // would consume jobs the earlier tests assert on.
  it('should process a job delivered through the real queue', async () => {
    const video = await seedUploadedVideo();
    await queue.enqueueVideoProcessing(payloadFor(video));
    expect(await waitForQueueSize(queue, QUEUES.VIDEO_PROCESSING, 1)).toBe(1);

    await handler.onApplicationBootstrap();

    const deadline = Date.now() + 25_000;
    let row = await videos.findOneByOrFail({ id: video.id });
    while (row.status !== VideoStatus.READY && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      row = await videos.findOneByOrFail({ id: video.id });
    }

    expect(row.status).toBe(VideoStatus.READY);
    expect(row.thumbnail_key).toBe(buildThumbnailKey(video.id));
  }, 40_000);
});
