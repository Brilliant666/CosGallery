import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { getGalleryStatistics } from '../src/db/gallery-statistics-repository.js';
import { requestTestApp } from './http-test-utils.js';

function fixtures(db: DatabaseSync) {
  let sequence = 0;
  const creator = (id: number, active = 1) => db.prepare(`INSERT INTO archive_catalog_creators
    (id,canonical_name,normalized_name,seed_source,seed_source_creator_id,is_active,preference)
    VALUES(?,? ,?,'test',?,?,'liked')`).run(id, `Creator ${id}`, `creator ${id}`, String(id), active);
  const folder = (creatorId: number | null) => {
    const n = ++sequence;
    const id = Number(db.prepare('INSERT INTO folders(slug,name,folder_path) VALUES(?,?,?)')
      .run(`folder-${n}`, `Folder ${n}`, `Folder ${n}`).lastInsertRowid);
    const local = Number(db.prepare(`INSERT INTO archive_catalog_local_creator_folders
      (gallery_folder_id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(?,?,'/synthetic',?,?,? ,?,'fixed')`).run(id, creatorId, `Folder ${n}`, `/synthetic/Folder ${n}`,
      `Folder ${n}`, creatorId === null ? 'unmatched' : 'matched').lastInsertRowid);
    return { id, local, path: `Folder ${n}` };
  };
  const work = (creatorId: number) => Number(db.prepare(`INSERT INTO archive_catalog_works(creator_id,display_title)
    VALUES(?,'Same title')`).run(creatorId).lastInsertRowid);
  const copy = (owner: ReturnType<typeof folder>, workId: number | null, filenames = ['1.jpg'], legacy = false) => {
    const n = ++sequence;
    const source = `${owner.path}/copy-${n}`;
    const post = Number(db.prepare(`INSERT INTO posts(folder_id,source_path,post_type,sort_timestamp)
      VALUES(?,?,'carousel',1)`).run(owner.id, source).lastInsertRowid);
    const images = filenames.map((name, i) => {
      const mediaId = Number(db.prepare(`INSERT INTO images(folder_id,filename,extension,relative_path,absolute_path,
        file_size,width,height,media_type,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
        VALUES(?,? ,'.fixture',?,?,1,20,30,?,'fixture',?,1,'fixed',1,'fixture.webp','fixture.webp')`)
        .run(owner.id, name.split('/').at(-1), `${source}/${name}`, `/synthetic/${source}/${name}`,
          name.endsWith('.mp4') ? 'video' : 'image', `${post}-${i}`).lastInsertRowid);
      db.prepare('INSERT INTO post_items(post_id,image_id,position) VALUES(?,?,?)').run(post, mediaId, i + 1);
      return mediaId;
    });
    const local = Number(db.prepare(`INSERT INTO archive_catalog_local_works
      (local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(?,?,?,?,?,?,'matched','fixed')`).run(owner.local, workId, legacy ? null : post,
      `copy-${n}`, `/synthetic/${source}`, `copy-${n}`).lastInsertRowid);
    return { post, local, images };
  };
  const primary = (workId: number, localId: number) => db.prepare('UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=?').run(localId, workId);
  return { creator, folder, work, copy, primary };
}

describe('canonical gallery statistics', () => {
  let db: DatabaseSync | undefined;
  const setup = () => { db = new DatabaseSync(':memory:'); db.exec(schemaSql); return fixtures(db); };
  afterEach(() => { db?.close(); db = undefined; });

  it('deduplicates creator folders and Work copies, preserves distinct same-title Works and includes video-only Works', () => {
    const f = setup(); f.creator(1); f.creator(2, 0);
    const first = f.folder(1), alias = f.folder(1), inactive = f.folder(2), unlinked = f.folder(null);
    const work = f.work(1), sameTitle = f.work(1), video = f.work(1);
    const primary = f.copy(first, work, ['1.jpg', '2.jpg']); f.primary(work, primary.local);
    f.copy(alias, work, ['duplicate1.jpg', 'duplicate2.jpg', 'duplicate3.jpg']);
    f.copy(alias, sameTitle); f.copy(first, video, ['clip.mp4']);
    f.copy(first, null, ['orphan.jpg']); f.copy(unlinked, null); f.copy(inactive, f.work(2));
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 3, photos: 3 });
  });

  it('keeps offline creator cards but never replaces an explicitly unavailable primary with a secondary', () => {
    const f = setup(); f.creator(1); const owner = f.folder(1), work = f.work(1);
    const first = f.copy(owner, work), second = f.copy(owner, work, ['1.jpg', '2.jpg']);
    f.primary(work, first.local);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 1, photos: 1 });
    f.primary(work, second.local);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 1, photos: 2 });
    db!.prepare('UPDATE archive_catalog_local_works SET is_active=0 WHERE id=?').run(second.local);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 0, photos: 0 });
    db!.prepare('UPDATE archive_catalog_local_creator_folders SET is_active=0 WHERE id=?').run(owner.local);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 0, photos: 0 });
  });

  it('uses only the unambiguous legacy copy and exact indexed path, without choosing among multiple copies', () => {
    const f = setup(); f.creator(1); const owner = f.folder(1), work = f.work(1);
    const first = f.copy(owner, work, ['1.jpg'], true);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 1, photos: 1 });
    const second = f.copy(owner, work);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 0, photos: 0 });
    db!.prepare('UPDATE posts SET is_deleted=1 WHERE id=?').run(second.post);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 1, photos: 1 });
    db!.prepare("UPDATE posts SET source_path='different/exact-path' WHERE id=?").run(first.post);
    expect(getGalleryStatistics(db).works).toBe(0);
  });

  it.each([
    'missing Post', 'inactive copy without Post', 'inactive copy', 'unmatched copy',
    'inactive folder', 'unmatched folder', 'different creator', 'different Post folder',
    'ambiguous owner', 'cover-only Post'
  ])('does not let an ineligible secondary (%s) hide the sole viable copy', (reason) => {
    const f = setup(); f.creator(1); f.creator(2);
    const owner = f.folder(1), otherFolder = f.folder(1), work = f.work(1);
    const valid = f.copy(owner, work);
    const invalid = f.copy(otherFolder, work);
    const discardPostLink = () => db!.prepare(`UPDATE archive_catalog_local_works
      SET post_id=NULL, relative_path='not-indexed' WHERE id=?`).run(invalid.local);
    switch (reason) {
      case 'missing Post': discardPostLink(); break;
      case 'inactive copy without Post':
        discardPostLink();
        db!.prepare('UPDATE archive_catalog_local_works SET is_active=0 WHERE id=?').run(invalid.local); break;
      case 'inactive copy':
        db!.prepare('UPDATE archive_catalog_local_works SET is_active=0 WHERE id=?').run(invalid.local); break;
      case 'unmatched copy':
        db!.prepare("UPDATE archive_catalog_local_works SET match_status='unmatched' WHERE id=?").run(invalid.local); break;
      case 'inactive folder':
        db!.prepare('UPDATE archive_catalog_local_creator_folders SET is_active=0 WHERE id=?').run(otherFolder.local); break;
      case 'unmatched folder':
        db!.prepare("UPDATE archive_catalog_local_creator_folders SET match_status='unmatched' WHERE id=?").run(otherFolder.local); break;
      case 'different creator':
        db!.prepare('UPDATE archive_catalog_local_creator_folders SET creator_id=2 WHERE id=?').run(otherFolder.local); break;
      case 'different Post folder':
        db!.prepare('UPDATE posts SET folder_id=? WHERE id=?').run(owner.id, invalid.post); break;
      case 'ambiguous owner':
        db!.exec('DROP INDEX idx_catalog_folder_gallery_active');
        db!.prepare(`INSERT INTO archive_catalog_local_creator_folders
          (gallery_folder_id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
          VALUES(?,2,'/other','ambiguous','/other/ambiguous','ambiguous','matched','fixed')`).run(otherFolder.id); break;
      case 'cover-only Post':
        db!.prepare("UPDATE images SET filename='cover.jpg' WHERE id=?").run(invalid.images[0]); break;
    }
    expect(getGalleryStatistics(db)).toMatchObject({ works: 1, photos: 1 });
    // An explicit but unusable primary remains authoritative: no implicit failover.
    f.primary(work, invalid.local);
    expect(getGalleryStatistics(db)).toMatchObject({ works: 0, photos: 0 });
    f.primary(work, valid.local);
    expect(getGalleryStatistics(db)).toMatchObject({ works: 1, photos: 1 });
  });

  it('excludes media trash, removed Works, retained originals and excluded attachments; derivatives are never members', () => {
    const f = setup(); f.creator(1); const owner = f.folder(1), work = f.work(1);
    const copy = f.copy(owner, work, ['photo.jpg', 'trash-ad.jpg', '_未支持格式原件/large.jpg',
      '.local-admission-attachments/ad.jpg', 'clip.mp4']); f.primary(work, copy.local);
    db!.prepare(`INSERT INTO media_trash_entries(image_id,post_id,original_position,original_post_type,trashed_at)
      VALUES(?,?,2,'carousel','fixed')`).run(copy.images[1], copy.post);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 1, photos: 1 });
    db!.prepare('UPDATE images SET is_trashed=1 WHERE id=?').run(copy.images[0]);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 1, photos: 0 });
    db!.exec(`INSERT INTO removal_operations VALUES('remove','work',${work},'trash','complete','{}','fixed','fixed',NULL);
      INSERT INTO work_removals VALUES(${work},'trashed','remove','{}','fixed')`);
    expect(getGalleryStatistics(db)).toEqual({ creators: 1, works: 0, photos: 0 });
  });

  it('does not count ambiguous canonical owners or private roster-only creators', () => {
    const f = setup(); f.creator(1); f.creator(2); f.creator(3);
    const owner = f.folder(1); f.copy(owner, f.work(1));
    expect(getGalleryStatistics(db).creators).toBe(1);
    // Simulate a damaged legacy ownership index, as the existing gallery does.
    db!.exec('DROP INDEX idx_catalog_folder_gallery_active');
    db!.prepare(`INSERT INTO archive_catalog_local_creator_folders
      (gallery_folder_id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(?,2,'/other','same','/other/same','same','matched','fixed')`).run(owner.id);
    expect(getGalleryStatistics(db)).toEqual({ creators: 0, works: 0, photos: 0 });
  });

  it('caches unchanged reads, invalidates writes and discards rolled-back snapshots', () => {
    const f = setup(); f.creator(1); const owner = f.folder(1), work = f.work(1); const copy = f.copy(owner, work);
    const prepare = vi.spyOn(db!, 'prepare');
    const reads = () => prepare.mock.calls.filter(([sql]) => sql.includes('WITH visible_posts')).length;
    const value = getGalleryStatistics(db); value.photos = 999;
    expect(getGalleryStatistics(db).photos).toBe(1); expect(reads()).toBe(1);
    const sql = prepare.mock.calls.find(([query]) => query.includes('WITH visible_posts'))![0];
    const plan = db!.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join('\n');
    expect(plan).toMatch(/SEARCH media USING INTEGER PRIMARY KEY/);
    expect(plan).not.toMatch(/SCAN media\b/);
    db!.exec('BEGIN'); db!.prepare('UPDATE images SET is_trashed=1 WHERE id=?').run(copy.images[0]);
    expect(getGalleryStatistics(db).photos).toBe(0);
    db!.exec('ROLLBACK'); expect(getGalleryStatistics(db).photos).toBe(1);
    db!.prepare('UPDATE images SET is_deleted=1 WHERE id=?').run(copy.images[0]);
    expect(getGalleryStatistics(db).photos).toBe(0);
    prepare.mockRestore();
  });
});

describe('public gallery statistics contract', () => {
  it('exposes only three numeric aggregates to guests and admins and reports zero when storage is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-statistics-api-'));
    let manager: typeof import('../src/db/database.js')['databaseManager'] | undefined;
    try {
      vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('COS_GALLERY_MODE', '1'); vi.stubEnv('PUBLIC_DEMO_MODE', '0');
      for (const key of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
        const dir = path.join(root, key); await fs.mkdir(dir); vi.stubEnv(key, dir);
      }
      vi.resetModules();
      manager = (await import('../src/db/database.js')).databaseManager;
      const app = (await import('../src/app.js')).createApp();
      const auth = (await import('../src/services/auth-service.js')).authService;
      const gallery = (await import('../src/services/gallery-service.js')).galleryService;
      const storage = (await import('../src/services/storage-service.js')).storageService;
      const f = fixtures(manager.connection); f.creator(1); const owner = f.folder(1), workId = f.work(1);
      f.copy(owner, workId);
      const staleCopy = f.copy(owner, workId);
      manager.connection.prepare(`UPDATE archive_catalog_local_works
        SET is_active=0, post_id=NULL, relative_path='not-indexed' WHERE id=?`).run(staleCopy.local);
      auth.setAdminPassword('isolated-statistics-password'); auth.setViewerAccess('public');
      let cookie = '';
      auth.setAuthenticatedSession({ cookie(name: string, value: string) { cookie = `${name}=${value}`; } } as Response,
        { secure: false, get() { return undefined; } } as unknown as Request, 'admin');
      const response = await requestTestApp(app, 'GET', '/api/status');
      expect(response.status).toBe(200);
      expect(response.body.galleryStatistics).toEqual({ creators: 1, works: 1, photos: 1 });
      expect(gallery.getStats().galleryStatistics).toEqual(response.body.galleryStatistics);
      const admin = await requestTestApp(app, 'GET', '/api/admin/stats', { cookie });
      expect(admin.status).toBe(200); expect(admin.body.galleryStatistics).toEqual(response.body.galleryStatistics);
      expect((await requestTestApp(app, 'GET', '/api/admin/stats')).status).toBe(401);
      expect((await requestTestApp(app, 'GET', '/api/cos-gallery/creators')).body.total).toBe(response.body.galleryStatistics.creators);
      expect(JSON.stringify(response.body.galleryStatistics)).not.toMatch(/liked|kept|path|name|password|alias/i);
      const current = storage.getState();
      const unavailable = vi.spyOn(storage, 'getState').mockReturnValue({ ...current, libraryAvailable: false });
      expect((await requestTestApp(app, 'GET', '/api/status')).body.galleryStatistics).toEqual({ creators: 0, works: 0, photos: 0 });
      expect(gallery.getStats().galleryStatistics).toEqual({ creators: 0, works: 0, photos: 0 });
      unavailable.mockRestore();
      expect((await requestTestApp(app, 'GET', '/api/status')).body.galleryStatistics.photos).toBe(1);
    } finally {
      vi.restoreAllMocks(); manager?.close(); vi.unstubAllEnvs(); vi.resetModules();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
