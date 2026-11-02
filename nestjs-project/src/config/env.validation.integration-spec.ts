import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT_INTERNAL: 'http://minio:9000',
  S3_ENDPOINT_PUBLIC: 'http://localhost:9000',
  S3_BUCKET_VIDEOS: 'streamtube-videos',
  S3_BUCKET_THUMBNAILS: 'streamtube-thumbnails',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

/** Joi types `value` as `any`; narrowing it keeps the assertions type-checked. */
type ValidatedEnv = Record<string, string | number | boolean | undefined>;

const validateTyped = (
  env: Record<string, string>,
): { value: ValidatedEnv; error?: { message: string } } =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as { value: ValidatedEnv; error?: { message: string } };

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validateTyped({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validateTyped({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validateTyped({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validateTyped({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — object storage keys', () => {
  it('should accept the full storage key set', () => {
    const { error } = validateTyped({});
    expect(error).toBeUndefined();
  });

  it.each([
    'S3_ENDPOINT_INTERNAL',
    'S3_ENDPOINT_PUBLIC',
    'S3_BUCKET_VIDEOS',
    'S3_BUCKET_THUMBNAILS',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ])('should reject a missing %s', (key) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];
    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject a non-URI endpoint', () => {
    const { error } = validateTyped({ S3_ENDPOINT_INTERNAL: 'not-a-uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT_INTERNAL');
  });

  it('should apply defaults for the optional storage keys', () => {
    const { value, error } = validateTyped({});
    expect(error).toBeUndefined();
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_FORCE_PATH_STYLE).toBe('true');
    expect(value.PRESIGN_TTL_SECONDS).toBe(900);
  });

  it('should reject a non-positive PRESIGN_TTL_SECONDS', () => {
    const { error } = validateTyped({ PRESIGN_TTL_SECONDS: '0' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('PRESIGN_TTL_SECONDS');
  });

  it('should not define an upload size limit key', () => {
    const { value } = validateTyped({});
    expect(value.UPLOAD_MAX_BYTES).toBeUndefined();
  });
});
