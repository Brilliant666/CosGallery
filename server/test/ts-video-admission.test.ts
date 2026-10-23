import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';
import type { MediaType } from '../src/types/models.js';
import type { MediaMetadata, DerivativePathOverrides } from '../src/services/derivative-service.js';

// The bytes and decoder responses are synthetic. Directory admission, filesystem
// moves, scanner indexing, Work identity and HTTP reads use their real implementations.
describe.sequential('isolated TS video directory admission', () => {
  let root: string;
  let waiting: string;
  let gallery: string;
  let creatorId: number;
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  let config: typeof import('../src/config/env.js')['appConfig'];
  let service: import('../src/services/local-admission-web-service.js').LocalAdmissionWebService;
  let createApp: typeof import('../src/app.js')['createApp'];
  const creator = 'Synthetic TS Creator';
  const filenames = ['01.ts', '02.TS', 'videos/03.ts', 'videos/04.TS'];

  const metadata = vi.fn(async (source: string, mediaType: MediaType): Promise<MediaMetadata> => {
    expect(mediaType).toBe('video');
    const bytes = await fs.readFile(source, 'utf8');
    const { assertTransportStreamVideoProbe } = await import('../src/utils/transport-stream.js');
    const probe = bytes.startsWith('export const')
      ? { format: { format_name: 'typescript' }, streams: [] }
      : bytes === 'synthetic audio-only transport stream'
        ? { format: { format_name: 'mpegts' }, streams: [{ codec_type: 'audio' }] }
        : { format: { format_name: 'mpegts' }, streams: [{ codec_type: 'video', width: 1920, height: 1080 }] };
    assertTransportStreamVideoProbe(source, probe);
    expect(bytes).toMatch(/^synthetic MPEG-TS video [1-4]$/);
    return { width: 1920, height: 1080, takenAt: null, exif: null, durationMs: 2500,
      mediaType: 'video', playbackStrategy: 'preview', isAnimated: false };
  });
  const thumbnail = vi.fn(async (_source: string, relativePath: string, _force = false, overrides: DerivativePathOverrides = {}) => {
    const { getThumbnailRelativePath } = await import('../src/utils/image-utils.js');
    const thumbnailPath = overrides.thumbnailPath ?? getThumbnailRelativePath(relativePath);
    const output = path.join(config.thumbnailsDir, thumbnailPath);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, 'synthetic mocked video thumbnail');
    return { thumbnailPath, generatedThumbnail: true };
  });

  beforeEach(async () => {
    vi.resetModules();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-ts-admission-'));
    waiting = path.join(root, 'cos等待入库');
    gallery = path.join(root, 'gallery');
    for (const [key, value] of Object.entries({ NODE_ENV: 'test', COS_GALLERY_MODE: '1', PUBLIC_DEMO_MODE: '0',
      DERIVATIVE_MODE: 'lazy', SCAN_MEDIA_ERROR_MODE: 'fail', SCAN_DISCOVERY_CONCURRENCY: '1',
      DATA_ROOT: path.join(root, 'data'), DB_DIR: path.join(root, 'db'), GALLERY_ROOT: gallery,
      THUMBNAILS_DIR: path.join(root, 'thumbnails'), PREVIEWS_DIR: path.join(root, 'previews'),
      APP_ENV_FILE: path.join(root, 'absent.env'), APP_RUN_CONFIG_FILE: path.join(root, 'absent.run.xml') })) vi.stubEnv(key, value);
    await Promise.all([fs.mkdir(path.join(waiting, creator), { recursive: true }), fs.mkdir(gallery, { recursive: true })]);
    ({ databaseManager: manager } = await import('../src/db/database.js'));
    ({ appConfig: config } = await import('../src/config/env.js'));
    const derivatives = await import('../src/services/derivative-service.js');
    metadata.mockClear();
    thumbnail.mockClear();
    vi.spyOn(derivatives, 'readMediaMetadata').mockImplementation(metadata);
    vi.spyOn(derivatives, 'generateThumbnailDerivative').mockImplementation(thumbnail);
    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    creatorId = new ManagedCreatorService(manager.connection, gallery).create({ name: creator, rating: 'R15', preference: 'liked' }).id;
    const { LocalAdmissionWebService } = await import('../src/services/local-admission-web-service.js');
    service = new LocalAdmissionWebService(manager.connection, gallery);
    ({ createApp } = await import('../src/app.js'));
  }, 30_000);

  afterEach(async () => {
    await service?.waitForIdle();
    vi.restoreAllMocks();
    manager?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('cosgallery-ts-admission-')) {
      throw new Error('Refusing cleanup outside the isolated TS admission fixture');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });

  const count = (table: string) => Number(manager.connection.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
  const identityCounts = () => ['archive_catalog_works', 'archive_catalog_local_works', 'posts', 'images'].map(count);
  async function make(name: string, files: Record<string, string>) {
    for (const [filename, bytes] of Object.entries(files)) {
      const file = path.join(waiting, creator, name, filename);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
    }
  }
  const execution = (batch: Awaited<ReturnType<typeof service.preview>>) => ({ requestKey: randomUUID(), confirmed: true,
    acceptExistingVersion: true, actions: batch.items.map(item => ({ key: item.key, action: 'new', displayTitle: item.displayTitle })) });
  const checkpoint = (id: string) => manager.connection.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=?').get(id)!;
  const savedPlan = (id: string) => manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(id)!;

  it('previews four TS files without decoding, indexes one independent Work and safely replays original bytes', async () => {
    const name = 'NO.001 Pure Transport Streams [4V]';
    const originals = Object.fromEntries(filenames.map((filename, index) => [filename, `synthetic MPEG-TS video ${index + 1}`]));
    await make(name, originals);
    // Keep the waiting parent available for raw-plan replay after the web flow's
    // optional empty-parent cleanup; this file is outside the confirmed Work.
    const parentAttachment = path.join(waiting, creator, 'unrelated-parent-note.txt');
    await fs.writeFile(parentAttachment, 'synthetic unrelated attachment');
    const sourcePaths = filenames.map(filename => path.join(waiting, creator, name, filename));
    const originalStats = await Promise.all(sourcePaths.map(file => fs.stat(file, { bigint: true })));
    const reads = vi.spyOn(fs, 'readFile');
    let batch: Awaited<ReturnType<typeof service.preview>>;
    try {
      batch = await service.preview({ creatorId, parent: creator, directories: [name] });
      expect(reads.mock.calls.filter(([file]) => sourcePaths.includes(String(file)))).toHaveLength(0);
    } finally { reads.mockRestore(); }
    expect(batch!.items[0].summary).toMatchObject({ images: 0, videos: 4, other: 0 });
    expect(batch!.state).toBe('draft');
    expect(metadata).not.toHaveBeenCalled();
    expect(thumbnail).not.toHaveBeenCalled();
    expect(identityCounts()).toEqual([0, 0, 0, 0]);
    expect(savedPlan(batch!.id)).toBeUndefined();
    const request = execution(batch!);
    await service.execute(batch!.id, request);
    await service.waitForIdle();
    expect(service.get(batch!.id).state).toBe('completed');
    expect(identityCounts()).toEqual([1, 1, 1, 4]);
    const item = service.items(batch!.id).items[0];
    expect(item).toMatchObject({ state: 'completed', executionState: 'completed' });
    const work = manager.connection.prepare('SELECT * FROM archive_catalog_works').get()!;
    const local = manager.connection.prepare('SELECT * FROM archive_catalog_local_works').get()!;
    const post = manager.connection.prepare('SELECT * FROM posts').get()!;
    expect(local).toMatchObject({ work_id: work.id, post_id: post.id, image_count: 0, video_count: 4 });
    expect(work.primary_local_work_id).toBe(local.id);
    expect(post.post_type).toBe('carousel');
    const media = manager.connection.prepare('SELECT * FROM images ORDER BY relative_path').all();
    expect(media).toHaveLength(4);
    expect(media.every(row => row.media_type === 'video' && row.mime_type === 'video/mp2t' && row.playback_strategy === 'preview')).toBe(true);
    expect(manager.connection.prepare('SELECT image_id, position FROM post_items WHERE post_id=? ORDER BY position').all(Number(post.id)))
      .toEqual(media.map((row, index) => ({ image_id: row.id, position: index + 1 })));
    for (const table of ['archive_catalog_source_works', 'archive_catalog_download_tasks', 'local_ingest_jobs']) expect(count(table)).toBe(0);
    expect(metadata).toHaveBeenCalledTimes(4);
    expect(thumbnail).not.toHaveBeenCalled();

    const app = createApp();
    const works = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${creatorId}/works?page=1&limit=10`);
    expect(works.status).toBe(200);
    expect(works.body.items).toHaveLength(1);
    expect(works.body.items[0]).toMatchObject({ imageCount: 0, videoCount: 4, itemCount: 4 });
    const detail = await requestTestApp(app, 'GET', `/api/posts/${post.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ postType: 'carousel', itemCount: 4 });
    expect(detail.body.mediaItems.map((row: { mediaType: string; mimeType: string }) => [row.mediaType, row.mimeType]))
      .toEqual(filenames.map(() => ['video', 'video/mp2t']));
    const reels = await requestTestApp(app, 'GET', '/api/reels?page=1&limit=10&mode=recent&seed=1');
    expect(reels.status).toBe(200);
    expect(reels.body.items).toHaveLength(4);
    expect(new Set(reels.body.items.map((row: { postId: number }) => row.postId))).toEqual(new Set([post.id]));
    expect(new Set(reels.body.items.map((row: { mediaId: number }) => row.mediaId))).toEqual(new Set(media.map(row => row.id)));
    for (const row of media) {
      const playback = await requestTestApp(app, 'GET', `/api/reels/media/${row.id}/playback`);
      expect(playback.status).toBe(200);
      expect(playback.body.originalMimeType).toBe('video/mp2t');
      const original = await requestTestApp(app, 'GET', playback.body.originalUrl);
      expect(original.status).toBe(200);
      expect(original.headers.get('content-type')).toBe('video/mp2t');
      const filename = String(row.relative_path).slice(`${creator}/${name}/`.length);
      expect(original.body).toBe(originals[filename]);
    }
    const target = path.join(gallery, creator, name);
    for (const [index, filename] of filenames.entries()) {
      expect(await fs.readFile(path.join(target, filename), 'utf8')).toBe(originals[filename]);
      const current = await fs.stat(path.join(target, filename), { bigint: true });
      expect([current.dev, current.ino, current.size, current.mtimeNs]).toEqual([
        originalStats[index].dev, originalStats[index].ino, originalStats[index].size, originalStats[index].mtimeNs]);
    }
    await expect(fs.stat(path.join(waiting, creator, name))).rejects.toMatchObject({ code: 'ENOENT' });
    const immutable = savedPlan(batch!.id);
    const indexed = manager.connection.prepare('SELECT * FROM images ORDER BY id').all();
    const decisions = manager.connection.prepare('SELECT * FROM archive_catalog_work_decisions ORDER BY id').all();
    expect((await service.execute(batch!.id, request)).state).toBe('completed');
    const { LocalFolderAdmissionService } = await import('../src/services/local-folder-admission-service.js');
    expect((await new LocalFolderAdmissionService(manager.connection, gallery).apply(JSON.parse(String(immutable.payload_json)))).completed).toBe(true);
    expect(identityCounts()).toEqual([1, 1, 1, 4]);
    expect(savedPlan(batch!.id)).toEqual(immutable);
    expect(manager.connection.prepare('SELECT * FROM images ORDER BY id').all()).toEqual(indexed);
    expect(manager.connection.prepare('SELECT * FROM archive_catalog_work_decisions ORDER BY id').all()).toEqual(decisions);
    for (const filename of filenames) expect(await fs.readFile(path.join(target, filename), 'utf8')).toBe(originals[filename]);
    expect(await fs.readFile(parentAttachment, 'utf8')).toBe('synthetic unrelated attachment');
    expect(metadata).toHaveBeenCalledTimes(4);
    expect(thumbnail).not.toHaveBeenCalled();
  });

  it('refreshes an unconfirmed historical unsupported-TS draft without rewriting its evidence or decoding files', async () => {
    const name = 'NO.003 Historical TS Draft';
    const originals = Object.fromEntries(filenames.map((filename, index) => [filename, `synthetic MPEG-TS video ${index + 1}`]));
    await make(name, originals);
    const batch = await service.preview({ creatorId, parent: creator, directories: [name] });
    const db = manager.connection;
    const old = db.prepare('SELECT summary_json FROM local_admission_web_items WHERE batch_id=?').get(batch.id)!;
    const legacy = JSON.parse(String(old.summary_json));
    legacy.summary = { ...legacy.summary, images: 0, videos: 0, other: 4 };
    legacy.group = 'D';
    legacy.targetPath = '';
    legacy.reviewIssues = ['read_error'];
    legacy.conflicts = ['No supported media found; nothing admitted'];
    db.prepare('UPDATE local_admission_web_items SET summary_json=?,preview_json=NULL WHERE batch_id=?').run(JSON.stringify(legacy), batch.id);
    const saved = db.prepare('SELECT * FROM local_admission_web_items WHERE batch_id=?').get(batch.id);
    const next = await service.repreview(batch.id, [batch.items[0].key]);
    expect(next.id).not.toBe(batch.id);
    expect(next.state).toBe('draft');
    expect(next.items[0].summary).toMatchObject({ images: 0, videos: 4, other: 0 });
    expect(next.items[0].conflicts).not.toContain('No supported media found; nothing admitted');
    expect(db.prepare('SELECT * FROM local_admission_web_items WHERE batch_id=?').get(batch.id)).toEqual(saved);
    expect(identityCounts()).toEqual([0, 0, 0, 0]);
    expect(count('archive_local_admission_plans')).toBe(0);
    expect(metadata).not.toHaveBeenCalled();
    expect(thumbnail).not.toHaveBeenCalled();
    for (const filename of filenames) expect(await fs.readFile(path.join(waiting, creator, name, filename), 'utf8')).toBe(originals[filename]);
  });

  it.each([
    ['disguised TypeScript', 'export const example = 1;'],
    ['audio-only TS', 'synthetic audio-only transport stream']
  ])('keeps the immutable plan unfinished after the decoder rejects %s', async (_kind, bytes) => {
    const error = 'MPEG-TS 文件未检测到有效视频流，或实际容器格式不匹配';
    const name = 'NO.002 Invalid Transport Stream';
    await make(name, { 'invalid.TS': bytes });
    const batch = await service.preview({ creatorId, parent: creator, directories: [name] });
    expect(batch.items[0].summary).toMatchObject({ images: 0, videos: 1, other: 0 });
    expect(metadata).not.toHaveBeenCalled();
    await service.execute(batch.id, execution(batch));
    await service.waitForIdle();
    expect(service.get(batch.id).state).toBe('needs_review');
    expect(service.get(batch.id).error).toContain(error);
    expect(checkpoint(batch.id)).toMatchObject({ state: 'files_verified' });
    expect(checkpoint(batch.id).last_error).toContain(error);
    const { decodeAdmissionIssue } = await import('../src/services/local-admission-execution-issue.js');
    expect(decodeAdmissionIssue(checkpoint(batch.id).last_error)).toMatchObject({ kind: 'system', code: 'ADMISSION_EXECUTION_PAUSED' });
    expect(manager.connection.prepare('SELECT status FROM scan_runs ORDER BY id DESC LIMIT 1').get()?.status).toBe('failed');
    expect(identityCounts()).toEqual([1, 1, 0, 0]);
    expect(thumbnail).not.toHaveBeenCalled();
    const immutable = savedPlan(batch.id);
    const confirmed = manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(batch.id);
    const originalCheckpoint = checkpoint(batch.id);
    const target = path.join(gallery, creator, name, 'invalid.TS');
    expect(await fs.readFile(target, 'utf8')).toBe(bytes);
    await expect(service.repreview(batch.id)).rejects.toThrow('原计划');
    service.resume(batch.id, { requestKey: randomUUID(), confirmed: true });
    await service.waitForIdle();
    expect(service.get(batch.id).state).toBe('needs_review');
    expect(checkpoint(batch.id)).toMatchObject({ state: 'files_verified', work_id: originalCheckpoint.work_id, local_work_id: originalCheckpoint.local_work_id });
    expect(savedPlan(batch.id)).toEqual(immutable);
    expect(manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(batch.id)).toEqual(confirmed);
    expect(identityCounts()).toEqual([1, 1, 0, 0]);
    expect(await fs.readFile(target, 'utf8')).toBe(bytes);
    expect(count('archive_local_admission_plans')).toBe(1);
  });
});
