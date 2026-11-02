import { CreateMultipartUploadCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Exercises the real storage service from the Compose stack — presigning, ranged
 * reads and the multipart APIs the reaper depends on. Mirrors the `mailpit`
 * precedent: no fakes for anything the infrastructure can actually run
 * (per phase-03-videos/TD-15).
 */
describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  let prefix: string;
  let client: S3Client;

  const startMultipart = async (key: string): Promise<string> => {
    const out = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: storage.bucketVideos,
        Key: key,
      }),
    );
    return out.UploadId as string;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storage = moduleRef.get(StorageService);
    // Per-suite key prefix so parallel-ish suites never collide on object names.
    prefix = `itest/${randomUUID()}`;

    // Stands in for the browser client that really drives multipart. Points at the
    // INTERNAL endpoint because this suite runs inside the container, where the
    // public endpoint (localhost:9000) resolves to the container itself.
    const cfg = storageConfig();
    client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpointInternal,
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  });

  afterAll(async () => {
    // Objects land under a per-suite `itest/<uuid>/` prefix, so they cannot collide
    // with another suite. Prefix teardown is SI-03.9's storage test helper.
    client?.destroy();
    await moduleRef?.close();
  });

  it('should round-trip putObject → headObject with the exact byte length', async () => {
    const key = `${prefix}/roundtrip.bin`;
    const body = Buffer.from('streamtube-storage-roundtrip');

    await storage.putObject(storage.bucketVideos, key, body, 'video/mp4');
    const head = await storage.headObject(storage.bucketVideos, key);

    expect(head).not.toBeNull();
    expect(head!.contentLength).toBe(body.byteLength);
    expect(head!.contentType).toBe('video/mp4');
  });

  it('should return null from headObject for a key that does not exist', async () => {
    const head = await storage.headObject(
      storage.bucketVideos,
      `${prefix}/definitely-absent.bin`,
    );

    expect(head).toBeNull();
  });

  it('should return only the requested byte range from getObjectStream', async () => {
    const key = `${prefix}/ranged.bin`;
    const body = Buffer.from('0123456789ABCDEF');
    await storage.putObject(storage.bucketVideos, key, body);

    const { stream, contentLength } = await storage.getObjectStream(
      storage.bucketVideos,
      key,
      { start: 4, end: 7 },
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const received = Buffer.concat(chunks);

    expect(received.toString()).toBe('4567');
    expect(contentLength).toBe(4);
  });

  it('should stream the whole object when no range is given', async () => {
    const key = `${prefix}/whole.bin`;
    const body = Buffer.from('0123456789ABCDEF');
    await storage.putObject(storage.bucketVideos, key, body);

    const { contentLength } = await storage.getObjectStream(
      storage.bucketVideos,
      key,
    );

    expect(contentLength).toBe(body.byteLength);
  });

  it('should sign upload URLs against the public endpoint, not the internal one', async () => {
    const config = storageConfig();
    const url = await storage.presignUpload({
      bucket: storage.bucketVideos,
      key: `${prefix}/presigned.bin`,
      method: 'POST',
    });

    const host = new URL(url).host;
    expect(host).toBe(new URL(config.endpointPublic).host);
    expect(host).not.toBe(new URL(config.endpointInternal).host);
    expect(url).toContain('X-Amz-Signature');
  });

  it('should write thumbnails to a different bucket than originals', async () => {
    const key = `${prefix}/thumb.jpg`;
    const body = Buffer.from('fake-jpeg-bytes');

    await storage.putObject(storage.bucketThumbnails, key, body, 'image/jpeg');

    const inThumbs = await storage.headObject(storage.bucketThumbnails, key);
    const inVideos = await storage.headObject(storage.bucketVideos, key);

    expect(inThumbs).not.toBeNull();
    expect(inVideos).toBeNull();
  });

  it('should list and abort a stale multipart upload', async () => {
    // This is the reaper's mechanism — the lifecycle rule TD-04 wanted is not
    // supported by this storage build (see nestjs-project/CLAUDE.md).
    const key = `${prefix}/orphan.bin`;
    const uploadId = await startMultipart(key);
    expect(uploadId).toBeTruthy();

    const future = new Date(Date.now() + 60_000);
    const stale = await storage.listStaleUploads(storage.bucketVideos, future);
    const mine = stale.find((u) => u.key === key);

    expect(mine).toBeDefined();
    expect(mine!.initiatedAt).toBeInstanceOf(Date);

    await storage.abortUpload(storage.bucketVideos, key, mine!.uploadId);

    const after = await storage.listStaleUploads(storage.bucketVideos, future);
    expect(after.find((u) => u.key === key)).toBeUndefined();
  });

  it('should not report a fresh upload as stale', async () => {
    const key = `${prefix}/fresh.bin`;
    const uploadId = await startMultipart(key);

    const past = new Date(Date.now() - 60_000);
    const stale = await storage.listStaleUploads(storage.bucketVideos, past);

    expect(stale.find((u) => u.key === key)).toBeUndefined();

    await storage.abortUpload(storage.bucketVideos, key, uploadId);
  });
});
