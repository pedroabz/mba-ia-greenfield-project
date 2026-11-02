import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

/**
 * Entry point of the `video-worker` container.
 *
 * `createApplicationContext` — not `create` — because the worker has no HTTP
 * surface: it only consumes the queue (per phase-03-videos/TD-08).
 */
async function bootstrap(): Promise<void> {
  const context = await NestFactory.createApplicationContext(WorkerModule);

  // Without this, SIGTERM from `docker compose down` kills the process outright and
  // pg-boss never runs its graceful stop — an in-flight job would stay `active`
  // until its visibility window lapsed.
  context.enableShutdownHooks();

  new Logger('Worker').log('Video worker started');
}

void bootstrap();
