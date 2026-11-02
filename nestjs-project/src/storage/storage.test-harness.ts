import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

/**
 * Storage harness for integration suites, mirroring `src/test/mailpit.ts`: it talks
 * to the REAL service from Compose rather than simulating it (per
 * phase-03-videos/TD-15).
 *
 * Every suite gets its own key prefix. Integration suites share one storage service
 * and run serially under `--runInBand`, so without a per-suite prefix a suite that
 * writes `videos/.../original.mp4` would be visible to — and deleted by — the next
 * one. The prefix is what makes the teardown safe to run unconditionally.
 */

const endpoint = process.env.S3_ENDPOINT_INTERNAL ?? 'http://minio:9000';

const client = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'streamtube',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'streamtube',
  },
});

export const BUCKET_VIDEOS =
  process.env.S3_BUCKET_VIDEOS ?? 'streamtube-videos';
export const BUCKET_THUMBNAILS =
  process.env.S3_BUCKET_THUMBNAILS ?? 'streamtube-thumbnails';

const BUCKETS = [BUCKET_VIDEOS, BUCKET_THUMBNAILS];

export interface TestStorage {
  /** Prefix owned by this suite. Every key it produces lives under it. */
  readonly prefix: string;
  /** A key under this suite's prefix. */
  key(name: string): string;
  put(bucket: string, key: string, body: Buffer | string): Promise<void>;
  /**
   * Removes one object by absolute key. Needed because the keys the APPLICATION
   * generates (`videos/<uuid>/original.mp4`) are server-authoritative and therefore
   * live outside this suite's prefix, so `cleanup()` cannot reach them.
   */
  remove(bucket: string, key: string): Promise<void>;
  /** Byte length of a stored object, or `null` when absent. */
  size(bucket: string, key: string): Promise<number | null>;
  /** Content type the SERVER recorded for the object — not what the row claims. */
  contentType(bucket: string, key: string): Promise<string | null>;
  list(bucket: string): Promise<string[]>;
  /**
   * Opens a multipart upload and returns its UploadId. Multipart uploads are
   * invisible to `ListObjectsV2`, so a suite that needs to assert on orphan cleanup
   * has to create and inspect them through these three methods.
   */
  startMultipart(bucket: string, key: string): Promise<string>;
  /** UploadIds of every in-flight multipart upload under this suite's prefix. */
  listMultipartUploads(bucket: string): Promise<string[]>;
  abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
  /** Removes every object AND every in-flight multipart upload under the prefix. */
  cleanup(): Promise<void>;
}

/**
 * @param suite short, stable label for the suite (e.g. `'videos-service'`). It only
 *   makes the prefix readable when inspecting the bucket; a random segment is always
 *   appended so two runs of the same suite cannot collide either.
 */
export function createTestStorage(suite: string): TestStorage {
  const prefix = `test/${suite}/${randomUUID()}`;

  /**
   * In-flight multipart uploads under this suite's prefix.
   *
   * The `Prefix` parameter of `ListMultipartUploads` is **ignored by this MinIO
   * build** — it is echoed back in the response and the result set comes back empty
   * (verified empirically; see nestjs-project/CLAUDE.md § Video Infrastructure).
   * So the listing is unfiltered and the prefix is applied here, client-side.
   * Passing `Prefix` to the server instead makes every multipart cleanup a silent
   * no-op.
   */
  const listOwnUploads = async (
    bucket: string,
  ): Promise<{ key: string; uploadId: string }[]> => {
    const out = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket }),
    );
    return (out.Uploads ?? [])
      .filter((u) => u.Key?.startsWith(prefix) && u.UploadId)
      .map((u) => ({ key: u.Key as string, uploadId: u.UploadId as string }));
  };

  const cleanupBucket = async (bucket: string): Promise<void> => {
    // Objects. ListObjectsV2 is paginated, so follow the continuation token —
    // a single page would silently leave objects behind.
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const objects = (page.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k));

      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects.map((Key) => ({ Key })) },
          }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    // In-flight multipart uploads. These are invisible to ListObjectsV2 and this
    // MinIO build cannot expire them via a lifecycle rule, so a suite that creates
    // a multipart and never completes it would leak storage indefinitely
    // (see nestjs-project/CLAUDE.md § Video Infrastructure).
    for (const upload of await listOwnUploads(bucket)) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.key,
          UploadId: upload.uploadId,
        }),
      );
    }
  };

  return {
    prefix,

    key: (name: string) => `${prefix}/${name}`,

    async put(bucket, key, body) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
      );
    },

    async remove(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async size(bucket, key) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return head.ContentLength ?? null;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw error;
      }
    },

    async startMultipart(bucket, key) {
      const out = await client.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
      );
      if (!out.UploadId) {
        throw new Error(`Storage did not return an UploadId for ${key}`);
      }
      return out.UploadId;
    },

    async listMultipartUploads(bucket) {
      return (await listOwnUploads(bucket)).map((u) => u.uploadId);
    },

    async abortMultipart(bucket, key, uploadId) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    },

    async contentType(bucket, key) {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return head.ContentType ?? null;
    },

    async list(bucket) {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
      );
      return (page.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k));
    },

    async cleanup() {
      for (const bucket of BUCKETS) {
        await cleanupBucket(bucket);
      }
    },
  };
}

/** Releases the module-level client. Call from the last `afterAll` that uses it. */
export function destroyTestStorageClient(): void {
  client.destroy();
}
