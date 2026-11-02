import { randomUUID } from 'crypto';
import type { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channelId: string;

  const baseVideo = (overrides: Partial<Video> = {}): Partial<Video> => ({
    slug: randomUUID().slice(0, 11),
    channel_id: channelId,
    title: 'Meu vídeo',
    video_bucket: 'streamtube-videos',
    video_key: `videos/${randomUUID()}/original.mp4`,
    declared_size_bytes: '1048576',
    content_type: 'video/mp4',
    ...overrides,
  });

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      { synchronize: false },
    );
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save({
      email: `owner-${randomUUID()}@streamtube.test`,
      password: 'hash',
    } as Partial<User>);
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Canal',
      nickname: `canal_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    } as Partial<Channel>);
    channelId = channel.id;
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  it('should default status to draft and attempts to zero', async () => {
    const saved = await videos.save(baseVideo() as Video);

    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.processing_attempts).toBe(0);
  });

  it('should leave all seven metadata fields NULL on a fresh draft', async () => {
    const saved = await videos.save(baseVideo() as Video);

    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.duration_seconds).toBeNull();
    expect(found.width).toBeNull();
    expect(found.height).toBeNull();
    expect(found.codec_name).toBeNull();
    expect(found.container_format).toBeNull();
    expect(found.bitrate_bps).toBeNull();
    expect(found.size_bytes).toBeNull();
  });

  it('should leave the thumbnail keys NULL until the worker fills them', async () => {
    const saved = await videos.save(baseVideo() as Video);

    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.thumbnail_bucket).toBeNull();
    expect(found.thumbnail_key).toBeNull();
  });

  it('should reject a duplicate slug', async () => {
    const slug = randomUUID().slice(0, 11);
    await videos.save(baseVideo({ slug }) as Video);

    await expect(videos.save(baseVideo({ slug }) as Video)).rejects.toThrow(
      /duplicate key|unique/i,
    );
  });

  it('should reject a video with no channel', async () => {
    await expect(
      videos.save(baseVideo({ channel_id: randomUUID() }) as Video),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('should accept every value of the status cycle', async () => {
    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.ERROR,
    ]) {
      const saved = await videos.save(baseVideo({ status }) as Video);
      const found = await videos.findOneByOrFail({ id: saved.id });
      expect(found.status).toBe(status);
    }
  });

  it('should reject a status outside the declared cycle', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO videos (slug, channel_id, title, status, video_bucket, video_key, declared_size_bytes, content_type)
         VALUES ($1, $2, 'x', 'published', 'b', 'k', 1, 'video/mp4')`,
        [randomUUID().slice(0, 11), channelId],
      ),
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it('should keep declared_size_bytes and size_bytes independent', async () => {
    // One is the untrusted client claim; the other is observed by ffprobe. The
    // completion handshake compares them (per phase-03-videos/TD-04).
    const saved = await videos.save(
      baseVideo({ declared_size_bytes: '5000', size_bytes: '4999' }) as Video,
    );

    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.declared_size_bytes).toBe('5000');
    expect(found.size_bytes).toBe('4999');
  });

  it('should cascade-delete videos when their channel is removed', async () => {
    await videos.save(baseVideo() as Video);

    await dataSource.getRepository(Channel).delete({ id: channelId });

    expect(await videos.countBy({ channel_id: channelId })).toBe(0);
  });

  it('should load the channel relation from both sides', async () => {
    const saved = await videos.save(baseVideo() as Video);

    const withChannel = await videos.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });
    const channelWithVideos = await dataSource
      .getRepository(Channel)
      .findOneOrFail({ where: { id: channelId }, relations: ['videos'] });

    expect(withChannel.channel.id).toBe(channelId);
    expect(channelWithVideos.videos.map((v) => v.id)).toContain(saved.id);
  });

  it('should not have a visibility column — that axis is Phase 04', async () => {
    const columns = await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'videos' AND column_name = ANY($1::text[])`,
      [['visibility', 'published_at']],
    );

    expect(columns).toHaveLength(0);
  });
});
