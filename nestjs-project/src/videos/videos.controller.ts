import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalUser } from '../auth/decorators/optional-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadDto } from './dto/sign-upload.dto';
import { VideoResponseDto, VideoStatusDto } from './dto/video-response.dto';
import { SlugParamPipe } from './pipes/slug-param.pipe';
import { SIGN_RATE_LIMIT } from './videos.constants';
import {
  VideosService,
  type CreatedDraft,
  type SignedOperation,
  type UploadCompletion,
} from './videos.service';

const envelope = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pre-register a video as a draft',
    description:
      'Creates the video row in `draft` and returns the authoritative object key the client must upload to. No bytes pass through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        uploadKey: { type: 'string' },
        part_size_bytes: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: envelope,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_NOT_OWNED — the user has no channel to own the draft',
    schema: envelope,
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreatedDraft> {
    return this.videos.createDraft(user.sub, dto);
  }

  @Post(':id/upload/sign')
  // Signing is once PER PART, so the inherited 10 req/60s limit caps uploads at
  // 80 MiB. See SIGN_RATE_LIMIT for the sizing and the empirical failure.
  @Throttle({ default: SIGN_RATE_LIMIT })
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign one S3 upload operation',
    description:
      'Signs exactly one operation — called once per CreateMultipartUpload, once per UploadPart, and again for ListParts / CompleteMultipartUpload / AbortMultipartUpload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expires_in: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: envelope,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'UPLOAD_KEY_MISMATCH or VIDEO_NOT_OWNED',
    schema: envelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: envelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_INVALID_STATE',
    schema: envelope,
  })
  async sign(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignUploadDto,
  ): Promise<SignedOperation> {
    return this.videos.signUpload(user.sub, id, dto);
  }

  @Post(':id/upload-complete')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the uploaded object and start processing',
    description:
      'Checks the stored object exists and matches the declared size, then transitions the video to `processing` and enqueues it. The transition is a conditional update, so a duplicated call cannot enqueue twice.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload accepted; processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_NOT_OWNED',
    schema: envelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: envelope,
  })
  @ApiResponse({
    status: 409,
    description:
      'UPLOAD_OBJECT_MISSING, UPLOAD_SIZE_MISMATCH or VIDEO_INVALID_STATE',
    schema: envelope,
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadCompletion> {
    return this.videos.completeUpload(user.sub, id);
  }

  // `@Public()` opts out of the global guard, but the guard still attaches the user
  // when a valid token is present — which is what lets a non-`ready` video be shown
  // to its OWNER while staying invisible to everyone else.
  /**
   * NOT throttled. `ThrottlerGuard` is registered as `APP_GUARD` (in AuthModule) and
   * is therefore APP-WIDE at 10 requests / 60s, despite the phase plan describing it
   * as AuthModule-scoped. At that limit both documented read behaviours break:
   * a player issues dozens of range requests per playback, and the OpenAPI polling
   * guidance of one poll every 3 seconds exceeds 10/min after half a minute.
   * Verified empirically — 30 of 40 range requests came back 429 before this.
   * The write routes stay throttled.
   */
  @Public()
  @SkipThrottle()
  @Get(':slug')
  @ApiOperation({
    summary: 'Read a video and its processing status',
    description: [
      'Open to anonymous callers once `status` is `ready`. While the video is in any',
      'other status it is visible only to its owner, and answers `404` to everyone',
      "else so a draft's existence is not disclosed.",
      '',
      '**Polling:** poll every 3 seconds while `status` is `draft` or `processing`.',
      '`ready` and `error` are terminal — stop polling when either is reached.',
      'On `error`, `processing_error` carries the reason and',
      '`POST /videos/{slug}/reprocess` is the recovery path.',
    ].join(' '),
  })
  @ApiResponse({
    status: 200,
    description: 'The video',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — unknown slug, or not `ready` and not the owner',
    schema: envelope,
  })
  async findOne(
    @OptionalUser() user: JwtPayload | null,
    @Param('slug', SlugParamPipe) slug: string,
  ): Promise<VideoResponseDto> {
    return this.videos.findBySlug(slug, user?.sub ?? null);
  }

  // Declared BEFORE `@Get(':slug')` would also work (the paths differ in segment
  // count), but keeping the delivery routes together reads better.
  @Public()
  @SkipThrottle()
  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Stream the video bytes',
    description:
      'Answers `206 Partial Content` for a `Range` request and `200` with the full body otherwise, so playback starts without downloading the whole file. The byte interval is pushed down to object storage — the API never buffers the object. Open to anonymous callers once the video is `ready`.',
  })
  @ApiHeader({
    name: 'Range',
    required: false,
    description:
      'e.g. `bytes=0-1023`. Suffix form `bytes=-N` is also supported.',
  })
  @ApiResponse({ status: 200, description: 'Full body (no Range header)' })
  @ApiResponse({
    status: 206,
    description: 'Partial content for the requested range',
  })
  @ApiResponse({ status: 400, description: 'Malformed slug', schema: envelope })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: envelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY — processing has not finished',
    schema: envelope,
  })
  @ApiResponse({
    status: 416,
    description: 'RANGE_NOT_SATISFIABLE — the range lies outside the object',
    schema: envelope,
  })
  async stream(
    @Param('slug', SlugParamPipe) slug: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.respondWithStream(slug, rangeHeader, response, false);
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/download')
  @ApiOperation({
    summary: 'Download the video file',
    description:
      'The same handler as `/stream`, differing only in `Content-Disposition: attachment`. Range requests are honoured here too, so an interrupted download can resume.',
  })
  @ApiHeader({ name: 'Range', required: false })
  @ApiResponse({ status: 200, description: 'Full body as an attachment' })
  @ApiResponse({
    status: 206,
    description: 'Partial content for the requested range',
  })
  @ApiResponse({ status: 400, description: 'Malformed slug', schema: envelope })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: envelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: envelope,
  })
  @ApiResponse({
    status: 416,
    description: 'RANGE_NOT_SATISFIABLE',
    schema: envelope,
  })
  async download(
    @Param('slug', SlugParamPipe) slug: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.respondWithStream(slug, rangeHeader, response, true);
  }

  /**
   * Shared body of both delivery routes. The status code and the range headers are
   * set here rather than by a decorator because they depend on whether the request
   * carried a usable `Range` — a fixed `@HttpCode` could not express both.
   */
  private async respondWithStream(
    slug: string,
    rangeHeader: string | undefined,
    response: Response,
    asAttachment: boolean,
  ): Promise<StreamableFile> {
    const result = await this.videos.openStream(slug, rangeHeader);

    // Advertised on EVERY response, including the 200 — it is how a player learns
    // it may seek at all.
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', result.contentType);

    if (asAttachment) {
      response.setHeader('Content-Disposition', result.disposition);
    }

    if (result.range) {
      response.status(HttpStatus.PARTIAL_CONTENT);
      response.setHeader('Content-Range', result.range.contentRange);
      response.setHeader('Content-Length', result.range.length);
    } else {
      response.setHeader('Content-Length', result.totalSize);
    }

    return new StreamableFile(result.stream);
  }

  @Post(':slug/reprocess')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-enqueue a video whose processing failed',
    description:
      'Valid only while `status` is `error`. The transition and the re-enqueue share one transaction, so a video in `processing` always has a job behind it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Re-enqueued',
    type: VideoStatusDto,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_NOT_OWNED',
    schema: envelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: envelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_INVALID_STATE — the video is not in `error`',
    schema: envelope,
  })
  async reprocess(
    @CurrentUser() user: JwtPayload,
    @Param('slug', SlugParamPipe) slug: string,
  ): Promise<UploadCompletion> {
    return this.videos.reprocess(user.sub, slug);
  }
}
