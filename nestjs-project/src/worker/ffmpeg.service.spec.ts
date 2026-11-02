import { FfmpegService } from './ffmpeg.service';
import type { ProcessRunner, RunOptions } from './process-runner';
import {
  FFMPEG_BIN,
  FFMPEG_TIMEOUT_MS,
  FFPROBE_BIN,
  THUMBNAIL_POSITION_RATIO,
} from './worker.constants';

const probeJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: {
      duration: '12.500000',
      size: '1048576',
      bit_rate: '670000',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
    streams: [
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    ],
    ...overrides,
  });

describe('FfmpegService', () => {
  type RunMock = jest.Mock<
    Promise<{ stdout: string; stderr: string }>,
    [string, string[], RunOptions?]
  >;

  const build = (stdout = probeJson()) => {
    // Explicit tuple params are what make `run.mock.calls[0][n]` typed instead of
    // `any` — the assertions below index into the recorded argv.
    // Double cast: the mock ignores its arguments, but RunMock declares the tuple
    // so `run.mock.calls[0][n]` is typed where the assertions index into it.
    const run = jest.fn(() =>
      Promise.resolve({ stdout, stderr: '' }),
    ) as unknown as RunMock;
    const runner = { run } as unknown as ProcessRunner;
    return { service: new FfmpegService(runner), run };
  };

  const argvOf = (run: RunMock): string[] => run.mock.calls[0][1];
  const optionsOf = (run: RunMock): RunOptions =>
    run.mock.calls[0][2] as RunOptions;
  const binOf = (run: RunMock): string => run.mock.calls[0][0];

  describe('probe', () => {
    it('should read every field in a single ffprobe invocation', async () => {
      const { service, run } = build();

      await service.probe('/tmp/source');

      // One call, not one per field: a call per field would re-open and re-demux
      // the file each time (per TD-09 revision).
      expect(run).toHaveBeenCalledTimes(1);
      expect(binOf(run)).toBe(FFPROBE_BIN);
      expect(argvOf(run)).toEqual([
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '/tmp/source',
      ]);
    });

    it('should map the seven metadata columns from the probe output', async () => {
      const { service } = build();

      expect(await service.probe('/tmp/source')).toEqual({
        duration_seconds: '12.500000',
        width: 1920,
        height: 1080,
        codec_name: 'h264',
        container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate_bps: '670000',
        size_bytes: '1048576',
      });
    });

    it('should take dimensions from the video stream, not from streams[0]', async () => {
      // The fixture above puts an audio stream first on purpose — reading
      // streams[0] would yield null dimensions for a perfectly valid video.
      const { service } = build();

      const metadata = await service.probe('/tmp/source');

      expect(metadata.width).toBe(1920);
      expect(metadata.codec_name).toBe('h264');
    });

    it('should leave absent fields NULL rather than failing the job', async () => {
      const { service } = build(
        JSON.stringify({ format: { duration: '3.0' }, streams: [] }),
      );

      expect(await service.probe('/tmp/source')).toEqual({
        duration_seconds: '3.0',
        width: null,
        height: null,
        codec_name: null,
        container_format: null,
        bitrate_bps: null,
        size_bytes: null,
      });
    });

    it('should treat the literal "N/A" as NULL', async () => {
      // ffprobe emits this string for fields it could not determine; storing it
      // verbatim would put "N/A" in a numeric-ish column.
      const { service } = build(
        JSON.stringify({
          format: { duration: 'N/A', bit_rate: 'N/A' },
          streams: [],
        }),
      );

      const metadata = await service.probe('/tmp/source');

      expect(metadata.duration_seconds).toBeNull();
      expect(metadata.bitrate_bps).toBeNull();
    });

    it('should fail when the output is not JSON at all', async () => {
      const { service } = build('not json');

      await expect(service.probe('/tmp/source')).rejects.toThrow(/JSON/);
    });

    it('should forward the abort signal and timeout to the runner', async () => {
      const { service, run } = build();
      const controller = new AbortController();

      await service.probe('/tmp/source', {
        signal: controller.signal,
        timeoutMs: 1234,
      });

      expect(optionsOf(run)).toEqual({
        signal: controller.signal,
        timeoutMs: 1234,
      });
    });
  });

  describe('extractThumbnail', () => {
    it('should place -ss BEFORE -i so seeking does not decode the whole file', async () => {
      const { service, run } = build();

      await service.extractThumbnail('/tmp/source', '/tmp/thumb.jpg', 1.25);

      const argv = argvOf(run);
      // THE load-bearing assertion of this SI: with -ss after -i, ffmpeg decodes and
      // discards every frame up to the timestamp, which on a 10 GB file is the
      // difference between instant and minutes (per TD-10).
      expect(argv.indexOf('-ss')).toBeLessThan(argv.indexOf('-i'));
      expect(argv[argv.indexOf('-ss') + 1]).toBe('1.250');
    });

    it('should omit -ss entirely at offset 0', async () => {
      const { service, run } = build();

      await service.extractThumbnail('/tmp/source', '/tmp/thumb.jpg', 0);

      // Input-seeking a stream with no container timestamps makes ffmpeg seek past
      // the whole input and write no output WHILE STILL EXITING 0 — verified
      // against a raw H.264 elementary stream. At offset 0 there is nothing to
      // seek to anyway.
      expect(argvOf(run)).not.toContain('-ss');
    });

    it('should still seek for a non-zero offset', async () => {
      const { service, run } = build();

      await service.extractThumbnail('/tmp/source', '/tmp/thumb.jpg', 4.2);

      const argv = argvOf(run);
      expect(argv).toContain('-ss');
      expect(argv.indexOf('-ss')).toBeLessThan(argv.indexOf('-i'));
      expect(argv[argv.indexOf('-ss') + 1]).toBe('4.200');
    });

    it('should request exactly one frame and write it as an image', async () => {
      const { service, run } = build();

      await service.extractThumbnail('/tmp/source', '/tmp/thumb.jpg', 0);

      const argv = argvOf(run);
      expect(binOf(run)).toBe(FFMPEG_BIN);
      expect(argv).toContain('-frames:v');
      expect(argv[argv.indexOf('-frames:v') + 1]).toBe('1');
      expect(argv[argv.length - 1]).toBe('/tmp/thumb.jpg');
    });

    it('should fit the frame inside 1280x720 without stretching it', async () => {
      const { service, run } = build();

      await service.extractThumbnail('/tmp/source', '/tmp/thumb.jpg', 0);

      const filter = argvOf(run)[argvOf(run).indexOf('-vf') + 1];
      expect(filter).toContain('force_original_aspect_ratio=decrease');
      // Capped at the SOURCE size: `decrease` on its own still upscales, which
      // would blow a 320x240 frame up to 960x720 for no added detail.
      expect(filter).toContain("w='min(1280,iw)'");
      expect(filter).toContain("h='min(720,ih)'");
      // Even dimensions — the JPEG encoder's chroma subsampling requires them.
      expect(filter).toContain('trunc(iw/2)*2:trunc(ih/2)*2');
    });

    it('should pass argv as an array so no shell can interpret a filename', async () => {
      const { service, run } = build();

      await service.extractThumbnail('/tmp/a; rm -rf /', '/tmp/thumb.jpg', 0);

      const argv = argvOf(run);
      expect(Array.isArray(argv)).toBe(true);
      // The whole hostile path arrives as ONE argv element — never concatenated
      // into a command string (per TD-09).
      expect(argv).toContain('/tmp/a; rm -rf /');
    });

    it('should forward an abort signal', async () => {
      const { service, run } = build();
      const controller = new AbortController();

      await service.extractThumbnail('/tmp/source', '/tmp/thumb.jpg', 0, {
        signal: controller.signal,
      });

      expect(optionsOf(run).signal).toBe(controller.signal);
    });
  });

  describe('thumbnailOffset', () => {
    const metadata = (duration: string | null) =>
      ({ duration_seconds: duration }) as never;

    it('should seek to 10% of the duration', () => {
      const { service } = build();

      expect(service.thumbnailOffset(metadata('100'))).toBe(
        100 * THUMBNAIL_POSITION_RATIO,
      );
    });

    it.each([null, '0', 'N/A'])(
      'should fall back to 0 when duration is %s',
      (duration) => {
        const { service } = build();

        expect(service.thumbnailOffset(metadata(duration))).toBe(0);
      },
    );
  });

  it('should default the runner timeout rather than leave it unbounded', () => {
    // A hung ffmpeg would otherwise hold the worker's concurrency slot forever.
    expect(FFMPEG_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
