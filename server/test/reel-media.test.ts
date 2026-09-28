import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFingerprint, getMimeTypeFromExtension, getPreviewRelativePath, getThumbnailRelativePath } from '../src/utils/image-utils.js';

describe.sequential('scoped reel original and remux HTTP delivery', () => {
  let root: string;
  let server: http.Server;
  let origin: string;
  let config: typeof import('../src/config/env.js')['appConfig'];
  let repos: typeof import('../src/db/repositories.js');
  let database: typeof import('../src/db/database.js')['databaseManager'];
  let playback: typeof import('../src/services/reel-playback-service.js');
  let versions: typeof import('../src/utils/derivative-version.js');
  const writer = vi.fn(async (_source: string, output: string) => { await fs.writeFile(output, 'synthetic-lossless-output'); });
  const inspect = vi.fn(async () => ({ mode: 'remux', mimeType: 'video/mp4' }));
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-media-http-'));
    for (const [key, value] of Object.entries({ NODE_ENV: 'test', DATA_ROOT: 'data', GALLERY_ROOT: '.hidden-root/gallery', DB_DIR: 'db', THUMBNAILS_DIR: 'thumbnails', PREVIEWS_DIR: '.hidden-root/previews' })) vi.stubEnv(key, key === 'NODE_ENV' ? value : path.join(root, value));
    vi.resetModules();
    vi.doMock('../src/services/reel-video-format.js', () => ({ inspectReelVideo: inspect, writeReelRemux: writer }));
    ({ appConfig: config } = await import('../src/config/env.js'));
    repos = await import('../src/db/repositories.js');
    ({ databaseManager: database } = await import('../src/db/database.js'));
    playback = await import('../src/services/reel-playback-service.js');
    versions = await import('../src/utils/derivative-version.js');
    const { serveReelMedia } = await import('../src/routes/reel-media.js');
    const app = express();
    for (const kind of ['original', 'remux'] as const) app.get(`/api/reels/:id/${kind}`, async (req, res) => { await serveReelMedia(req, res, Number(req.params.id), kind); });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    writer.mockClear();
    inspect.mockReset().mockResolvedValue({ mode: 'remux', mimeType: 'video/mp4' });
    repos.maintenanceRepository.resetLibraryIndex();
    await fs.mkdir(config.galleryRoot, { recursive: true });
    await fs.rm(config.previewsDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    database.close();
    vi.doUnmock('../src/services/reel-video-format.js');
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(extension = '.mov') {
    const filename = `clip${extension}`;
    const absolutePath = path.join(config.galleryRoot, filename);
    await fs.writeFile(absolutePath, 'synthetic-source-original');
    const stat = await fs.stat(absolutePath);
    const folder = repos.folderRepository.upsert({ slug: 'clips', name: 'Clips', folderPath: '' });
    const image = repos.imageRepository.upsert({ folderId: folder.id, filename, extension, relativePath: filename, absolutePath, fileSize: stat.size, width: 16, height: 16, mediaType: 'video', mimeType: getMimeTypeFromExtension(extension), durationMs: 1000, fingerprint: createFingerprint(filename, stat.size, stat.mtimeMs), mtimeMs: stat.mtimeMs, firstSeenAt: new Date().toISOString(), sortTimestamp: stat.mtimeMs, takenAt: stat.mtimeMs, takenAtSource: 'mtime', exifJson: null, thumbnailPath: getThumbnailRelativePath(filename), previewPath: getPreviewRelativePath(filename, 'video'), playbackStrategy: extension === '.mp4' ? 'original' : 'preview' });
    const post = repos.postRepository.findByImageId(image.id)!;
    const result = await playback.resolveReelPlayback(post.id, extension !== '.mp4');
    return { image, post, url: new URL(extension === '.mp4' ? result.originalUrl! : result.remuxUrl!, origin) };
  }
  it('singleflights cold remux, supports Range and reuses separately stamped bytes', async () => {
    const { image, url } = await fixture();
    const responses = await Promise.all([fetch(url), fetch(url)]);
    for (const response of responses) { expect(response.status).toBe(200); expect(await response.text()).toBe('synthetic-lossless-output'); }
    expect(writer).toHaveBeenCalledOnce();
    expect(await fs.readFile(image.absolute_path, 'utf8')).toBe('synthetic-source-original');
    const output = playback.getReelRemuxLocation(image);
    expect(await versions.hasCurrentDerivative(output.output, output.version)).toBe(true);
    await expect(fs.stat(path.join(config.previewsDir, image.preview_path))).rejects.toMatchObject({ code: 'ENOENT' });
    const partial = await fetch(url, { headers: { Range: 'bytes=0-8' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-type')).toBe('video/mp4');
    expect(partial.headers.get('cache-control')).toContain('immutable');
    expect(await partial.text()).toBe('synthetic');
    const invalid = await fetch(url, { headers: { Range: 'bytes=99999-' } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
    expect(writer).toHaveBeenCalledOnce();
  });
  it('delivers original bytes and Range without generating any output', async () => {
    const { url } = await fixture('.mp4');
    const response = await fetch(url, { headers: { Range: 'bytes=0-8' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('synthetic');
    expect(writer).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(['.mov', '.mkv', '.m4v', '.webm'])('serves %s original GET and HEAD without probing or generating', async extension => {
    const { image, post } = await fixture(extension);
    inspect.mockClear();
    const result = await playback.resolveReelPlayback(post.id);
    const url = new URL(result.originalUrl!, origin);
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(getMimeTypeFromExtension(extension));
    expect(await head.text()).toBe('');
    const response = await fetch(url, { headers: { Range: 'bytes=0-8' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('synthetic');
    expect(inspect).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(await fs.readFile(image.absolute_path, 'utf8')).toBe('synthetic-source-original');
  });

  it('rejects an unverified cold remux request instead of copying incompatible streams', async () => {
    const { image, post } = await fixture('.mp4');
    inspect.mockResolvedValue({ mode: 'preview', mimeType: 'video/mp4' });
    const remux = playback.getReelRemuxLocation(image);
    const response = await fetch(new URL(`/api/reels/${post.id}/remux?v=${remux.version}`, origin));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'REEL_REMUX_UNAVAILABLE' });
    expect(writer).not.toHaveBeenCalled();
  });

  it('rechecks visibility after fallback inspection before generating a remux', async () => {
    const { post, url } = await fixture();
    inspect.mockImplementationOnce(async () => {
      database.connection.prepare('UPDATE posts SET is_trashed = 1 WHERE id = ?').run(post.id);
      return { mode: 'remux', mimeType: 'video/mp4' };
    });
    expect((await fetch(url)).status).toBe(404);
    expect(writer).not.toHaveBeenCalled();
  });
  it('does not expose hidden media inside a configured root and keeps missing files as 404', async () => {
    const { image, post } = await fixture('.mp4');
    const filename = '.hidden-clip.mp4';
    await fs.rename(image.absolute_path, path.join(config.galleryRoot, filename));
    database.connection.prepare('UPDATE images SET relative_path = ?, absolute_path = ? WHERE id = ?').run(filename, path.join(config.galleryRoot, filename), image.id);
    const current = await playback.resolveReelPlayback(post.id);
    const hidden = await fetch(new URL(current.originalUrl!, origin));
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain(root);
    await fs.rm(path.join(config.galleryRoot, filename));
    expect((await fetch(new URL(current.originalUrl!, origin))).status).toBe(404);
  });
  it.each(['original', 'remux'] as const)('rejects stale URL/source and hidden %s posts', async kind => {
    const { image, post, url } = await fixture(kind === 'original' ? '.mp4' : '.mov');
    const wrong = new URL(url); wrong.searchParams.set('v', 'stale');
    expect((await fetch(wrong)).status).toBe(409);
    await fs.appendFile(image.absolute_path, '-changed');
    expect((await fetch(url)).status).toBe(409);
    database.connection.prepare('UPDATE posts SET is_trashed = 1 WHERE id = ?').run(post.id);
    const hidden = await fetch(url);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain(root);
    expect(writer).not.toHaveBeenCalled();
  });
  it('does not publish output after an identity/visibility change during remux', async () => {
    const { image, post, url } = await fixture();
    writer.mockImplementationOnce(async (_source, output) => {
      await fs.writeFile(output, 'unsafe-output');
      database.connection.prepare('UPDATE posts SET is_trashed = 1 WHERE id = ?').run(post.id);
    });
    expect((await fetch(url)).status).toBe(404);
    expect(await versions.hasCurrentDerivative(playback.getReelRemuxLocation(image).output, playback.getReelRemuxLocation(image).version)).toBe(false);
  });
  it('keeps valid remux available after source removal but rejects deleted posts even for warm caches', async () => {
    const { image, post, url } = await fixture();
    expect((await fetch(url)).status).toBe(200);
    await fs.rm(image.absolute_path);
    expect((await playback.resolveReelPlayback(post.id)).remuxReady).toBe(true);
    expect((await fetch(url)).status).toBe(200);
    database.connection.prepare('UPDATE posts SET is_deleted = 1 WHERE id = ?').run(post.id);
    expect((await fetch(url)).status).toBe(404);
  });
  it.each(['original', 'remux'] as const)('does not reuse %s identity after an index reset reuses IDs and source stat values', async kind => {
    const { image, url } = await fixture(kind === 'original' ? '.mp4' : '.mov');
    if (kind === 'remux') expect((await fetch(url)).status).toBe(200);
    const oldRemux = playback.getReelRemuxLocation(image);
    const renamed = `different${image.extension}`;
    await fs.rename(image.absolute_path, path.join(config.galleryRoot, renamed));
    // Same ID/size/mtime, different source identity is the collision an index
    // reset can produce. Preserve the old cache to exercise accidental reuse.
    database.connection.prepare('UPDATE images SET relative_path = ?, absolute_path = ? WHERE id = ?').run(renamed, path.join(config.galleryRoot, renamed), image.id);
    const changed = repos.imageRepository.getById(image.id)!;
    expect(playback.getReelOriginalVersion(changed)).not.toBe(playback.getReelOriginalVersion(image));
    expect(playback.getReelRemuxLocation(changed).output).not.toBe(oldRemux.output);
    expect((await fetch(url)).status).toBe(409);
    expect(await versions.hasCurrentDerivative(playback.getReelRemuxLocation(changed).output, playback.getReelRemuxLocation(changed).version)).toBe(false);
  });
});
