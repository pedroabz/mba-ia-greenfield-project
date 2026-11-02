import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { FFMPEG_TIMEOUT_MS } from './worker.constants';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ProcessFailedError extends Error {
  constructor(
    readonly bin: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
  ) {
    super(
      `${bin} exited with ${exitCode === null ? `signal ${signal}` : `code ${exitCode}`}: ${stderr.trim().slice(0, 500)}`,
    );
    this.name = 'ProcessFailedError';
  }
}

/**
 * The single mockable seam between this codebase and the FFmpeg binaries (per
 * phase-03-videos/TD-09). Everything above it builds argv; everything below it is
 * the real process. That split is what lets argv be unit-tested without spawning,
 * and the binaries be integration-tested without mocks.
 */
@Injectable()
export class ProcessRunner {
  /**
   * @param args argv as an ARRAY — never a shell string. `shell` is left off, so no
   *   shell is involved and a filename containing `;` or `$(…)` is inert rather than
   *   injectable.
   */
  async run(
    bin: string,
    args: string[],
    options: RunOptions = {},
  ): Promise<ProcessResult> {
    const { timeoutMs = FFMPEG_TIMEOUT_MS, signal } = options;

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(bin, args, {
        // Both are enforced by Node itself; a hung ffmpeg would otherwise hold the
        // worker's concurrency slot forever.
        timeout: timeoutMs,
        signal,
        killSignal: 'SIGKILL',
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      // ffmpeg writes its progress AND its errors to stderr, so this is the
      // diagnostic payload that ends up in `processing_error`.
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      child.on('error', (error) => reject(error));

      child.on('close', (code, closeSignal) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new ProcessFailedError(bin, code, closeSignal, stderr));
      });
    });
  }
}
