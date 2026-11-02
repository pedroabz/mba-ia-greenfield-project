import { spawnSync } from 'child_process';
import { FFMPEG_BIN, FFPROBE_BIN } from './worker.constants';

/**
 * Whether the FFmpeg binaries are present in THIS container.
 *
 * They are installed only in the `video-worker` image — `Dockerfile.dev` is
 * multi-stage and `compose.yaml` picks a `target:` per service, which is
 * deliberate (a multi-minute FFmpeg run must not live in the API image, per
 * phase-03-videos/TD-08).
 *
 * Test suites that drive the real binaries use this to SKIP rather than fail when
 * run from a container that legitimately lacks them. Skipping is honest here and
 * failing is not: the absence is by design, not a regression. The Definition of
 * Done is run in `video-worker`, where nothing skips — so this cannot quietly
 * erode coverage.
 *
 * Synchronous on purpose: `describe.skip` has to be decided at module-evaluation
 * time, before Jest collects the suite.
 */
function probe(bin: string): boolean {
  const result = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

let cached: boolean | undefined;

export function hasFfmpeg(): boolean {
  cached ??= probe(FFPROBE_BIN) && probe(FFMPEG_BIN);
  return cached;
}

/**
 * `describe` when the binaries are available, `describe.skip` otherwise — so the
 * suite is reported as skipped with a reason instead of failing.
 */
export const describeWithFfmpeg: jest.Describe = hasFfmpeg()
  ? describe
  : describe.skip;

export const FFMPEG_SKIP_REASON =
  'requires ffmpeg/ffprobe — run in the video-worker container';
