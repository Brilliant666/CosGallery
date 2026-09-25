import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFingerprint,
  getMediaTypeFromExtension,
  getMimeTypeFromExtension,
  getPreviewRelativePath,
  getThumbnailRelativePath
} from '../src/utils/image-utils.js';

type AppConfigModule = typeof import('../src/config/env.js');
type GalleryServiceModule = typeof import('../src/services/gallery-service.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type ModelsModule = typeof import('../src/types/models.js');

type FolderRecord = ModelsModule['FolderRecord'];

describe.sequential('highlight rail selection', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let galleryService: GalleryServiceModule['galleryService'];
  let folderRepository: RepositoriesModule['folderRepository'];
  let imageRepository: RepositoriesModule['imageRepository'];
  let maintenanceRepository: RepositoriesModule['maintenanceRepository'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-highlight-rail-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));

    vi.resetModules();

    ({ appConfig } = await import('../src/config/env.js'));
    ({ galleryService } = await import('../src/services/gallery-service.js'));
    ({ folderRepository, imageRepository, maintenanceRepository } = await import('../src/db/repositories.js'));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    maintenanceRepository.resetLibraryIndex();
    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('does not materialize date capsules when preferred highlights are available', async () => {
    await createIndexedFolder('highlights-only', new Date(2025, 4, 31, 12).getTime(), 30);
    const dates = vi.spyOn(imageRepository, 'countByMonthDayKeys');
    const recent = vi.spyOn(imageRepository, 'listRecentCandidates');
    expect(galleryService.listMoments().railKind).toBe('highlights');
    expect(dates).not.toHaveBeenCalled();
    expect(recent).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected definition for direct capsule reading instead of rebuilding all highlights', async () => {
    await createIndexedFolder('direct-highlight', new Date(2025, 4, 31, 12).getTime(), 30);
    const candidates = vi.spyOn(imageRepository, 'listRandom');
    expect(galleryService.getMomentFeed('highlight-lucky-dip', 1, 30)?.items.length).toBeGreaterThan(0);
    expect(candidates).toHaveBeenCalledTimes(1);
  });

  it('computes Moments first when capture dates are reliable, without assembling Highlights', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 4, 31, 12));
    await createIndexedFolder('reliable-captures', new Date(2025, 4, 31, 12).getTime(), 30, 'exif');
    const random = vi.spyOn(imageRepository, 'listRandom');
    const rail = galleryService.listMoments();
    expect(rail.railKind).toBe('moments');
    expect(rail.items.map(item=>item.id)).toEqual(['on-this-day','this-week-previous-years','from-last-year']);
    expect(new Set(rail.items.map(item=>item.coverImage.id)).size).toBe(rail.items.length);
    expect(random).not.toHaveBeenCalled();
  });

  it('falls back from preferred empty Moments, and reevaluates the date next read', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 0, 1, 12));
    await createIndexedFolder('changing-day', new Date(2025, 4, 31, 12).getTime(), 30, 'exif');
    expect(galleryService.listMoments().railKind).toBe('highlights');
    vi.setSystemTime(new Date(2026, 4, 31, 12));
    expect(galleryService.listMoments().railKind).toBe('moments');
  });

  it('falls back from empty Highlights to Moments, preserving the ordinary fixed-date result', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 4, 31, 12));
    await createIndexedFolder('fallback-dates', new Date(2025, 4, 31, 12).getTime(), 30, 'exif');
    const expected = galleryService.listMoments();
    vi.spyOn(imageRepository,'countByTakenAtSource').mockReturnValue(0);
    vi.spyOn(imageRepository,'listRecentCandidates').mockReturnValue([]);
    vi.spyOn(imageRepository,'countRediscover').mockReturnValue(0);
    vi.spyOn(imageRepository,'listRandom').mockReturnValue([]);
    expect(galleryService.listMoments()).toEqual(expected);
  });

  it('preserves empty Highlights metadata and immediately reflects new indexed content', async () => {
    expect(galleryService.listMoments()).toMatchObject({railKind:'highlights',items:[]});
    await createIndexedFolder('new-content', new Date(2025, 4, 31, 12).getTime(), 2);
    expect(galleryService.listMoments().items.length).toBeGreaterThan(0);
  });

  it('recomputes the local daily seed and sliding cutoff rather than caching time-based contents', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 4, 31, 12));
    await createIndexedFolder('daily-seed', new Date(2025, 4, 31, 12).getTime(), 30);
    const random = vi.spyOn(imageRepository,'listRandom');
    const rediscover = vi.spyOn(imageRepository,'countRediscover');
    galleryService.listMoments();
    const firstCutoff=rediscover.mock.calls[0]![0];
    expect(random.mock.calls[0]![2]).toBe(20260531);
    vi.setSystemTime(new Date(2026, 5, 1, 12));galleryService.listMoments();
    expect(random.mock.calls[1]![2]).toBe(20260601);
    expect(rediscover.mock.calls[1]![0]-firstCutoff).toBe(24*60*60*1000);
  });

  it('keeps highlight covers and recent batch items out of the top recent feed window when enough alternatives exist', async () => {
    await createIndexedFolder('alpha', 1_777_000_000_000, 12);
    await createIndexedFolder('bravo', 1_776_000_000_000, 12);
    await createIndexedFolder('charlie', 1_775_000_000_000, 12);

    const recentFeedIds = new Set(galleryService.getFeed(1, 18, 'recent').items.map((item) => item.id));
    const rail = galleryService.listMoments();

    expect(rail.railKind).toBe('highlights');
    expect(rail.items.length).toBeGreaterThan(0);

    for (const capsule of rail.items) {
      expect(recentFeedIds.has(capsule.coverImage.id)).toBe(false);
    }

    const recentBatches = rail.items.find((capsule) => capsule.id === 'highlight-recent-batches');
    expect(recentBatches).toBeDefined();

    const recentBatchFeed = galleryService.getMomentFeed('highlight-recent-batches', 1, 30);
    expect(recentBatchFeed).not.toBeNull();
    expect(recentBatchFeed?.items.length).toBeGreaterThanOrEqual(2);

    for (const item of recentBatchFeed?.items ?? []) {
      expect(recentFeedIds.has(item.id)).toBe(false);
    }
  });

  async function createIndexedFolder(relativeFolderPath: string, startTimestamp: number, imageCount: number, takenAtSource: 'mtime' | 'exif' = 'mtime'): Promise<{
    folder: FolderRecord;
  }> {
    const slug = relativeFolderPath.replaceAll('/', '-');
    const folderName = path.posix.basename(relativeFolderPath);
    const folder = folderRepository.upsert({
      slug,
      name: folderName,
      folderPath: relativeFolderPath
    });

    for (let index = 0; index < imageCount; index += 1) {
      const filename = `photo-${String(index + 1).padStart(2, '0')}.jpg`;
      const relativePath = `${relativeFolderPath}/${filename}`;
      const absolutePath = path.join(appConfig.galleryRoot, relativePath);
      const extension = path.extname(filename).toLowerCase();
      const mediaType = getMediaTypeFromExtension(extension);
      const thumbnailRelativePath = getThumbnailRelativePath(relativePath);
      const previewRelativePath = getPreviewRelativePath(relativePath, mediaType);
      const capturedAt = startTimestamp - index * 60_000;
      const fileSize = 1_000 + index;

      const image = imageRepository.upsert({
        folderId: folder.id,
        filename,
        extension,
        relativePath,
        absolutePath,
        fileSize,
        width: 1200,
        height: 800,
        mediaType,
        mimeType: getMimeTypeFromExtension(extension),
        durationMs: null,
        fingerprint: createFingerprint(relativePath, fileSize, capturedAt),
        mtimeMs: capturedAt,
        firstSeenAt: '2026-03-01T00:00:00.000Z',
        sortTimestamp: capturedAt,
        takenAt: capturedAt,
        takenAtSource,
        exifJson: '{}',
        thumbnailPath: thumbnailRelativePath,
        previewPath: previewRelativePath
      });

      if (index === 0) {
        folderRepository.setAvatar(folder.id, image.id);
      }
    }

    return { folder };
  }
});
