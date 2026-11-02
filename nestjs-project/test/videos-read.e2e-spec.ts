import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { QUEUES } from '../src/queue/queue.constants';
import { QueueService } from '../src/queue/queue.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import type {
  VideoResponseDto,
  VideoStatusDto,
} from '../src/videos/dto/video-response.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

/**
 * `supertest` types `res.body` as `any`. Narrowing it at the call site keeps the
 * assertions type-checked — a field renamed on the DTO then fails to compile here
 * instead of silently asserting `undefined === undefined`.
 */
const asVideo = (body: unknown): VideoResponseDto => body as VideoResponseDto;
const asStatus = (body: unknown): VideoStatusDto => body as VideoStatusDto;
const asError = (body: unknown): { error: string } => body as { error: string };

describe('Videos read and reprocess (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let queue: QueueService;
  let storage: StorageService;

  let ownerToken: string;
  let otherToken: string;
  let ownerChannelId: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videos = dataSource.getRepository(Video);
    queue = moduleFixture.get(QueueService);
    storage = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(QUEUES.VIDEO_PROCESSING);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(QUEUES.VIDEO_PROCESSING);

    const owner = await seedUserWithChannel();
    ownerToken = owner.token;
    ownerChannelId = owner.channelId;
    otherToken = (await seedUserWithChannel()).token;
  });

  async function seedUserWithChannel(): Promise<{
    token: string;
    channelId: string;
  }> {
    const user = await dataSource.getRepository(User).save({
      email: `read-e2e-${randomUUID()}@streamtube.test`,
      password: 'hashed',
      is_confirmed: true,
    } as Partial<User>);
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Canal',
      nickname: `canal_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    } as Partial<Channel>);

    const jwt = app.get(JwtService, { strict: false });
    return {
      token: await jwt.signAsync({ sub: user.id, email: user.email }),
      channelId: channel.id,
    };
  }

  /** Seeds a video row directly — the upload handshake is covered elsewhere. */
  async function seedVideo(overrides: Partial<Video> = {}): Promise<Video> {
    const id = randomUUID();
    return videos.save({
      id,
      slug: randomUUID().replace(/-/g, '').slice(0, 11),
      channel_id: ownerChannelId,
      title: 'Meu vídeo',
      status: VideoStatus.DRAFT,
      video_bucket: storage.bucketVideos,
      video_key: `videos/${id}/original.mp4`,
      declared_size_bytes: '1024',
      content_type: 'video/mp4',
      ...overrides,
    } as Partial<Video> as Video);
  }

  const readyFields = (id: string): Partial<Video> => ({
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
  });

  describe('1. Leitura do recurso de vídeo', () => {
    // 1.1. le-video-pronto-de-forma-anonima — AC #1
    it('le video pronto de forma anonima', async () => {
      const id = randomUUID();
      const video = await seedVideo({ id, ...readyFields(id) });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .expect(200);

      const body = asVideo(res.body);
      expect(body.status).toBe(VideoStatus.READY);
      expect(body.duration_seconds).not.toBeNull();
      expect(body.thumbnail_url).not.toBeNull();
      for (const field of [
        'width',
        'height',
        'codec_name',
        'container_format',
        'bitrate_bps',
        'size_bytes',
      ] as const) {
        expect(body).toHaveProperty(field);
        expect(body[field]).not.toBeNull();
      }
    });

    // 1.2. esconde-rascunho-de-quem-nao-e-dono — AC #2
    it('esconde rascunho de quem nao e dono', async () => {
      const video = await seedVideo();

      const asOther = await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);

      // 404, NOT 403 — a 403 would confirm the draft exists.
      expect(asError(asOther.body).error).toBe('VIDEO_NOT_FOUND');

      await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .expect(404);
    });

    // 1.3. mostra-rascunho-para-o-dono — AC #3
    it('mostra rascunho para o dono', async () => {
      const video = await seedVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const body = asVideo(res.body);
      expect(body.status).toBe(VideoStatus.DRAFT);
      expect(body.duration_seconds).toBeNull();
      expect(body.thumbnail_url).toBeNull();
    });

    // 1.4. expoe-erro-de-processamento — AC #4
    it('expoe erro de processamento', async () => {
      const video = await seedVideo({
        status: VideoStatus.ERROR,
        processing_error: 'ffprobe exited with code 1',
        processing_attempts: 3,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const body = asVideo(res.body);
      expect(body.status).toBe(VideoStatus.ERROR);
      expect(body.processing_error).toBeTruthy();
      expect(body.processing_attempts).toBe(3);
    });

    it('rejeita slug fora do formato antes de consultar o banco', async () => {
      // A route parameter is not covered by the global ValidationPipe + DTO pair,
      // so SlugParamPipe is what keeps an arbitrary string out of the query.
      await request(app.getHttpServer()).get('/videos/short').expect(400);
      await request(app.getHttpServer())
        .get('/videos/way-too-long-slug-value')
        .expect(400);
    });

    it('responde 404 para um slug bem formado que nao existe', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/aaaaaaaaaaa')
        .expect(404);

      expect(asError(res.body).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('2. Reprocessamento', () => {
    // 2.1. reenfileira-video-em-erro — AC #5
    it('reenfileira video em erro', async () => {
      const video = await seedVideo({
        status: VideoStatus.ERROR,
        processing_error: 'boom',
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.slug}/reprocess`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(asStatus(res.body).status).toBe(VideoStatus.PROCESSING);
      expect((await videos.findOneByOrFail({ id: video.id })).status).toBe(
        VideoStatus.PROCESSING,
      );
      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(1);
      expect(await queue.fetchOne(QUEUES.VIDEO_PROCESSING)).toMatchObject({
        videoId: video.id,
      });
    });

    // 2.2. rejeita-reprocess-em-estado-nao-erro — AC #6
    it('rejeita reprocess em estado nao erro', async () => {
      const ready = await seedVideo({ status: VideoStatus.READY });

      const res = await request(app.getHttpServer())
        .post(`/videos/${ready.slug}/reprocess`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(409);

      expect(asError(res.body).error).toBe('VIDEO_INVALID_STATE');
      expect((await videos.findOneByOrFail({ id: ready.id })).status).toBe(
        VideoStatus.READY,
      );
      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);

      const errored = await seedVideo({ status: VideoStatus.ERROR });
      const asOther = await request(app.getHttpServer())
        .post(`/videos/${errored.slug}/reprocess`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);

      expect(asError(asOther.body).error).toBe('VIDEO_NOT_OWNED');
      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
    });

    it('exige autenticacao para reprocessar', async () => {
      const video = await seedVideo({ status: VideoStatus.ERROR });

      await request(app.getHttpServer())
        .post(`/videos/${video.slug}/reprocess`)
        .expect(401);

      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
    });
  });
});
