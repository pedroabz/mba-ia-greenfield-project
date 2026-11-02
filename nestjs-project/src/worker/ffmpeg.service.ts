import { Injectable, Logger } from '@nestjs/common';
import { ProcessRunner, type RunOptions } from './process-runner';
import {
  FFMPEG_BIN,
  FFPROBE_BIN,
  THUMBNAIL_FALLBACK_SECONDS,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_POSITION_RATIO,
  THUMBNAIL_WIDTH,
} from './worker.constants';

/**
 * The seven metadata columns of `videos`, in the shape they are persisted. Every
 * field is nullable: a field absent from the ffprobe output must persist as NULL
 * rather than fail the job (per phase-03-videos/TD-09 revision).
 */
export interface VideoMetadata {
  duration_seconds: string | null;
  width: number | null;
  height: number | null;
  codec_name: string | null;
  container_format: string | null;
  bitrate_bps: string | null;
  size_bytes: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: {
    duration?: string;
    size?: string;
    bit_rate?: string;
    format_name?: string;
  };
  streams?: FfprobeStream[];
}

@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  constructor(private readonly runner: ProcessRunner) {}

  /**
   * Reads every metadata field in ONE ffprobe call. Splitting it into a call per
   * field would re-open and re-demux the file each time (per TD-09 revision).
   */
  async probe(
    filePath: string,
    options: RunOptions = {},
  ): Promise<VideoMetadata> {
    const { stdout } = await this.runner.run(
      FFPROBE_BIN,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      options,
    );

    return this.toMetadata(this.parse(stdout));
  }

  /**
   * Writes one frame to `outputPath`.
   *
   * When seeking, `-ss` goes BEFORE `-i` (input seeking): ffmpeg jumps straight to
   * the keyframe and decodes from there, so the cost is independent of the file's
   * size. With `-ss` after `-i` (output seeking) ffmpeg decodes and discards
   * everything up to the timestamp, which on a 10 GB file is the difference between
   * instant and minutes (per phase-03-videos/TD-10).
   *
   * At offset 0 the flag is omitted entirely. There is nothing to seek to, and
   * input-seeking a stream with NO container timestamps (a raw elementary stream,
   * where ffprobe reports no duration) makes ffmpeg seek past the whole input and
   * write **no output while still exiting 0** — verified empirically. Omitting the
   * flag is both cheaper and the only form that works for those inputs.
   */
  async extractThumbnail(
    inputPath: string,
    outputPath: string,
    atSeconds: number,
    options: RunOptions = {},
  ): Promise<void> {
    await this.runner.run(
      FFMPEG_BIN,
      [
        '-y',
        '-v',
        'error',
        ...(atSeconds > 0 ? ['-ss', atSeconds.toFixed(3)] : []),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        // Fits the frame inside the box without stretching it, and never ENLARGES
        // it. `force_original_aspect_ratio=decrease` alone does not prevent
        // upscaling — it would blow a 320x240 source up to 960x720, producing a
        // blurrier and larger file for no added detail. The `min(…, iw/ih)` terms
        // are what cap it at the source size. They are single-quoted because a
        // bare comma separates FILTERS in a filtergraph; the quoting is the
        // filtergraph parser's, not a shell's (no shell is involved).
        '-vf',
        `scale=w='min(${THUMBNAIL_WIDTH},iw)':h='min(${THUMBNAIL_HEIGHT},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        '-f',
        'image2',
        outputPath,
      ],
      options,
    );
  }

  /** Seek offset for the thumbnail: ~10% in, or 0 when duration is unknown. */
  thumbnailOffset(metadata: VideoMetadata): number {
    const duration = Number(metadata.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      return THUMBNAIL_FALLBACK_SECONDS;
    }
    return duration * THUMBNAIL_POSITION_RATIO;
  }

  private parse(stdout: string): FfprobeOutput {
    try {
      return JSON.parse(stdout) as FfprobeOutput;
    } catch {
      // A probe that produced unparseable output is a genuine failure — it means the
      // file is not a media container at all.
      this.logger.error('ffprobe produced output that is not JSON');
      throw new Error('ffprobe output could not be parsed as JSON');
    }
  }

  private toMetadata(probe: FfprobeOutput): VideoMetadata {
    // First VIDEO stream, not `streams[0]` — an audio-first mux would otherwise
    // yield null dimensions for a perfectly valid video.
    const video = (probe.streams ?? []).find((s) => s.codec_type === 'video');

    return {
      duration_seconds: this.asString(probe.format?.duration),
      width: this.asNumber(video?.width),
      height: this.asNumber(video?.height),
      codec_name: this.asString(video?.codec_name),
      container_format: this.asString(probe.format?.format_name),
      bitrate_bps: this.asString(probe.format?.bit_rate),
      size_bytes: this.asString(probe.format?.size),
    };
  }

  private asString(value: string | number | undefined): string | null {
    if (value === undefined || value === null || value === '') return null;
    // ffprobe emits the literal string "N/A" for fields it could not determine.
    if (value === 'N/A') return null;
    return String(value);
  }

  private asNumber(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}
