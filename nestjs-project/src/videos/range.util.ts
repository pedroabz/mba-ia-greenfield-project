/**
 * Minimal HTTP `Range` handling for a single byte range (per phase-03-videos/TD-14).
 *
 * Multipart ranges (`bytes=0-99,200-299`) are deliberately NOT supported: no video
 * player issues them, and answering `200` with the full body — which RFC 9110 allows
 * for any range a server chooses to ignore — is correct and simpler than emitting a
 * `multipart/byteranges` document.
 */

export interface ResolvedRange {
  start: number;
  end: number;
  /** Number of bytes in the range, i.e. the `Content-Length` of the 206. */
  length: number;
  /** Value for the `Content-Range` response header. */
  contentRange: string;
}

/** `Range` requested a region that does not overlap the object at all. */
export class UnsatisfiableRangeError extends Error {
  constructor(readonly header: string) {
    super(`Range "${header}" lies outside the object`);
    this.name = 'UnsatisfiableRangeError';
  }
}

const BYTES_UNIT = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolves a `Range` header against an object of `totalSize` bytes.
 *
 * Returns `null` when there is nothing to honour — header absent, a unit other than
 * `bytes`, a syntactically invalid value, or multiple ranges. The caller then answers
 * `200` with the whole body.
 *
 * Throws `UnsatisfiableRangeError` only for a *well-formed* range that cannot be
 * satisfied, which is the one case that must become a `416`. An unparseable header is
 * NOT a 416 — RFC 9110 says to ignore it.
 */
export function resolveRange(
  header: string | undefined,
  totalSize: number,
): ResolvedRange | null {
  if (!header) return null;

  const match = BYTES_UNIT.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;

  // An empty object can satisfy no range at all.
  if (totalSize <= 0) throw new UnsatisfiableRangeError(header);

  let start: number;
  let end: number;

  if (rawStart === '') {
    // Suffix form `bytes=-N`: the LAST n bytes. Players use it to read the moov atom
    // of a non-faststart MP4, which lives at the end of the file.
    if (rawEnd === '') return null;
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) throw new UnsatisfiableRangeError(header);
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    // An open-ended `bytes=N-` means "to the end of the object".
    end = rawEnd === '' ? totalSize - 1 : Number(rawEnd);
  }

  if (start >= totalSize) throw new UnsatisfiableRangeError(header);
  if (end < start) throw new UnsatisfiableRangeError(header);

  // Clamping rather than rejecting: a request past the end is satisfiable for the
  // part that does overlap, and RFC 9110 requires serving that part.
  end = Math.min(end, totalSize - 1);

  return {
    start,
    end,
    length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${totalSize}`,
  };
}

/** `Content-Disposition` for the download endpoint. */
export function attachmentDisposition(slug: string, videoKey: string): string {
  const extension = extensionOf(videoKey);
  return `attachment; filename="${slug}${extension}"`;
}

function extensionOf(key: string): string {
  const basename = key.slice(key.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot) : '';
}
