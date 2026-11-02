/**
 * Fixed multipart part size. Derived with headroom against S3's hard limits, which
 * constrain the whole upload design (per phase-03-videos/TD-03):
 *
 * - maximum 10,000 parts per upload
 * - part size 5 MiB–5 GiB, with no minimum on the last part
 * - `ListParts` is paginated at 1,000 parts per request
 *
 * At 8 MiB a 10 GiB file is 1,280 parts — comfortably inside the 10,000 ceiling
 * (this part size would carry a 78 GiB file). The size is deliberately FIXED and
 * not computed per upload: resume works by skipping already-uploaded parts, which
 * is only correct if part boundaries are reproducible.
 */
export const PART_SIZE_BYTES = 8 * 1024 * 1024;

/** S3's hard ceiling on parts per multipart upload. */
export const S3_MAX_PARTS = 10_000;

/**
 * `ListParts` returns at most this many parts per request. A 10 GiB upload exceeds
 * one page, so resume MUST paginate — a single-page read would conclude that the
 * parts beyond 1,000 are missing and re-upload them.
 */
export const LIST_PARTS_PAGE_SIZE = 1_000;

/** Object key for a video's original file, inside the videos bucket. */
export const buildVideoKey = (videoId: string, extension: string): string =>
  `videos/${videoId}/original${extension}`;

/** Object key for a video's generated thumbnail, inside the thumbnails bucket. */
export const buildThumbnailKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;
