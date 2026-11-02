import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';

/**
 * Owns every interaction with object storage. No other module imports from
 * `@aws-sdk/*` — the narrow surface here is what makes the MinIO→S3 swap a pure
 * configuration change (per phase-03-videos/TD-02).
 */
@Module({
  imports: [ConfigModule],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
