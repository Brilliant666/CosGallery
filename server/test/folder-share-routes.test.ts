import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import sharp from 'sharp';

import { requestTestApp as requestApp } from './http-test-utils.js';

type DatabaseModule = typeof import('../src/db/database.js');
type AuthServiceModule = typeof import('../src/services/auth-service.js');

describe.sequential('folder share API routes', () => {
  let tempRoot = '';
  let app: express.Application;
  let authService: AuthServiceModule['authService'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-share-routes-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  });

  beforeEach(async () => {
    try {
      const dbModule: DatabaseModule = await import('../src/db/database.js');
      dbModule.databaseManager.close();
    } catch {
      // Ignore
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
    await Promise.all([
      fs.mkdir(path.join(tempRoot, 'db'), { recursive: true }),
      fs.mkdir(path.join(tempRoot, 'gallery'), { recursive: true }),
      fs.mkdir(path.join(tempRoot, 'thumbnails'), { recursive: true }),
      fs.mkdir(path.join(tempRoot, 'previews'), { recursive: true })
    ]);

    vi.resetModules();
    const { createApp } = await import('../src/app.js');
    ({ authService } = await import('../src/services/auth-service.js'));
    const { folderRepository, imageRepository, maintenanceRepository, postRepository } = await import('../src/db/repositories.js');

    maintenanceRepository.resetLibraryIndex();
    authService.setAdminPassword('admin12345');
    authService.setViewerAccess('password', 'viewer12345');

    const folderA = folderRepository.upsert({ slug: 'folder-a', name: 'Folder A', folderPath: 'folder-a' });
    const folderB = folderRepository.upsert({ slug: 'folder-b', name: 'Folder B', folderPath: 'folder-b' });

    imageRepository.upsert({
      folderId: folderA.id,
      filename: 'image-a.jpg',
      extension: 'jpg',
      relativePath: 'folder-a/image-a.jpg',
      absolutePath: path.join(tempRoot, 'gallery', 'folder-a', 'image-a.jpg'),
      fileSize: 1024,
      width: 800,
      height: 600,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      durationMs: null,
      fingerprint: 'fp-a',
      mtimeMs: Date.now(),
      firstSeenAt: new Date().toISOString(),
      sortTimestamp: Date.now(),
      takenAt: Date.now(),
      takenAtSource: 'mtime',
      thumbnailPath: 'folder-a/image-a.webp',
      previewPath: 'folder-a/image-a.webp',
      exifJson: JSON.stringify({ latitude: 37.7749, longitude: -122.4194, cameraMake: 'Canon' })
    });

    imageRepository.upsert({
      folderId: folderB.id,
      filename: 'image-b.jpg',
      extension: 'jpg',
      relativePath: 'folder-b/image-b.jpg',
      absolutePath: path.join(tempRoot, 'gallery', 'folder-b', 'image-b.jpg'),
      fileSize: 2048,
      width: 1200,
      height: 900,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      durationMs: null,
      fingerprint: 'fp-b',
      mtimeMs: Date.now(),
      firstSeenAt: new Date().toISOString(),
      sortTimestamp: Date.now(),
      takenAt: Date.now(),
      takenAtSource: 'mtime',
      thumbnailPath: 'folder-b/image-b.webp',
      previewPath: 'folder-b/image-b.webp',
      exifJson: null
    });

    const carouselSource = folderRepository.upsert({
      slug: 'folder-a-carousel-trip',
      name: 'Trip',
      folderPath: 'folder-a/carousels/trip',
      role: 'carousel_source',
      carouselOwnerFolderId: folderA.id
    });
    const carouselItems = [
      imageRepository.upsert({
        folderId: carouselSource.id,
        filename: '01-image.jpg',
        extension: 'jpg',
        relativePath: 'folder-a/carousels/trip/01-image.jpg',
        absolutePath: path.join(tempRoot, 'gallery', 'folder-a', 'carousels', 'trip', '01-image.jpg'),
        fileSize: 3001,
        width: 1400,
        height: 900,
        mediaType: 'image',
        mimeType: 'image/jpeg',
        durationMs: null,
        fingerprint: 'fp-carousel-image',
        mtimeMs: Date.now(),
        firstSeenAt: new Date().toISOString(),
        sortTimestamp: Date.now() + 1000,
        takenAt: Date.now(),
        takenAtSource: 'mtime',
        thumbnailPath: 'folder-a/carousels/trip/01-image.webp',
        previewPath: 'folder-a/carousels/trip/01-image.webp',
        exifJson: JSON.stringify({ latitude: 51.5, longitude: -0.1, cameraModel: 'Private Camera' })
      }),
      imageRepository.upsert({
        folderId: carouselSource.id,
        filename: '02-animated.gif',
        extension: 'gif',
        relativePath: 'folder-a/carousels/trip/02-animated.gif',
        absolutePath: path.join(tempRoot, 'gallery', 'folder-a', 'carousels', 'trip', '02-animated.gif'),
        fileSize: 3002,
        width: 900,
        height: 900,
        mediaType: 'image',
        mimeType: 'image/gif',
        durationMs: 1200,
        isAnimated: true,
        fingerprint: 'fp-carousel-animated',
        mtimeMs: Date.now(),
        firstSeenAt: new Date().toISOString(),
        sortTimestamp: Date.now() + 1000,
        takenAt: Date.now(),
        takenAtSource: 'mtime',
        thumbnailPath: 'folder-a/carousels/trip/02-animated.webp',
        previewPath: 'folder-a/carousels/trip/02-animated.gif',
        exifJson: JSON.stringify({ cameraMake: 'Private Make' })
      }),
      imageRepository.upsert({
        folderId: carouselSource.id,
        filename: '03-video.mp4',
        extension: 'mp4',
        relativePath: 'folder-a/carousels/trip/03-video.mp4',
        absolutePath: path.join(tempRoot, 'gallery', 'folder-a', 'carousels', 'trip', '03-video.mp4'),
        fileSize: 3003,
        width: 1920,
        height: 1080,
        mediaType: 'video',
        mimeType: 'video/mp4',
        durationMs: 5000,
        fingerprint: 'fp-carousel-video',
        mtimeMs: Date.now(),
        firstSeenAt: new Date().toISOString(),
        sortTimestamp: Date.now() + 1000,
        takenAt: Date.now(),
        takenAtSource: 'mtime',
        thumbnailPath: 'folder-a/carousels/trip/03-video.webp',
        previewPath: 'folder-a/carousels/trip/03-video.mp4',
        playbackStrategy: 'original',
        exifJson: null
      })
    ];
    postRepository.upsertPostWithItems({
      folderId: folderA.id,
      sourcePath: 'folder-a/carousels/trip',
      postType: 'carousel',
      sortTimestamp: Date.now() + 1000,
      takenAt: Date.now(),
      takenAtSource: 'mtime'
    }, carouselItems.map((image, index) => ({ imageId: image.id, position: index + 1 })));

    await fs.mkdir(path.join(tempRoot, 'gallery', 'folder-a'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'gallery', 'folder-b'), { recursive: true });

    const tinyJpeg = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } }
    })
      .jpeg()
      .toBuffer();

    await fs.writeFile(path.join(tempRoot, 'gallery', 'folder-a', 'image-a.jpg'), tinyJpeg);
    await fs.writeFile(path.join(tempRoot, 'gallery', 'folder-b', 'image-b.jpg'), tinyJpeg);

    // Create dummy derivative files on disk
    await fs.mkdir(path.join(tempRoot, 'thumbnails', 'folder-a'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'thumbnails', 'folder-b'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'thumbnails', 'folder-a', 'image-a.webp'), 'dummy-thumb-a');
    await fs.writeFile(path.join(tempRoot, 'thumbnails', 'folder-b', 'image-b.webp'), 'dummy-thumb-b');

    await fs.mkdir(path.join(tempRoot, 'previews', 'folder-a'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'previews', 'folder-b'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'previews', 'folder-a', 'image-a.webp'), 'dummy-preview-a');
    await fs.writeFile(path.join(tempRoot, 'previews', 'folder-b', 'image-b.webp'), 'dummy-preview-b');

    app = createApp();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    try {
      const dbModule: DatabaseModule = await import('../src/db/database.js');
      dbModule.databaseManager.close();
    } catch {
      // Ignore
    }
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rejects share session cookies on admin endpoints with 401 and viewer cookies with 403', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const { folderRepository } = await import('../src/db/repositories.js');
    const folder = folderRepository.getNormalBySlug('folder-a')!;
    const link = folderShareService.createLink('folder-a', { expiresAt: null })!;
    const grant = folderShareService.verifyLinkToken('folder-a', link.rawToken)!;

    // Generate share cookie
    const mockRes = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    folderShareService.setShareSession(mockRes as any, { secure: false, get: () => undefined } as any, grant);
    const shareCookie = mockRes.cookie.mock.calls.at(-1)?.[1];

    // Anonymous request -> 401
    const anonRes = await requestApp(app, 'GET', '/api/admin/stats');
    expect(anonRes.status).toBe(401);

    // Share cookie request -> 401
    const shareRes = await requestApp(app, 'GET', '/api/admin/stats', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(shareRes.status).toBe(401);

    // Viewer auth cookie request -> 403
    const viewerResMock = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    authService.setAuthenticatedSession(viewerResMock as any, { secure: false, get: () => undefined } as any, 'viewer');
    const viewerCookie = viewerResMock.cookie.mock.calls.at(-1)?.[1];

    const viewerRes = await requestApp(app, 'GET', '/api/admin/stats', {
      Cookie: `foldergram_session=${viewerCookie}`
    });
    expect(viewerRes.status).toBe(403);
  });

  it('rejects cross-folder derivative access', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const link = folderShareService.createLink('folder-a', { expiresAt: null })!;
    const grant = folderShareService.verifyLinkToken('folder-a', link.rawToken)!;

    const mockRes = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    folderShareService.setShareSession(mockRes as any, { secure: false, get: () => undefined } as any, grant);
    const shareCookie = mockRes.cookie.mock.calls.at(-1)?.[1];

    // Access image 1 (in folder-a) -> allowed (200)
    const allowedRes = await requestApp(app, 'GET', '/api/share/images/1/thumbnail', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(allowedRes.status).toBe(200);

    // Access image 2 (in folder-b) -> rejected (401)
    const rejectedRes = await requestApp(app, 'GET', '/api/share/images/2/thumbnail', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(rejectedRes.status).toBe(401);
  });

  it('immediately revokes active share sessions when link is revoked', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const link = folderShareService.createLink('folder-a', { expiresAt: null })!;
    const grant = folderShareService.verifyLinkToken('folder-a', link.rawToken)!;

    const mockRes = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    folderShareService.setShareSession(mockRes as any, { secure: false, get: () => undefined } as any, grant);
    const shareCookie = mockRes.cookie.mock.calls.at(-1)?.[1];

    // Session works initially
    const initialRes = await requestApp(app, 'GET', '/api/share/folders/folder-a', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(initialRes.status).toBe(200);

    // Revoke link
    folderShareService.revokeLink('folder-a', link.link.id);

    // Session is immediately rejected
    const revokedRes = await requestApp(app, 'GET', '/api/share/folders/folder-a', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(revokedRes.status).toBe(401);
  });

  it('redacts sensitive metadata from shared JSON endpoints', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const { postRepository } = await import('../src/db/repositories.js');
    const carousel = postRepository.findBySourcePath('folder-a/carousels/trip')!;
    const expectRecursivelyRedacted = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(expectRecursivelyRedacted);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      expect(Object.keys(record)).not.toEqual(expect.arrayContaining([
        'absolutePath', 'exif', 'exifJson', 'originalUrl', 'relativePath', 'sourcePath'
      ]));
      Object.values(record).forEach(expectRecursivelyRedacted);
    };
    const link = folderShareService.createLink('folder-a', { expiresAt: null })!;
    const grant = folderShareService.verifyLinkToken('folder-a', link.rawToken)!;

    const mockRes = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    folderShareService.setShareSession(mockRes as any, { secure: false, get: () => undefined } as any, grant);
    const shareCookie = mockRes.cookie.mock.calls.at(-1)?.[1];

    // Folder detail
    const folderRes = await requestApp(app, 'GET', '/api/share/folders/folder-a', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(folderRes.status).toBe(200);
    expect(folderRes.body).not.toHaveProperty('folderPath');
    expect(folderRes.body).not.toHaveProperty('absolutePath');

    // Folder images
    const imagesRes = await requestApp(app, 'GET', '/api/share/folders/folder-a/images', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(imagesRes.status).toBe(200);
    expect(imagesRes.body.items[0]).not.toHaveProperty('folderPath');
    expect(imagesRes.body.items[0]).not.toHaveProperty('relativePath');
    expect(imagesRes.body.items[0]).not.toHaveProperty('exif');
    expectRecursivelyRedacted(imagesRes.body);

    // Shared image detail
    const imageDetailRes = await requestApp(app, 'GET', '/api/share/images/1', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(imageDetailRes.status).toBe(200);
    expect(imageDetailRes.body).not.toHaveProperty('folderPath');
    expect(imageDetailRes.body).not.toHaveProperty('relativePath');
    expect(imageDetailRes.body).not.toHaveProperty('absolutePath');
    expect(imageDetailRes.body).not.toHaveProperty('exif');

    const carouselDetailRes = await requestApp(app, 'GET', `/api/share/posts/${carousel.id}`, {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(carouselDetailRes.status).toBe(200);
    expect(carouselDetailRes.body.mediaItems).toHaveLength(3);
    expectRecursivelyRedacted(carouselDetailRes.body);

    folderShareService.setPassword('folder-a', 'carousel-password');
    const passwordGrant = folderShareService.verifyPassword('folder-a', 'carousel-password')!;
    const passwordResponse = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    folderShareService.setShareSession(
      passwordResponse as any,
      { secure: false, get: () => undefined } as any,
      passwordGrant
    );
    const passwordCookie = passwordResponse.cookie.mock.calls.at(-1)?.[1];
    const passwordDetailRes = await requestApp(app, 'GET', `/api/share/posts/${carousel.id}`, {
      Cookie: `foldergram_share_session=${passwordCookie}`
    });
    expect(passwordDetailRes.status).toBe(200);
    expectRecursivelyRedacted(passwordDetailRes.body);
  });

  it('redacts paths and EXIF recursively for anonymous public feed and detail payloads', async () => {
    const { postRepository } = await import('../src/db/repositories.js');
    const carousel = postRepository.findBySourcePath('folder-a/carousels/trip')!;
    authService.setViewerAccess('public');

    const assertNoSensitiveKeys = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(assertNoSensitiveKeys);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      expect(Object.keys(record)).not.toEqual(expect.arrayContaining([
        'absolutePath', 'exif', 'exifJson', 'relativePath', 'sourcePath'
      ]));
      Object.values(record).forEach(assertNoSensitiveKeys);
    };

    const feedRes = await requestApp(app, 'GET', '/api/feed?mode=recent');
    expect(feedRes.status).toBe(200);
    const publicCarousel = feedRes.body.items.find((item: { id: number }) => item.id === carousel.id);
    expect(publicCarousel?.mediaItems).toHaveLength(3);
    expect(publicCarousel).toMatchObject({
      folderPath: 'folder-a',
      carouselTitle: 'trip'
    });
    expect(publicCarousel).not.toHaveProperty('sourcePath');
    assertNoSensitiveKeys(feedRes.body);

    const detailRes = await requestApp(app, 'GET', `/api/posts/${carousel.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.mediaItems).toHaveLength(3);
    expect(detailRes.body).toMatchObject({
      folderPath: 'folder-a',
      carouselTitle: 'trip'
    });
    assertNoSensitiveKeys(detailRes.body);

    const adminResponse = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    authService.setAuthenticatedSession(
      adminResponse as any,
      { secure: false, get: () => undefined } as any,
      'admin'
    );
    const adminCookie = adminResponse.cookie.mock.calls.at(-1)?.[1];
    const adminDetailRes = await requestApp(app, 'GET', `/api/posts/${carousel.id}`, {
      Cookie: `foldergram_session=${adminCookie}`
    });
    expect(adminDetailRes.status).toBe(200);
    expect(adminDetailRes.body).toMatchObject({
      folderPath: 'folder-a',
      sourcePath: 'folder-a/carousels/trip',
      carouselTitle: 'trip'
    });
    expect(adminDetailRes.body.mediaItems[0]).toHaveProperty('relativePath');
    expect(adminDetailRes.body.mediaItems[0]).toHaveProperty('exif');
  });

  it('serves shared derivatives (pre-existing and lazy-generated) with Cache-Control: private, no-store and Vary: Cookie', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const link = folderShareService.createLink('folder-a', { expiresAt: null })!;
    const grant = folderShareService.verifyLinkToken('folder-a', link.rawToken)!;

    const mockRes = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    folderShareService.setShareSession(mockRes as any, { secure: false, get: () => undefined } as any, grant);
    const shareCookie = mockRes.cookie.mock.calls.at(-1)?.[1];

    // Case 1: Pre-existing derivative file
    const resPreExisting = await requestApp(app, 'GET', '/api/share/images/1/thumbnail', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(resPreExisting.status).toBe(200);
    expect(resPreExisting.headers.get('cache-control')).toBe('private, no-store');
    expect(resPreExisting.headers.get('vary')).toContain('Cookie');

    // Case 2: Lazy generation (file does not exist on disk, must be generated on-demand)
    await fs.rm(path.join(tempRoot, 'thumbnails', 'folder-a', 'image-a.webp'), { force: true });
    await fs.rm(path.join(tempRoot, 'previews', 'folder-a', 'image-a.webp'), { force: true });

    const resLazyThumb = await requestApp(app, 'GET', '/api/share/images/1/thumbnail', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(resLazyThumb.status).toBe(200);
    expect(resLazyThumb.headers.get('cache-control')).toBe('private, no-store');
    expect(resLazyThumb.headers.get('vary')).toContain('Cookie');

    const resLazyPreview = await requestApp(app, 'GET', '/api/share/images/1/preview', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(resLazyPreview.status).toBe(200);
    expect(resLazyPreview.headers.get('cache-control')).toBe('private, no-store');
    expect(resLazyPreview.headers.get('vary')).toContain('Cookie');
  });

  it('rejects unlocking expired share links via API endpoint', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const link = folderShareService.createLink('folder-a', {
      expiresAt: new Date(Date.now() - 3_600_000)
    })!;

    const unlockRes = await requestApp(
      app,
      'POST',
      '/api/share/folders/folder-a/unlock-link',
      { 'x-foldergram-intent': '1' },
      { token: link.rawToken }
    );
    expect(unlockRes.status).toBe(403);
    expect(unlockRes.body).toEqual({ message: 'This folder share is expired, revoked, or locked.' });
  });

  it('never stores raw reusable passwords in SQLite or returns them in API responses', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const { folderSharePasswordRepository, folderRepository } = await import('../src/db/repositories.js');

    folderShareService.setPassword('folder-a', 'super-secret-password-99');

    const folderA = folderRepository.getNormalBySlug('folder-a')!;
    const dbRecord = folderSharePasswordRepository.get(folderA.id)!;

    expect(dbRecord.password_hash).not.toBe('super-secret-password-99');
    expect(dbRecord.password_hash).not.toContain('super-secret-password-99');
    expect(Object.keys(dbRecord)).not.toContain('password');

    // Admin share links list endpoint
    const adminResMock = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    authService.setAuthenticatedSession(adminResMock as any, { secure: false, get: () => undefined } as any, 'admin');
    const adminCookie = adminResMock.cookie.mock.calls.at(-1)?.[1];

    const linksRes = await requestApp(app, 'GET', '/api/admin/folders/folder-a/share-links', {
      Cookie: `foldergram_session=${adminCookie}`
    });
    expect(linksRes.status).toBe(200);

    expect(JSON.stringify(linksRes.body)).not.toContain('super-secret-password-99');
  });

  it('rejects cross-folder preview access with 401', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const link = folderShareService.createLink('folder-a', { expiresAt: null })!;
    const grant = folderShareService.verifyLinkToken('folder-a', link.rawToken)!;

    const mockRes = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    folderShareService.setShareSession(mockRes as any, { secure: false, get: () => undefined } as any, grant);
    const shareCookie = mockRes.cookie.mock.calls.at(-1)?.[1];

    const allowedRes = await requestApp(app, 'GET', '/api/share/images/1/preview', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(allowedRes.status).toBe(200);

    const rejectedRes = await requestApp(app, 'GET', '/api/share/images/2/preview', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(rejectedRes.status).toBe(401);
  });

  it('revokes share links through API endpoint with required intent header', async () => {
    const { folderShareService } = await import('../src/services/folder-share-service.js');
    const link = folderShareService.createLink('folder-a', { expiresAt: null })!;
    const grant = folderShareService.verifyLinkToken('folder-a', link.rawToken)!;

    const mockRes = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    folderShareService.setShareSession(mockRes as any, { secure: false, get: () => undefined } as any, grant);
    const shareCookie = mockRes.cookie.mock.calls.at(-1)?.[1];

    // Session works initially
    const initialRes = await requestApp(app, 'GET', '/api/share/images/1/thumbnail', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(initialRes.status).toBe(200);

    // Get admin cookie
    const adminResMock = { cookie: vi.fn().mockReturnThis(), setHeader: vi.fn() };
    authService.setAuthenticatedSession(adminResMock as any, { secure: false, get: () => undefined } as any, 'admin');
    const adminCookie = adminResMock.cookie.mock.calls.at(-1)?.[1];

    // Delete link via API
    const deleteRes = await requestApp(
      app,
      'DELETE',
      `/api/admin/folders/folder-a/share-links/${link.link.id}`,
      {
        Cookie: `foldergram_session=${adminCookie}`,
        'x-foldergram-intent': '1'
      }
    );
    expect(deleteRes.status).toBe(200);

    // Share session should now be rejected
    const rejectedRes = await requestApp(app, 'GET', '/api/share/images/1/thumbnail', {
      Cookie: `foldergram_share_session=${shareCookie}`
    });
    expect(rejectedRes.status).toBe(401);
  });
});
