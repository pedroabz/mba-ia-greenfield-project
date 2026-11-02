/** Queue names. Both are created explicitly at boot — `createQueue` is mandatory. */
export const QUEUES = {
  VIDEO_PROCESSING: 'video-processing',
  VIDEO_PROCESSING_DLQ: 'video-processing-dlq',
  DRAFT_REAPER: 'draft-reaper',
} as const;

/**
 * Retry policy, set EXPLICITLY on `createQueue` rather than inherited.
 * `pg-boss` has made retries opt-out since v10 with a default `retryLimit` of 2,
 * which is the wrong default for a non-idempotent FFmpeg handler
 * (per phase-03-videos/TD-11 revision).
 */
export const VIDEO_PROCESSING_RETRY = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/** Identifies the queue's connections in `pg_stat_activity`. */
export const QUEUE_APPLICATION_NAME = 'streamtube-queue' as const;

/**
 * Pool size for the queue's dedicated connections. Deliberately small: the pool is
 * duplicated (not the configuration) so the worker's long-poll cannot starve request
 * handling (per phase-03-videos/TD-17).
 */
export const QUEUE_POOL_MAX = 4;

/** A draft whose upload never completed is reaped after this long. */
export const DRAFT_EXPIRY_HOURS = 24;

/** Reaper cadence — hourly is ample for a 24h draft expiry window. */
export const DRAFT_REAPER_CRON = '0 * * * *' as const;
