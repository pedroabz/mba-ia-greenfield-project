import type { QueueService } from '../queue/queue.service';

/**
 * Queue harness for integration suites. Like `src/storage/storage.test-harness.ts` it drives the
 * REAL `pg-boss` against the Compose database rather than faking the queue, so what
 * the suites exercise is the same delivery path production uses (per TD-15).
 */

const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Waits until `queue` holds at least `expected` queued jobs. Returns the final count,
 * which lets a caller assert the EXACT count afterwards — polling for "at least one"
 * and then asserting "exactly one" is the only way to distinguish a single enqueue
 * from a duplicate without sleeping for a fixed interval.
 */
export async function waitForQueueSize(
  queues: QueueService,
  queue: string,
  expected: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let size = await queues.queueSize(queue);

  while (size < expected && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    size = await queues.queueSize(queue);
  }

  return size;
}

/**
 * Registers a worker on `queue` and resolves with the first payload it receives.
 * The worker stays registered for the life of the `QueueService` — pg-boss has no
 * per-worker teardown short of `offWork`, so a suite should register at most one.
 */
export async function captureFirstJob<T extends object>(
  queues: QueueService,
  queue: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const received: T[] = [];
  await queues.registerWorker<T>(queue, (payload) => {
    received.push(payload);
    return Promise.resolve();
  });

  const deadline = Date.now() + timeoutMs;
  while (received.length === 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
  }

  if (received.length === 0) {
    throw new Error(`No job delivered on "${queue}" within ${timeoutMs}ms`);
  }

  return received[0];
}

/**
 * Empties a queue between suites. Uses the service's `drain`, which deletes jobs in
 * EVERY state — `pg-boss`'s own `deleteQueuedJobs` leaves active jobs behind and
 * those would contaminate the next suite.
 */
export async function drainQueues(
  queues: QueueService,
  ...names: string[]
): Promise<void> {
  for (const name of names) {
    await queues.drain(name);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
