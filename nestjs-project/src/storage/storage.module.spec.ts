import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and resolve StorageService from the DI container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);

    await moduleRef.close();
  });

  it('should expose both bucket names from config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    const service = moduleRef.get(StorageService);

    expect(service.bucketVideos).toBeTruthy();
    expect(service.bucketThumbnails).toBeTruthy();
    // Two buckets per phase-03-videos/TD-05 (Option B) — they must not collapse.
    expect(service.bucketVideos).not.toBe(service.bucketThumbnails);

    await moduleRef.close();
  });

  it('should destroy both S3 clients on shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    const service = moduleRef.get(StorageService);
    const spy = jest.spyOn(service, 'onModuleDestroy');

    await moduleRef.close();

    // Leaving the pooled HTTP agents open is what makes Jest hang after a suite.
    expect(spy).toHaveBeenCalled();
  });
});
