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
import { S3_MAX_PARTS } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createTestStorage,
  destroyTestStorageClient,
} from '../src/storage/storage.test-harness';
import { User } from '../src/users/entities/user.entity';
import { VideosController } from '../src/videos/videos.controller';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

/** See the note in videos-read.e2e-spec.ts — `supertest` types `res.body` as `any`. */
interface DraftBody {
  id: string;
  slug: string;
  uploadKey: string;
  part_size_bytes: number;
}
interface SignedBody {
  url?: string;
  expires_in?: number;
  error?: string;
}
interface CompletionBody {
  id: string;
  slug: string;
  status: VideoStatus;
  error?: string;
}

const DECLARED_SIZE = 4096;
const TEN_GIB = 10 * 1024 ** 3;

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let queue: QueueService;
  let storage: StorageService;
  const testStorage = createTestStorage('videos-upload-e2e');
  const writtenKeys: string[] = [];

  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // createTestingModule does not run main.ts, so the global config is reproduced
    // here — without it the ValidationPipe wiring under test would not be active.
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
    for (const key of writtenKeys) {
      await testStorage.remove(storage.bucketVideos, key);
    }
    await testStorage.cleanup();
    destroyTestStorageClient();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(QUEUES.VIDEO_PROCESSING);

    ownerToken = await createConfirmedUserWithChannel();
    otherToken = await createConfirmedUserWithChannel();
  });

  /**
   * Seeds a confirmed user plus their channel directly and signs a token through the
   * app's own JWT service. Going through `/auth/register` + e-mail confirmation would
   * couple this suite to the auth flow and to the rate limiter.
   */
  async function createConfirmedUserWithChannel(): Promise<string> {
    const user = await dataSource.getRepository(User).save({
      email: `vid-e2e-${randomUUID()}@streamtube.test`,
      password: 'hashed',
      is_confirmed: true,
    } as Partial<User>);
    await dataSource.getRepository(Channel).save({
      name: 'Canal',
      nickname: `canal_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    } as Partial<Channel>);

    // JwtService lives inside AuthModule, so the lookup must not be strict.
    const jwt = app.get(JwtService, { strict: false });
    return jwt.signAsync({ sub: user.id, email: user.email });
  }

  const createDraft = async (
    token: string,
  ): Promise<{
    id: string;
    slug: string;
    uploadKey: string;
    part_size_bytes: number;
  }> => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Meu vídeo',
        declared_size_bytes: DECLARED_SIZE,
        content_type: 'video/mp4',
      })
      .expect(201);
    return res.body as DraftBody;
  };

  async function uploadTo(key: string, size: number): Promise<void> {
    await testStorage.put(storage.bucketVideos, key, Buffer.alloc(size, 7));
    writtenKeys.push(key);
  }

  describe('1. Pré-cadastro do rascunho', () => {
    // 1.1. cria-rascunho-com-corpo-valido — AC #1
    it('cria rascunho com corpo valido', async () => {
      const body = await createDraft(ownerToken);

      expect(body.id).toBeDefined();
      expect(body.uploadKey).toBeDefined();
      expect(body.slug).toHaveLength(11);
      expect(body.part_size_bytes).toBeGreaterThan(0);
      expect(Math.ceil(TEN_GIB / body.part_size_bytes)).toBeLessThan(
        S3_MAX_PARTS,
      );

      const row = await videos.findOneByOrFail({ id: body.id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.declared_size_bytes).toBe(String(DECLARED_SIZE));
      expect(row.video_key).toBe(body.uploadKey);
      expect(row.processing_attempts).toBe(0);
      // All seven metadata fields stay NULL until the worker fills them.
      expect(row.duration_seconds).toBeNull();
      expect(row.width).toBeNull();
      expect(row.height).toBeNull();
      expect(row.codec_name).toBeNull();
      expect(row.container_format).toBeNull();
      expect(row.bitrate_bps).toBeNull();
      expect(row.size_bytes).toBeNull();
    });

    // 1.2. rejeita-rascunho-sem-token — AC #7
    it('rejeita rascunho sem token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 'Meu vídeo',
          declared_size_bytes: DECLARED_SIZE,
          content_type: 'video/mp4',
        })
        .expect(401);

      expect(await videos.count()).toBe(0);
    });

    it('rejeita corpo invalido pelo ValidationPipe global', async () => {
      // Covers the `phase-02-auth/TD-06` wiring requirement: the pipe must be active
      // on a videos route, not only on the auth ones.
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: '', declared_size_bytes: -1 })
        .expect(400);

      expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
      expect(await videos.count()).toBe(0);
    });
  });

  describe('2. Assinatura de operações S3', () => {
    // 2.1. rejeita-key-que-nao-pertence-ao-rascunho — AC #2
    it('rejeita key que nao pertence ao rascunho', async () => {
      const draft = await createDraft(ownerToken);

      const rejected = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/sign`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          method: 'PUT',
          key: 'videos/outro-id/original.mp4',
          upload_id: 'upload-1',
          part_number: 1,
        })
        .expect(403);

      const rejectedBody = rejected.body as SignedBody;
      expect(rejectedBody.error).toBe('UPLOAD_KEY_MISMATCH');
      expect(rejectedBody.url).toBeUndefined();

      const accepted = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/sign`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          method: 'PUT',
          key: draft.uploadKey,
          upload_id: 'upload-1',
          part_number: 1,
        })
        .expect(200);

      const acceptedBody = accepted.body as SignedBody;
      expect(acceptedBody.url).toBeDefined();
      expect(acceptedBody.expires_in).toBeGreaterThan(0);
      // SigV4 signs the host header, so the URL must carry the PUBLIC host — a URL
      // signed against the internal one is rejected when used from outside Docker.
      const publicHost = new URL(process.env.S3_ENDPOINT_PUBLIC as string).host;
      const internalHost = new URL(process.env.S3_ENDPOINT_INTERNAL as string)
        .host;
      expect(new URL(acceptedBody.url as string).host).toBe(publicHost);
      expect(new URL(acceptedBody.url as string).host).not.toBe(internalHost);
    });

    // 2.2. rejeita-assinatura-por-usuario-que-nao-e-dono — AC #3
    it('rejeita assinatura por usuario que nao e dono', async () => {
      const draft = await createDraft(ownerToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/sign`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ method: 'PUT', key: draft.uploadKey, upload_id: 'upload-1' })
        .expect(403);

      expect((res.body as SignedBody).error).toBe('VIDEO_NOT_OWNED');

      // ListParts pagination is a signable operation like any other — resume on a
      // 10 GiB upload needs page 2 onwards.
      const listParts = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/sign`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          method: 'GET',
          key: draft.uploadKey,
          upload_id: 'upload-1',
          part_number_marker: '1000',
        })
        .expect(200);

      expect((listParts.body as SignedBody).url).toBeDefined();
    });
  });

  describe('2b. Rate limiting da assinatura', () => {
    it('permite muito mais de 10 assinaturas — uma por parte', async () => {
      const draft = await createDraft(ownerToken);

      // The inherited global limit is 10 req/60s. Signing happens once PER PART, so
      // under that limit the largest upload that completes is 80 MiB and a 10 GiB
      // one needs 1,284 calls. This was found by actually attempting a 10 GiB
      // upload: the client died at part 10 with a 429.
      const codes: number[] = [];
      for (let part = 1; part <= 40; part++) {
        const res = await request(app.getHttpServer())
          .post(`/videos/${draft.id}/upload/sign`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({
            method: 'PUT',
            key: draft.uploadKey,
            upload_id: 'upload-1',
            part_number: part,
          });
        codes.push(res.status);
      }

      expect(codes.filter((c) => c === 429)).toHaveLength(0);
      expect(codes.every((c) => c === 200)).toBe(true);
    }, 60000);

    it('mantem o limite herdado na criacao de rascunho', () => {
      // Only the signing route is widened; creating drafts is once per video and
      // stays on the inherited limit.
      const limits = Reflect.getMetadata(
        'THROTTLER:LIMIT',
        VideosController.prototype.create,
      ) as unknown;

      expect(limits).toBeUndefined();
    });
  });

  describe('3. Conclusão do upload e integridade', () => {
    // 3.1. rejeita-conclusao-sem-objeto-no-storage — AC #4
    it('rejeita conclusao sem objeto no storage', async () => {
      const draft = await createDraft(ownerToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload-complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(409);

      expect((res.body as CompletionBody).error).toBe('UPLOAD_OBJECT_MISSING');
      expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
        VideoStatus.DRAFT,
      );
      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
    });

    // 3.2. rejeita-conclusao-com-tamanho-divergente — AC #5
    it('rejeita conclusao com tamanho divergente', async () => {
      const draft = await createDraft(ownerToken);
      await uploadTo(draft.uploadKey, DECLARED_SIZE - 1);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload-complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(409);

      expect((res.body as CompletionBody).error).toBe('UPLOAD_SIZE_MISMATCH');
      expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
        VideoStatus.DRAFT,
      );
      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
    });

    // 3.3. conclui-e-enfileira-uma-unica-vez-em-chamada-duplicada — AC #6
    it('conclui e enfileira uma unica vez em chamada duplicada', async () => {
      const draft = await createDraft(ownerToken);
      await uploadTo(draft.uploadKey, DECLARED_SIZE);

      const first = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload-complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect((first.body as CompletionBody).status).toBe(
        VideoStatus.PROCESSING,
      );
      expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
        VideoStatus.PROCESSING,
      );
      expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(1);
      expect(await queue.fetchOne(QUEUES.VIDEO_PROCESSING)).toEqual({
        videoId: draft.id,
        videoBucket: storage.bucketVideos,
        videoKey: draft.uploadKey,
      });

      // Second call: the spec asserts side effects only, deliberately not a status
      // code — the conditional update is what prevents a second enqueue.
      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload-complete`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
        VideoStatus.PROCESSING,
      );
      // `fetchOne` above moved the job to active, so count across every state.
      expect((await queue.stats(QUEUES.VIDEO_PROCESSING))?.totalCount).toBe(1);
    });
  });
});
