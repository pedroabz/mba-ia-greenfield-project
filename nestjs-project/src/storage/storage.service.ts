import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Readable } from 'stream';
import storageConfig from '../config/storage.config';
import { LIST_PARTS_PAGE_SIZE } from './storage.constants';

/**
 * One presignable S3 operation. The shape mirrors the request body of
 * `POST /videos/{id}/upload/sign` verbatim, so the controller forwards it without
 * reshaping (per phase-03-videos/TD-03).
 */
export interface PresignUploadInput {
  bucket: string;
  key: string;
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  uploadId?: string;
  partNumber?: number;
  partNumberMarker?: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType?: string;
}

export interface StaleUpload {
  key: string;
  uploadId: string;
  initiatedAt: Date;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  /** Used for every server-side operation; reaches storage over the Docker network. */
  private readonly internal: S3Client;
  /**
   * Used ONLY to sign URLs handed to callers outside the Docker network. SigV4 signs
   * the `host` header, so a URL signed against the internal endpoint cannot be used
   * from the host — and the origin cannot be rewritten after the fact
   * (per phase-03-videos/TD-16).
   */
  private readonly presigner: S3Client;
  readonly ttlSeconds: number;

  readonly bucketVideos: string;
  readonly bucketThumbnails: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    const shared = {
      region: config.region,
      // Required by MinIO; harmless against real S3 (per phase-03-videos/TD-01).
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    };

    this.internal = new S3Client({
      ...shared,
      endpoint: config.endpointInternal,
    });
    this.presigner = new S3Client({
      ...shared,
      endpoint: config.endpointPublic,
    });
    this.ttlSeconds = config.presignTtlSeconds;
    this.bucketVideos = config.bucketVideos;
    this.bucketThumbnails = config.bucketThumbnails;
  }

  /**
   * Both S3 clients keep HTTP agents with pooled sockets alive. Without this the
   * process holds open handles after shutdown — which surfaces as Jest refusing to
   * exit after a suite, and as a leak in production on redeploy.
   */
  onModuleDestroy(): void {
    this.internal.destroy();
    this.presigner.destroy();
  }

  /**
   * Presigns one multipart operation. Dispatch mirrors the S3 multipart choreography:
   * POST without uploadId creates, PUT uploads a part, GET lists parts, POST with
   * uploadId completes, DELETE aborts.
   */
  async presignUpload(input: PresignUploadInput): Promise<string> {
    const { bucket: Bucket, key: Key, uploadId: UploadId } = input;

    // getSignedUrl is generic over one concrete command type, so it is called per
    // branch rather than over a union of commands.
    const opts = { expiresIn: this.ttlSeconds };

    switch (input.method) {
      case 'POST':
        return UploadId
          ? getSignedUrl(
              this.presigner,
              new CompleteMultipartUploadCommand({ Bucket, Key, UploadId }),
              opts,
            )
          : getSignedUrl(
              this.presigner,
              new CreateMultipartUploadCommand({ Bucket, Key }),
              opts,
            );
      case 'PUT':
        return getSignedUrl(
          this.presigner,
          new UploadPartCommand({
            Bucket,
            Key,
            UploadId: UploadId as string,
            PartNumber: input.partNumber as number,
          }),
          opts,
        );
      case 'GET':
        return getSignedUrl(
          this.presigner,
          new ListPartsCommand({
            Bucket,
            Key,
            UploadId: UploadId as string,
            MaxParts: LIST_PARTS_PAGE_SIZE,
            PartNumberMarker: input.partNumberMarker,
          }),
          opts,
        );
      case 'DELETE':
        return getSignedUrl(
          this.presigner,
          new AbortMultipartUploadCommand({
            Bucket,
            Key,
            UploadId: UploadId as string,
          }),
          opts,
        );
    }
  }

  /** Presigns a read. Only used for out-of-band access; playback is served by the API. */
  async presignDownload(bucket: string, key: string): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: this.ttlSeconds },
    );
  }

  /**
   * Returns the object's metadata, or `null` when it does not exist. Absence is a
   * valid domain answer here (the completion handshake asks "did the bytes land?"),
   * so it is not an error.
   */
  async headObject(bucket: string, key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.internal.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        contentLength: out.ContentLength ?? 0,
        contentType: out.ContentType,
      };
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Streams an object, optionally a byte range. The range is passed through to S3
   * rather than fetching the whole object and slicing (per phase-03-videos/TD-14).
   */
  async getObjectStream(
    bucket: string,
    key: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentType?: string;
  }> {
    const out = await this.internal.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );

    return {
      stream: out.Body as Readable,
      contentLength: out.ContentLength ?? 0,
      contentType: out.ContentType,
    };
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Enumerates multipart uploads that were initiated before `olderThan`. This is the
   * reaper's input: the storage build in use does not support the
   * AbortIncompleteMultipartUpload lifecycle rule, so orphan cleanup is done by a job
   * (see nestjs-project/CLAUDE.md § Video Infrastructure).
   */
  async listStaleUploads(
    bucket: string,
    olderThan: Date,
  ): Promise<StaleUpload[]> {
    const out = await this.internal.send(
      new ListMultipartUploadsCommand({ Bucket: bucket }),
    );

    return (out.Uploads ?? [])
      .filter(
        (u) => u.Key && u.UploadId && u.Initiated && u.Initiated < olderThan,
      )
      .map((u) => ({
        key: u.Key as string,
        uploadId: u.UploadId as string,
        initiatedAt: u.Initiated as Date,
      }));
  }

  async abortUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await this.internal.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  private isNotFound(error: unknown): boolean {
    const name = (error as { name?: string })?.name;
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
  }
}
