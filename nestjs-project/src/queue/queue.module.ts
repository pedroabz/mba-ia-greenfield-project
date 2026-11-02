import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QueueService } from './queue.service';

/**
 * Owns the background job queue. No other module imports `pg-boss` — the narrow port
 * in QueueService is what bounds a future backend swap to one file
 * (per phase-03-videos/TD-07).
 */
@Module({
  imports: [ConfigModule],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
