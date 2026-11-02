import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateVideoDto {
  @ApiProperty({ minLength: 1, maxLength: 255, example: 'Meu primeiro vídeo' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  /**
   * Deliberately has NO upper bound. The value is the comparand for the completion
   * integrity check, not a policy limit — no source requires an upload ceiling and
   * phase-03-videos/TD-06 was rejected on exactly that ground.
   */
  @ApiProperty({
    example: 1048576,
    description: 'Byte length of the file about to be uploaded',
  })
  @IsInt()
  @IsPositive()
  declared_size_bytes: number;

  @ApiProperty({ example: 'video/mp4' })
  @IsString()
  @IsNotEmpty()
  content_type: string;
}
