import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ordinary derivative URLs after whole Work removal', () => {
  let root: string, server: http.Server, origin: string;
  let manager: (typeof import('../src/db/database.js'))['databaseManager'];
  let auth: (typeof import('../src/services/auth-service.js'))['authService'];
  let config: (typeof import('../src/config/env.js'))['appConfig'];
  let paths: Array<{ url: string; file: string }>;
  let adminCookie: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'work-removal-derivatives-'),
    );
    for (const key of [
      'DATA_ROOT',
      'GALLERY_ROOT',
      'DB_DIR',
      'THUMBNAILS_DIR',
      'PREVIEWS_DIR',
    ]) {
      const directory = path.join(root, key);
      await fs.mkdir(directory);
      vi.stubEnv(key, directory);
    }
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DERIVATIVE_MODE', 'lazy');
    vi.resetModules();
    ({ appConfig: config } = await import('../src/config/env.js'));
    ({ databaseManager: manager } = await import('../src/db/database.js'));
    ({ authService: auth } = await import('../src/services/auth-service.js'));
    const { requireMediaAuthentication } =
      await import('../src/middleware/auth-protection.js');
    const { lazyPreviewsRouter, lazyThumbnailsRouter } =
      await import('../src/routes/lazy-derivatives.js');
    const { imageRepository } = await import('../src/db/repositories.js');
    const { stampDerivative, imageDerivativeVersion } =
      await import('../src/utils/derivative-version.js');
    manager.connection
      .exec(`INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'synthetic','Synthetic','Synthetic');
   INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(1,1,'Synthetic/Album',1);
   INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
   VALUES(1,1,'a.jpg','.jpg','Synthetic/Album/a.jpg','/synthetic/a.jpg',1,1,1,'image/jpeg','synthetic',1,'now',1,'a-thumb.webp','a-preview.webp');
   INSERT INTO post_items(post_id,image_id,position) VALUES(1,1,1);`);
    paths = [
      {
        url: '/thumbnails/a-thumb.webp',
        file: path.join(config.thumbnailsDir, 'a-thumb.webp'),
      },
      {
        url: '/previews/a-preview.webp',
        file: path.join(config.previewsDir, 'a-preview.webp'),
      },
    ];
    for (const [index, item] of paths.entries()) {
      await fs.writeFile(item.file, 'synthetic cached derivative');
      await stampDerivative(
        item.file,
        imageDerivativeVersion(
          imageRepository.getById(1)!,
          index === 0 ? 'thumbnail' : 'preview',
        ),
      );
    }
    auth.setAdminPassword('synthetic-password');
    auth.setViewerAccess('public');
    const response = { cookie: vi.fn(), setHeader: vi.fn() };
    auth.setAuthenticatedSession(
      response as unknown as express.Response,
      { secure: false, get: () => undefined } as unknown as express.Request,
      'admin',
    );
    const [name, value] = response.cookie.mock.calls[0];
    adminCookie = `${name}=${value}`;
    const app = express();
    app.use('/thumbnails', requireMediaAuthentication, lazyThumbnailsRouter);
    app.use('/previews', requireMediaAuthentication, lazyPreviewsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('Missing isolated port');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    manager?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  function removeWork() {
    manager.connection
      .exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'Synthetic','synthetic','fixture','one');
   INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Album');
   INSERT INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(1,1,'/synthetic','Synthetic','/synthetic/Synthetic','Synthetic','matched','now');
   INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
    VALUES(1,1,1,1,'Album','/synthetic/Synthetic/Album','Album','matched','now');
   INSERT INTO removal_operations(operation_id,kind,target_id,mode,state,payload_json,created_at,updated_at) VALUES('removed','work',1,'trash','completed','{}','now','now');
   INSERT INTO work_removals(work_id,state,operation_id,snapshot_json,created_at) VALUES(1,'trashed','removed','{}','now');
   INSERT INTO work_removal_paths(work_id,local_work_id,absolute_path,relative_path) VALUES(1,1,'/synthetic/Synthetic/Album','Synthetic/Album');
   UPDATE archive_catalog_local_works SET is_active=0;
   UPDATE posts SET is_trashed=1; UPDATE images SET is_trashed=1;`);
  }
  it.each(['admin', 'public'])(
    'blocks existing hot and cold URLs for %s until Work restore',
    async (mode) => {
      const options =
        mode === 'admin' ? { headers: { cookie: adminCookie } } : {};
      for (const item of paths)
        expect((await fetch(origin + item.url, options)).status).toBe(200);
      removeWork();
      for (const item of paths) {
        const response = await fetch(origin + item.url, options);
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toContain('no-store');
        await fs.unlink(item.file);
        expect((await fetch(origin + item.url, options)).status).toBe(404);
        await expect(fs.stat(item.file)).rejects.toThrow();
        await fs.writeFile(item.file, 'synthetic cached derivative');
      }
      manager.connection.exec(
        'DELETE FROM work_removals; UPDATE posts SET is_trashed=0; UPDATE images SET is_trashed=0',
      );
      const { stampDerivative, imageDerivativeVersion } =
        await import('../src/utils/derivative-version.js');
      const { imageRepository } = await import('../src/db/repositories.js');
      for (const [index, item] of paths.entries())
        await stampDerivative(
          item.file,
          imageDerivativeVersion(
            imageRepository.getById(1)!,
            index === 0 ? 'thumbnail' : 'preview',
          ),
        );
      for (const item of paths)
        expect((await fetch(origin + item.url, options)).status).toBe(200);
    },
  );
  it.each(['admin', 'public'])(
    'preserves unrelated legacy Post recycle previews for %s',
    async (mode) => {
      manager.connection.exec(
        'UPDATE posts SET is_trashed=1; UPDATE images SET is_trashed=1',
      );
      for (const item of paths)
        expect(
          (
            await fetch(
              origin + item.url,
              mode === 'admin' ? { headers: { cookie: adminCookie } } : {},
            )
          ).status,
        ).toBe(200);
    },
  );
  it('also blocks a held Work path if its historical local Post link is absent', async () => {
    removeWork();
    manager.connection.exec(
      'UPDATE archive_catalog_local_works SET post_id=NULL',
    );
    for (const item of paths)
      expect((await fetch(origin + item.url)).status).toBe(404);
  });
});
