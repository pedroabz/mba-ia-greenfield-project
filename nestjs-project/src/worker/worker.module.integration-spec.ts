import { Test } from '@nestjs/testing';
import { DraftReaperService } from './draft-reaper.service';
import { FfmpegService } from './ffmpeg.service';
import { ProcessRunner } from './process-runner';
import { VideoProcessingService } from './video-processing.service';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  // `compile()` does not run lifecycle hooks, so neither worker is registered and
  // pg-boss never starts here — only the DI graph is exercised.
  const compile = () =>
    Test.createTestingModule({ imports: [WorkerModule] }).compile();

  it('should compile the standalone worker context', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    expect(moduleRef.get(DraftReaperService)).toBeInstanceOf(
      DraftReaperService,
    );
    expect(moduleRef.get(FfmpegService)).toBeInstanceOf(FfmpegService);
    expect(moduleRef.get(ProcessRunner)).toBeInstanceOf(ProcessRunner);

    await moduleRef.close();
  }, 30000);

  it('should declare no controllers — the worker has no HTTP surface', () => {
    // This is the point of separating the worker from the API (per TD-08): a
    // multi-minute FFmpeg run must not occupy the API's event loop. A controller
    // appearing here would mean the worker image is also serving traffic.
    const controllers = Reflect.getMetadata('controllers', WorkerModule) as
      | unknown[]
      | undefined;

    expect(controllers ?? []).toEqual([]);
  });

  it('should not import AppModule', () => {
    // Importing it would drag in the global guard, the rate limiter and the
    // controllers, and would bind a second HTTP server inside the worker.
    const imports = Reflect.getMetadata('imports', WorkerModule) as unknown[];

    expect(
      imports.map((m) => (m as { name?: string })?.name).filter(Boolean),
    ).not.toContain('AppModule');
  });
});
