import type { DataSource } from 'typeorm';
import { QueryFailedError } from 'typeorm';
import type { ChannelsService } from '../channels/channels.service';
import type { QueueService } from '../queue/queue.service';
import type { StorageService } from '../storage/storage.service';
import {
  UploadKeyMismatchException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import {
  PART_SIZE_BYTES,
  S3_MAX_PARTS,
  LIST_PARTS_PAGE_SIZE,
} from '../storage/storage.constants';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { extensionForContentType } from './videos.constants';
import { VideosService } from './videos.service';

const OWNER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';

/** Minimal Channel stub — only `user_id` is read by the ownership checks. */
const channelOf = (userId: string): Channel => ({ user_id: userId }) as Channel;

const slugCollision = (): QueryFailedError => {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(error, {
    code: '23505',
    detail: 'Key (slug)=(abcdefghijk) already exists.',
  });
  return error;
};

type Repo = {
  create: (entity: Partial<Video>) => Partial<Video>;
  save: jest.Mock<Promise<Partial<Video>>, [Partial<Video>?]>;
  findOne: jest.Mock<Promise<Partial<Video> | null>, [unknown?]>;
  update: jest.Mock<Promise<unknown>, [unknown?, unknown?]>;
};

describe('VideosService', () => {
  interface Overrides {
    save?: Repo['save'];
    findOne?: Repo['findOne'];
    update?: Repo['update'];
    channel?: { id: string; user_id: string } | null;
  }

  const build = (overrides: Overrides = {}) => {
    const save =
      overrides.save ??
      (jest.fn((entity: Partial<Video>) =>
        Promise.resolve({ ...entity }),
      ) as Repo['save']);
    const findOne = overrides.findOne ?? (jest.fn() as Repo['findOne']);
    const update = overrides.update ?? (jest.fn() as Repo['update']);

    const repository: Repo = {
      create: (entity: Partial<Video>) => entity,
      save,
      findOne,
      update,
    };

    // Each collaborator is narrowed to the surface VideosService actually calls,
    // then cast once at the constructor boundary. Typing the mocks rather than
    // reaching for `as any` is what lets the compiler catch a signature drift here.
    const dataSource = {
      getRepository: () => repository,
    } as unknown as DataSource;

    const channels = {
      findByUserId: jest.fn(() =>
        Promise.resolve(
          overrides.channel === undefined
            ? { id: CHANNEL_ID, user_id: OWNER_ID }
            : overrides.channel,
        ),
      ),
    };

    const storage = {
      bucketVideos: 'streamtube-videos',
      bucketThumbnails: 'streamtube-thumbnails',
      ttlSeconds: 900,
      presignUpload: jest.fn(() =>
        Promise.resolve('https://signed.example/url'),
      ),
      presignDownload: jest.fn(() =>
        Promise.resolve('https://signed.example/thumb'),
      ),
      headObject: jest.fn(),
    };

    const queue = { enqueueVideoProcessing: jest.fn() };

    return {
      service: new VideosService(
        dataSource,
        channels as unknown as ChannelsService,
        storage as unknown as StorageService,
        queue as unknown as QueueService,
      ),
      save,
      findOne,
      update,
      storage,
      queue,
      channels,
    };
  };

  const dto = {
    title: 'Meu vídeo',
    declared_size_bytes: 1_048_576,
    content_type: 'video/mp4',
  };

  describe('createDraft', () => {
    it('should answer with the fixed part size rather than one derived per upload', async () => {
      const { service } = build();

      const draft = await service.createDraft(OWNER_ID, dto);

      // Resume works by skipping already-uploaded parts, which is only correct if
      // part boundaries are reproducible — so the size must not vary per upload.
      expect(draft.part_size_bytes).toBe(PART_SIZE_BYTES);
    });

    it('should keep a 10 GiB upload well inside the 10,000-part ceiling', () => {
      const tenGiB = 10 * 1024 ** 3;

      const parts = Math.ceil(tenGiB / PART_SIZE_BYTES);

      expect(parts).toBe(1280);
      expect(parts).toBeLessThan(S3_MAX_PARTS);
      // …and past the ListParts page, which is why resume has to paginate.
      expect(parts).toBeGreaterThan(LIST_PARTS_PAGE_SIZE);
    });

    it('should derive the object key from the generated id, not from client input', async () => {
      const { service, save } = build();

      const draft = await service.createDraft(OWNER_ID, dto);

      expect(draft.uploadKey).toBe(`videos/${draft.id}/original.mp4`);
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ video_key: draft.uploadKey }),
      );
    });

    it('should persist the draft in status draft with the declared size as a string', async () => {
      const { service, save } = build();

      await service.createDraft(OWNER_ID, dto);

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.DRAFT,
          channel_id: CHANNEL_ID,
          // bigint columns round-trip as strings in TypeORM
          declared_size_bytes: '1048576',
          content_type: 'video/mp4',
        }),
      );
    });

    it('should generate an 11-character slug', async () => {
      const { service } = build();

      const draft = await service.createDraft(OWNER_ID, dto);

      expect(draft.slug).toHaveLength(11);
    });

    it('should retry with a fresh slug on a unique violation', async () => {
      const save: Repo['save'] = jest
        .fn<Promise<Partial<Video>>, [Partial<Video>?]>()
        .mockRejectedValueOnce(slugCollision())
        .mockImplementation((entity?: Partial<Video>) =>
          Promise.resolve({ ...entity }),
        );
      const { service } = build({ save });

      const draft = await service.createDraft(OWNER_ID, dto);

      expect(save).toHaveBeenCalledTimes(2);
      expect(draft.slug).toHaveLength(11);
      // The retry must not change the key — it is derived from the id, which is stable.
      const [first] = save.mock.calls[0] as [Partial<Video>];
      const [second] = save.mock.calls[1] as [Partial<Video>];
      expect(second.video_key).toBe(first.video_key);
      expect(second.slug).not.toBe(first.slug);
    });

    it('should propagate a unique violation on a column other than slug', async () => {
      const other = new QueryFailedError('INSERT', [], new Error('dup'));
      Object.assign(other, {
        code: '23505',
        detail: 'Key (id)=(x) already exists.',
      });
      const save: Repo['save'] = jest
        .fn<Promise<Partial<Video>>, [Partial<Video>?]>()
        .mockRejectedValue(other);
      const { service } = build({ save });

      await expect(service.createDraft(OWNER_ID, dto)).rejects.toBe(other);
    });

    it('should reject a user with no channel to own the draft', async () => {
      const { service } = build({ channel: null });

      await expect(service.createDraft(OWNER_ID, dto)).rejects.toThrow(
        VideoNotOwnedException,
      );
    });
  });

  describe('extensionForContentType', () => {
    it.each([
      ['video/mp4', '.mp4'],
      ['video/quicktime', '.mov'],
      ['video/x-matroska', '.mkv'],
      ['VIDEO/MP4', '.mp4'],
    ])('should map %s to %s', (contentType, expected) => {
      expect(extensionForContentType(contentType)).toBe(expected);
    });

    it('should fall back to .bin for an unknown type instead of rejecting', () => {
      // The key is only a storage path; the authoritative container format is what
      // ffprobe observes. No source asks for a format allowlist in this phase.
      expect(extensionForContentType('video/unknown-codec')).toBe('.bin');
    });
  });

  describe('reprocess', () => {
    const row = (status: VideoStatus): Partial<Video> => ({
      id: 'video-1',
      slug: 'abcdefghijk',
      status,
      video_bucket: 'streamtube-videos',
      video_key: 'videos/video-1/original.mp4',
      channel: channelOf(OWNER_ID),
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.READY])(
      'should refuse to reprocess a video in %s',
      async (status) => {
        const { service, queue } = build({
          findOne: jest.fn(() => Promise.resolve(row(status))),
        });

        await expect(
          service.reprocess(OWNER_ID, 'abcdefghijk'),
        ).rejects.toThrow(VideoInvalidStateException);
        // The guard must run before the enqueue — otherwise a `ready` video would
        // be re-processed and its metadata rewritten.
        expect(queue.enqueueVideoProcessing).not.toHaveBeenCalled();
      },
    );

    it('should reject a caller who does not own the video', async () => {
      const { service, queue } = build({
        findOne: jest.fn(() =>
          Promise.resolve({
            ...row(VideoStatus.ERROR),
            channel: channelOf('other'),
          }),
        ),
      });

      await expect(service.reprocess(OWNER_ID, 'abcdefghijk')).rejects.toThrow(
        VideoNotOwnedException,
      );
      expect(queue.enqueueVideoProcessing).not.toHaveBeenCalled();
    });

    it('should report an unknown slug as not found', async () => {
      const { service } = build({
        findOne: jest.fn(() => Promise.resolve(null)),
      });

      await expect(service.reprocess(OWNER_ID, 'abcdefghijk')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('findBySlug', () => {
    const row = (
      status: VideoStatus,
      overrides: Partial<Video> = {},
    ): Partial<Video> => ({
      id: 'video-1',
      slug: 'abcdefghijk',
      title: 'Meu vídeo',
      status,
      duration_seconds: null,
      width: null,
      height: null,
      codec_name: null,
      container_format: null,
      bitrate_bps: null,
      size_bytes: null,
      thumbnail_bucket: null,
      thumbnail_key: null,
      processing_error: null,
      processing_attempts: 0,
      channel: channelOf(OWNER_ID),
      ...overrides,
    });

    it('should serve a ready video to an anonymous caller', async () => {
      const { service } = build({
        findOne: jest.fn(() => Promise.resolve(row(VideoStatus.READY))),
      });

      const found = await service.findBySlug('abcdefghijk', null);

      expect(found.status).toBe(VideoStatus.READY);
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
      'should hide a %s video from an anonymous caller as NOT FOUND',
      async (status) => {
        const { service } = build({
          findOne: jest.fn(() => Promise.resolve(row(status))),
        });

        // 404 rather than 403 on purpose: a 403 would confirm the draft exists.
        await expect(service.findBySlug('abcdefghijk', null)).rejects.toThrow(
          VideoNotFoundException,
        );
      },
    );

    it('should hide a draft from an authenticated non-owner', async () => {
      const { service } = build({
        findOne: jest.fn(() => Promise.resolve(row(VideoStatus.DRAFT))),
      });

      await expect(service.findBySlug('abcdefghijk', 'other')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should show a draft to its owner', async () => {
      const { service } = build({
        findOne: jest.fn(() => Promise.resolve(row(VideoStatus.DRAFT))),
      });

      const found = await service.findBySlug('abcdefghijk', OWNER_ID);

      expect(found.status).toBe(VideoStatus.DRAFT);
      expect(found.duration_seconds).toBeNull();
      expect(found.thumbnail_url).toBeNull();
    });

    it('should emit the bigint and numeric columns as numbers, not strings', async () => {
      const { service } = build({
        findOne: jest.fn(() =>
          Promise.resolve(
            row(VideoStatus.READY, {
              duration_seconds: '12.500',
              bitrate_bps: '670000',
              size_bytes: '1048576',
              width: 1920,
              height: 1080,
            }),
          ),
        ),
      });

      const found = await service.findBySlug('abcdefghijk', null);

      // These columns round-trip as strings in TypeORM; a client polling for
      // duration should not have to parse one.
      expect(found.duration_seconds).toBe(12.5);
      expect(found.bitrate_bps).toBe(670000);
      expect(found.size_bytes).toBe(1048576);
    });

    it('should presign the thumbnail only once the worker has written it', async () => {
      const { service, storage } = build({
        findOne: jest.fn(() =>
          Promise.resolve(
            row(VideoStatus.READY, {
              thumbnail_bucket: 'streamtube-thumbnails',
              thumbnail_key: 'videos/video-1/thumbnail.jpg',
            }),
          ),
        ),
      });
      storage.presignDownload = jest.fn(() =>
        Promise.resolve('https://signed/thumb.jpg'),
      );

      const found = await service.findBySlug('abcdefghijk', null);

      expect(found.thumbnail_url).toBe('https://signed/thumb.jpg');
      expect(storage.presignDownload).toHaveBeenCalledWith(
        'streamtube-thumbnails',
        'videos/video-1/thumbnail.jpg',
      );
    });

    it('should surface the failure reason on an error video', async () => {
      const { service } = build({
        findOne: jest.fn(() =>
          Promise.resolve(
            row(VideoStatus.ERROR, {
              processing_error: 'ffprobe exited with code 1',
              processing_attempts: 3,
            }),
          ),
        ),
      });

      const found = await service.findBySlug('abcdefghijk', OWNER_ID);

      expect(found.processing_error).toBe('ffprobe exited with code 1');
      expect(found.processing_attempts).toBe(3);
    });

    it('should report an unknown slug as not found', async () => {
      const { service } = build({
        findOne: jest.fn(() => Promise.resolve(null)),
      });

      await expect(service.findBySlug('abcdefghijk', OWNER_ID)).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('signUpload', () => {
    const draftRow = (overrides: Partial<Video> = {}): Partial<Video> => ({
      id: 'video-1',
      slug: 'abcdefghijk',
      status: VideoStatus.DRAFT,
      video_bucket: 'streamtube-videos',
      video_key: 'videos/video-1/original.mp4',
      upload_id: null,
      channel: channelOf(OWNER_ID),
      ...overrides,
    });

    const signDto = {
      method: 'PUT' as const,
      key: 'videos/video-1/original.mp4',
      upload_id: 'upload-1',
      part_number: 3,
    };

    it('should reject a key that does not belong to the draft', async () => {
      const { service, storage } = build({
        findOne: jest.fn(() => Promise.resolve(draftRow())),
      });

      await expect(
        service.signUpload(OWNER_ID, 'video-1', {
          ...signDto,
          key: 'videos/someone-else/original.mp4',
        }),
      ).rejects.toThrow(UploadKeyMismatchException);

      // The guard must run BEFORE signing — otherwise the endpoint is an oracle
      // that will sign any key in the bucket.
      expect(storage.presignUpload).not.toHaveBeenCalled();
    });

    it('should sign the stored key and answer with the configured TTL', async () => {
      const { service, storage } = build({
        findOne: jest.fn(() => Promise.resolve(draftRow())),
      });

      const signed = await service.signUpload(OWNER_ID, 'video-1', signDto);

      expect(signed).toEqual({
        url: 'https://signed.example/url',
        expires_in: 900,
      });
      expect(storage.presignUpload).toHaveBeenCalledWith({
        bucket: 'streamtube-videos',
        key: 'videos/video-1/original.mp4',
        method: 'PUT',
        uploadId: 'upload-1',
        partNumber: 3,
        partNumberMarker: undefined,
      });
    });

    it('should forward the ListParts continuation token', async () => {
      const { service, storage } = build({
        findOne: jest.fn(() => Promise.resolve(draftRow())),
      });

      await service.signUpload(OWNER_ID, 'video-1', {
        method: 'GET',
        key: 'videos/video-1/original.mp4',
        upload_id: 'upload-1',
        part_number_marker: '1000',
      });

      expect(storage.presignUpload).toHaveBeenCalledWith(
        expect.objectContaining({ partNumberMarker: '1000' }),
      );
    });

    it('should record the upload id so a resume can list parts without it', async () => {
      const update = jest.fn();
      const { service } = build({
        findOne: jest.fn(() => Promise.resolve(draftRow())),
        update,
      });

      await service.signUpload(OWNER_ID, 'video-1', signDto);

      expect(update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { upload_id: 'upload-1' },
      );
    });

    it('should not rewrite an upload id that is already stored', async () => {
      const update = jest.fn();
      const { service } = build({
        findOne: jest.fn(() =>
          Promise.resolve(draftRow({ upload_id: 'upload-1' })),
        ),
        update,
      });

      await service.signUpload(OWNER_ID, 'video-1', signDto);

      expect(update).not.toHaveBeenCalled();
    });

    it('should reject a caller who does not own the draft channel', async () => {
      const { service } = build({
        findOne: jest.fn(() =>
          Promise.resolve(draftRow({ channel: channelOf('other') })),
        ),
      });

      await expect(
        service.signUpload(OWNER_ID, 'video-1', signDto),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('should report a missing video as not found', async () => {
      const { service } = build({
        findOne: jest.fn(() => Promise.resolve(null)),
      });

      await expect(
        service.signUpload(OWNER_ID, 'video-1', signDto),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.ERROR])(
      'should refuse to sign while the video is %s',
      async (status) => {
        const { service } = build({
          findOne: jest.fn(() => Promise.resolve(draftRow({ status }))),
        });

        await expect(
          service.signUpload(OWNER_ID, 'video-1', signDto),
        ).rejects.toThrow(VideoInvalidStateException);
      },
    );
  });
});
