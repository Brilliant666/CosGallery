import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Exercise the real Sharp generator and HTTP response, not the mocked generator
// used by the broader lazy-route control-flow suite.
describe.sequential('real lazy image derivatives in isolated storage', () => {
  let root = '';
  let server: http.Server | undefined;
  let origin = '';
  let config: typeof import('../src/config/env.js')['appConfig'];
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  let repos: typeof import('../src/db/repositories.js');
  let gallery: typeof import('../src/services/gallery-service.js')['galleryService'];

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'real-lazy-derivatives-'));
    vi.stubEnv('NODE_ENV', 'test'); // Do not load the repository .env.
    vi.stubEnv('DERIVATIVE_MODE', 'lazy');
    vi.stubEnv('IMAGE_DETAIL_SOURCE', 'preview');
    vi.stubEnv('LOCAL_INGEST_STARTUP_SCAN', 'false');
    vi.stubEnv('PUBLIC_DEMO_MODE', 'false');
    for (const name of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      const directory = path.join(root, name);
      await fs.mkdir(directory, { recursive: true });
      vi.stubEnv(name, directory);
    }
    vi.resetModules();
    ({ appConfig: config } = await import('../src/config/env.js'));
    for (const directory of [config.dataRoot, config.galleryRoot, config.dbDir, config.thumbnailsDir, config.previewsDir]) {
      expect(path.relative(root, directory)).not.toMatch(/^\.\.(?:[/\\]|$)/);
      expect(path.isAbsolute(path.relative(root, directory))).toBe(false);
    }
    ({ databaseManager: manager } = await import('../src/db/database.js'));
    repos = await import('../src/db/repositories.js');
    ({ galleryService: gallery } = await import('../src/services/gallery-service.js'));
    const { createApp } = await import('../src/app.js');
    server = http.createServer(createApp());
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing isolated HTTP listener');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
    manager?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('generates valid thumbnail/preview WebP once and preserves cached bytes, mtime, URLs and headers', async () => {
    const relativePath = 'Synthetic/swatch.png';
    const sourcePath = path.join(config.galleryRoot, relativePath);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await sharp({ create: { width: 960, height: 1440, channels: 3, background: '#345678' } })
      .png().toFile(sourcePath);
    const original = await fs.readFile(sourcePath);
    const sourceStat = await fs.stat(sourcePath);
    const folder = repos.folderRepository.upsert({ slug: 'synthetic', name: 'Synthetic', folderPath: 'Synthetic' });
    const image = repos.imageRepository.upsert({
      folderId: folder.id, filename: 'swatch.png', extension: '.png', relativePath, absolutePath: sourcePath,
      fileSize: sourceStat.size, width: 960, height: 1440, mediaType: 'image', mimeType: 'image/png',
      durationMs: null, isAnimated: false, fingerprint: 'synthetic-swatch', mtimeMs: sourceStat.mtimeMs,
      firstSeenAt: '2026-01-01T00:00:00.000Z', sortTimestamp: 1, takenAt: null, takenAtSource: 'mtime',
      exifJson: null, thumbnailPath: 'Synthetic/swatch.webp', previewPath: 'Synthetic/swatch.webp',
      playbackStrategy: 'preview'
    });
    const post = repos.postRepository.findByImageId(image.id)!;
    const detailBefore = gallery.getImageDetail(post.id)!;
    expect(detailBefore).not.toBeNull();
    const derivatives = [
      { url: detailBefore.thumbnailUrl, output: path.join(config.thumbnailsDir, image.thumbnail_path), width: 640, height: 960 },
      { url: detailBefore.previewUrl, output: path.join(config.previewsDir, image.preview_path), width: 960, height: 1440 }
    ];
    for (const derivative of derivatives) {
      await expect(fs.access(derivative.output)).rejects.toMatchObject({ code: 'ENOENT' });
      const first = await fetch(new URL(derivative.url, origin));
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toContain('image/webp');
      expect(first.headers.get('cache-control')).toBe('public, max-age=604800, immutable');
      const bytes = Buffer.from(await first.arrayBuffer());
      expect(await sharp(bytes).metadata()).toMatchObject({ format: 'webp', width: derivative.width, height: derivative.height });
      expect(await fs.readFile(derivative.output)).toEqual(bytes);
      const stat = await fs.stat(derivative.output, { bigint: true });

      const second = await fetch(new URL(derivative.url, origin));
      expect(second.status).toBe(200);
      expect(Buffer.from(await second.arrayBuffer())).toEqual(bytes);
      expect(second.headers.get('cache-control')).toBe(first.headers.get('cache-control'));
      expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
      expect((await fs.stat(derivative.output, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
    }
    const detailAfter = gallery.getImageDetail(post.id)!;
    expect([detailAfter.thumbnailUrl, detailAfter.previewUrl])
      .toEqual([detailBefore.thumbnailUrl, detailBefore.previewUrl]);
    expect(await fs.readFile(sourcePath)).toEqual(original);
    for (const prefix of ['thumbnails', 'previews']) {
      const response = await fetch(`${origin}/${prefix}/missing.webp`);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ message: 'Derivative not found.' });
    }
  });

  it('changes only changed media URLs and rejects obsolete versions instead of caching new pixels under them', async () => {
    const previous = repos.imageRepository.getByThumbnailPath('Synthetic/swatch.webp')!;
    const post = repos.postRepository.findByImageId(previous.id)!;
    const oldDetail = gallery.getImageDetail(post.id)!;
    const oldBytes = Buffer.from(await (await fetch(new URL(oldDetail.thumbnailUrl, origin))).arrayBuffer());
    await sharp({ create: { width: 1010, height: 1510, channels: 3, background: '#ee2211' } }).png().toFile(previous.absolute_path);
    const stat = await fs.stat(previous.absolute_path);
    manager.connection.prepare('UPDATE images SET file_size = ?, mtime_ms = ?, checksum_or_fingerprint = ? WHERE id = ?')
      .run(stat.size, stat.mtimeMs, 'changed-fixture', previous.id);
    const nextDetail = gallery.getImageDetail(post.id)!;
    expect(nextDetail.thumbnailUrl).not.toBe(oldDetail.thumbnailUrl);
    expect(nextDetail.previewUrl).not.toBe(oldDetail.previewUrl);
    const stale = await fetch(new URL(oldDetail.thumbnailUrl, origin));
    expect(stale.status).toBe(409);
    expect(stale.headers.get('cache-control')).toBe('no-store');
    const current = await fetch(new URL(nextDetail.thumbnailUrl, origin));
    expect(current.status).toBe(200);
    const currentBytes = Buffer.from(await current.arrayBuffer());
    expect(currentBytes).not.toEqual(oldBytes);
    expect(await sharp(currentBytes).metadata()).toMatchObject({ format: 'webp', width: 640 });
    manager.connection.prepare('UPDATE images SET caption = ?, sort_timestamp = ? WHERE id = ?').run('display only', 999, previous.id);
    expect(gallery.getImageDetail(post.id)!.thumbnailUrl).toBe(nextDetail.thumbnailUrl);
    const output = path.join(config.thumbnailsDir, previous.thumbnail_path);
    const generatedAt = (await fs.stat(output)).mtimeMs;
    const retry = await fetch(new URL(nextDetail.thumbnailUrl, origin));
    expect(retry.status).toBe(200);
    await retry.arrayBuffer();
    expect((await fs.stat(output)).mtimeMs).toBe(generatedAt);
    const legacy = await fetch(new URL(nextDetail.thumbnailUrl.split('?')[0]!, origin));
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('cache-control')).toBe('private, no-store');
    await legacy.arrayBuffer();
  });

  it('counts only published derivative media, including legacy cache, excluding sidecars and actual temporary names', async () => {
    const before = gallery.getStats();
    const thumb = path.join(config.thumbnailsDir, 'count-fixture');
    const preview = path.join(config.previewsDir, 'count-fixture');
    await fs.mkdir(path.join(thumb, 'nested'), { recursive: true });
    await fs.mkdir(preview, { recursive: true });
    const uuid = '12345678-1234-4234-8234-123456789abc';
    for (const [dir, names] of [[thumb, ['old.webp', 'nested/tmp-legitimate.webp', 'old.webp.version.json', `old.webp.version.json.${uuid}.tmp`, `.new.${uuid}.tmp.webp`, '.gitkeep', 'other.txt', 'invalid.mp4']], [preview, ['old.webp', 'old.mp4', 'a-tmp.mp4', `.new.${uuid}.tmp.mp4`, 'old.mp4.version.json', 'other.jpg']]] as const) {
      for (const name of names) await fs.writeFile(path.join(dir, name), 'fixture');
    }
    const during = gallery.getStats();
    expect(during.thumbnailCount - before.thumbnailCount).toBe(2);
    expect(during.previewCount - before.previewCount).toBe(3);
    await fs.rename(path.join(thumb, `.new.${uuid}.tmp.webp`), path.join(thumb, 'new.webp'));
    await fs.writeFile(path.join(thumb, 'new.webp.version.json'), '{}');
    expect(gallery.getStats().thumbnailCount - during.thumbnailCount).toBe(1);
  });

  it('serves reliable indexed A without statting source B; absent or unstamped A reports pending index without publishing B', async () => {
    const record = repos.imageRepository.getByThumbnailPath('Synthetic/swatch.webp')!;
    const { imageDerivativeVersion } = await import('../src/utils/derivative-version.js');
    const version = imageDerivativeVersion(record, 'thumbnail');
    const url = `${origin}/thumbnails/${record.thumbnail_path}?v=${version}`;
    const output = path.join(config.thumbnailsDir, record.thumbnail_path);
    const oldBytes = await fs.readFile(output);
    const oldStamp = await fs.readFile(`${output}.version.json`);
    await sharp({ create: { width: 1005, height: 1405, channels: 3, background: '#112233' } }).png().toFile(record.absolute_path);
    const reliable = await fetch(url);
    expect(reliable.status).toBe(200);
    expect(Buffer.from(await reliable.arrayBuffer())).toEqual(oldBytes);
    await fs.rm(`${output}.version.json`);
    const unknown = await fetch(url);
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
    expect(await fs.readFile(output)).toEqual(oldBytes);
    await expect(fs.access(`${output}.version.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(output);
    const missing = await fetch(url);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
    await expect(fs.access(output)).rejects.toMatchObject({ code: 'ENOENT' });
    // The controlled index update, not GET, restores generation.
    const stat = await fs.stat(record.absolute_path);
    manager.connection.prepare('UPDATE images SET file_size = ?, mtime_ms = ? WHERE id = ?').run(stat.size, stat.mtimeMs, record.id);
    const obsolete = await fetch(url);
    expect(await obsolete.json()).toMatchObject({ code: 'DERIVATIVE_VERSION_CHANGED' });
    const current = repos.imageRepository.getByThumbnailPath(record.thumbnail_path)!;
    const restored = await fetch(`${origin}/thumbnails/${record.thumbnail_path}?v=${imageDerivativeVersion(current, 'thumbnail')}`);
    expect(restored.status).toBe(200);
    expect(Buffer.from(await restored.arrayBuffer())).not.toEqual(oldBytes);
    expect(await fs.readFile(`${output}.version.json`)).not.toEqual(oldStamp);
  });
});
