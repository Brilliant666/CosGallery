import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFingerprint, getMediaTypeFromExtension, getMimeTypeFromExtension, getPreviewRelativePath, getThumbnailRelativePath } from '../src/utils/image-utils.js';

type AppConfigModule = typeof import('../src/config/env.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type FolderRecord = import('../src/types/models.js').FolderRecord;
type ImageRecord = import('../src/types/models.js').ImageRecord;

describe.sequential('retired legacy folder deletion', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let folderRepository: RepositoriesModule['folderRepository'];
  let imageRepository: RepositoriesModule['imageRepository'];
  let postRepository: RepositoriesModule['postRepository'];
  let folderScanStateRepository: RepositoriesModule['folderScanStateRepository'];
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-retired-delete-'));
    vi.stubEnv('NODE_ENV', 'test');
    for (const [key, child] of Object.entries({ DATA_ROOT: 'data', GALLERY_ROOT: 'gallery', DB_DIR: 'db', THUMBNAILS_DIR: 'thumbnails', PREVIEWS_DIR: 'previews', BACKUP_ROOT: 'backups' })) vi.stubEnv(key, path.join(tempRoot, child));
    vi.resetModules();
    ({ appConfig } = await import('../src/config/env.js'));
    ({ folderRepository, imageRepository, postRepository, folderScanStateRepository } = await import('../src/db/repositories.js'));
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected isolated TCP listener');
    origin = 'http://127.0.0.1:' + address.port;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const { databaseManager } = await import('../src/db/database.js');
    databaseManager.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const { databaseManager } = await import('../src/db/database.js');
    databaseManager.connection.exec('PRAGMA foreign_keys=ON');
    expect(databaseManager.connection.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });
  async function seedFixture() {
    const { databaseManager } = await import('../src/db/database.js');
    const db = databaseManager.connection;
    const owner = await createIndexedFolder('retired', ['parent.jpg']);
    await createIndexedFolder('retired/ordinary', ['ordinary.jpg']);
    await createIndexedFolder('retired/owned', ['owned.mp4'], { role: 'carousel_source', carouselOwnerFolderId: owner.folder.id });
    await fs.writeFile(path.join(appConfig.galleryRoot, 'retired', 'notes.txt'), 'synthetic attachment');
    const post = postRepository.upsertPostWithItems({ folderId: owner.folder.id, sourcePath: 'retired/parent.jpg', postType: 'single', sortTimestamp: 1700000000000, isDeleted: 0, isTrashed: 0 }, [{ imageId: owner.images[0].id, position: 1 }]);
    if (!db.prepare('SELECT id FROM archive_catalog_local_works LIMIT 1').get()) {
      const local = db.prepare("INSERT INTO archive_catalog_local_creator_folders(root_path,relative_path,absolute_path,folder_name,match_status,scanned_at,gallery_folder_id) VALUES(?,?,?,?, 'unmatched',CURRENT_TIMESTAMP,?)").run(appConfig.galleryRoot,'retired',path.join(appConfig.galleryRoot,'retired'),'retired',owner.folder.id);
      db.prepare("INSERT INTO archive_catalog_local_works(local_creator_folder_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(?,?,?,?,?,'unmatched',CURRENT_TIMESTAMP)").run(Number(local.lastInsertRowid),post.id,'parent.jpg',owner.images[0].absolute_path,'parent.jpg');
    }
  }
  async function snapshot() {
    const { databaseManager } = await import('../src/db/database.js');
    const db = databaseManager.connection;
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
    const rows = tables.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]);
    const files: Record<string, string> = {};
    for (const root of [appConfig.galleryRoot, appConfig.thumbnailsDir, appConfig.previewsDir]) {
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const target = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(target);
          else files[target] = createHash('sha256').update(await fs.readFile(target)).digest('hex');
        }
      };
      await walk(root);
    }
    return { rows, files };
  }
  it('removes the internal destructive method without changing single-post deletion', async () => {
    const { galleryService } = await import('../src/services/gallery-service.js');
    expect('deleteFolder' in galleryService).toBe(false);
    expect(typeof galleryService.deleteImage).toBe('function');
  });
  it.each(['', '?deleteSourceFolder=true', '?deleteSourceFolder=false'])('returns stable 410 without file or database mutations, including repeats (%s)', async suffix => {
    await seedFixture();
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(origin + '/api/folders/retired' + suffix, { method: 'DELETE', headers: { 'x-foldergram-intent': '1' } });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: 'LEGACY_FOLDER_DELETE_RETIRED' });
      expect(await snapshot()).toEqual(before);
    }
  });
  it('returns retirement even for a missing folder, without a new lookup path', async () => {
    const response = await fetch(origin + '/api/folders/not-present?deleteSourceFolder=true', { method: 'DELETE', headers: { 'x-foldergram-intent': '1' } });
    expect(response.status).toBe(410);
  });
  it('also protects legacy folders without any LocalWork reference', async () => {
    await createIndexedFolder('unreferenced', ['legacy.jpg']);
    const before = await snapshot();
    for (const suffix of ['', '?deleteSourceFolder=true']) {
      const response = await fetch(origin + '/api/folders/unreferenced' + suffix, { method: 'DELETE', headers: { 'x-foldergram-intent': '1' } });
      expect(response.status).toBe(410);
      expect(await snapshot()).toEqual(before);
    }
  });
  it('retains mutation intent and parameter validation', async () => {
    expect((await fetch(origin + '/api/folders/retired', { method: 'DELETE' })).status).toBe(403);
    expect((await fetch(origin + '/api/folders/retired?deleteSourceFolder=invalid', { method: 'DELETE', headers: { 'x-foldergram-intent': '1' } })).status).toBe(400);
  });
  it('retains authentication and viewer prohibition, while admins receive 410 with protection enabled', async () => {
    await seedFixture();
    const { authService } = await import('../src/services/auth-service.js');
    authService.setAdminPassword('isolated-admin-only');
    authService.setViewerAccess('password', 'isolated-viewer-only');
    const before = await snapshot();
    const headers: Record<string, string> = { 'x-foldergram-intent': '1' };
    expect((await fetch(origin + '/api/folders/retired', { method: 'DELETE', headers })).status).toBe(401);
    for (const [password, expected] of [['isolated-viewer-only', 403], ['isolated-admin-only', 410]] as const) {
      const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const response = await fetch(origin + '/api/folders/retired?deleteSourceFolder=true', { method: 'DELETE', headers: { ...headers, cookie } });
      expect(response.status).toBe(expected);
      if (expected === 410) expect(await response.json()).toMatchObject({ code: 'LEGACY_FOLDER_DELETE_RETIRED' });
    }
    expect(await snapshot()).toEqual(before);
  });

  async function createIndexedFolder(
    relativeFolderPath: string,
    filenames: string[],
    options: { role?: 'normal' | 'carousel_source'; carouselOwnerFolderId?: number | null } = {}
  ): Promise<{
    folder: FolderRecord;
    images: ImageRecord[];
  }> {
    const slug = relativeFolderPath.replaceAll('/', '-');
    const folderName = path.posix.basename(relativeFolderPath);
    const folder = folderRepository.upsert({
      slug,
      name: folderName,
      folderPath: relativeFolderPath,
      role: options.role,
      carouselOwnerFolderId: options.carouselOwnerFolderId
    });
    const images: ImageRecord[] = [];

    for (const [index, filename] of filenames.entries()) {
      const relativePath = `${relativeFolderPath}/${filename}`;
      const absolutePath = path.join(appConfig.galleryRoot, relativePath);
      const extension = path.extname(filename).toLowerCase();
      const mediaType = getMediaTypeFromExtension(extension);
      const thumbnailRelativePath = getThumbnailRelativePath(relativePath);
      const previewRelativePath = getPreviewRelativePath(relativePath, mediaType);
      const thumbnailPath = path.join(appConfig.thumbnailsDir, thumbnailRelativePath);
      const previewPath = path.join(appConfig.previewsDir, previewRelativePath);

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
      await fs.mkdir(path.dirname(previewPath), { recursive: true });
      await fs.writeFile(absolutePath, `source:${relativePath}`);
      await fs.writeFile(thumbnailPath, `thumb:${relativePath}`);
      await fs.writeFile(previewPath, `preview:${relativePath}`);

      const fileSize = Buffer.byteLength(`source:${relativePath}`);
      const mtimeMs = 1_700_000_000_000 + index;
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
        durationMs: mediaType === 'video' ? 15_000 : null,
        fingerprint: createFingerprint(relativePath, fileSize, mtimeMs),
        mtimeMs,
        firstSeenAt: '2026-03-01T00:00:00.000Z',
        sortTimestamp: mtimeMs,
        takenAt: mtimeMs,
        takenAtSource: 'mtime',
        exifJson: mediaType === 'image' ? '{}' : null,
        thumbnailPath: thumbnailRelativePath,
        previewPath: previewRelativePath
      });

      images.push(image);
    }

    folderRepository.setAvatar(folder.id, images.at(0)?.id ?? null);
    folderScanStateRepository.upsert({
      folderPath: relativeFolderPath,
      signature: `signature:${relativeFolderPath}`,
      fileCount: filenames.length,
      maxMtimeMs: images.length > 0 ? Math.max(...images.map((image) => image.mtime_ms)) : 0,
      totalSize: images.reduce((total, image) => total + image.file_size, 0)
    });

    return {
      folder,
      images
    };
  }

});
