/** How many times slug generation retries a unique-constraint collision. */
export const SLUG_MAX_RETRIES = 5;

/** Length of the public slug — `nanoid(11)` (per phase-03-videos/TD-13). */
export const SLUG_LENGTH = 11;

/**
 * Extension written into the object key, by declared MIME type. The key is only a
 * storage path — the authoritative container format is what ffprobe observes and
 * records in `container_format`, so an unknown type falls back to `.bin` instead of
 * rejecting the upload (no source requires a format allowlist in this phase).
 */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpeg',
};

export const extensionForContentType = (contentType: string): string =>
  EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase().trim()] ?? '.bin';
