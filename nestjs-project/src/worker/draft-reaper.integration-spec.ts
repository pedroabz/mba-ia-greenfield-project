import { randomUUID } from 'crypto';
import type { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { QUEUES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createTestStorage,
  destroyTestStorageClient,
} from '../storage/storage.test-harness';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { DraftReaperService } from './draft-reaper.service';

/**
 * This suite is the evidence for the lifecycle-rule substitution recorded in
 * nestjs-project/CLAUDE.md § Video Infrastructure: the MinIO build in use rejects
 * `AbortIncompleteMultipartUpload`, so the cleanup requirement lives in this job
 * instead. If this suite is deleted, nothing cleans orphaned multipart uploads.
 */
const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('DraftReaperService (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let queue: QueueService;
  let reaper: DraftReaperService;
  const testStorage = createTestStorage('draft-reaper');

  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);

    storage = new StorageService(storageConfig());
    queue = new QueueService(databaseConfig());
    await queue.onModuleInit();

    reaper = new DraftReaperService(dataSource, storage, queue);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(QUEUES.DRAFT_REAPER);
    await testStorage.cleanup();
    destroyTestStorageClient();
    storage.onModuleDestroy();
    await queue.onApplicationShutdown();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save({
      email: `reaper-${randomUUID()}@streamtube.test`,
      password: 'hashed',
    } as Partial<User>);
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Canal',
      nickname: `canal_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    } as Partial<Channel>);
    channelId = channel.id;
  });

  /**
   * Seeds a row and then back-dates `created_at` with raw SQL — `@CreateDateColumn`
   * is managed by TypeORM and ignores a value passed to `save`.
   */
  async function seedVideo(
    status: VideoStatus,
    ageHours: number,
  ): Promise<Video> {
    const saved = await videos.save({
      id: randomUUID(),
      slug: randomUUID().slice(0, 11),
      channel_id: channelId,
      title: 'Meu vídeo',
      status,
      video_bucket: storage.bucketVideos,
      video_key: `videos/${randomUUID()}/original.mp4`,
      declared_size_bytes: '1024',
      content_type: 'video/mp4',
    } as Partial<Video> as Video);

    await dataSource.query(
      `UPDATE videos SET created_at = now() - ($1 || ' hours')::interval WHERE id = $2`,
      [String(ageHours), saved.id],
    );

    return saved;
  }

  it('should delete a draft older than the expiry window', async () => {
    const stale = await seedVideo(VideoStatus.DRAFT, 48);

    const summary = await reaper.reap(24);

    expect(summary.draftsDeleted).toBe(1);
    expect(await videos.findOneBy({ id: stale.id })).toBeNull();
  });

  it('should keep a draft that is still inside the window', async () => {
    const fresh = await seedVideo(VideoStatus.DRAFT, 1);

    await reaper.reap(24);

    expect(await videos.findOneBy({ id: fresh.id })).not.toBeNull();
  });

  it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.ERROR])(
    'should never delete an old %s video',
    async (status) => {
      // Only `draft` is debris. An old `processing` row is a job in flight and an
      // old `ready` row is a published video.
      const video = await seedVideo(status, 240);

      const summary = await reaper.reap(24);

      expect(summary.draftsDeleted).toBe(0);
      expect(await videos.findOneBy({ id: video.id })).not.toBeNull();
    },
  );

  it('should abort a multipart upload initiated before the cutoff', async () => {
    const key = testStorage.key(`orphan-${randomUUID()}.mp4`);
    const uploadId = await testStorage.startMultipart(
      storage.bucketVideos,
      key,
    );

    // A cutoff in the FUTURE makes the just-created upload count as stale, which is
    // the only way to exercise this without waiting 24 hours.
    const summary = await reaper.reap(-1);

    expect(summary.uploadsAborted).toBeGreaterThanOrEqual(1);
    expect(
      await testStorage.listMultipartUploads(storage.bucketVideos),
    ).not.toContain(uploadId);
  });

  it('should leave a freshly initiated multipart upload alone', async () => {
    const key = testStorage.key(`in-flight-${randomUUID()}.mp4`);
    const uploadId = await testStorage.startMultipart(
      storage.bucketVideos,
      key,
    );

    // A resumable upload a user is actively working on must survive the reaper.
    const summary = await reaper.reap(24);

    expect(summary.uploadsAborted).toBe(0);
    expect(
      await testStorage.listMultipartUploads(storage.bucketVideos),
    ).toContain(uploadId);

    await testStorage.abortMultipart(storage.bucketVideos, key, uploadId);
  });

  it('should be idempotent — a second pass finds nothing left to do', async () => {
    await seedVideo(VideoStatus.DRAFT, 48);
    await reaper.reap(24);

    // Delivery is at-least-once, so this must be safe. It is naturally idempotent
    // because the predicate is status-and-age, not a fixed row set.
    const second = await reaper.reap(24);

    expect(second).toEqual({ draftsDeleted: 0, uploadsAborted: 0 });
  });
});
