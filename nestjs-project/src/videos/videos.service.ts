import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import type { Readable } from 'stream';
import {
  RangeNotSatisfiableException,
  UploadKeyMismatchException,
  UploadObjectMissingException,
  UploadSizeMismatchException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { PART_SIZE_BYTES, buildVideoKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { SignUploadDto } from './dto/sign-upload.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import {
  UnsatisfiableRangeError,
  attachmentDisposition,
  resolveRange,
  type ResolvedRange,
} from './range.util';
import { Video, VideoStatus } from './entities/video.entity';
import {
  SLUG_LENGTH,
  SLUG_MAX_RETRIES,
  extensionForContentType,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';

export interface CreatedDraft {
  id: string;
  slug: string;
  uploadKey: string;
  part_size_bytes: number;
}

export interface SignedOperation {
  url: string;
  expires_in: number;
}

/** Everything the controller needs to write a 200 or a 206 response. */
export interface VideoStream {
  stream: Readable;
  /** `null` when the whole object is being served (no usable `Range`). */
  range: ResolvedRange | null;
  totalSize: number;
  contentType: string;
  disposition: string;
}

export interface UploadCompletion {
  id: string;
  slug: string;
  status: VideoStatus;
}

@Injectable()
export class VideosService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly channels: ChannelsService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Pre-registers the video as a draft BEFORE a single byte is uploaded. That order
   * is what makes the object key server-authoritative: the client never proposes a
   * key, it is handed one (per phase-03-videos/TD-04).
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedDraft> {
    const channel = await this.channels.findByUserId(userId);
    if (!channel) throw new VideoNotOwnedException();

    // The id is generated here rather than by the database because `video_key` is
    // derived from it and has to be known before the INSERT.
    const id = randomUUID();
    const videoKey = buildVideoKey(
      id,
      extensionForContentType(dto.content_type),
    );

    const repository = this.dataSource.getRepository(Video);

    for (let attempt = 0; attempt <= SLUG_MAX_RETRIES; attempt++) {
      try {
        const saved = await repository.save(
          repository.create({
            id,
            slug: nanoid(SLUG_LENGTH),
            channel_id: channel.id,
            title: dto.title,
            status: VideoStatus.DRAFT,
            video_bucket: this.storage.bucketVideos,
            video_key: videoKey,
            declared_size_bytes: String(dto.declared_size_bytes),
            content_type: dto.content_type,
          }),
        );

        return {
          id: saved.id,
          slug: saved.slug,
          uploadKey: saved.video_key,
          part_size_bytes: PART_SIZE_BYTES,
        };
      } catch (error) {
        // A nanoid(11) collision is astronomically unlikely, but the column is
        // unique and a 500 on a collision would be a real (if rare) bug.
        if (!this.isSlugCollision(error) || attempt === SLUG_MAX_RETRIES)
          throw error;
      }
    }

    throw new Error('Slug collision could not be resolved after max retries');
  }

  /**
   * Signs exactly ONE S3 operation. The `key` in the request is untrusted and is
   * re-validated against the draft on every call — otherwise this endpoint is an
   * oracle that signs arbitrary keys in the bucket (per TD-03).
   */
  async signUpload(
    userId: string,
    videoId: string,
    dto: SignUploadDto,
  ): Promise<SignedOperation> {
    const video = await this.findOwnedOrFail(userId, videoId);

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoInvalidStateException(video.status);
    }
    if (dto.key !== video.video_key) {
      throw new UploadKeyMismatchException();
    }

    // Retained so a resume can call ListParts without the client re-supplying it.
    if (dto.upload_id && dto.upload_id !== video.upload_id) {
      await this.dataSource
        .getRepository(Video)
        .update({ id: video.id }, { upload_id: dto.upload_id });
    }

    const url = await this.storage.presignUpload({
      bucket: video.video_bucket,
      key: video.video_key,
      method: dto.method,
      uploadId: dto.upload_id,
      partNumber: dto.part_number,
      partNumberMarker: dto.part_number_marker,
    });

    return { url, expires_in: this.storage.ttlSeconds };
  }

  /**
   * Verifies the uploaded object, then transitions `draft → processing` and enqueues
   * processing INSIDE the same transaction, so the row and the job commit together
   * (per TD-04, TD-11, TD-17).
   */
  async completeUpload(
    userId: string,
    videoId: string,
  ): Promise<UploadCompletion> {
    const video = await this.findOwnedOrFail(userId, videoId);

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoInvalidStateException(video.status);
    }

    const head = await this.storage.headObject(
      video.video_bucket,
      video.video_key,
    );
    if (!head || head.contentLength === 0) {
      throw new UploadObjectMissingException();
    }

    // INTEGRITY check, not policy: a size that differs from what the client declared
    // means the upload is truncated or the multipart was completed with missing
    // parts. There is no upload ceiling here (TD-06 rejected).
    if (String(head.contentLength) !== String(video.declared_size_bytes)) {
      throw new UploadSizeMismatchException(
        video.declared_size_bytes,
        head.contentLength,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // CONDITIONAL update: the `status = draft` predicate is what makes a duplicated
      // call unable to enqueue a second job, even if both calls race past the read
      // above. Zero affected rows means another call already won.
      const result = await manager
        .createQueryBuilder()
        .update(Video)
        .set({ status: VideoStatus.PROCESSING, processing_error: null })
        .where('id = :id AND status = :status', {
          id: video.id,
          status: VideoStatus.DRAFT,
        })
        .execute();

      if (result.affected === 0) {
        // Throwing rolls the transaction back, so no job is enqueued either.
        throw new VideoInvalidStateException(VideoStatus.PROCESSING);
      }

      await this.enqueueProcessing(video, manager);

      return { id: video.id, slug: video.slug, status: VideoStatus.PROCESSING };
    });
  }

  /**
   * The polling read. `userId` is `null` for an anonymous caller.
   *
   * A video that is not `ready` is answered with `404 VIDEO_NOT_FOUND` — not `403` —
   * for anyone who is not its owner, so a draft's existence is not disclosed
   * (per § Authorization Matrix).
   */
  async findBySlug(
    slug: string,
    userId: string | null,
  ): Promise<VideoResponseDto> {
    const video = await this.dataSource.getRepository(Video).findOne({
      where: { slug },
      relations: ['channel'],
    });

    if (!video) throw new VideoNotFoundException();

    const isOwner = userId !== null && video.channel.user_id === userId;
    if (video.status !== VideoStatus.READY && !isOwner) {
      throw new VideoNotFoundException();
    }

    return this.toResponse(video);
  }

  /**
   * Recovery path for a video whose processing failed. Mirrors the completion
   * handshake: conditional update plus a re-enqueue in the SAME transaction, so a
   * row in `processing` always has a job behind it (per TD-11, TD-17).
   */
  async reprocess(userId: string, slug: string): Promise<UploadCompletion> {
    const video = await this.findOwnedBySlugOrFail(userId, slug);

    if (video.status !== VideoStatus.ERROR) {
      throw new VideoInvalidStateException(video.status);
    }

    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(Video)
        .set({ status: VideoStatus.PROCESSING, processing_error: null })
        .where('id = :id AND status = :status', {
          id: video.id,
          status: VideoStatus.ERROR,
        })
        .execute();

      if (result.affected === 0) {
        throw new VideoInvalidStateException(VideoStatus.PROCESSING);
      }

      await this.enqueueProcessing(video, manager);

      return { id: video.id, slug: video.slug, status: VideoStatus.PROCESSING };
    });
  }

  /** Loads a ready video by slug, for the delivery endpoints (SI-03.8). */
  async findReadyBySlugOrFail(slug: string): Promise<Video> {
    const video = await this.dataSource
      .getRepository(Video)
      .findOneBy({ slug });

    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();

    return video;
  }

  /**
   * Opens a (possibly ranged) read of a ready video's bytes.
   *
   * The byte interval is pushed down to the storage layer rather than fetching the
   * whole object and slicing it — that is the entire point of range support on a
   * 10 GB file (per TD-14).
   */
  async openStream(
    slug: string,
    rangeHeader: string | undefined,
  ): Promise<VideoStream> {
    const video = await this.findReadyBySlugOrFail(slug);

    // HeadObject first: the range has to be resolved against the real object size,
    // and the size is also what `Content-Range` must report.
    const head = await this.storage.headObject(
      video.video_bucket,
      video.video_key,
    );
    if (!head) throw new UploadObjectMissingException();

    let range: ResolvedRange | null;
    try {
      range = resolveRange(rangeHeader, head.contentLength);
    } catch (error) {
      if (error instanceof UnsatisfiableRangeError) {
        throw new RangeNotSatisfiableException();
      }
      throw error;
    }

    const { stream } = await this.storage.getObjectStream(
      video.video_bucket,
      video.video_key,
      range ? { start: range.start, end: range.end } : undefined,
    );

    return {
      stream,
      range,
      totalSize: head.contentLength,
      // The ROW wins over the object's metadata. A presigned PUT need not carry a
      // `Content-Type` header, in which case storage records
      // `application/octet-stream` — and serving that back makes a browser
      // download the file instead of playing it. The row is the authoritative
      // record of what the video is; storage's value is only a fallback for a row
      // that somehow has none.
      contentType:
        video.content_type || head.contentType || 'application/octet-stream',
      disposition: attachmentDisposition(video.slug, video.video_key),
    };
  }

  /** Shared by the completion handshake and by reprocessing (SI-03.7). */
  async enqueueProcessing(video: Video, manager: EntityManager): Promise<void> {
    await this.queue.enqueueVideoProcessing(
      {
        videoId: video.id,
        videoBucket: video.video_bucket,
        videoKey: video.video_key,
      },
      manager,
    );
  }

  /**
   * Loads a video and asserts the caller owns its channel. Absence and foreign
   * ownership are distinguished deliberately here — the endpoints that must not
   * disclose existence map that themselves (see the Authorization Matrix).
   */
  private async findOwnedOrFail(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.dataSource.getRepository(Video).findOne({
      where: { id: videoId },
      relations: ['channel'],
    });

    if (!video) throw new VideoNotFoundException();
    if (video.channel.user_id !== userId) throw new VideoNotOwnedException();

    return video;
  }

  private async findOwnedBySlugOrFail(
    userId: string,
    slug: string,
  ): Promise<Video> {
    const video = await this.dataSource.getRepository(Video).findOne({
      where: { slug },
      relations: ['channel'],
    });

    if (!video) throw new VideoNotFoundException();
    if (video.channel.user_id !== userId) throw new VideoNotOwnedException();

    return video;
  }

  private async toResponse(video: Video): Promise<VideoResponseDto> {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      duration_seconds: this.toNumber(video.duration_seconds),
      width: video.width,
      height: video.height,
      codec_name: video.codec_name,
      container_format: video.container_format,
      bitrate_bps: this.toNumber(video.bitrate_bps),
      size_bytes: this.toNumber(video.size_bytes),
      thumbnail_url:
        video.thumbnail_bucket && video.thumbnail_key
          ? await this.storage.presignDownload(
              video.thumbnail_bucket,
              video.thumbnail_key,
            )
          : null,
      processing_error: video.processing_error,
      processing_attempts: video.processing_attempts,
    };
  }

  /** bigint/numeric columns round-trip as strings; the API answers with numbers. */
  private toNumber(value: string | null): number | null {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private isSlugCollision(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = error as unknown as { code?: string; detail?: string };
    return (
      driverError.code === PG_UNIQUE_VIOLATION &&
      typeof driverError.detail === 'string' &&
      driverError.detail.includes('slug')
    );
  }
}
