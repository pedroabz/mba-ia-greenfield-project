import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import databaseConfig from '../config/database.config';
import { QUEUES, QUEUE_APPLICATION_NAME } from './queue.constants';
import { QueueModule } from './queue.module';
import { QueueService, type VideoProcessingPayload } from './queue.service';

describe('QueueService (integration)', () => {
  let moduleRef: TestingModule;
  let queue: QueueService;
  let dataSource: DataSource;

  const payload = (videoId: string): VideoProcessingPayload => ({
    videoId,
    videoBucket: 'streamtube-videos',
    videoKey: `videos/${videoId}/original.mp4`,
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
        QueueModule,
      ],
    }).compile();

    // init() runs onModuleInit, which is what creates the `pgboss` schema and the
    // three queues. The schema is NOT provisioned by a migration (see
    // nestjs-project/CLAUDE.md § Video Infrastructure).
    await moduleRef.init();
    queue = moduleRef.get(QueueService);

    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [],
      synchronize: false,
    });
    await dataSource.initialize();
  });

  beforeEach(async () => {
    await queue.drain(QUEUES.VIDEO_PROCESSING);
  });

  afterAll(async () => {
    await queue.drain(QUEUES.VIDEO_PROCESSING);
    await dataSource.destroy();
    // close() fires onApplicationShutdown, which stops pg-boss and releases its
    // dedicated pool. Without it Jest hangs on the open handles.
    await moduleRef.close();
  });

  it('should create the pgboss schema and the declared queues at boot', async () => {
    const [{ exists }] = await dataSource.query<{ exists: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss') AS exists`,
    );

    expect(exists).toBe(true);

    const rows = await dataSource.query<{ name: string }[]>(
      `SELECT name FROM pgboss.queue WHERE name = ANY($1::text[])`,
      [
        [
          QUEUES.VIDEO_PROCESSING,
          QUEUES.VIDEO_PROCESSING_DLQ,
          QUEUES.DRAFT_REAPER,
        ],
      ],
    );

    expect(rows.map((r) => r.name).sort()).toEqual(
      [
        QUEUES.DRAFT_REAPER,
        QUEUES.VIDEO_PROCESSING,
        QUEUES.VIDEO_PROCESSING_DLQ,
      ].sort(),
    );
  });

  it('should configure the work queue with an explicit retry policy and dead letter', async () => {
    const [row] = await dataSource.query<
      { retry_limit: number; dead_letter: string | null }[]
    >(`SELECT retry_limit, dead_letter FROM pgboss.queue WHERE name = $1`, [
      QUEUES.VIDEO_PROCESSING,
    ]);

    // Retries are opt-OUT since v10 with a default limit of 2 — this asserts the
    // policy was set deliberately rather than inherited (per TD-11 revision).
    expect(row.retry_limit).toBe(3);
    expect(row.dead_letter).toBe(QUEUES.VIDEO_PROCESSING_DLQ);
  });

  it('should enqueue a job and expose it on the queue', async () => {
    const jobId = await queue.enqueueVideoProcessing(payload('vid-1'));

    expect(jobId).toBeTruthy();
    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(1);
  });

  it('should round-trip the payload without reshaping it', async () => {
    const sent = payload('vid-2');
    await queue.enqueueVideoProcessing(sent);

    expect(
      await queue.fetchOne<VideoProcessingPayload>(QUEUES.VIDEO_PROCESSING),
    ).toEqual(sent);
  });

  it('should commit the job together with the transaction that enqueued it', async () => {
    await dataSource.transaction(async (manager) => {
      await queue.enqueueVideoProcessing(payload('vid-3'), manager);
    });

    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(1);
  });

  it('should discard the job when the enclosing transaction rolls back', async () => {
    // THE reason TD-07 chose pg-boss over an external broker: the job insert shares
    // the transaction's fate, so a draft row and its job cannot diverge. An external
    // broker would have published already and left an orphan job here.
    await expect(
      dataSource.transaction(async (manager) => {
        await queue.enqueueVideoProcessing(payload('vid-4'), manager);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await queue.queueSize(QUEUES.VIDEO_PROCESSING)).toBe(0);
  });

  it('should not leak a transactional enqueue into the ambient connection', async () => {
    // Guards the BYODB adapter: if `executeSql` ran on a pooled connection instead
    // of the transaction's own, the row above would survive the rollback. Asserting
    // the queue is still empty from a SEPARATE connection proves it did not.
    const [{ count }] = await dataSource.query<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM pgboss.job
       WHERE name = $1 AND data->>'videoId' = 'vid-4'`,
      [QUEUES.VIDEO_PROCESSING],
    );

    expect(count).toBe('0');
  });

  it('should release every pg-boss connection on shutdown', async () => {
    // `QUEUE_APPLICATION_NAME` exists precisely so these connections are
    // identifiable in pg_stat_activity. A leaked pool shows up as Jest refusing to
    // exit, and in production as connection exhaustion across redeploys.
    const countQueueConnections = async (): Promise<number> => {
      const [row] = await dataSource.query<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = $1`,
        [QUEUE_APPLICATION_NAME],
      );
      return Number(row.n);
    };

    // Measured as a DELTA, because the suite's own QueueService is open under the
    // same application_name.
    const baseline = await countQueueConnections();

    const second = new QueueService(databaseConfig());
    await second.onModuleInit();
    const whileOpen = await countQueueConnections();
    expect(whileOpen).toBeGreaterThan(baseline);

    await second.onApplicationShutdown();

    // pg-boss closes asynchronously; poll rather than assert on a fixed sleep.
    const deadline = Date.now() + 10_000;
    let after = await countQueueConnections();
    while (after > baseline && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await countQueueConnections();
    }

    expect(after).toBe(baseline);
  }, 20_000);

  it('should deliver an enqueued job to a registered worker', async () => {
    const received: VideoProcessingPayload[] = [];
    const workerId = await queue.registerWorker<VideoProcessingPayload>(
      QUEUES.VIDEO_PROCESSING,
      (data) => {
        received.push(data);
        return Promise.resolve();
      },
    );

    await queue.enqueueVideoProcessing(payload('vid-5'));

    const deadline = Date.now() + 15_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(workerId).toBeTruthy();
    expect(received).toEqual([payload('vid-5')]);
  }, 20_000);
});
