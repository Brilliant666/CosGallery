import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRecord } from '../src/types/models.js';
import { createFingerprint, getMimeTypeFromExtension, getPreviewRelativePath, getThumbnailRelativePath } from '../src/utils/image-utils.js';

describe.sequential('scoped reel playback resolution', () => {
  let root: string;
  let config: typeof import('../src/config/env.js')['appConfig'];
  let repositories: typeof import('../src/db/repositories.js');
  let database: typeof import('../src/db/database.js')['databaseManager'];
  let resolve: typeof import('../src/services/reel-playback-service.js')['resolveReelPlayback'];
  let originalVersion: typeof import('../src/services/reel-playback-service.js')['getReelOriginalVersion'];
  let versions: typeof import('../src/utils/derivative-version.js');
  let apiRouter: typeof import('../src/routes/api.js')['apiRouter'];
  let auth: typeof import('../src/services/auth-service.js')['authService'];
  let protection: typeof import('../src/middleware/auth-protection.js')['requireApiAuthentication'];
  const generate = vi.fn();
  const probe = vi.fn();
  const inspect = vi.fn();

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-playback-'));
    for (const [key, value] of Object.entries({ NODE_ENV: 'test', DATA_ROOT: 'data', GALLERY_ROOT: 'gallery', DB_DIR: 'db', THUMBNAILS_DIR: 'thumbnails', PREVIEWS_DIR: 'previews' })) {
      vi.stubEnv(key, key === 'NODE_ENV' ? value : path.join(root, value));
    }
    vi.resetModules();
    vi.doMock('../src/services/derivative-service.js', () => ({
      generateDerivatives: generate, generateThumbnailDerivative: generate, generatePreviewDerivative: generate, readMediaMetadata: probe
    }));
    vi.doMock('../src/services/reel-video-format.js', () => ({ inspectReelVideo: inspect, writeReelRemux: generate }));
    ({ appConfig: config } = await import('../src/config/env.js'));
    repositories = await import('../src/db/repositories.js');
    ({ databaseManager: database } = await import('../src/db/database.js'));
    ({ resolveReelPlayback: resolve, getReelOriginalVersion: originalVersion } = await import('../src/services/reel-playback-service.js'));
    versions = await import('../src/utils/derivative-version.js');
    ({ apiRouter } = await import('../src/routes/api.js'));
    ({ authService: auth } = await import('../src/services/auth-service.js'));
    ({ requireApiAuthentication: protection } = await import('../src/middleware/auth-protection.js'));
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    inspect.mockReset().mockResolvedValue({ mode: 'preview', mimeType: null });
    repositories.maintenanceRepository.resetLibraryIndex();
    for (const directory of [config.galleryRoot, config.previewsDir]) {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.mkdir(directory, { recursive: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    repositories.maintenanceRepository.resetLibraryIndex();
    expect(generate).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    database.close();
    vi.doUnmock('../src/services/derivative-service.js');
    vi.doUnmock('../src/services/reel-video-format.js');
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function fixture(strategy: 'original' | 'preview' = 'original', filename = 'clip.mp4') {
    const folder = repositories.folderRepository.upsert({ slug: 'clips', name: 'Clips', folderPath: 'clips' });
    const relativePath = `clips/${filename}`;
    const absolutePath = path.join(config.galleryRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `source:${filename}`);
    const stat = await fs.stat(absolutePath);
    const extension = path.extname(filename);
    const mediaType = extension === '.jpg' ? 'image' : 'video';
    const image = repositories.imageRepository.upsert({
      folderId: folder.id, filename, extension, relativePath, absolutePath,
      fileSize: stat.size, width: 720, height: 1280, mediaType, mimeType: getMimeTypeFromExtension(extension),
      durationMs: 1000, fingerprint: createFingerprint(relativePath, stat.size, stat.mtimeMs), mtimeMs: stat.mtimeMs,
      firstSeenAt: new Date().toISOString(), sortTimestamp: stat.mtimeMs, takenAt: stat.mtimeMs, takenAtSource: 'mtime',
      exifJson: null, thumbnailPath: getThumbnailRelativePath(relativePath), previewPath: getPreviewRelativePath(relativePath, mediaType), playbackStrategy: strategy
    });
    const post = repositories.postRepository.findByImageId(image.id)!;
    return { image, post, output: path.join(config.previewsDir, image.preview_path) };
  }

  async function cache(image: ImageRecord, stamp = true) {
    const output = path.join(config.previewsDir, image.preview_path);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, 'preview');
    if (stamp) await versions.stampDerivative(output, versions.imageDerivativeVersion(image, 'preview'));
    return output;
  }

  it('retains a stamped current preview when the compatible source is unavailable', async () => {
    const { image, post } = await fixture();
    await cache(image);
    await fs.rm(image.absolute_path);
    const stat = vi.spyOn(fs, 'stat');
    expect(await resolve(post.id)).toEqual({
      previewUrl: `/previews/clips/clip.mp4?v=${versions.imageDerivativeVersion(image, 'preview')}`,
      previewReady: true, originalUrl: null, originalMimeType: null, remuxUrl: null, remuxMimeType: null, remuxReady: false
    });
    expect(stat.mock.calls.some(([target]) => target === image.absolute_path)).toBe(true);
  });

  it('offers a compatible original even when a current preview exists', async () => {
    const { image, post } = await fixture();
    await cache(image);
    expect(await resolve(post.id)).toMatchObject({
      previewReady: true, originalUrl: `/api/reels/${post.id}/original?v=${originalVersion(image)}`, originalMimeType: 'video/mp4'
    });
    await fs.appendFile(image.absolute_path, 'changed');
    await expect(resolve(post.id)).rejects.toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
  });

  it('does not require an incompatible source for a valid cached preview', async () => {
    const { image, post } = await fixture('preview', 'clip.webm');
    await cache(image);
    await fs.rm(image.absolute_path);
    const stat = vi.spyOn(fs, 'stat');
    expect(await resolve(post.id)).toMatchObject({ previewReady: true, originalUrl: null });
    expect(stat.mock.calls.some(([target]) => target === image.absolute_path)).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unversioned', 'old-version', 'size', 'mtime'] as const)('uses an eligible original when preview is %s', async (state) => {
    const { image, post, output } = await fixture();
    if (state !== 'missing') await cache(image, state !== 'unversioned');
    if (state === 'old-version') await versions.stampDerivative(output, 'outdated');
    if (state === 'size') await fs.appendFile(output, 'tampered');
    if (state === 'mtime') await fs.utimes(output, new Date(0), new Date(0));
    expect(await resolve(post.id)).toMatchObject({ previewReady: false, originalUrl: `/api/reels/${post.id}/original?v=${originalVersion(image)}`, originalMimeType: 'video/mp4' });
    if (state === 'missing') await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the preview path for an incompatible original without generating it', async () => {
    const { post } = await fixture('preview', 'clip.webm');
    expect(await resolve(post.id)).toMatchObject({ previewReady: false, originalUrl: null, originalMimeType: null, previewUrl: expect.stringContaining('/previews/clips/clip.mp4?v=') });
  });

  it.each([false, true])('resolves readiness=%s without waiting for an active preview writer or listing the feed', async (warm) => {
    const { image, post, output } = await fixture();
    if (warm) await cache(image);
    const { withDerivativeOutputWrite } = await import('../src/services/derivative-output-lock.js');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const ready = new Promise<void>(done => { started = done; });
    const writer = withDerivativeOutputWrite(output, async () => { started(); await gate; });
    await ready;
    const list = vi.spyOn(repositories.imageRepository, 'listVisibleVideoCandidates');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        resolve(post.id),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Resolver waited for the active writer')), 1000); })
      ]);
      expect(result).toMatchObject({ previewReady: warm, originalUrl: `/api/reels/${post.id}/original?v=${originalVersion(image)}` });
      expect(list).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      release();
      await writer;
    }
  });

  it('does not infer compatibility when the stored strategy is unknown', async () => {
    const { image, post } = await fixture();
    // A legacy/unknown persisted value must not enable direct playback.
    database.connection.prepare("UPDATE images SET playback_strategy = '' WHERE id = ?").run(image.id);
    expect(await resolve(post.id)).toMatchObject({ originalUrl: null, originalMimeType: null });
  });

  it('resolves post IDs to the exact original image ID', async () => {
    const folder = repositories.folderRepository.upsert({ slug: 'clips', name: 'Clips', folderPath: 'clips' });
    repositories.postRepository.upsertPost({ id: 1, folderId: folder.id, sourcePath: 'reserved', postType: 'single', sortTimestamp: 1 });
    const { image, post } = await fixture();
    expect(post.id).not.toBe(image.id);
    const result = await resolve(post.id);
    expect(result.originalUrl).toBe(`/api/reels/${post.id}/original?v=${originalVersion(image)}`);
    const { galleryService } = await import('../src/services/gallery-service.js');
    expect(galleryService.getOriginalMediaFile(image.id)?.path).toBe(image.absolute_path);
    await expect(resolve(image.id)).rejects.toMatchObject({ status: 404 });
  });

  it.each(['deleted-image', 'trashed-image', 'deleted-post', 'trashed-post', 'hidden-folder', 'carousel', 'extra-item', 'nonvideo', 'missing-post'] as const)('rejects %s', async (state) => {
    const { image, post } = await fixture();
    const db = database.connection;
    if (state === 'deleted-image') db.prepare('UPDATE images SET is_deleted = 1 WHERE id = ?').run(image.id);
    if (state === 'trashed-image') db.prepare('UPDATE images SET is_trashed = 1 WHERE id = ?').run(image.id);
    if (state === 'deleted-post') db.prepare('UPDATE posts SET is_deleted = 1 WHERE id = ?').run(post.id);
    if (state === 'trashed-post') db.prepare('UPDATE posts SET is_trashed = 1 WHERE id = ?').run(post.id);
    if (state === 'hidden-folder') db.prepare("UPDATE folders SET role = 'carousel_source' WHERE id = ?").run(image.folder_id);
    if (state === 'carousel') db.prepare("UPDATE posts SET post_type = 'carousel' WHERE id = ?").run(post.id);
    if (state === 'nonvideo') db.prepare("UPDATE images SET media_type = 'image' WHERE id = ?").run(image.id);
    if (state === 'extra-item') {
      const other = await fixture('preview', 'second.mp4');
      db.prepare('DELETE FROM post_items WHERE image_id = ?').run(other.image.id);
      db.prepare('INSERT INTO post_items(post_id, image_id, position) VALUES (?, ?, 2)').run(post.id, other.image.id);
    }
    await expect(resolve(state === 'missing-post' ? 999999 : post.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a missing original and an original changed since indexing', async () => {
    const { image, post } = await fixture();
    await fs.appendFile(image.absolute_path, 'changed');
    await expect(resolve(post.id)).rejects.toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
    await fs.rm(image.absolute_path);
    await expect(resolve(post.id)).rejects.toMatchObject({ status: 404 });
  });

  it('offers supported WebM originals from legacy preview rows without updating the database', async () => {
    const { image, post } = await fixture('preview', 'legacy.webm');
    await cache(image);
    inspect.mockResolvedValue({ mode: 'original', mimeType: 'video/webm; codecs="vp9, opus"' });
    expect(await resolve(post.id)).toMatchObject({ originalUrl: expect.stringContaining(`/api/reels/${post.id}/original?v=`), originalMimeType: 'video/webm; codecs="vp9, opus"', remuxUrl: null });
    expect(repositories.imageRepository.getById(image.id)?.playback_strategy).toBe('preview');
    expect(inspect).toHaveBeenCalledWith(image.absolute_path, versions.derivativeSourceVersion(image.file_size, image.mtime_ms));
  });

  it('returns a separate remux recipe and readiness without creating the output', async () => {
    const { image, post } = await fixture('preview', 'legacy.mov');
    inspect.mockResolvedValue({ mode: 'remux', mimeType: 'video/mp4' });
    const { getReelRemuxLocation } = await import('../src/services/reel-playback-service.js');
    const remux = getReelRemuxLocation(image);
    expect(remux.version).not.toBe(versions.imageDerivativeVersion(image, 'preview'));
    expect(await resolve(post.id)).toMatchObject({ originalUrl: null, remuxUrl: `/api/reels/${post.id}/remux?v=${remux.version}`, remuxReady: false, remuxMimeType: 'video/mp4' });
    await expect(fs.stat(remux.output)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.mkdir(path.dirname(remux.output), { recursive: true });
    await fs.writeFile(remux.output, 'remux');
    await versions.stampDerivative(remux.output, remux.version);
    expect(await resolve(post.id)).toMatchObject({ remuxReady: true });
  });

  it('rechecks identity after format probing', async () => {
    const { post } = await fixture('preview', 'legacy.mov');
    inspect.mockImplementation(async () => {
      database.connection.prepare('UPDATE posts SET is_trashed = 1 WHERE id = ?').run(post.id);
      return { mode: 'remux', mimeType: 'video/mp4' };
    });
    await expect(resolve(post.id)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps a valid preview when ffprobe fails, but does not hide a changed source', async () => {
    const { image, post } = await fixture('preview', 'legacy.mov');
    await cache(image);
    inspect.mockRejectedValue(new Error('probe unavailable'));
    expect(await resolve(post.id)).toMatchObject({ previewReady: true, originalUrl: null });
    inspect.mockRejectedValue(new versions.SourceIndexOutdatedError());
    await expect(resolve(post.id)).rejects.toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
  });

  it.each(['hidden', 'source-path', 'version', 'membership'] as const)('rechecks %s after asynchronous cache reads', async (change) => {
    const { image, post } = await fixture();
    await cache(image);
    const other = change === 'membership' ? await fixture('original', 'replacement.mp4') : null;
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args: Parameters<typeof fs.readFile>) => {
      const data = await read(...args);
      const db = database.connection;
      if (change === 'hidden') db.prepare('UPDATE posts SET is_trashed = 1 WHERE id = ?').run(post.id);
      if (change === 'source-path') db.prepare("UPDATE images SET relative_path = 'other.mp4' WHERE id = ?").run(image.id);
      if (change === 'version') db.prepare('UPDATE images SET mtime_ms = mtime_ms + 10000 WHERE id = ?').run(image.id);
      if (other) {
        db.prepare('DELETE FROM post_items WHERE image_id = ?').run(other.image.id);
        db.prepare('UPDATE post_items SET image_id = ? WHERE post_id = ?').run(other.image.id, post.id);
      }
      return data;
    });
    await expect(resolve(post.id)).rejects.toMatchObject(change === 'hidden' ? { status: 404 } : { code: 'SOURCE_INDEX_OUTDATED' });
  });

  it('rechecks source identity after the source stat', async () => {
    const { image, post } = await fixture();
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const result = await stat(...args);
      if (args[0] === image.absolute_path) database.connection.prepare("UPDATE images SET relative_path = 'replacement.mp4' WHERE id = ?").run(image.id);
      return result;
    });
    await expect(resolve(post.id)).rejects.toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
  });

  it('rechecks identity before falling back to cache after a missing-source stat', async () => {
    const { image, post } = await fixture();
    await cache(image);
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (args[0] === image.absolute_path) {
        database.connection.prepare('UPDATE posts SET is_trashed = 1 WHERE id = ?').run(post.id);
        throw Object.assign(new Error('source missing'), { code: 'ENOENT' });
      }
      return stat(...args);
    });
    await expect(resolve(post.id)).rejects.toMatchObject({ status: 404 });
  });

  it.each([false, true])('preserves the rebuild boundary with previewReady=%s', async (warm) => {
    const { image, post } = await fixture();
    if (warm) await cache(image);
    const { scannerService } = await import('../src/services/scanner-service.js');
    vi.spyOn(scannerService, 'isLibraryRebuildRequired').mockReturnValue(true);
    if (warm) expect(await resolve(post.id)).toMatchObject({ previewReady: true, originalUrl: null });
    else await expect(resolve(post.id)).rejects.toMatchObject({ status: 409, code: 'LIBRARY_REBUILD_REQUIRED' });
  });

  function response() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn(), locals: {} };
  }

  async function invoke(id: number) {
    const layers = (apiRouter as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: express.RequestHandler }> } }> }).stack;
    const handler = layers.find(layer => layer.route?.path === '/reels/:id/playback')!.route!.stack[0].handle;
    const res = response();
    await handler({ params: { id: String(id) } } as express.Request, res as unknown as express.Response, vi.fn());
    return res;
  }

  it('returns the contract, no-store, and path-free known HTTP errors', async () => {
    const { image, post } = await fixture();
    const success = await invoke(post.id);
    expect(success.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(success.json.mock.calls[0][0]).toEqual(await resolve(post.id));
    await fs.appendFile(image.absolute_path, 'changed');
    const stale = await invoke(post.id);
    expect(stale.status).toHaveBeenCalledWith(409);
    expect(stale.json.mock.calls[0][0].code).toBe('SOURCE_INDEX_OUTDATED');
    expect(JSON.stringify(stale.json.mock.calls)).not.toContain(root);
    const missing = await invoke(999999);
    expect(missing.status).toHaveBeenCalledWith(404);
  });

  it('uses existing API viewer authentication without requiring admin', () => {
    auth.setAdminPassword('playback-password-123');
    const req = { method: 'GET', path: '/reels/1/playback', get: () => undefined } as unknown as express.Request;
    const blocked = response();
    const next = vi.fn();
    protection(req, blocked as unknown as express.Response, next);
    expect(blocked.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    vi.spyOn(auth, 'isAuthenticatedRequest').mockReturnValue(true);
    protection(req, response() as unknown as express.Response, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
