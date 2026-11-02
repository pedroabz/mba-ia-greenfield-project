import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  /**
   * Reached from inside the Docker network (API and worker containers).
   * Used for every server-side S3 operation.
   */
  endpointInternal: process.env.S3_ENDPOINT_INTERNAL || 'http://minio:9000',
  /**
   * Reached from outside the Docker network (the e2e suite, manual verification,
   * and any client that uploads directly to storage). Presigned URLs destined for
   * such callers MUST be signed against this endpoint: SigV4 signs the `host`
   * header, so a URL signed for `endpointInternal` cannot be used from the host.
   */
  endpointPublic: process.env.S3_ENDPOINT_PUBLIC || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  bucketVideos: process.env.S3_BUCKET_VIDEOS || 'streamtube-videos',
  bucketThumbnails: process.env.S3_BUCKET_THUMBNAILS || 'streamtube-thumbnails',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  /** Required by MinIO; harmless against real S3. */
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  presignTtlSeconds: parseInt(process.env.PRESIGN_TTL_SECONDS || '900', 10),
}));
