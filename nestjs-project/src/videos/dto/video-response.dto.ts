import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

/**
 * Projection of a video for the polling surface (per phase-03-videos/TD-12).
 *
 * The numeric metadata fields are emitted as JSON **numbers** even though their
 * columns are `bigint`/`numeric` and therefore round-trip as strings in TypeORM —
 * a client polling for `duration_seconds` should not have to parse a string.
 */
export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: '11-character public identifier' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({
    enum: VideoStatus,
    description:
      '`draft` and `processing` are transient; `ready` and `error` are terminal.',
  })
  status: VideoStatus;

  @ApiProperty({ type: Number, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({ type: String, nullable: true })
  codec_name: string | null;

  @ApiProperty({ type: String, nullable: true })
  container_format: string | null;

  @ApiProperty({ type: Number, nullable: true })
  bitrate_bps: number | null;

  @ApiProperty({ type: Number, nullable: true })
  size_bytes: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Presigned URL; null until the worker has written the thumbnail.',
  })
  thumbnail_url: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Populated only when `status` is `error`.',
  })
  processing_error: string | null;

  @ApiProperty()
  processing_attempts: number;
}

/** Answer of the two endpoints that only report a transition. */
export class VideoStatusDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;
}
