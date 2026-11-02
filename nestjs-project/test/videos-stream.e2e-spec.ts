import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createTestStorage,
  destroyTestStorageClient,
} from '../src/storage/storage.test-harness';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

const OBJECT_SIZE = 5000;

describe('Videos stream and download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  const testStorage = createTestStorage('videos-stream-e2e');
  const writtenKeys: string[] = [];

  let channelId: string;

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
    storage = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    for (const key of writtenKeys) {
      await testStorage.remove(storage.bucketVideos, key);
    }
    await testStorage.cleanup();
    destroyTestStorageClient();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save({
      email: `stream-e2e-${randomUUID()}@streamtube.test`,
      password: 'hashed',
      is_confirmed: true,
    } as Partial<User>);
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Canal',
      nickname: `canal_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    } as Partial<Channel>);
    channelId = channel.id;
  });

  /**
   * Seeds a video plus its stored object. The byte at index `i` is `i % 251` — a
   * prime, so the pattern never aligns with a power-of-two range boundary and an
   * off-by-one in the range arithmetic shows up as wrong bytes, not just a wrong
   * length.
   */
  async function seedVideo(
    status: VideoStatus = VideoStatus.READY,
    size = OBJECT_SIZE,
  ): Promise<{ slug: string; body: Buffer }> {
    const id = randomUUID();
    const key = `videos/${id}/original.mp4`;
    const body = Buffer.from(Array.from({ length: size }, (_, i) => i % 251));

    await testStorage.put(storage.bucketVideos, key, body);
    writtenKeys.push(key);

    const saved = await videos.save({
      id,
      slug: randomUUID().replace(/-/g, '').slice(0, 11),
      channel_id: channelId,
      title: 'Meu vídeo',
      status,
      video_bucket: storage.bucketVideos,
      video_key: key,
      declared_size_bytes: String(size),
      content_type: 'video/mp4',
      size_bytes: String(size),
    } as Partial<Video> as Video);

    return { slug: saved.slug, body };
  }

  describe('1. Streaming por range', () => {
    // 1.1. serve-range-parcial-com-206 — AC #1
    it('serve range parcial com 206', async () => {
      const { slug, body } = await seedVideo();

      const first = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Range', 'bytes=0-1023')
        .expect(206);

      expect(first.headers['content-range']).toBe(
        `bytes 0-1023/${OBJECT_SIZE}`,
      );
      expect(first.headers['accept-ranges']).toBe('bytes');
      expect(first.headers['content-length']).toBe('1024');
      expect(first.body).toHaveLength(1024);
      expect(
        Buffer.from(first.body as Buffer).equals(body.subarray(0, 1024)),
      ).toBe(true);

      const second = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Range', 'bytes=1024-2047')
        .expect(206);

      // Different bytes prove the range really reached storage rather than being
      // ignored with the head of the object returned twice.
      expect(second.headers['content-range']).toBe(
        `bytes 1024-2047/${OBJECT_SIZE}`,
      );
      expect(
        Buffer.from(second.body as Buffer).equals(first.body as Buffer),
      ).toBe(false);
      expect(
        Buffer.from(second.body as Buffer).equals(body.subarray(1024, 2048)),
      ).toBe(true);
    });

    // 1.2. serve-corpo-completo-sem-header-range — AC #2
    it('serve corpo completo sem header range', async () => {
      const { slug } = await seedVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .expect(200);

      // Accept-Ranges on the 200 as well — it is how a player learns it may seek.
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(OBJECT_SIZE));
    });

    // 1.3. rejeita-range-insatisfazivel — AC #3
    it('rejeita range insatisfazivel', async () => {
      const { slug } = await seedVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Range', `bytes=${OBJECT_SIZE + 1000}-${OBJECT_SIZE + 2000}`)
        .expect(416);

      expect((res.body as { error: string }).error).toBe(
        'RANGE_NOT_SATISFIABLE',
      );
    });

    // 1.4. permite-acesso-anonimo-a-video-pronto — AC #6
    it('permite acesso anonimo a video pronto', async () => {
      const { slug } = await seedVideo();

      // No Authorization header at all: anonymous viewing is the requirement.
      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Range', 'bytes=0-1023')
        .expect(206);

      expect(res.headers['content-range']).toBeDefined();
    });

    it('serve o content type da linha, nao o do objeto', async () => {
      // The object was stored without a Content-Type (as a presigned PUT that
      // omitted the header would), so serving storage's value back would make a
      // browser download instead of play.
      const { slug } = await seedVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .expect(200);

      expect(res.headers['content-type']).toContain('video/mp4');
    });
  });

  describe('2. Guarda de estado', () => {
    // 2.1. rejeita-streaming-de-video-nao-pronto — AC #4
    it.each([VideoStatus.PROCESSING, VideoStatus.DRAFT])(
      'rejeita streaming de video em %s',
      async (status) => {
        const { slug } = await seedVideo(status);

        const res = await request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .expect(409);

        expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
      },
    );

    it('responde 404 para slug inexistente', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/aaaaaaaaaaa/stream')
        .expect(404);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('2b. Rate limiting', () => {
    it('nao limita requisicoes de range — um player faz dezenas por reproducao', async () => {
      const { slug } = await seedVideo();

      // ThrottlerGuard is registered as APP_GUARD and is app-wide at 10 req/60s.
      // Without @SkipThrottle on the delivery routes, playback dies after the 10th
      // range request (verified: 30 of 40 came back 429).
      const codes: number[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .set('Range', `bytes=${i * 100}-${i * 100 + 99}`);
        codes.push(res.status);
      }

      expect(codes.filter((c) => c === 429)).toHaveLength(0);
      expect(codes.every((c) => c === 206)).toBe(true);
    }, 60000);

    it('nao limita o polling de status no intervalo de 3s documentado', async () => {
      const { slug } = await seedVideo();

      // The OpenAPI guidance says poll every 3 seconds; at 10 req/60s a client
      // would start getting 429s after about half a minute.
      const codes: number[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await request(app.getHttpServer()).get(`/videos/${slug}`);
        codes.push(res.status);
      }

      expect(codes.filter((c) => c === 429)).toHaveLength(0);
    }, 60000);

    it('mantem o rate limit nas rotas de escrita', async () => {
      // Only the public READ routes are exempt; abuse protection on writes stays.
      const unauthenticated = await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 'x',
          declared_size_bytes: 1,
          content_type: 'video/mp4',
        });

      // 401 (guard) rather than 200 — the point is that it is NOT skipped-and-open.
      expect(unauthenticated.status).toBe(401);
    });
  });

  describe('3. Download', () => {
    // 3.1. serve-download-como-anexo — AC #5
    it('serve download como anexo', async () => {
      const { slug } = await seedVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .expect(200);

      const disposition = res.headers['content-disposition'];
      expect(disposition).toMatch(/^attachment;/);
      expect(disposition).toContain(slug);
      expect(res.headers['accept-ranges']).toBe('bytes');
    });

    it('rejeita download de video nao pronto', async () => {
      const { slug } = await seedVideo(VideoStatus.PROCESSING);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .expect(409);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
    });

    it('honra Range no download para que uma retomada funcione', async () => {
      const { slug } = await seedVideo();

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .set('Range', 'bytes=2000-2999')
        .expect(206);

      expect(res.headers['content-range']).toBe(
        `bytes 2000-2999/${OBJECT_SIZE}`,
      );
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    });
  });
});
