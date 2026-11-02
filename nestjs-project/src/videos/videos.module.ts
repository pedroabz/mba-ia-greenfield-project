import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

/**
 * Owns the video domain. `forFeature` is what makes the entity discoverable — with
 * `autoLoadEntities: true` an entity is still invisible unless some module registers
 * it here, and the failure mode is silent (the app boots; queries and migrations
 * just miss the table).
 *
 * Channel ownership is read through `ChannelsService`, not by querying the Channel
 * entity here — the videos domain does not reach into another module's tables.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
