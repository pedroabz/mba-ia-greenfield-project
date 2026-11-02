import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { DraftReaperService } from './draft-reaper.service';
import { FfmpegService } from './ffmpeg.service';
import { ProcessRunner } from './process-runner';
import { VideoProcessingService } from './video-processing.service';

/**
 * Root module of the `video-worker` container. It deliberately declares **no
 * controllers** — the worker runs as a standalone Nest context with no HTTP
 * listener, which is the whole point of separating it from the API: a multi-minute
 * FFmpeg run cannot occupy the API's event loop or its request concurrency
 * (per phase-03-videos/TD-08).
 *
 * It also does NOT import AppModule. Doing so would drag in the controllers, the
 * global guard and the rate limiter, and would bind a second HTTP server.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // The whole RELATION GRAPH, not just the entity the worker queries.
        // `Video` declares `@ManyToOne(() => Channel)` and `Channel` declares
        // `@ManyToOne(() => User)`, and TypeORM resolves inverse sides at
        // initialization: with `entities: [Video]` alone the DataSource fails to
        // build with "Entity metadata for Video#channel was not found" and the
        // worker container never boots.
        entities: [User, Channel, Video],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    QueueModule,
  ],
  providers: [
    ProcessRunner,
    FfmpegService,
    VideoProcessingService,
    DraftReaperService,
  ],
})
export class WorkerModule {}
