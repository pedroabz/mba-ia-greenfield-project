import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  ALL_ENTITIES,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  /**
   * Compiles the real module graph. `forRoot` is required rather than an overridden
   * DataSource because `overrideProvider` only reaches the root test module —
   * ChannelsModule resolves its own DataSource from the TypeORM core module. Same
   * pattern as channels.module.spec.ts / users.module.spec.ts.
   *
   * `compile()` runs no lifecycle hooks, so pg-boss never starts here.
   */
  const compile = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

  it('should compile with the Video repository registered via forFeature', async () => {
    // Without forFeature the app still boots but repository injection fails at
    // runtime and the entity can go missing from migrations — hence this test.
    const moduleRef = await compile();

    expect(moduleRef.get(getRepositoryToken(Video))).toBeDefined();

    await moduleRef.close();
  }, 30000);

  it('should wire the controller and the service', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
    expect(moduleRef.get(VideosService)).toBeInstanceOf(VideosService);

    await moduleRef.close();
  }, 30000);

  it('should reach channel ownership and storage through their owning modules', async () => {
    const moduleRef = await compile();

    // The videos domain must not query another module's entity directly; ownership
    // comes from ChannelsService and object access from StorageService.
    expect(moduleRef.get(ChannelsService, { strict: false })).toBeInstanceOf(
      ChannelsService,
    );
    expect(moduleRef.get(StorageService, { strict: false })).toBeInstanceOf(
      StorageService,
    );

    await moduleRef.close();
  }, 30000);
});
