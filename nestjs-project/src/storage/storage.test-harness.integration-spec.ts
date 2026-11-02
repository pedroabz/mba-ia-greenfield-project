import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BUCKET_THUMBNAILS,
  BUCKET_VIDEOS,
  createTestStorage,
  destroyTestStorageClient,
} from './storage.test-harness';

describe('test storage helper (integration)', () => {
  afterAll(() => {
    destroyTestStorageClient();
  });

  it('should write and read back an object in each bucket', async () => {
    const storage = createTestStorage('helper-roundtrip');

    await storage.put(
      BUCKET_VIDEOS,
      storage.key('original.mp4'),
      'video-bytes',
    );
    await storage.put(
      BUCKET_THUMBNAILS,
      storage.key('thumbnail.jpg'),
      'thumb-bytes',
    );

    expect(await storage.size(BUCKET_VIDEOS, storage.key('original.mp4'))).toBe(
      11,
    );
    expect(
      await storage.size(BUCKET_THUMBNAILS, storage.key('thumbnail.jpg')),
    ).toBe(11);

    await storage.cleanup();
  });

  it('should report null for an absent key instead of throwing', async () => {
    const storage = createTestStorage('helper-absent');

    expect(
      await storage.size(BUCKET_VIDEOS, storage.key('nope.mp4')),
    ).toBeNull();
  });

  it('should leave both buckets empty of the suite prefix after cleanup', async () => {
    const storage = createTestStorage('helper-teardown');
    await storage.put(BUCKET_VIDEOS, storage.key('a.mp4'), 'a');
    await storage.put(BUCKET_THUMBNAILS, storage.key('a.jpg'), 'a');

    await storage.cleanup();

    expect(await storage.list(BUCKET_VIDEOS)).toEqual([]);
    expect(await storage.list(BUCKET_THUMBNAILS)).toEqual([]);
  });

  it('should isolate two suites that write the same object name', async () => {
    // This is the whole point of the prefix: two suites running back to back under
    // --runInBand must not see — or delete — each other's objects.
    const first = createTestStorage('helper-isolation');
    const second = createTestStorage('helper-isolation');

    await first.put(BUCKET_VIDEOS, first.key('original.mp4'), 'first');
    await second.put(
      BUCKET_VIDEOS,
      second.key('original.mp4'),
      'second-longer',
    );

    expect(first.prefix).not.toBe(second.prefix);

    await first.cleanup();

    // The first suite's teardown must not have touched the second's object.
    expect(await second.size(BUCKET_VIDEOS, second.key('original.mp4'))).toBe(
      13,
    );

    await second.cleanup();
  });

  it('should store the committed mp4 fixture at its documented byte length', async () => {
    const storage = createTestStorage('helper-fixture');
    const fixture = readFileSync(
      join(__dirname, '..', 'test', 'fixtures', 'sample.mp4'),
    );

    await storage.put(BUCKET_VIDEOS, storage.key('sample.mp4'), fixture);

    // Byte length is asserted here; duration/dimensions are asserted by the ffprobe
    // suite. Both numbers are documented in src/test/fixtures/README.md.
    expect(fixture.byteLength).toBe(15725);
    expect(await storage.size(BUCKET_VIDEOS, storage.key('sample.mp4'))).toBe(
      15725,
    );

    await storage.cleanup();
  });
});
