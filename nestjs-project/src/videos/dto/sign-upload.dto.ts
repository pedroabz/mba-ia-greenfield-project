import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { S3_MAX_PARTS } from '../../storage/storage.constants';

export const SIGNABLE_METHODS = ['GET', 'PUT', 'POST', 'DELETE'] as const;
export type SignableMethod = (typeof SIGNABLE_METHODS)[number];

export class SignUploadDto {
  @ApiProperty({ enum: SIGNABLE_METHODS })
  @IsIn(SIGNABLE_METHODS)
  method: SignableMethod;

  /** Untrusted. Validated against the draft's stored `video_key` before signing. */
  @ApiProperty({ example: 'videos/<uuid>/original.mp4' })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiPropertyOptional({
    description: 'Present for every multipart operation after creation',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  upload_id?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: S3_MAX_PARTS })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(S3_MAX_PARTS)
  part_number?: number;

  /**
   * `ListParts` continuation token. Required for resume: the API pages at 1,000
   * parts and a 10 GiB upload is ~1,280 parts, so a single-page read would conclude
   * the parts past 1,000 are missing and re-upload them (per TD-03).
   */
  @ApiPropertyOptional({ description: 'ListParts continuation token' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  part_number_marker?: string;
}
