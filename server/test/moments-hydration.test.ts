import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.sequential('late Moments media hydration', () => {
  let root: string;
  let db: typeof import('../src/db/database.js')['databaseManager'];
  let repos: typeof import('../src/db/repositories.js');
  let gallery: typeof import('../src/services/gallery-service.js')['galleryService'];
  let storage: typeof import('../src/services/storage-service.js')['storageService'];
  let serial = 0;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moments-hydration-'));
    vi.stubEnv('NODE_ENV', 'test');
    for (const key of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      const directory = path.join(root, key);
      await fs.mkdir(directory, { recursive: true });
      vi.stubEnv(key, directory);
    }
    vi.resetModules();
    ({ databaseManager: db } = await import('../src/db/database.js'));
    repos = await import('../src/db/repositories.js');
    ({ galleryService: gallery } = await import('../src/services/gallery-service.js'));
    ({ storageService: storage } = await import('../src/services/storage-service.js'));
  });
  beforeEach(() => {
    repos.maintenanceRepository.resetLibraryIndex();
    serial = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 31, 12));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => {
    db?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  function fixture(source: 'mtime' | 'exif' = 'mtime') {
    const ids: number[] = [];
    for (let group = 0; group < 4; group++) {
      const owner = repos.folderRepository.upsert({ slug: `owner-${group}`, name: `Owner ${group}`, folderPath: `owner-${group}` });
      const assets = repos.folderRepository.upsert({ slug: `assets-${group}`, name: 'Assets', folderPath: `owner-${group}/assets`,
        role: 'carousel_source', carouselOwnerFolderId: owner.id });
      for (let index = 0; index < 12; index++) {
        const name = `post-${++serial}`;
        const stamp = new Date(2025, 4, 31, 12 - group, index).getTime();
        const items = Array.from({ length: 3 }, (_, position) => {
          const relativePath = `owner-${group}/assets/${name}/${position}.jpg`;
          const image = repos.imageRepository.upsert({ folderId: assets.id, filename: `${position}.jpg`, extension: '.jpg',
            relativePath, absolutePath: path.join(root, 'GALLERY_ROOT', relativePath), fileSize: 1000 + position,
            width: 1200 + position, height: 800, mediaType: 'image', mimeType: 'image/jpeg', durationMs: null,
            fingerprint: relativePath, mtimeMs: stamp, firstSeenAt: '2025-05-31T00:00:00.000Z',
            sortTimestamp: stamp, takenAt: stamp, takenAtSource: source, exifJson: '{}',
            thumbnailPath: `${name}-${position}.webp`, previewPath: `${name}-${position}-preview.webp` });
          return { imageId: image.id, position: position + 1 };
        });
        const post = repos.postRepository.upsertPostWithItems({ folderId: owner.id, sourcePath: `${owner.folder_path}/${name}`,
          postType: 'carousel', sortTimestamp: stamp, takenAt: stamp, takenAtSource: source }, items);
        ids.push(post.id);
        if (group >= 2) db.connection.prepare('INSERT INTO likes (post_id,created_at) VALUES (?,?)').run(post.id, '2025-06-01T00:00:00.000Z');
        // Capture-date coverage uses visible individual images, not assets in
        // carousel_source folders. Include genuine singles to enable date rails.
        if (source === 'exif' && index < 6) {
          const relativePath = `owner-${group}/single-${index}.jpg`;
          const singleStamp = new Date(2024, 4, 31, 8, index).getTime();
          repos.imageRepository.upsert({ folderId: owner.id, filename: `single-${index}.jpg`, extension: '.jpg',
            relativePath, absolutePath: path.join(root, 'GALLERY_ROOT', relativePath), fileSize: 800,
            width: 800, height: 600, mediaType: 'image', mimeType: 'image/jpeg', durationMs: null,
            fingerprint: relativePath, mtimeMs: singleStamp, firstSeenAt: '2024-05-31T00:00:00.000Z',
            sortTimestamp: singleStamp, takenAt: singleStamp, takenAtSource: source, exifJson: '{}',
            thumbnailPath: `single-${group}-${index}.webp`, previewPath: `single-${group}-${index}-preview.webp` });
        }
      }
    }
    return ids;
  }

  // Exercise the old eager repository behavior against exactly the same database,
  // time and selection code; compare complete payloads, not just IDs/counts.
  function eager<T>(read: () => T): T {
    const image = repos.imageRepository;
    const recent = image.listRecentCandidates.bind(image);
    const rediscover = image.listRediscoverCandidates.bind(image);
    const random = image.listRandom.bind(image);
    const monthDay = image.listByMonthDayKeys.bind(image);
    const range = image.listByEffectiveTimeRange.bind(image);
    const liked = repos.likeRepository.listLikedOlderThan.bind(repos.likeRepository);
    const spies = [
      vi.spyOn(image, 'listRecentCandidates').mockImplementation((offset, limit) => recent(offset, limit)),
      vi.spyOn(image, 'listRediscoverCandidates').mockImplementation((offset, limit, cutoff) => rediscover(offset, limit, cutoff)),
      vi.spyOn(image, 'listRandom').mockImplementation((page, limit, seed) => random(page, limit, seed)),
      vi.spyOn(image, 'listByMonthDayKeys').mockImplementation((keys, year, page, limit) => monthDay(keys, year, page, limit)),
      vi.spyOn(image, 'listByEffectiveTimeRange').mockImplementation((start, end, page, limit) => range(start, end, page, limit)),
      vi.spyOn(repos.likeRepository, 'listLikedOlderThan').mockImplementation((page, limit, cutoff) => liked(page, limit, cutoff))
    ];
    try { return read(); } finally { spies.forEach(spy => spy.mockRestore()); }
  }

  function snapshot() {
    const rail = gallery.listMoments();
    return { rail, feeds: rail.items.flatMap(item => [1, 2].map(page => gallery.getMomentFeed(item.id, page, 5))) };
  }

  it('preserves complete Highlights, nonempty favorites and carousel pages across daily seeds', () => {
    fixture();
    for (const day of [31, 32, 33]) {
      vi.setSystemTime(new Date(2026, 4, day, 12));
      const actual = snapshot();
      expect(actual.rail.railKind).toBe('highlights');
      expect(actual.rail.items.map(item => item.id)).toContain('highlight-forgotten-favorites');
      expect(actual).toEqual(eager(snapshot));
      for (const capsule of actual.rail.items) expect(capsule.coverImage.mediaItems).toHaveLength(3);
      for (const feed of actual.feeds) {
        expect(feed).not.toBeNull();
        for (const item of feed!.items) {
          expect(item.mediaItems).toHaveLength(3);
          expect(item.mediaItems!.map(media => media.position)).toEqual([1, 2, 3]);
          expect(item.mediaItems![0].originalUrl).toMatch(/^\/api\/originals\//);
        }
      }
    }
  });

  it('preserves date Moments metadata, cover selection, pagination and end-of-feed behavior', () => {
    fixture('exif');
    const actual = snapshot();
    expect(actual.rail.railKind).toBe('moments');
    expect(actual.rail.items.map(item => item.id)).toEqual(['on-this-day', 'this-week-previous-years', 'from-last-year']);
    expect(actual).toEqual(eager(snapshot));
    expect(gallery.getMomentFeed('on-this-day', 99, 5)).toEqual(eager(() => gallery.getMomentFeed('on-this-day', 99, 5)));
    expect(gallery.getMomentFeed('on-this-day', 99, 5)?.items).toEqual([]);
  });

  it.each(['mtime', 'exif'] as const)('hydrates only the selected covers and requested page in batches (%s)', source => {
    fixture(source);
    const hydrate = vi.spyOn(repos.postRepository, 'hydratePostItems');
    const rail = gallery.listMoments();
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate.mock.calls[0]![0].map(post => post.id)).toEqual(rail.items.map(item => item.coverImage.id));
    expect(hydrate.mock.calls[0]![0].length).toBeLessThan(5);
    hydrate.mockClear();
    const feed = gallery.getMomentFeed(rail.items[0]!.id, 2, 5)!;
    expect(feed.items).toHaveLength(5);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate.mock.calls[0]![0].map(post => post.id)).toEqual(rail.items.map(item => item.coverImage.id));
    expect(hydrate.mock.calls[1]![0].map(post => post.id)).toEqual(feed.items.map(item => item.id));
  });

  it('keeps preferred-empty rail fallback without loading media for failed candidates', () => {
    fixture('exif');
    const expected = snapshot();
    vi.spyOn(repos.imageRepository, 'countByTakenAtSource').mockReturnValue(0);
    vi.spyOn(repos.imageRepository, 'listRecentCandidates').mockReturnValue([]);
    vi.spyOn(repos.imageRepository, 'countRediscover').mockReturnValue(0);
    vi.spyOn(repos.imageRepository, 'listRandom').mockReturnValue([]);
    vi.spyOn(repos.likeRepository, 'listLikedOlderThan').mockReturnValue([]);
    const hydrate = vi.spyOn(repos.postRepository, 'hydratePostItems');
    expect(snapshot()).toEqual(expected);
    expect(hydrate.mock.calls.every(([posts]) => posts.length <= 5)).toBe(true);
  });

  it('reflects new indexing, likes and visibility writes immediately rather than caching candidates', () => {
    expect(gallery.listMoments()).toMatchObject({ railKind: 'highlights', items: [] });
    const ids = fixture();
    expect(gallery.listMoments().items).toHaveLength(4);
    db.connection.exec('DELETE FROM likes');
    expect(gallery.getMomentFeed('highlight-forgotten-favorites', 1, 5)).toBeNull();
    db.connection.prepare('INSERT INTO likes (post_id,created_at) VALUES (?,?)').run(ids.at(-1)!, '2026-05-31');
    expect(gallery.getMomentFeed('highlight-forgotten-favorites', 1, 5)?.items.map(item => item.id)).toEqual([ids.at(-1)]);
    db.connection.prepare('UPDATE posts SET is_trashed=1 WHERE id=?').run(ids.at(-1)!);
    expect(gallery.getMomentFeed('highlight-forgotten-favorites', 1, 5)).toBeNull();
    db.connection.prepare('UPDATE posts SET is_trashed=0 WHERE id=?').run(ids.at(-1)!);
    expect(snapshot()).toEqual(eager(snapshot));
  });

  it('falls back to Highlights when reliable EXIF dates have no matching date capsules', () => {
    fixture('exif');
    vi.setSystemTime(new Date(2026, 0, 1, 12));
    const dates = vi.spyOn(repos.imageRepository, 'countByMonthDayKeys');
    const actual = snapshot();
    expect(dates).toHaveBeenCalled();
    expect(actual.rail.railKind).toBe('highlights');
    expect(actual.rail.items.length).toBeGreaterThan(0);
    expect(actual).toEqual(eager(snapshot));
  });

  it('does not query or hydrate media while storage is unavailable', () => {
    vi.spyOn(storage, 'getState').mockReturnValue({ libraryAvailable: false, reason: 'Synthetic unavailable storage',
      usingInMemoryDatabase: true, databasePath: ':memory:' });
    const count = vi.spyOn(repos.imageRepository, 'countFeed');
    const candidates = vi.spyOn(repos.imageRepository, 'listRecentCandidates');
    const hydrate = vi.spyOn(repos.postRepository, 'hydratePostItems');
    expect(gallery.listMoments()).toMatchObject({ railKind: 'moments', items: [] });
    expect(gallery.getMomentFeed('on-this-day', 1, 5)).toBeNull();
    expect(count).not.toHaveBeenCalled();
    expect(candidates).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
  });
});
