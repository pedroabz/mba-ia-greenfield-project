import {
  UnsatisfiableRangeError,
  attachmentDisposition,
  resolveRange,
} from './range.util';

const TOTAL = 10_000;

describe('resolveRange', () => {
  describe('ranges that must be honoured', () => {
    it('should resolve a closed range', () => {
      expect(resolveRange('bytes=0-1023', TOTAL)).toEqual({
        start: 0,
        end: 1023,
        length: 1024,
        contentRange: 'bytes 0-1023/10000',
      });
    });

    it('should treat the range as inclusive on both ends', () => {
      // `bytes=0-0` is one byte, not zero. Getting this wrong makes every
      // Content-Length off by one.
      expect(resolveRange('bytes=0-0', TOTAL)?.length).toBe(1);
      expect(resolveRange('bytes=10-19', TOTAL)?.length).toBe(10);
    });

    it('should read an open-ended range to the end of the object', () => {
      expect(resolveRange('bytes=9000-', TOTAL)).toEqual({
        start: 9000,
        end: 9999,
        length: 1000,
        contentRange: 'bytes 9000-9999/10000',
      });
    });

    it('should resolve the suffix form to the last N bytes', () => {
      // Players use `bytes=-N` to read the moov atom of a non-faststart MP4, which
      // lives at the END of the file.
      expect(resolveRange('bytes=-500', TOTAL)).toEqual({
        start: 9500,
        end: 9999,
        length: 500,
        contentRange: 'bytes 9500-9999/10000',
      });
    });

    it('should clamp a suffix longer than the object to the whole object', () => {
      expect(resolveRange('bytes=-99999', TOTAL)).toEqual({
        start: 0,
        end: 9999,
        length: TOTAL,
        contentRange: 'bytes 0-9999/10000',
      });
    });

    it('should clamp an end past the object instead of rejecting', () => {
      // RFC 9110: a range that partly overlaps is satisfiable for the overlap.
      expect(resolveRange('bytes=9990-99999', TOTAL)).toEqual({
        start: 9990,
        end: 9999,
        length: 10,
        contentRange: 'bytes 9990-9999/10000',
      });
    });

    it('should tolerate surrounding whitespace', () => {
      expect(resolveRange('  bytes=0-9  ', TOTAL)?.length).toBe(10);
    });

    it('should cover the whole object when asked for exactly that', () => {
      expect(resolveRange('bytes=0-9999', TOTAL)?.length).toBe(TOTAL);
    });
  });

  describe('headers to ignore (answer 200 with the full body)', () => {
    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['a non-bytes unit', 'items=0-10'],
      ['a multipart range', 'bytes=0-99,200-299'],
      ['garbage', 'bytes=abc-def'],
      ['a bare dash', 'bytes=-'],
      ['no unit at all', '0-1023'],
    ])('should return null for %s', (_label, header) => {
      // RFC 9110 says an unparseable Range is IGNORED, not a 416.
      expect(resolveRange(header, TOTAL)).toBeNull();
    });
  });

  describe('ranges that must become a 416', () => {
    it('should reject a start at or past the object size', () => {
      expect(() => resolveRange(`bytes=${TOTAL}-`, TOTAL)).toThrow(
        UnsatisfiableRangeError,
      );
      expect(() => resolveRange('bytes=20000-20100', TOTAL)).toThrow(
        UnsatisfiableRangeError,
      );
    });

    it('should reject an inverted range', () => {
      expect(() => resolveRange('bytes=500-100', TOTAL)).toThrow(
        UnsatisfiableRangeError,
      );
    });

    it('should reject a zero-length suffix', () => {
      expect(() => resolveRange('bytes=-0', TOTAL)).toThrow(
        UnsatisfiableRangeError,
      );
    });

    it('should reject any range against an empty object', () => {
      expect(() => resolveRange('bytes=0-10', 0)).toThrow(
        UnsatisfiableRangeError,
      );
    });

    it('should carry the offending header on the error', () => {
      expect(() => resolveRange('bytes=500-100', TOTAL)).toThrow(
        /bytes=500-100/,
      );
    });
  });
});

describe('attachmentDisposition', () => {
  it('should name the file after the slug, keeping the stored extension', () => {
    expect(
      attachmentDisposition('abcdefghijk', 'videos/some-uuid/original.mp4'),
    ).toBe('attachment; filename="abcdefghijk.mp4"');
  });

  it.each([
    ['videos/x/original.mov', '.mov'],
    ['videos/x/original.webm', '.webm'],
    ['videos/x/original.bin', '.bin'],
  ])('should carry the extension of %s', (key, extension) => {
    expect(attachmentDisposition('slug1234567', key)).toBe(
      `attachment; filename="slug1234567${extension}"`,
    );
  });

  it('should omit the extension when the key has none', () => {
    expect(attachmentDisposition('abcdefghijk', 'videos/x/original')).toBe(
      'attachment; filename="abcdefghijk"',
    );
  });

  it('should not treat a dot in a directory name as the extension', () => {
    expect(attachmentDisposition('abcdefghijk', 'videos/v1.2/original')).toBe(
      'attachment; filename="abcdefghijk"',
    );
  });
});
