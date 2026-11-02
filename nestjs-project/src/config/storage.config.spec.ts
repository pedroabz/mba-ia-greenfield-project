import storageConfig from './storage.config';

const ENV_KEYS = [
  'S3_ENDPOINT_INTERNAL',
  'S3_ENDPOINT_PUBLIC',
  'S3_REGION',
  'S3_BUCKET_VIDEOS',
  'S3_BUCKET_THUMBNAILS',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'PRESIGN_TTL_SECONDS',
] as const;

describe('storageConfig', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });

  it('should map every env key to the typed config object', () => {
    process.env.S3_ENDPOINT_INTERNAL = 'http://storage:9000';
    process.env.S3_ENDPOINT_PUBLIC = 'http://127.0.0.1:9000';
    process.env.S3_REGION = 'sa-east-1';
    process.env.S3_BUCKET_VIDEOS = 'videos-bucket';
    process.env.S3_BUCKET_THUMBNAILS = 'thumbs-bucket';
    process.env.S3_ACCESS_KEY_ID = 'ak';
    process.env.S3_SECRET_ACCESS_KEY = 'sk';
    process.env.S3_FORCE_PATH_STYLE = 'false';
    process.env.PRESIGN_TTL_SECONDS = '300';

    expect(storageConfig()).toEqual({
      endpointInternal: 'http://storage:9000',
      endpointPublic: 'http://127.0.0.1:9000',
      region: 'sa-east-1',
      bucketVideos: 'videos-bucket',
      bucketThumbnails: 'thumbs-bucket',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      forcePathStyle: false,
      presignTtlSeconds: 300,
    });
  });

  it('should keep the internal and public endpoints distinct', () => {
    process.env.S3_ENDPOINT_INTERNAL = 'http://minio:9000';
    process.env.S3_ENDPOINT_PUBLIC = 'http://localhost:9000';

    const config = storageConfig();

    expect(config.endpointInternal).not.toBe(config.endpointPublic);
  });

  it('should coerce S3_FORCE_PATH_STYLE to a boolean', () => {
    process.env.S3_FORCE_PATH_STYLE = 'true';
    expect(storageConfig().forcePathStyle).toBe(true);

    process.env.S3_FORCE_PATH_STYLE = 'false';
    expect(storageConfig().forcePathStyle).toBe(false);
  });

  it('should coerce PRESIGN_TTL_SECONDS to a number', () => {
    process.env.PRESIGN_TTL_SECONDS = '42';

    const { presignTtlSeconds } = storageConfig();

    expect(presignTtlSeconds).toBe(42);
    expect(typeof presignTtlSeconds).toBe('number');
  });

  it('should default forcePathStyle to true — MinIO requires path-style addressing', () => {
    expect(storageConfig().forcePathStyle).toBe(true);
  });

  it('should default presignTtlSeconds to 900', () => {
    expect(storageConfig().presignTtlSeconds).toBe(900);
  });
});
