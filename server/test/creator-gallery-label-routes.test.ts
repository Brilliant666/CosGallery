import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';

describe.sequential('gallery label API and administrator-only preferences', () => {
  let root: string, app: express.Application;
  let db: typeof import('../src/db/database.js')['databaseManager'];
  let auth: typeof import('../src/services/auth-service.js')['authService'];
  let admin: Record<string, string>, viewer: Record<string, string>;
  const url = '/api/admin/archive-catalog/creators/1/gallery-labels';
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-label-api-'));
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('COS_GALLERY_MODE', '1'); vi.stubEnv('PUBLIC_DEMO_MODE', '0');
    for (const key of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      const directory = path.join(root, key); await fs.mkdir(directory, { recursive: true }); vi.stubEnv(key, directory);
    }
    vi.resetModules();
    db = (await import('../src/db/database.js')).databaseManager;
    app = (await import('../src/app.js')).createApp();
    auth = (await import('../src/services/auth-service.js')).authService;
    db.connection.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id,preference,effective_rating)
      VALUES(1,'Synthetic A','synthetic a','fixture','a','liked','R18'),(2,'Synthetic B','synthetic b','fixture','b','kept','R15');
      INSERT INTO archive_catalog_creator_gallery_labels VALUES(1,'cosplay'),(2,'selfie');`);
    for (const id of [1, 2]) {
      const name = `Creator-${id}`;
      db.connection.prepare('INSERT INTO folders(id,slug,name,folder_path) VALUES(?,?,?,?)').run(id, name, name, name);
      db.connection.prepare(`INSERT INTO archive_catalog_local_creator_folders(creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES(?,?,?,?,?,?,'matched','fixed')`).run(id, id, path.join(root, 'GALLERY_ROOT'), name, path.join(root, 'GALLERY_ROOT', name), name);
      db.connection.prepare(`INSERT INTO posts(id,folder_id,source_path,post_type,sort_timestamp) VALUES(?,?,?,'single',1)`).run(id, id, `${name}/01.jpg`);
      db.connection.prepare(`INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
        VALUES(?,?,'01.jpg','.jpg',?,?,1,20,30,'image/jpeg',?,1,'fixed',1,'fixture.jpg','fixture.jpg')`).run(id, id, `${name}/01.jpg`, path.join(root, 'GALLERY_ROOT', name, '01.jpg'), name);
      db.connection.prepare('INSERT INTO post_items(post_id,image_id,position) VALUES(?,?,1)').run(id, id);
    }
    auth.setAdminPassword('isolated-admin-password');
    auth.setViewerAccess('public');
    const session = (role: 'admin' | 'viewer') => {
      let cookie = '';
      auth.setAuthenticatedSession({ cookie(name: string, value: string) { cookie = `${name}=${value}`; } } as express.Response,
        { secure: false, get() { return undefined; } } as unknown as express.Request, role);
      return { cookie, 'x-foldergram-intent': '1' };
    };
    admin = session('admin'); viewer = session('viewer');
  });
  afterAll(async () => {
    db?.close(); vi.unstubAllEnvs(); vi.resetModules();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('protects label reads and writes, enforces intent, validates input and rejects stale writes', async () => {
    const before = await requestTestApp(app, 'GET', url, admin);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ galleryLabels: ['cosplay'], revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    for (const headers of [{}, viewer]) {
      expect((await requestTestApp(app, 'GET', url, headers)).status).toBe('cookie' in headers ? 403 : 401);
      expect([401, 403]).toContain((await requestTestApp(app, 'PUT', url, { ...headers, 'x-foldergram-intent': '1' }, {
        galleryLabels: ['fuliji'], expectedRevision: before.body.revision
      })).status);
    }
    expect((await requestTestApp(app, 'PUT', url, { cookie: admin.cookie }, { galleryLabels: [], expectedRevision: before.body.revision })).status).toBe(403);
    expect((await requestTestApp(app, 'PUT', url, admin, { galleryLabels: ['unknown'], expectedRevision: before.body.revision })).status).toBe(400);
    const saved = await requestTestApp(app, 'PUT', url, admin, { galleryLabels: ['portrait', 'cosplay'], expectedRevision: before.body.revision });
    expect(saved.status).toBe(200); expect(saved.body.galleryLabels).toEqual(['cosplay', 'portrait']);
    expect((await requestTestApp(app, 'PUT', url, admin, { galleryLabels: [], expectedRevision: before.body.revision })).status).toBe(409);
    expect((await requestTestApp(app, 'GET', url, admin)).body).toEqual(saved.body);
    const empty = await requestTestApp(app, 'PUT', url, admin, { galleryLabels: [], expectedRevision: saved.body.revision });
    expect(empty.body.galleryLabels).toEqual([]);
    await requestTestApp(app, 'PUT', url, admin, { galleryLabels: ['cosplay', 'portrait'], expectedRevision: empty.body.revision });
    expect((await requestTestApp(app, 'GET', url.replace('/1/', '/999/'), admin)).status).toBe(404);
  });

  it.each(['anonymous', 'viewer'] as const)('%s cannot read or infer preferences through gallery or legacy DTOs', async role => {
    const headers = role === 'viewer' ? viewer : {};
    const plain = await requestTestApp(app, 'GET', '/api/cos-gallery/creators', headers);
    expect(plain.status).toBe(200); expect(plain.body.total).toBe(2);
    expect(plain.body.items.every((item: object) => !Object.hasOwn(item, 'preference'))).toBe(true);
    for (const preference of ['liked', 'kept', 'invalid', 'liked&preference=kept']) {
      const result = await requestTestApp(app, 'GET', `/api/cos-gallery/creators?preference=${preference}`, headers);
      expect(result.status).toBe(200); expect(result.body).toEqual(plain.body);
    }
    const labeled = await requestTestApp(app, 'GET', '/api/cos-gallery/creators?label=cosplay&preference=kept&contentRating=R15', headers);
    expect(labeled.body.total).toBe(1);
    expect(labeled.body.items[0].galleryLabels).toEqual(['cosplay', 'portrait']);
    const noPreference = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      expect(Object.hasOwn(value, 'preference')).toBe(false);
      for (const child of Object.values(value)) noPreference(child);
    };
    for (const endpoint of ['/api/cos-gallery/creators/1', '/api/cos-gallery/creators/1/works', '/api/cos-gallery/creators/1/works/1',
      '/api/cos-gallery/works', '/api/folders', '/api/folders/Creator-1', '/api/folders/Creator-1/images']) {
      const result = await requestTestApp(app, 'GET', endpoint, headers);
      expect(result.status, endpoint).toBe(200); noPreference(result.body);
    }
  });

  it('keeps administrator preference fields and filters, and both categories reach the same creator', async () => {
    for (const label of ['cosplay', 'portrait']) {
      const result = await requestTestApp(app, 'GET', `/api/cos-gallery/creators?label=${label}&preference=liked`, admin);
      expect(result.body.total).toBe(1); expect(result.body.items[0]).toMatchObject({ id: 1, preference: 'liked' });
    }
    expect((await requestTestApp(app, 'GET', '/api/cos-gallery/creators?preference=kept', admin)).body.items.map((item: { id: number }) => item.id)).toEqual([2]);
    expect((await requestTestApp(app, 'GET', '/api/cos-gallery/creators/1', admin)).body.creator.preference).toBe('liked');
    expect((await requestTestApp(app, 'GET', '/api/cos-gallery/creators/1/works', admin)).body.creator.preference).toBe('liked');
  });
});
