import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
// v11 declares `export = PgBoss`, so this is the default import. The named form
// `{ PgBoss }` is v12-only and does not compile here (see library-refs.md).
import PgBoss from 'pg-boss';
import type { EntityManager } from 'typeorm';
import databaseConfig from '../config/database.config';
import {
  DRAFT_REAPER_CRON,
  QUEUES,
  QUEUE_APPLICATION_NAME,
  QUEUE_POOL_MAX,
  VIDEO_PROCESSING_RETRY,
} from './queue.constants';

/** Payload of the `video-processing` job — deliberately thin (per TD-07). */
export interface VideoProcessingPayload {
  videoId: string;
  videoBucket: string;
  videoKey: string;
}

export type QueueHandler<T extends object> = (payload: T) => Promise<void>;

/**
 * Real shape returned by `getQueueStats`. pg-boss@11.0.2 declares it as
 * `Promise<number>` in `types.d.ts`, but the runtime returns this row — verified
 * against `src/plans.js:938`. The cast below is the narrow fix for that upstream
 * type bug; do not "simplify" it back to a number.
 */
export interface QueueStats {
  name: string;
  queuedCount: number;
  activeCount: number;
  deferredCount: number;
  totalCount: number;
}

/**
 * Narrow port over `pg-boss`. Nothing outside this module imports the library, so a
 * later backend swap touches one file (per phase-03-videos/TD-07).
 */
@Injectable()
export class QueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly boss: PgBoss;

  constructor(
    @Inject(databaseConfig.KEY)
    db: ConfigType<typeof databaseConfig>,
  ) {
    // Connection parameters come from the SAME factory the application uses. What is
    // duplicated is the pool, not the configuration — that is what keeps the
    // inherited phase-01 single-source convention intact (per TD-17).
    this.boss = new PgBoss({
      host: db.host,
      port: db.port,
      database: db.name,
      user: db.username,
      password: db.password,
      application_name: QUEUE_APPLICATION_NAME,
      max: QUEUE_POOL_MAX,
    });
  }

  async onModuleInit(): Promise<void> {
    // pg-boss EMITS errors rather than throwing them; without this listener a
    // background failure is silent.
    this.boss.on('error', (error) => this.logger.error('pg-boss error', error));

    await this.boss.start();

    // `createQueue` is mandatory since v10 and never UPDATES an existing queue —
    // changing the retry policy later requires altering the queue explicitly.
    await this.boss.createQueue(QUEUES.VIDEO_PROCESSING_DLQ);
    await this.boss.createQueue(QUEUES.VIDEO_PROCESSING, {
      name: QUEUES.VIDEO_PROCESSING,
      ...VIDEO_PROCESSING_RETRY,
      deadLetter: QUEUES.VIDEO_PROCESSING_DLQ,
    });
    await this.boss.createQueue(QUEUES.DRAFT_REAPER);

    // The reaper is periodic, so pg-boss owns its cadence rather than application
    // code hand-enqueuing it (per phase-03-videos/TD-04's cleanup mechanism).
    await this.boss.schedule(QUEUES.DRAFT_REAPER, DRAFT_REAPER_CRON);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: true, close: true });
  }

  /**
   * Enqueues video processing. Pass `manager` to enqueue INSIDE an open TypeORM
   * transaction: the job insert then shares the transaction's fate, so the draft row
   * and its job commit together and cannot diverge. This is TD-07's central
   * justification for choosing pg-boss (per TD-04, TD-17).
   */
  async enqueueVideoProcessing(
    payload: VideoProcessingPayload,
    manager?: EntityManager,
  ): Promise<string | null> {
    return this.boss.send(QUEUES.VIDEO_PROCESSING, payload, {
      ...(manager ? { db: this.adapt(manager) } : {}),
    });
  }

  async enqueueDraftReaper(manager?: EntityManager): Promise<string | null> {
    return this.boss.send(
      QUEUES.DRAFT_REAPER,
      {},
      { ...(manager ? { db: this.adapt(manager) } : {}) },
    );
  }

  /**
   * Registers a handler. The handler always receives an ARRAY, even at batch size 1
   * — hence the destructure (per library-refs.md § pg-boss).
   */
  async registerWorker<T extends object>(
    queue: string,
    handler: QueueHandler<T>,
  ): Promise<string> {
    return this.boss.work<T>(queue, async ([job]) => {
      await handler(job.data);
    });
  }

  /**
   * Full job counters for a queue, or `null` when the queue holds no jobs at all —
   * the aggregate query returns no row rather than a zeroed one.
   */
  async stats(queue: string): Promise<QueueStats | null> {
    return this.boss.getQueueStats(
      queue,
    ) as unknown as Promise<QueueStats | null>;
  }

  /** Jobs waiting to be picked up — excludes jobs already being worked. */
  async queueSize(queue: string): Promise<number> {
    return (await this.stats(queue))?.queuedCount ?? 0;
  }

  /**
   * Clears a queue completely. `deleteQueuedJobs` only removes jobs in the queued
   * state and leaves ACTIVE ones behind, which silently contaminates the next test.
   * Test-support only; never called on a request path.
   */
  async drain(queue: string): Promise<void> {
    await this.boss.deleteAllJobs(queue);
  }

  /** Fetches without a worker loop — lets tests assert on the payload directly. */
  async fetchOne<T extends object>(queue: string): Promise<T | null> {
    const jobs = await this.boss.fetch<T>(queue);
    return jobs.length ? jobs[0].data : null;
  }

  /** Wraps a TypeORM manager in pg-boss's BYODB adapter shape. */
  private adapt(manager: EntityManager): {
    executeSql: (
      text: string,
      values: unknown[],
    ) => Promise<{ rows: unknown[] }>;
  } {
    return {
      executeSql: async (text: string, values: unknown[]) => {
        const rows: unknown = await manager.query(text, values);
        return { rows: (Array.isArray(rows) ? rows : []) as unknown[] };
      },
    };
  }
}
