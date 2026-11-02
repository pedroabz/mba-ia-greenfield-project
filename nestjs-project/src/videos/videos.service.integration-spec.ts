import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import type { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import {
  UploadObjectMissingException,
  UploadSizeMismatchException,
  RangeNotSatisfiableException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { QUEUES } from '../queue/queue.constants';
import {
  QueueService,
  type VideoProcessingPayload,
} from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  destroyTestStorageClient,
  createTestStorage,
} from '../storage/storage.test-harness';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const DECLARED_SIZE = 2048;

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let service: VideosService;
  let storage: StorageService;
  let queue: QueueService;
  const testStorage = createTestStorage('videos-service');

  let ownerId: string;
  let otherUserId: string;
  /**
   * Keys the SERVICE generated. They are derived from the video id, so they sit
   * outside the suite prefix and the helper's prefix sweep cannot see them.
   */
  const writtenKeys: string[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);

    storage = new StorageService(storageConfig());
    queue = new QueueService(databaseConfig());
    await queue.onModuleInit();

    service = new VideosService(
      dataSource,
      new ChannelsService(dataSource),
      storage,
      queue,
    );
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(QUEUES.VIDEO_PROCESSING);
    for (const key of writtenKeys) {
      await testStorage.remove(storage.bucketVideos, key);
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

    ownerId = (await createUserWithChannel()).userId;
    otherUserId = (await createUserWithChannel()).userId;
  });

  async function createUserWithChannel(): Promise<{ userId: string }> {
    const user = await dataSource.getRepository(User).save({
      email: `vid-svc-${randomUUID()}@streamtube.test`,
      password: 'hashed',
    } as Partial<User>);
    await dataSource.getRepository(Channel).save({
      name: 'Canal',
      nickname: `canal_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    } as Partial<Channel>);
    return { userId: user.id };
  }

  const createDraft = () =>
    service.createDraft(ownerId, {
      title: 'Meu vídeo',
      declared_size_bytes: DECLARED_SIZE,
      content_type: 'video/mp4',
    });

  /** Writes an object of `size` bytes at the draft's authoritative key. */
  async function uploadTo(key: string, size: number): Promise<void> {
    await testStorage.put(storage.bucketVideos, key, Buffer.alloc(size, 1));
    writtenKeys.push(key);
  }

  it('should persist a draft the database agrees is a draft', async () => {
    const draft = await createDraft();

    const row = await videos.findOneByOrFail({ id: draft.id });

    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.video_key).toBe(draft.uploadKey);
    expect(row.video_bucket).toBe(storage.bucketVideos);
    expect(row.declared_size_bytes).toBe(String(DECLARED_SIZE));
  });

  it('should not enqueue anything at draft creation', async () => {
    await createDraft();

    // Processing is enqueued by the COMPLETION handshake, never by draft creation —
    // at this point no bytes exist yet.
    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
  });

  it('should issue a signed URL usable against the public endpoint host', async () => {
    const draft = await createDraft();

    const signed = await service.signUpload(ownerId, draft.id, {
      method: 'PUT',
      key: draft.uploadKey,
    });

    expect(signed.url).toContain(draft.uploadKey);
    expect(signed.url).toContain('X-Amz-Signature');
    expect(signed.expires_in).toBe(storage.ttlSeconds);
  });

  it('should refuse to sign for a user who does not own the draft', async () => {
    const draft = await createDraft();

    await expect(
      service.signUpload(otherUserId, draft.id, {
        method: 'PUT',
        key: draft.uploadKey,
      }),
    ).rejects.toThrow(VideoNotOwnedException);
  });

  it('should complete the handshake and enqueue processing exactly once', async () => {
    const draft = await createDraft();
    await uploadTo(draft.uploadKey, DECLARED_SIZE);

    const result = await service.completeUpload(ownerId, draft.id);

    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
      VideoStatus.PROCESSING,
    );
    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(1);
  });

  it('should enqueue a payload pointing at the stored object', async () => {
    const draft = await createDraft();
    await uploadTo(draft.uploadKey, DECLARED_SIZE);

    await service.completeUpload(ownerId, draft.id);

    expect(
      await queue.fetchOne<VideoProcessingPayload>(QUEUES.VIDEO_PROCESSING),
    ).toEqual({
      videoId: draft.id,
      videoBucket: storage.bucketVideos,
      videoKey: draft.uploadKey,
    });
  });

  it('should not enqueue a second job when completion is called twice', async () => {
    const draft = await createDraft();
    await uploadTo(draft.uploadKey, DECLARED_SIZE);
    await service.completeUpload(ownerId, draft.id);

    await expect(service.completeUpload(ownerId, draft.id)).rejects.toThrow(
      VideoInvalidStateException,
    );

    expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
      VideoStatus.PROCESSING,
    );
    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(1);
  });

  it('should reject completion when nothing was uploaded', async () => {
    const draft = await createDraft();

    await expect(service.completeUpload(ownerId, draft.id)).rejects.toThrow(
      UploadObjectMissingException,
    );

    expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
      VideoStatus.DRAFT,
    );
    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
  });

  it('should reject completion when the stored object is smaller than declared', async () => {
    const draft = await createDraft();
    // A truncated multipart upload looks exactly like this.
    await uploadTo(draft.uploadKey, DECLARED_SIZE - 1);

    await expect(service.completeUpload(ownerId, draft.id)).rejects.toThrow(
      UploadSizeMismatchException,
    );

    expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
      VideoStatus.DRAFT,
    );
    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
  });

  it('should reject completion when the stored object is larger than declared', async () => {
    const draft = await createDraft();
    await uploadTo(draft.uploadKey, DECLARED_SIZE + 1);

    await expect(service.completeUpload(ownerId, draft.id)).rejects.toThrow(
      UploadSizeMismatchException,
    );
  });

  it('should leave no job behind when the completion transaction rolls back', async () => {
    const draft = await createDraft();
    await uploadTo(draft.uploadKey, DECLARED_SIZE);

    // Force the enqueue to commit and then fail the transaction after it. If the job
    // insert did NOT share the transaction, a job would survive this — which is the
    // dual-write failure pg-boss was chosen to avoid (per TD-07, TD-17).
    const enqueue = jest
      .spyOn(service, 'enqueueProcessing')
      .mockImplementation(async (video, manager) => {
        await queue.enqueueVideoProcessing(
          {
            videoId: video.id,
            videoBucket: video.video_bucket,
            videoKey: video.video_key,
          },
          manager,
        );
        throw new Error('failure after enqueue');
      });

    await expect(service.completeUpload(ownerId, draft.id)).rejects.toThrow(
      'failure after enqueue',
    );

    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
    // The status transition rolled back with it — the row and the job cannot diverge.
    expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
      VideoStatus.DRAFT,
    );

    enqueue.mockRestore();
  });

  describe('findBySlug', () => {
    /** Promotes a draft to `ready` with the metadata the worker would have written. */
    async function makeReady(id: string): Promise<void> {
      await videos.update(
        { id },
        {
          status: VideoStatus.READY,
          duration_seconds: '12.500',
          width: 1920,
          height: 1080,
          codec_name: 'h264',
          container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
          bitrate_bps: '670000',
          size_bytes: '1048576',
          thumbnail_bucket: storage.bucketThumbnails,
          thumbnail_key: `videos/${id}/thumbnail.jpg`,
        },
      );
    }

    it('should project the metadata and a usable thumbnail URL from the stored keys', async () => {
      const draft = await createDraft();
      await makeReady(draft.id);

      const found = await service.findBySlug(draft.slug, null);

      expect(found).toMatchObject({
        status: VideoStatus.READY,
        duration_seconds: 12.5,
        width: 1920,
        height: 1080,
        codec_name: 'h264',
        bitrate_bps: 670000,
        size_bytes: 1048576,
      });
      // Signed against the PUBLIC endpoint — a browser loads this directly.
      expect(found.thumbnail_url).toContain('X-Amz-Signature');
      expect(found.thumbnail_url).toContain(`videos/${draft.id}/thumbnail.jpg`);
    });

    it('should leave thumbnail_url null while the worker has not written one', async () => {
      const draft = await createDraft();

      const found = await service.findBySlug(draft.slug, ownerId);

      expect(found.thumbnail_url).toBeNull();
      expect(found.duration_seconds).toBeNull();
    });

    it('should hide a draft from a non-owner and from an anonymous caller', async () => {
      const draft = await createDraft();

      await expect(service.findBySlug(draft.slug, otherUserId)).rejects.toThrow(
        VideoNotFoundException,
      );
      await expect(service.findBySlug(draft.slug, null)).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('reprocess', () => {
    const toError = (id: string) =>
      videos.update(
        { id },
        {
          status: VideoStatus.ERROR,
          processing_error: 'ffprobe exited with code 1',
          processing_attempts: 3,
        },
      );

    it('should re-enqueue a video in error and clear the previous failure', async () => {
      const draft = await createDraft();
      await toError(draft.id);

      const result = await service.reprocess(ownerId, draft.slug);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const row = await videos.findOneByOrFail({ id: draft.id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.processing_error).toBeNull();
      // The attempt counter is deliberately NOT reset — it is the audit trail of how
      // many times this video has already failed.
      expect(row.processing_attempts).toBe(3);
      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(1);
    });

    it('should enqueue a payload the worker can act on', async () => {
      const draft = await createDraft();
      await toError(draft.id);

      await service.reprocess(ownerId, draft.slug);

      expect(
        await queue.fetchOne<VideoProcessingPayload>(QUEUES.VIDEO_PROCESSING),
      ).toEqual({
        videoId: draft.id,
        videoBucket: storage.bucketVideos,
        videoKey: draft.uploadKey,
      });
    });

    it('should refuse to reprocess a ready video and enqueue nothing', async () => {
      const draft = await createDraft();
      await videos.update({ id: draft.id }, { status: VideoStatus.READY });

      await expect(service.reprocess(ownerId, draft.slug)).rejects.toThrow(
        VideoInvalidStateException,
      );

      expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
        VideoStatus.READY,
      );
      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
    });

    it('should refuse a non-owner and enqueue nothing', async () => {
      const draft = await createDraft();
      await toError(draft.id);

      await expect(service.reprocess(otherUserId, draft.slug)).rejects.toThrow(
        VideoNotOwnedException,
      );

      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
    });

    it('should leave no job behind when the reprocess transaction rolls back', async () => {
      const draft = await createDraft();
      await toError(draft.id);

      const enqueue = jest
        .spyOn(service, 'enqueueProcessing')
        .mockImplementation(async (video, manager) => {
          await queue.enqueueVideoProcessing(
            {
              videoId: video.id,
              videoBucket: video.video_bucket,
              videoKey: video.video_key,
            },
            manager,
          );
          throw new Error('failure after enqueue');
        });

      await expect(service.reprocess(ownerId, draft.slug)).rejects.toThrow(
        'failure after enqueue',
      );

      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
      // A video left in `processing` with no job behind it would hang forever.
      expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
        VideoStatus.ERROR,
      );

      enqueue.mockRestore();
    });
  });

  describe('openStream', () => {
    /** A ready video whose stored object is a known, verifiable byte pattern. */
    async function readyVideoWithBytes(
      size: number,
    ): Promise<{ slug: string; body: Buffer }> {
      const draft = await createDraft();
      // Each byte equals its index mod 251 (prime, so the pattern does not align
      // with any power-of-two range boundary) — that makes an off-by-one in the
      // range arithmetic visible instead of silently returning plausible bytes.
      const body = Buffer.from(Array.from({ length: size }, (_, i) => i % 251));
      await uploadTo(draft.uploadKey, size);
      await testStorage.put(storage.bucketVideos, draft.uploadKey, body);
      await videos.update(
        { id: draft.id },
        { status: VideoStatus.READY, size_bytes: String(size) },
      );
      return { slug: draft.slug, body };
    }

    const collect = async (stream: Readable): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };

    it('should return exactly the requested byte range', async () => {
      const { slug, body } = await readyVideoWithBytes(5000);

      const result = await service.openStream(slug, 'bytes=1000-2023');

      expect(result.range).toMatchObject({
        start: 1000,
        end: 2023,
        length: 1024,
        contentRange: 'bytes 1000-2023/5000',
      });
      const received = await collect(result.stream);
      expect(received).toHaveLength(1024);
      // Byte-for-byte, not just the right length.
      expect(received.equals(body.subarray(1000, 2024))).toBe(true);
    });

    it('should return the last bytes for a suffix range', async () => {
      const { slug, body } = await readyVideoWithBytes(5000);

      const result = await service.openStream(slug, 'bytes=-100');

      const received = await collect(result.stream);
      expect(received.equals(body.subarray(4900))).toBe(true);
      expect(result.range?.contentRange).toBe('bytes 4900-4999/5000');
    });

    it('should return the whole object when no Range is sent', async () => {
      const { slug, body } = await readyVideoWithBytes(2048);

      const result = await service.openStream(slug, undefined);

      expect(result.range).toBeNull();
      expect(result.totalSize).toBe(2048);
      expect((await collect(result.stream)).equals(body)).toBe(true);
    });

    it('should resolve the range against the REAL object size, not the declared one', async () => {
      const { slug } = await readyVideoWithBytes(3000);

      const result = await service.openStream(slug, 'bytes=0-');

      // `declared_size_bytes` is the client's claim; `Content-Range` must report
      // what storage actually holds.
      expect(result.totalSize).toBe(3000);
      expect(result.range?.contentRange).toBe('bytes 0-2999/3000');
    });

    it('should reject a range beyond the object', async () => {
      const { slug } = await readyVideoWithBytes(1000);

      await expect(service.openStream(slug, 'bytes=5000-6000')).rejects.toThrow(
        RangeNotSatisfiableException,
      );
    });

    it('should serve the content type from the row, not the object metadata', async () => {
      // The helper writes the object WITHOUT a Content-Type, exactly as a presigned
      // PUT that omitted the header would. Storage then reports
      // `application/octet-stream`, and serving that back would make a browser
      // download the file instead of playing it.
      const { slug } = await readyVideoWithBytes(512);

      const result = await service.openStream(slug, undefined);

      expect(
        await testStorage.contentType(
          storage.bucketVideos,
          `videos/${(await videos.findOneByOrFail({ slug })).id}/original.mp4`,
        ),
      ).toBe('application/octet-stream');
      expect(result.contentType).toBe('video/mp4');
    });

    it('should name the download after the slug', async () => {
      const { slug } = await readyVideoWithBytes(512);

      const result = await service.openStream(slug, undefined);

      expect(result.disposition).toBe(`attachment; filename="${slug}.mp4"`);
    });

    it('should refuse to serve a video that is not ready', async () => {
      const draft = await createDraft();
      await uploadTo(draft.uploadKey, DECLARED_SIZE);

      await expect(service.openStream(draft.slug, undefined)).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('should report an unknown slug as not found', async () => {
      await expect(
        service.openStream('aaaaaaaaaaa', undefined),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  it('should refuse completion by a user who does not own the draft', async () => {
    const draft = await createDraft();
    await uploadTo(draft.uploadKey, DECLARED_SIZE);

    await expect(service.completeUpload(otherUserId, draft.id)).rejects.toThrow(
      VideoNotOwnedException,
    );

    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
  });
});
