import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// A real one-frame MPEG4/MP4 encoded from lavfi color. A standard free box below
// enlarges delivery without allocating an entire video or needing FFmpeg in CI.
const tinyVideo = Buffer.from('AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAA0Btb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACa3RyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAIAAAACAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAeNtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAABAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAGObWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABTnN0YmwAAADqc3RzZAAAAAAAAAABAAAA2m1wNHYAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAIAAgAEgAAABIAAAAAAAAAAETTGF2YzYxLjE5LjEwMCBtcGVnNAAAAAAAAAAAAAAAAAAY//8AAABgZXNkcwAAAAADgICATwABAASAgIBBIBEAAAAAAw1AAAABIAWAgIAvAAABsAEAAAG1iRMAAAEAAAABIADEjYgADQEEBBRDAAABskxhdmM2MS4xOS4xMDAGgICAAQIAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAMNQAAAASAAAAAYc3R0cwAAAAAAAAABAAAAAQAAQAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAAAJAAAAAEAAAAUc3RjbwAAAAAAAAABAAADbAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAAAIZnJlZQAAACxtZGF0AAABswAQBwAAAbYWBRgqG2B4BbG2378AAMJGCobYHgFsbbfv', 'base64');
let root: string;
let server: http.Server;
let origin: string;
let config: typeof import('../src/config/env.js')['appConfig'];
let db: typeof import('../src/db/database.js')['databaseManager'];
let repos: typeof import('../src/db/repositories.js');

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'derivative-slow-client-'));
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DERIVATIVE_MODE', 'lazy');
  vi.stubEnv('SCAN_DERIVATIVE_CONCURRENCY', '4');
  for (const name of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
    await fs.mkdir(path.join(root, name)); vi.stubEnv(name, path.join(root, name));
  }
  vi.resetModules();
  ({ appConfig: config } = await import('../src/config/env.js'));
  ({ databaseManager: db } = await import('../src/db/database.js'));
  repos = await import('../src/db/repositories.js');
  server = http.createServer((await import('../src/app.js')).createApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  db?.close(); vi.unstubAllEnvs(); vi.resetModules();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function media(name: string, video: boolean) {
  const source = path.join(config.galleryRoot, name);
  if (video) await fs.writeFile(source, tinyVideo);
  else await sharp({ create: { width: 960, height: 1440, channels: 3, background: '#987654' } }).png().toFile(source);
  const stat = await fs.stat(source);
  const folder = repos.folderRepository.upsert({ slug: 'fixture', name: 'Fixture', folderPath: '' });
  return repos.imageRepository.upsert({ folderId: folder.id, filename: name, extension: path.extname(name), relativePath: name,
    absolutePath: source, fileSize: stat.size, width: 32, height: 32, mediaType: video ? 'video' : 'image', mimeType: video ? 'video/mp4' : 'image/png',
    durationMs: video ? 1000 : null, isAnimated: false, fingerprint: name, mtimeMs: stat.mtimeMs, firstSeenAt: '2026-01-01', sortTimestamp: 1,
    takenAt: null, takenAtSource: 'mtime', exifJson: null, thumbnailPath: `${name}.webp`, previewPath: `${name}.${video ? 'mp4' : 'webp'}`, playbackStrategy: 'preview' });
}

it('attributes slow video wait to the output lease; other reads/generation work, abort and Range release all waiters', async () => {
  const { maintenanceOperationLock: global } = await import('../src/services/maintenance-operation-lock.js');
  const { writeVersionedDerivative, stampDerivative, imageDerivativeVersion } = await import('../src/utils/derivative-version.js');
  const generators = await import('../src/services/derivative-service.js');
  const video = await media('slow.mp4', true);
  const output = path.join(config.previewsDir, video.preview_path);
  await fs.copyFile(video.absolute_path, output);
  const free = Buffer.alloc(8); free.writeUInt32BE(64 * 1024 * 1024, 0); free.write('free', 4);
  await fs.appendFile(output, free);
  await fs.truncate(output, tinyVideo.length + 64 * 1024 * 1024);
  await stampDerivative(output, imageDerivativeVersion(video, 'preview'));
  const thumb = await media('hot.png', false);
  const cold = await media('cold.png', false);
  const thumbUrl = `${origin}/thumbnails/${thumb.thumbnail_path}?v=${imageDerivativeVersion(thumb, 'thumbnail')}`;
  await (await fetch(thumbUrl)).arrayBuffer();
  const videoUrl = `${origin}/previews/${video.preview_path}?v=${imageDerivativeVersion(video, 'preview')}`;
  let client!: http.ClientRequest;
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    client = http.get(videoUrl, incoming => { incoming.pause(); resolve(incoming); }); client.once('error', reject);
  });
  response.on('error', () => undefined);
  const events: Array<[string, number]> = [];
  const start = performance.now();
  const note = (name: string) => events.push([name, Math.round((performance.now() - start) * 100) / 100]);
  note('paused reader holds output read lease');
  let writerEntered = false;
  let maintained = false;
  let writing: Promise<unknown> | undefined;
  let maintenance: Promise<unknown> | undefined;
  const previewEncoder = vi.spyOn(generators, 'generatePreviewDerivative').mockImplementation(async (source, _relative, force, _overrides, expectation) => {
    // Only the codec is substituted by a copy of valid MP4 bytes. HTTP, p-limit,
    // singleflight, global lease, output lease and atomic writer are real.
    note('rebuild HTTP owns one limiter slot/global generation lease; waits output write lease');
    const generatedPreview = await writeVersionedDerivative(source, output, 'preview', 'video', force, async temporary => {
      writerEntered = true; note('same-output writer entered after read release'); await fs.copyFile(source, temporary);
    }, expectation);
    return { previewPath: video.preview_path, generatedPreview };
  });
  try {
    await global.runExclusive(async () => { note('maintenance with only hot reader: not blocked'); });
    await fs.rm(`${output}.version.json`);
    writing = fetch(videoUrl).then(async rebuilt => { expect(rebuilt.status).toBe(200); await rebuilt.arrayBuffer(); });
    await vi.waitFor(() => expect(previewEncoder).toHaveBeenCalledOnce());
    const hotStart = performance.now();
    const hot = await fetch(thumbUrl); expect(hot.status).toBe(200); await hot.arrayBuffer();
    note(`different hot thumbnail complete (${Math.round(performance.now() - hotStart)}ms)`);
    const coldResponse = await fetch(`${origin}/thumbnails/${cold.thumbnail_path}?v=${imageDerivativeVersion(cold, 'thumbnail')}`);
    expect(coldResponse.status).toBe(200); expect((await sharp(Buffer.from(await coldResponse.arrayBuffer())).metadata()).format).toBe('webp');
    note('different cold Sharp generation complete');
    maintenance = global.runExclusive(async () => { maintained = true; note('queued maintenance entered'); });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(writerEntered).toBe(false); expect(maintained).toBe(false);
    note('abort client'); client.destroy(); response.destroy();
    await Promise.all([writing, maintenance]);
    expect(writerEntered).toBe(true); expect(maintained).toBe(true);
    const ranged = await fetch(videoUrl, { headers: { Range: 'bytes=0-31' } });
    expect(ranged.status).toBe(206); expect(Buffer.from(await ranged.arrayBuffer())).toEqual(tinyVideo.subarray(0, 32));
    const invalid = await fetch(videoUrl, { headers: { Range: 'bytes=99999999-' } });
    expect(invalid.status).toBe(416); await invalid.text();
    await global.runGeneration(() => writeVersionedDerivative(video.absolute_path, output, 'preview', 'video', true, temporary => fs.copyFile(video.absolute_path, temporary)));
    note('Range/error follow-up write completed');
    console.info('SLOW_CLIENT_EVIDENCE', JSON.stringify({ bytes: tinyVideo.length + 64 * 1024 * 1024, events }));
  } finally {
    client.destroy(); response.destroy(); await Promise.allSettled([writing, maintenance].filter(Boolean));
    previewEncoder.mockRestore();
  }
});
