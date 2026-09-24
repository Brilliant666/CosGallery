import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';

describe.sequential('library complete-range joint filters', () => {
  let root: string;
  let db: typeof import('../src/db/database.js')['databaseManager'];
  let app: express.Application;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-joint-filter-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COS_GALLERY_MODE', '1');
    vi.stubEnv('PUBLIC_DEMO_MODE', '1');
    for (const key of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      const directory = path.join(root, key);
      await fs.mkdir(directory, { recursive: true });
      vi.stubEnv(key, directory);
    }
    vi.resetModules();
    ({ databaseManager: db } = await import('../src/db/database.js'));
    const repos = await import('../src/db/repositories.js');
    app = (await import('../src/app.js')).createApp();
    function addFolder(id: number, suffix = '') {
      const name = `Directory-${id}${suffix}`;
      const folder = repos.folderRepository.upsert({ slug: name, name, folderPath: name });
      if (id > 0) db.connection.prepare(`INSERT INTO archive_catalog_local_creator_folders
        (creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES (?,?,?,?,?,?,'matched','2026-01-01')`).run(id, folder.id, path.join(root, 'GALLERY_ROOT'), name, path.join(root, 'GALLERY_ROOT', name), name);
      const relativePath = `${name}/01.jpg`;
      const source = repos.folderRepository.upsert({ slug: `${name}-work`, name: 'Work', folderPath: `${name}/work`, role: 'carousel_source', carouselOwnerFolderId: folder.id });
      const image = repos.imageRepository.upsert({ folderId: source.id, filename: '01.jpg', extension: '.jpg', relativePath,
        absolutePath: path.join(root, 'GALLERY_ROOT', relativePath), fileSize: 100, width: 800, height: 1200,
        mediaType: 'image', mimeType: 'image/jpeg', durationMs: null, isAnimated: false, fingerprint: relativePath,
        mtimeMs: 1000, firstSeenAt: '2026-01-01', sortTimestamp: 1000, takenAt: null, takenAtSource: 'mtime',
        exifJson: '{}', thumbnailPath: `${relativePath}.webp`, previewPath: `${relativePath}.preview`, playbackStrategy: 'original' });
      repos.postRepository.upsertPostWithItems({ folderId: folder.id, sourcePath: name, postType: 'single',
        sortTimestamp: 1000, takenAt: null, takenAtSource: 'mtime' }, [{ imageId: image.id, position: 1 }]);
    }
    for (let id = 1; id <= 124; id++) {
      const rating = id <= 61 ? 'R18' : id <= 122 ? 'R15' : null;
      const preference = id <= 61 ? 'liked' : id <= 122 ? 'kept' : null;
      db.connection.prepare(`INSERT INTO archive_catalog_creators
        (id,canonical_name,normalized_name,seed_source,seed_source_creator_id,effective_rating,preference,is_active)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, `Creator ${String(id).padStart(3, '0')}`, `creator ${id}`, 'test', String(id), rating, preference, id === 124 ? 0 : 1);
      db.connection.prepare(`INSERT INTO archive_catalog_creator_aliases (creator_id,alias,normalized_alias,source)
        VALUES (?,?,?,'test')`).run(id, `共同别名 ${id}`, `共同别名 ${id}`);
      addFolder(id);
    }
    addFolder(1, '-second');
    addFolder(0); // Unlinked identities stay visible in the existing default range.
  });
  afterAll(async () => {
    db?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('defaults only this endpoint to 60 and gives full totals, stable pages and an exact last page', async () => {
    const pages = await Promise.all([1, 2, 3].map(page => requestTestApp(app, 'GET', `/api/cos-gallery/creators?page=${page}`)));
    expect(pages.map(page => page.status)).toEqual([200, 200, 200]);
    expect(pages.map(page => page.body.items.length)).toEqual([60, 60, 4]);
    expect(pages.map(page => page.body.total)).toEqual([124, 124, 124]);
    expect(pages.map(page => page.body.hasMore)).toEqual([true, true, false]);
    const items = pages.flatMap(page => page.body.items);
    expect(new Set(items.map(item => item.key)).size).toBe(124);
    expect(items.find(item => item.key === 'creator:1')).toMatchObject({ workCount: 2, folderIds: expect.any(Array) });
    expect(items.find(item => item.key === 'creator:1').folderIds).toHaveLength(2);
    expect(items.some(item => item.key === 'creator:123' && item.preference === null)).toBe(true);
    expect(items.some(item => item.linkStatus === 'unlinked')).toBe(true);
    expect(items.some(item => item.key === 'creator:124')).toBe(false);
  });

  it.each([['R18', 'liked'], ['R15', 'kept']])('ANDs alias search, %s and %s before pagination', async (rating, preference) => {
    const query = `q=${encodeURIComponent('共同别名')}&contentRating=${rating}&preference=${preference}`;
    const first = await requestTestApp(app, 'GET', `/api/cos-gallery/creators?${query}`);
    const last = await requestTestApp(app, 'GET', `/api/cos-gallery/creators?${query}&page=2`);
    expect(first.body).toMatchObject({ total: 61, limit: 60, hasMore: true });
    expect(first.body.items).toHaveLength(60);
    expect(last.body).toMatchObject({ total: 61, hasMore: false });
    expect(last.body.items).toHaveLength(1);
    expect([...first.body.items, ...last.body.items].every(item => item.preference === preference && item.contentRating === rating)).toBe(true);
  });

  it('keeps zero combinations empty, old lifecycle ranges exact, and observes preference changes on the next read', async () => {
    const empty = await requestTestApp(app, 'GET', '/api/cos-gallery/creators?contentRating=R15&preference=liked');
    expect(empty.body).toMatchObject({ total: 0, hasMore: false, items: [] });
    for (const rating of ['unclassified', 'unlinked', 'inactive']) {
      const response = await requestTestApp(app, 'GET', `/api/cos-gallery/creators?contentRating=${rating}`);
      expect(response.body.total).toBe(1);
    }
    db.connection.prepare("UPDATE archive_catalog_creators SET preference='kept' WHERE id=1").run();
    const refreshed = await requestTestApp(app, 'GET', '/api/cos-gallery/creators?contentRating=R18&preference=liked');
    expect(refreshed.body.total).toBe(60);
    expect(refreshed.body.items.some((item: { id: number }) => item.id === 1)).toBe(false);
    expect((await requestTestApp(app, 'GET', '/api/cos-gallery/creators?preference=invalid')).status).toBe(400);
  });
});
