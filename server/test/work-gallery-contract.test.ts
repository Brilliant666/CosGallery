import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';

describe.sequential('work gallery existing API contract', () => {
  let root: string;
  let app: express.Application;
  let repositories: typeof import('../src/db/repositories.js');
  let db: typeof import('../src/db/database.js')['databaseManager'];
  let config: typeof import('../src/config/env.js')['appConfig'];
  let auth: typeof import('../src/services/auth-service.js')['authService'];
  let postId: number;
  let ids: number[];
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'work-gallery-contract-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COS_GALLERY_MODE', '1');
    for (const [key, relative] of Object.entries({ DATA_ROOT: 'data', GALLERY_ROOT: 'gallery', DB_DIR: 'db', THUMBNAILS_DIR: 'thumbnails', PREVIEWS_DIR: 'previews' })) {
      vi.stubEnv(key, path.join(root, relative));
    }
    vi.resetModules();
    ({ databaseManager: db } = await import('../src/db/database.js'));
    repositories = await import('../src/db/repositories.js');
    ({ appConfig: config } = await import('../src/config/env.js'));
    ({ authService: auth } = await import('../src/services/auth-service.js'));
    app = (await import('../src/app.js')).createApp();
    await fs.mkdir(config.galleryRoot, { recursive: true });
  });
  beforeEach(() => {
    repositories.maintenanceRepository.resetLibraryIndex();
    config.cosGalleryMode = true;
    const creator = repositories.folderRepository.upsert({ slug: 'creator', name: 'Creator', folderPath: 'Creator' });
    const source = repositories.folderRepository.upsert({ slug: 'creator-work', name: 'Work', folderPath: 'Creator/Work', role: 'carousel_source', carouselOwnerFolderId: creator.id });
    const images = Array.from({ length: 5 }, (_, index) => {
      const position = index + 1;
      const video = position % 2 === 0;
      const filename = `${position}.${video ? 'mp4' : 'jpg'}`;
      const relativePath = `Creator/Work/${filename}`;
      return repositories.imageRepository.upsert({
        folderId: source.id, filename, extension: video ? '.mp4' : '.jpg', relativePath,
        absolutePath: path.join(config.galleryRoot, relativePath), fileSize: 1024 * position,
        width: 800, height: 1200, mediaType: video ? 'video' : 'image', mimeType: video ? 'video/mp4' : 'image/jpeg',
        durationMs: video ? 60000 : null, isAnimated: false, fingerprint: `fixture-${position}`,
        mtimeMs: 1000, firstSeenAt: '2026-01-01T00:00:00.000Z', sortTimestamp: 1000,
        takenAt: null, takenAtSource: 'mtime', exifJson: null,
        thumbnailPath: `Creator/Work/${position}.webp`, previewPath: `Creator/Work/${position}.${video ? 'mp4' : 'webp'}`, playbackStrategy: 'preview'
      });
    });
    ids = images.map((image) => image.id);
    postId = repositories.postRepository.upsertPostWithItems({
      folderId: creator.id, sourcePath: 'Creator/Work', postType: 'carousel', sortTimestamp: 1000, takenAt: null, takenAtSource: 'mtime'
    }, images.map((image, index) => ({ imageId: image.id, position: index + 1 })).reverse()).id;
  });
  afterAll(async () => {
    db?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns the entire mixed position-ordered media list with existing read-only fields', async () => {
    const response = await requestTestApp(app, 'GET', `/api/posts/${postId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: postId, folderSlug: 'creator', postType: 'carousel', itemCount: 5 });
    expect(response.body.mediaItems.map((item: { imageId: number }) => item.imageId)).toEqual(ids);
    expect(response.body.mediaItems.map((item: { mediaType: string }) => item.mediaType)).toEqual(['image', 'video', 'image', 'video', 'image']);
    expect(response.body.mediaItems.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5]);
    for (const item of response.body.mediaItems) {
      expect(item).toMatchObject({ filename: expect.any(String), width: 800, height: 1200, thumbnailUrl: expect.any(String), previewUrl: expect.any(String), originalUrl: expect.any(String), fileSize: expect.any(Number), relativePath: expect.any(String), mimeType: expect.any(String) });
      expect(item).not.toHaveProperty('absolutePath');
    }
    const legacy = await requestTestApp(app, 'GET', `/api/images/${ids[3]}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.id).toBe(postId);
  });

  it('opts in only when CosGallery mode is explicitly enabled, on both folder summary paths', async () => {
    for (const enabled of [true, false]) {
      config.cosGalleryMode = enabled;
      const mode = enabled ? 'work-gallery' : 'post';
      const folders = await requestTestApp(app, 'GET', '/api/folders');
      const page = await requestTestApp(app, 'GET', '/api/folders/creator/images');
      expect(folders.body[0]?.workNavigationMode ?? folders.body.items?.[0]?.workNavigationMode).toBe(mode);
      expect(page.body.folder.workNavigationMode).toBe(mode);
    }
  });

  it.each(['is_deleted', 'is_trashed'] as const)('does not return a Post marked %s', async (column) => {
    db.connection.prepare(`UPDATE posts SET ${column} = 1 WHERE id = ?`).run(postId);
    expect((await requestTestApp(app, 'GET', `/api/posts/${postId}`)).status).toBe(404);
    expect((await requestTestApp(app, 'GET', '/api/posts/999999')).status).toBe(404);
  });

  it('still enforces the existing private-library authentication boundary', async () => {
    auth.setAdminPassword('synthetic-test-password');
    auth.setViewerAccess('password', 'synthetic-viewer-password');
    expect((await requestTestApp(app, 'GET', `/api/posts/${postId}`)).status).toBe(401);
    expect((await requestTestApp(app, 'GET', '/api/folders/creator/images')).status).toBe(401);
  });
});
