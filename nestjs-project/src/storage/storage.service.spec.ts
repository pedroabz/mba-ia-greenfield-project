import { execSync } from 'child_process';
import { join } from 'path';
import {
  LIST_PARTS_PAGE_SIZE,
  PART_SIZE_BYTES,
  S3_MAX_PARTS,
  buildThumbnailKey,
  buildVideoKey,
} from './storage.constants';

describe('storage object keys', () => {
  it('should build the original-video key under the video id prefix', () => {
    expect(buildVideoKey('abc-123', '.mp4')).toBe(
      'videos/abc-123/original.mp4',
    );
  });

  it('should build the thumbnail key under the same video id prefix', () => {
    expect(buildThumbnailKey('abc-123')).toBe('videos/abc-123/thumbnail.jpg');
  });

  it('should key on the video id, never on the public slug', () => {
    // The slug may change without orphaning objects (per phase-03-videos/TD-05).
    const videoId = '550e8400-e29b-41d4-a716-446655440000';
    expect(buildVideoKey(videoId, '.mkv')).toContain(videoId);
  });

  it('should place both keys under one shared per-video prefix', () => {
    // Delete-a-video is therefore a prefix delete (per phase-03-videos/TD-05).
    const videoId = 'v1';
    const prefix = `videos/${videoId}/`;
    expect(buildVideoKey(videoId, '.mp4').startsWith(prefix)).toBe(true);
    expect(buildThumbnailKey(videoId).startsWith(prefix)).toBe(true);
  });
});

describe('storage multipart constants', () => {
  it('should keep the fixed part size inside S3 limits', () => {
    // S3: part size must be >= 5 MiB (except the last part).
    expect(PART_SIZE_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(PART_SIZE_BYTES).toBeLessThanOrEqual(5 * 1024 * 1024 * 1024);
  });

  it('should carry a 10GB upload well inside the 10,000-part ceiling', () => {
    const tenGiB = 10 * 1024 * 1024 * 1024;
    const parts = Math.ceil(tenGiB / PART_SIZE_BYTES);
    expect(parts).toBeLessThan(S3_MAX_PARTS);
    expect(parts).toBe(1280);
  });

  it('should acknowledge that a 10GB upload exceeds one ListParts page', () => {
    // This is why resume must paginate (per phase-03-videos/TD-03).
    const tenGiB = 10 * 1024 * 1024 * 1024;
    const parts = Math.ceil(tenGiB / PART_SIZE_BYTES);
    expect(parts).toBeGreaterThan(LIST_PARTS_PAGE_SIZE);
  });
});

describe('storage encapsulation', () => {
  it('should be the only module importing the AWS SDK', () => {
    // phase-03-videos/TD-02: no module outside src/storage imports @aws-sdk/* —
    // that is what keeps the MinIO→S3 swap a pure configuration change.
    const srcDir = join(__dirname, '..');
    const hits = execSync(
      `grep -rl "@aws-sdk/" "${srcDir}" --include=*.ts || true`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(`${srcDir}/`, ''))
      .filter((p) => !p.startsWith('storage/'));

    // No exemptions. The integration-test harness needs the SDK too (it drives the
    // real service), which is exactly why it lives at
    // `storage/storage.test-harness.ts` rather than under `src/test/` — keeping
    // this rule a single unqualified assertion instead of a list of exceptions.
    expect(hits).toEqual([]);
  });
});
