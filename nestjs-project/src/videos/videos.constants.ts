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

/**
 * Rate limit for `POST /videos/{id}/upload/sign`, sized from the phase requirement
 * rather than inherited.
 *
 * The inherited global limit is 10 requests / 60s (ThrottlerGuard registered as
 * APP_GUARD in AuthModule). Signing happens **once per part**, so a 10 GiB upload
 * needs 1,280 part signatures plus create, complete and two ListParts pages —
 * 1,284 calls. Under the global limit the largest upload that completes at all is
 * 80 MiB, and a 10 GiB one would spend ~128 minutes purely waiting on 429s.
 * Verified empirically: a real 1,280-part upload died at part 10.
 *
 * Not `@SkipThrottle`: the endpoint mints signed URLs, so an unbounded signing
 * oracle is worse than a generously bounded one. The limit admits a full 10 GiB
 * upload in one burst and nothing more.
 */
export const SIGN_RATE_LIMIT = { limit: 2000, ttl: 60_000 } as const;
