import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';
import { getThumbnailPathForAssetKey, getPreviewPathForAssetKey } from '../src/utils/derivative-paths.js';

// Synthetic originals and generated bodies only. No application module is loaded
// until all five storage paths are explicitly isolated.
describe.sequential('derivative cache reuse audit', () => {
  let root: string;
  let config: typeof import('../src/config/env.js')['appConfig'];
  let repositories: typeof import('../src/db/repositories.js');
  let db: typeof import('../src/db/database.js');
  let routes: typeof import('../src/routes/lazy-derivatives.js');
  let lock: typeof import('../src/services/maintenance-operation-lock.js')['maintenanceOperationLock'];
  const thumbnail = vi.fn();
  const preview = vi.fn();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-cache-audit-'));
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    for (const [key, directory] of Object.entries({ DATA_ROOT: 'data', GALLERY_ROOT: 'gallery', DB_DIR: 'db', THUMBNAILS_DIR: 'thumbnails', PREVIEWS_DIR: 'previews' })) {
      const absolute = path.join(root, directory);
      await fs.mkdir(absolute, { recursive: true });
      expect((await fs.lstat(absolute)).isSymbolicLink()).toBe(false);
      vi.stubEnv(key, absolute);
    }
    vi.stubEnv('LOCAL_INGEST_STARTUP_SCAN', 'false');
    vi.stubEnv('DERIVATIVE_MODE', 'lazy');
    vi.stubEnv('IMAGE_DETAIL_SOURCE', 'preview');
    vi.stubEnv('SCAN_DERIVATIVE_CONCURRENCY', '4');
    thumbnail.mockReset();
    preview.mockReset();
    vi.doMock('../src/services/derivative-service.js', () => ({ generateThumbnailDerivative: thumbnail, generatePreviewDerivative: preview }));
    ({ appConfig: config } = await import('../src/config/env.js'));
    expect(config.dbDir).toBe(path.join(root, 'db'));
    expect(config.thumbnailsDir).toBe(path.join(root, 'thumbnails'));
    expect(config.previewsDir).toBe(path.join(root, 'previews'));
    db = await import('../src/db/database.js');
    repositories = await import('../src/db/repositories.js');
    routes = await import('../src/routes/lazy-derivatives.js');
    ({ maintenanceOperationLock: lock } = await import('../src/services/maintenance-operation-lock.js'));
    for (const [mock, directory, field] of [[thumbnail, config.thumbnailsDir, 'thumbnailPath'], [preview, config.previewsDir, 'previewPath']] as const) {
      mock.mockImplementation(async (_source: string, relative: string, _force: boolean, overrides: Record<string, string>) => {
        const output = path.join(directory, overrides[field]!);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, `synthetic derivative ${relative}`);
        const record = field === 'thumbnailPath' ? repositories.imageRepository.getByThumbnailPath(overrides[field]!) : repositories.imageRepository.getByPreviewPath(overrides[field]!);
        const { stampDerivative, imageDerivativeVersion } = await import('../src/utils/derivative-version.js');
        await stampDerivative(output, imageDerivativeVersion(record!, field === 'thumbnailPath' ? 'thumbnail' : 'preview'));
      });
    }
  });

  afterEach(async () => {
    db?.databaseManager.close();
    vi.unstubAllEnvs();
    vi.doUnmock('../src/services/derivative-service.js');
    vi.resetModules();
    // Only the mkdtemp-owned synthetic root can be removed.
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(path.basename(root)).toMatch(/^cosgallery-cache-audit-/);
    await fs.rm(root, { recursive: true, force: true });
  });

  function image(filename = 'image.jpg') {
    const folder = repositories.folderRepository.upsert({ slug: 'synthetic', name: 'Synthetic', folderPath: 'synthetic' });
    const assetKey = createHash('sha256').update(filename).digest('hex').slice(0, 32);
    const source = path.join(config.galleryRoot, 'synthetic', filename);
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, Buffer.alloc(12));
    utimesSync(source, 1, 1);
    return repositories.imageRepository.upsert({ folderId: folder.id, assetKey, filename, extension: '.jpg', relativePath: `synthetic/${filename}`, absolutePath: path.join(config.galleryRoot, 'synthetic', filename), fileSize: 12, width: 20, height: 30, mediaType: 'image', mimeType: 'image/jpeg', durationMs: null, isAnimated: false, fingerprint: `fixture-${filename}`, mtimeMs: 1000, firstSeenAt: '2026-01-01T00:00:00Z', sortTimestamp: 1000, takenAt: 1000, takenAtSource: 'mtime', exifJson: '{}', thumbnailPath: getThumbnailPathForAssetKey(assetKey), previewPath: getPreviewPathForAssetKey(assetKey, 'image'), playbackStrategy: 'preview' });
  }

  function app() {
    return express().use('/thumbnails', routes.lazyThumbnailsRouter).use('/previews', routes.lazyPreviewsRouter);
  }

  async function stamp(file: string) {
    const stat = await fs.stat(file);
    return { size: stat.size, mtime: stat.mtimeMs, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
  }

  it('serves existing thumbnail and preview without generation even while maintenance is blocked', async () => {
    const record = image();
    for (const dir of [config.thumbnailsDir, config.previewsDir]) {
      await fs.mkdir(path.dirname(path.join(dir, record.thumbnail_path)), { recursive: true });
      await fs.writeFile(path.join(dir, record.thumbnail_path), 'existing');
      const { stampDerivative, imageDerivativeVersion } = await import('../src/utils/derivative-version.js');
      await stampDerivative(path.join(dir, record.thumbnail_path), imageDerivativeVersion(record, dir === config.thumbnailsDir ? 'thumbnail' : 'preview'));
    }
    let release!: () => void;
    const blocked = lock.runExclusive(() => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
      for (const url of [`/thumbnails/${record.thumbnail_path}`, `/previews/${record.preview_path}`]) {
        const response = await requestTestApp(app(), 'GET', url);
        expect(response.status).toBe(200);
        expect(response.body).toBe('existing');
        // Legacy unversioned links are readable but cannot be immutable keys.
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }
      expect(thumbnail).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    } finally { release(); await blocked; }
  });

  it('deduplicates simultaneous missing thumbnails and reuses the persistent file for subsequent HTTP clients', async () => {
    const record = image();
    const url = `/thumbnails/${record.thumbnail_path}`;
    const responses = await Promise.all(Array.from({ length: 6 }, () => requestTestApp(app(), 'GET', url)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(thumbnail).toHaveBeenCalledOnce();
    const before = await stamp(path.join(config.thumbnailsDir, record.thumbnail_path));
    // Each helper request creates a fresh HTTP client and has no browser cache.
    expect((await requestTestApp(app(), 'GET', url)).status).toBe(200);
    expect(await stamp(path.join(config.thumbnailsDir, record.thumbnail_path))).toEqual(before);
    expect(thumbnail).toHaveBeenCalledOnce();
  });

  it('generates distinct missing files concurrently at configured concurrency four', async () => {
    const first = image('first.jpg');
    const second = image('second.jpg');
    const enteredLock = vi.spyOn(lock, 'runGeneration');
    const generate = thumbnail.getMockImplementation()!;
    let release!: () => void;
    thumbnail.mockImplementationOnce(async (...args: unknown[]) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await generate(...args);
    });
    const pending = requestTestApp(app(), 'GET', `/thumbnails/${first.thumbnail_path}`);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const next = requestTestApp(app(), 'GET', `/thumbnails/${second.thumbnail_path}`);
    try {
      await vi.waitFor(() => expect(enteredLock).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(thumbnail).toHaveBeenCalledTimes(2));
    } finally { release(); }
    expect((await Promise.all([pending, next])).every((response) => response.status === 200)).toBe(true);
    expect(thumbnail).toHaveBeenCalledTimes(2);
  });

  it('keeps media URLs stable across unrelated completed and failed scans without regenerating', async () => {
    const record = image();
    const { galleryService } = await import('../src/services/gallery-service.js');
    const first = galleryService.getImageDetail(record.id)!;
    expect(first).not.toBeNull();
    await requestTestApp(app(), 'GET', first.thumbnailUrl);
    await requestTestApp(app(), 'GET', first.previewUrl);
    const files = [path.join(config.thumbnailsDir, record.thumbnail_path), path.join(config.previewsDir, record.preview_path)];
    const before = await Promise.all(files.map(stamp));
    const runId = repositories.scanRunRepository.start();
    repositories.scanRunRepository.finish(runId, { finished_at: '2026-09-01T00:00:00Z', status: 'completed', scanned_files: 0, new_files: 0, updated_files: 0, removed_files: 0, error_text: null, warning_count: 0, warning_text: null });
    const second = galleryService.getImageDetail(record.id)!;
    expect(second.thumbnailUrl).toBe(first.thumbnailUrl);
    expect(second.previewUrl).toBe(first.previewUrl);
    const failedRun = repositories.scanRunRepository.start();
    repositories.scanRunRepository.finish(failedRun, { finished_at: '2026-09-02T00:00:00Z', status: 'failed', scanned_files: 0, new_files: 0, updated_files: 0, removed_files: 0, error_text: 'fixture', warning_count: 0, warning_text: null });
    expect(galleryService.getImageDetail(record.id)!.thumbnailUrl).toBe(first.thumbnailUrl);
    expect(second.originalUrl).toBe(first.originalUrl);
    expect((await requestTestApp(app(), 'GET', second.thumbnailUrl)).status).toBe(200);
    expect((await requestTestApp(app(), 'GET', second.previewUrl)).status).toBe(200);
    expect(await Promise.all(files.map(stamp))).toEqual(before);
    expect(repositories.imageRepository.getById(record.id)).toEqual(record);
    expect(thumbnail).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledOnce();
  });

  it('rechecks source generation after asynchronous hot-cache validation', async () => {
    const record = image();
    const { galleryService } = await import('../src/services/gallery-service.js');
    const url = galleryService.getImageDetail(record.id)!.thumbnailUrl;
    expect((await requestTestApp(app(), 'GET', url)).status).toBe(200);
    const versions = await import('../src/utils/derivative-version.js');
    const check = versions.hasCurrentDerivative;
    const spy = vi.spyOn(versions, 'hasCurrentDerivative').mockImplementationOnce(async (...args) => {
      const valid = await check(...args);
      db.databaseManager.connection.prepare('UPDATE images SET file_size = file_size + 1 WHERE id = ?').run(record.id);
      return valid;
    });
    try {
      const stale = await requestTestApp(app(), 'GET', url);
      expect(stale.status).toBe(409);
      expect(stale.headers.get('cache-control')).toBe('no-store');
      expect(thumbnail).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });

  it('does not generate deleted or unindexed retained originals', async () => {
    const record = image();
    db.databaseManager.connection.prepare('UPDATE images SET is_deleted = 1 WHERE id = ?').run(record.id);
    expect((await requestTestApp(app(), 'GET', `/thumbnails/${record.thumbnail_path}`)).status).toBe(404);
    expect((await requestTestApp(app(), 'GET', '/thumbnails/retained-original.webp')).status).toBe(404);
    expect(thumbnail).not.toHaveBeenCalled();
  });
});
