import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FFMPEG_SKIP_REASON, describeWithFfmpeg } from './ffmpeg-available';
import { FfmpegService } from './ffmpeg.service';
import { ProcessFailedError, ProcessRunner } from './process-runner';

/**
 * Runs the REAL binaries. ffmpeg/ffprobe are installed only in the `video-worker`
 * image, so this suite must run inside that container — see
 * nestjs-project/CLAUDE.md § "Test execution".
 */
const FIXTURE = join(__dirname, '..', 'test', 'fixtures', 'sample.mp4');

describeWithFfmpeg(
  `FfmpegService (integration) — ${FFMPEG_SKIP_REASON}`,
  () => {
    const service = new FfmpegService(new ProcessRunner());
    let workDir: string;

    beforeAll(async () => {
      workDir = await fs.mkdtemp(join(tmpdir(), 'ffmpeg-spec-'));
    });

    afterAll(async () => {
      await fs.rm(workDir, { recursive: true, force: true });
    });

    it('should probe the committed fixture to its documented metadata', async () => {
      const metadata = await service.probe(FIXTURE);

      // These values are documented in src/test/fixtures/README.md and are the reason
      // the fixture is committed rather than generated at test time.
      expect(Number(metadata.duration_seconds)).toBeCloseTo(2.0, 2);
      expect(metadata.width).toBe(320);
      expect(metadata.height).toBe(240);
      expect(metadata.codec_name).toBe('h264');
      expect(metadata.container_format).toBe('mov,mp4,m4a,3gp,3g2,mj2');
      expect(metadata.size_bytes).toBe('15725');
      expect(metadata.bitrate_bps).not.toBeNull();
    });

    it('should extract a JPEG thumbnail from the fixture', async () => {
      const output = join(workDir, 'thumb.jpg');
      const metadata = await service.probe(FIXTURE);

      await service.extractThumbnail(
        FIXTURE,
        output,
        service.thumbnailOffset(metadata),
      );

      const bytes = await fs.readFile(output);
      expect(bytes.byteLength).toBeGreaterThan(0);
      // JPEG SOI marker — proves it is really a JPEG, not an empty or misencoded file.
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
    });

    it('should keep a thumbnail of a small video inside the 1280x720 box', async () => {
      const output = join(workDir, 'small.jpg');

      await service.extractThumbnail(FIXTURE, output, 0.2);

      // Probing the thumbnail itself is the only way to assert the scale filter was
      // applied rather than merely passed.
      const probed = await service.probe(output);
      expect(probed.width).toBeLessThanOrEqual(1280);
      expect(probed.height).toBeLessThanOrEqual(720);
      // Never upscaled: a 320x240 source stays 320x240 rather than becoming 960x720.
      expect(probed.width).toBe(320);
      expect(probed.height).toBe(240);
    });

    it('should fail with the binary stderr when the input is not a media file', async () => {
      const bogus = join(workDir, 'not-video.mp4');
      await fs.writeFile(bogus, 'this is not a container');

      // The stderr text is what ends up in `processing_error`, so it has to survive.
      await expect(service.probe(bogus)).rejects.toThrow(ProcessFailedError);
    });

    it('should reject when the input file does not exist', async () => {
      await expect(
        service.probe(join(workDir, 'missing.mp4')),
      ).rejects.toThrow();
    });

    it('should abort a run when the signal fires', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        service.probe(FIXTURE, { signal: controller.signal }),
      ).rejects.toThrow();
    });

    it('should not interpret a hostile filename through a shell', async () => {
      // `spawn` is called without `shell`, so this path is a filename, not a command.
      // If a shell were involved, the `touch` would run and the probe error would be
      // about a different file.
      const canary = join(workDir, 'canary');
      const hostile = join(workDir, `x; touch ${canary}`);

      await expect(service.probe(hostile)).rejects.toThrow();

      await expect(fs.access(canary)).rejects.toThrow();
    });
  },
);
