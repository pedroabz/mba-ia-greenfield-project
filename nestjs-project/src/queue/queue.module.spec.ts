import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import databaseConfig from '../config/database.config';
import { QUEUES } from './queue.constants';
import { QueueModule } from './queue.module';
import { QueueService } from './queue.service';

describe('QueueModule', () => {
  // `compile()` deliberately does NOT run lifecycle hooks, so no connection is
  // opened here — that is what keeps this a unit test. The boot path itself is
  // covered by queue.service.integration-spec.ts.
  const compile = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
        QueueModule,
      ],
    }).compile();

  it('should resolve QueueService from the DI container', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(QueueService)).toBeInstanceOf(QueueService);
  });

  it('should declare a dead-letter queue distinct from the work queue', () => {
    // A deadLetter pointing at its own queue is an infinite redelivery loop.
    expect(QUEUES.VIDEO_PROCESSING_DLQ).not.toBe(QUEUES.VIDEO_PROCESSING);
  });
});
