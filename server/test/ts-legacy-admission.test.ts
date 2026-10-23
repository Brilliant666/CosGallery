import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdmissionPlan } from '../src/services/local-folder-admission-service.js';
import type { MediaMetadata } from '../src/services/derivative-service.js';

describe.sequential('legacy mixed-image TS admission evidence', () => {
  let root: string;
  let input: string;
  let gallery: string;
  let creatorId: number;
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  let admission: typeof import('../src/services/local-folder-admission-service.js');
  let service: import('../src/services/local-folder-admission-service.js').LocalFolderAdmissionService;
  const creator = 'Synthetic Legacy TS Creator';
  const videoBytes = 'synthetic MPEG-TS legacy video';
  const videoMetadata = vi.fn(async (source: string): Promise<MediaMetadata> => {
    expect(await fs.readFile(source, 'utf8')).toBe(videoBytes);
    const { assertTransportStreamVideoProbe } = await import('../src/utils/transport-stream.js');
    assertTransportStreamVideoProbe(source, { format: { format_name: 'mpegts' },
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }] });
    return { width: 1920, height: 1080, takenAt: null, exif: null, durationMs: 2500,
      mediaType: 'video', playbackStrategy: 'preview', isAnimated: false };
  });

  beforeEach(async () => {
    vi.resetModules();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-ts-legacy-admission-'));
    input = path.join(root, 'waiting', creator);
    gallery = path.join(root, 'gallery');
    for (const [key, value] of Object.entries({ NODE_ENV: 'test', COS_GALLERY_MODE: '1', PUBLIC_DEMO_MODE: '0',
      DERIVATIVE_MODE: 'lazy', SCAN_MEDIA_ERROR_MODE: 'fail', SCAN_DISCOVERY_CONCURRENCY: '1',
      DATA_ROOT: path.join(root, 'data'), DB_DIR: path.join(root, 'db'), GALLERY_ROOT: gallery,
      THUMBNAILS_DIR: path.join(root, 'thumbnails'), PREVIEWS_DIR: path.join(root, 'previews'),
      APP_ENV_FILE: path.join(root, 'absent.env'), APP_RUN_CONFIG_FILE: path.join(root, 'absent.run.xml') })) vi.stubEnv(key, value);
    await Promise.all([fs.mkdir(input, { recursive: true }), fs.mkdir(gallery, { recursive: true })]);
    ({ databaseManager: manager } = await import('../src/db/database.js'));
    const derivatives = await import('../src/services/derivative-service.js');
    const readMediaMetadata = derivatives.readMediaMetadata;
    videoMetadata.mockClear();
    // JPEG decoding is real; the TS decoder response is synthetic and passes the
    // production MPEG-TS validation helper. Lazy scans must not invoke FFmpeg.
    vi.spyOn(derivatives, 'readMediaMetadata').mockImplementation((source, type, options) =>
      path.extname(source).toLowerCase() === '.ts' ? videoMetadata(source) : readMediaMetadata(source, type, options));
    vi.spyOn(derivatives, 'generateThumbnailDerivative').mockImplementation(async () => { throw new Error('Unexpected eager derivative generation'); });
    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    creatorId = new ManagedCreatorService(manager.connection, gallery).create({ name: creator, rating: 'R15', preference: 'liked' }).id;
    admission = await import('../src/services/local-folder-admission-service.js');
    service = new admission.LocalFolderAdmissionService(manager.connection, gallery);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    manager?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('cosgallery-ts-legacy-admission-')) {
      throw new Error('Refusing cleanup outside the isolated legacy TS fixture');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });

  const counts = () => ['archive_catalog_works', 'archive_catalog_local_works', 'posts', 'images'].map(table =>
    Number(manager.connection.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n));
  const evidence = (plan: AdmissionPlan) => ({
    plan: manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(plan.planId),
    manifest: manager.connection.prepare('SELECT manifest_json FROM archive_local_admission_items WHERE plan_id=?').get(plan.planId)
  });

  async function legacy(state: 'planned' | 'files_verified' | 'completed') {
    const name = `Legacy Mixed Work ${state}`;
    const source = path.join(input, name);
    await fs.mkdir(source);
    await sharp({ create: { width: 12, height: 18, channels: 3, background: '#2468aa' } }).jpeg().toFile(path.join(source, 'photo.jpg'));
    await fs.writeFile(path.join(source, 'legacy.TS'), videoBytes);
    // An exactly representable timestamp lets the replacement test keep mtime
    // unchanged while proving that the original inode still matters.
    const fixedTime = new Date('2026-01-01T00:00:00.000Z');
    await fs.utimes(path.join(source, 'legacy.TS'), fixedTime, fixedTime);
    const preview = await service.preview({ creatorId, inputRoot: input, directories: [name] });
    expect(preview.items[0].review.summary).toMatchObject({ images: 1, videos: 1 });
    const plan = admission.admissionPlanSchema.parse({ ...preview, confirmed: true, items: preview.items.map(item => ({ ...item,
      reason: 'Historical confirmation of the entire mixed directory',
      manifest: item.manifest.map(entry => entry.relativePath === 'legacy.TS' ? { ...entry, kind: 'other' } : entry)
    })) });
    const item = plan.items[0];
    const payload = JSON.stringify(plan);
    manager.connection.prepare('INSERT INTO archive_local_admission_plans(plan_id,payload_json,content_hash) VALUES(?,?,?)')
      .run(plan.planId, payload, createHash('sha256').update(payload).digest('hex'));
    const { WorkIdentityService } = await import('../src/services/work-identity-service.js');
    const identity = new WorkIdentityService(manager.connection);
    const mapped = state === 'planned' ? null : identity.registerLocal({ creatorId, rootPath: gallery, creatorFolderName: plan.creatorDirectory,
      absolutePath: item.targetPath, relativePath: path.relative(gallery, item.targetPath), title: item.displayTitle,
      reason: item.reason, key: `${plan.planId}:${item.key}`, localOnly: false });
    manager.connection.prepare('INSERT INTO archive_local_admission_items(plan_id,item_key,state,manifest_json,work_id,local_work_id) VALUES(?,?,?,?,?,?)')
      .run(plan.planId, item.key, state, JSON.stringify(item.manifest), mapped?.workId ?? null, mapped?.localWorkId ?? null);
    if (mapped) {
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true });
      await fs.rename(source, item.targetPath);
    }
    if (state === 'completed') {
      // Seed the old scanner's image-only index. The TS attachment is temporarily
      // hidden only inside this fixture, then restored before any replay check.
      const video = path.join(item.targetPath, 'legacy.TS');
      const hidden = path.join(item.targetPath, '.legacy-ts-kept');
      const { scannerService } = await import('../src/services/scanner-service.js');
      await fs.rename(video, hidden);
      try {
        expect((await scannerService.scanCosCreators([creator], 'isolated-legacy-index', { workFolderName: name }))?.status).toBe('completed');
      } finally { await fs.rename(hidden, video); }
      const post = manager.connection.prepare('SELECT id,folder_id FROM posts WHERE source_path=?').get(`${creator}/${name}`)!;
      const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
      new ManagedCreatorService(manager.connection, gallery).linkFolder(Number(post.folder_id), { creatorId });
      identity.attachPost(mapped!.localWorkId, Number(post.id));
    }
    return { plan, name, directory: mapped ? item.targetPath : source };
  }

  it.each(['planned', 'files_verified', 'completed'] as const)('resumes a historical %s checkpoint without rewriting other/TS evidence', async state => {
    const { plan, directory } = await legacy(state);
    const immutable = evidence(plan);
    const original = await fs.stat(path.join(directory, 'legacy.TS'), { bigint: true });
    if (state === 'planned') await service.verifyUnstarted(plan);
    expect((await service.apply(plan)).completed).toBe(true);
    const expected = [1, 1, 1, state === 'completed' ? 1 : 2];
    expect(counts()).toEqual(expected);
    expect(evidence(plan)).toEqual(immutable);
    expect(JSON.parse(String(immutable.manifest!.manifest_json)).find((entry: { relativePath: string }) => entry.relativePath === 'legacy.TS').kind).toBe('other');
    const target = path.join(plan.items[0].targetPath, 'legacy.TS');
    expect(await fs.readFile(target, 'utf8')).toBe(videoBytes);
    const after = await fs.stat(target, { bigint: true });
    expect([after.dev, after.ino, after.size, after.mtimeNs]).toEqual([original.dev, original.ino, original.size, original.mtimeNs]);
    const decisions = manager.connection.prepare('SELECT * FROM archive_catalog_work_decisions ORDER BY id').all();
    const indexed = manager.connection.prepare('SELECT * FROM images ORDER BY id').all();
    const decodeCount = videoMetadata.mock.calls.length;
    expect((await service.apply(plan)).completed).toBe(true);
    expect(counts()).toEqual(expected);
    expect(evidence(plan)).toEqual(immutable);
    expect(manager.connection.prepare('SELECT * FROM archive_catalog_work_decisions ORDER BY id').all()).toEqual(decisions);
    expect(manager.connection.prepare('SELECT * FROM images ORDER BY id').all()).toEqual(indexed);
    expect(videoMetadata).toHaveBeenCalledTimes(decodeCount);
    if (state === 'completed') expect(videoMetadata).not.toHaveBeenCalled();
  });

  it.each(['size', 'inode', 'mtime'] as const)('normalizes historical review baseline kinds while still detecting a changed TS %s', async fact => {
    const { plan, directory } = await legacy('planned');
    const manifest = plan.items[0].manifest;
    const baseline = JSON.stringify(manifest);
    const immutable = evidence(plan);
    expect(await admission.inventoryPlannedDirectory(directory, manifest)).toEqual(manifest);
    expect(await admission.inventoryAdmissionDirectory(directory)).not.toEqual(manifest);
    const video = path.join(directory, 'legacy.TS');
    const original = await fs.stat(video, { bigint: true });
    if (fact === 'size') await fs.appendFile(video, ' changed bytes');
    if (fact === 'mtime') await fs.utimes(video, new Date(), new Date('2026-01-01T00:01:00.000Z'));
    if (fact === 'inode') {
      await fs.rename(video, path.join(root, 'retired-source.TS'));
      await fs.writeFile(video, videoBytes);
      const fixedTime = new Date('2026-01-01T00:00:00.000Z');
      await fs.utimes(video, fixedTime, fixedTime);
      const replacement = await fs.stat(video, { bigint: true });
      expect(replacement.ino).not.toBe(original.ino);
      expect([replacement.dev, replacement.size, replacement.mtimeNs]).toEqual([original.dev, original.size, original.mtimeNs]);
    }
    const observed = await admission.inventoryPlannedDirectory(directory, manifest);
    expect(observed.find(entry => entry.relativePath === 'legacy.TS')?.kind).toBe('other');
    expect(observed).not.toEqual(manifest);
    expect(JSON.stringify(manifest)).toBe(baseline);
    await expect(service.verifyUnstarted(plan)).rejects.toThrow('Source changed since preview');
    await expect(service.apply(plan)).rejects.toThrow('Directory changed since confirmation');
    expect(evidence(plan)).toEqual(immutable);
    expect(counts()).toEqual([0, 0, 0, 0]);
    expect(videoMetadata).not.toHaveBeenCalled();
  });

  it('rejects changed legacy TS bytes at the moved checkpoint and keeps its original plan', async () => {
    const { plan, directory } = await legacy('files_verified');
    const immutable = evidence(plan);
    await fs.writeFile(path.join(directory, 'legacy.TS'), 'changed legacy TS content with a different size');
    await expect(service.apply(plan)).rejects.toThrow('Target or saved attachments changed');
    expect(evidence(plan)).toEqual(immutable);
    expect(manager.connection.prepare('SELECT state FROM archive_local_admission_items WHERE plan_id=?').get(plan.planId)?.state).toBe('files_verified');
    expect(counts()).toEqual([1, 1, 0, 0]);
    expect(videoMetadata).not.toHaveBeenCalled();
  });
});
