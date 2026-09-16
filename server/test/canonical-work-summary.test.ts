import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';

describe.sequential('canonical creator work summaries', () => {
  let root: string;
  let repos: typeof import('../src/db/repositories.js');
  let db: typeof import('../src/db/database.js')['databaseManager'];
  let gallery: typeof import('../src/services/gallery-service.js')['galleryService'];
  let app: express.Application;
  const postIds: number[] = [];
  const mediaByPost = new Map<number, number[]>();

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-summary-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COS_GALLERY_MODE', '1');
    for (const key of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      const directory = path.join(root, key);
      await fs.mkdir(directory, { recursive: true });
      vi.stubEnv(key, directory);
    }
    vi.resetModules();
    ({ databaseManager: db } = await import('../src/db/database.js'));
    repos = await import('../src/db/repositories.js');
    ({ galleryService: gallery } = await import('../src/services/gallery-service.js'));
    app = (await import('../src/app.js')).createApp();
    db.connection.exec(`INSERT INTO archive_catalog_creators (id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES (1,'Synthetic','synthetic','test','synthetic'), (2,'Unrelated','unrelated','test','unrelated');
      INSERT INTO archive_catalog_creator_aliases (creator_id,alias,normalized_alias,source)
      VALUES (1,'First alias','first alias','test'), (2,'Other alias','other alias','test');
      UPDATE archive_catalog_creators SET preference='kept',effective_rating='R18' WHERE id=1;`);
    const owners = ['First', 'Second'].map((name, index) => {
      const folder = repos.folderRepository.upsert({ slug: name.toLowerCase(), name, folderPath: name });
      db.connection.prepare(`INSERT INTO archive_catalog_local_creator_folders
        (creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES (1,?,?,?,?,?,'matched','2026-01-01')`).run(folder.id, path.join(root, 'GALLERY_ROOT'), name, path.join(root, 'GALLERY_ROOT', name), name);
      return folder;
    });
    for (let index = 0; index < 27; index += 1) {
      const owner = owners[index % 2]!;
      const sourcePath = `${owner.folder_path}/Work-${index}`;
      const source = repos.folderRepository.upsert({ slug: `work-${index}`, name: `Work-${index}`, folderPath: sourcePath,
        role: 'carousel_source', carouselOwnerFolderId: owner.id });
      const media = Array.from({ length: index === 0 ? 1 : 3 }, (_, position) => {
        const video = (position + index) % 3 === 0;
        const extension = video ? '.mp4' : '.jpg';
        const relativePath = `${sourcePath}/${position + 1}${extension}`;
        return repos.imageRepository.upsert({ folderId: source.id, filename: `${position + 1}${extension}`, extension,
          relativePath, absolutePath: path.join(root, 'GALLERY_ROOT', relativePath), fileSize: 100 + position,
          width: 800 + position, height: 1200 + position, mediaType: video ? 'video' : 'image',
          mimeType: video ? 'video/mp4' : 'image/jpeg', durationMs: video ? 4000 : null,
          isAnimated: false, fingerprint: relativePath, mtimeMs: index + 1000, firstSeenAt: '2026-01-01', sortTimestamp: index + 1000,
          takenAt: null, takenAtSource: 'mtime', exifJson: JSON.stringify({ cameraMake: 'Synthetic' }),
          thumbnailPath: `${relativePath}.webp`, previewPath: `${relativePath}.preview`, playbackStrategy: 'preview' });
      });
      const post = repos.postRepository.upsertPostWithItems({ folderId: owner.id, sourcePath,
        postType: media.length > 1 ? 'carousel' : 'single', sortTimestamp: 1000 + Math.floor(index / 2),
        takenAt: null, takenAtSource: 'mtime' }, media.map((image, position) => ({ imageId: image.id, position: position + 1 })).reverse());
      db.connection.prepare('UPDATE posts SET caption=? WHERE id=?').run(index < 2 ? 'Same title' : `Title ${index}`, post.id);
      postIds.push(post.id);
      mediaByPost.set(post.id, media.map(image => image.id));
    }
  });

  afterAll(async () => {
    db?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not hydrate media for a full page; batches counts with only one extra query', () => {
    const hydrate = vi.spyOn(repos.postRepository, 'hydratePostItems');
    const prepare = vi.spyOn(db.connection, 'prepare');
    try {
      const page = repos.canonicalCreatorGalleryRepository.listVisibleWorks(1, 1, 24);
      expect(page).toHaveLength(24);
      expect(hydrate).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(2);
      const statements = prepare.mock.calls.map(call => call[0]);
      expect(statements.every(sql => !sql.includes('exif_json') && !sql.includes('file_size'))).toBe(true);
      for (const item of page) {
        expect(item).toMatchObject({ representation: 'summary', itemCount: 3, imageCount: 2, videoCount: 1 });
        expect(item).not.toHaveProperty('mediaItems');
      }
    } finally { hydrate.mockRestore(); prepare.mockRestore(); }
  });

  it('projects only the requested creator with the same complete multi-folder metadata as the gallery', () => {
    const full = gallery.getCosGalleryCreators(1, 100).items.find(item => item.id === 1)!;
    const candidates = vi.spyOn(repos.canonicalCreatorGalleryRepository, 'listFolderCandidates');
    const aliases = vi.spyOn(repos.canonicalCreatorGalleryRepository, 'listAliases');
    try {
      expect(gallery.getCanonicalCreator(1)).toMatchObject(full);
      expect(gallery.getCanonicalCreator(1)).toMatchObject({ aliases: ['First alias'], preference: 'kept', contentRating: 'R18' });
      expect(candidates).toHaveBeenCalledWith(1);
      expect(aliases).toHaveBeenCalledWith(1);
      expect(repos.canonicalCreatorGalleryRepository.listFolderCandidates(1)).toEqual(
        repos.canonicalCreatorGalleryRepository.listFolderCandidates().filter(item => item.canonicalCreatorId === 1));
      expect(gallery.getCanonicalCreator(2)).toBeNull();
      expect(gallery.getCanonicalCreator(999)).toBeNull();
      db.connection.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=1').run();
      expect(gallery.getCanonicalCreator(1)?.rosterStatus).toBe('inactive');
    } finally {
      db.connection.prepare('UPDATE archive_catalog_creators SET is_active=1 WHERE id=1').run();
      candidates.mockRestore(); aliases.mockRestore();
    }
  });

  it('scopes SQL before aggregation and uses existing creator and post indexes', () => {
    const prepare = vi.spyOn(db.connection, 'prepare');
    repos.canonicalCreatorGalleryRepository.listFolderCandidates(1);
    const sql = prepare.mock.calls[0]![0];
    prepare.mockRestore();
    const plan = db.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 1) as Array<{ detail: string }>;
    const details = plan.map(row => row.detail).join('\n');
    expect(details).toMatch(/SEARCH archive_catalog_local_creator_folders USING .*INDEX .*\(creator_id=\?\)/);
    expect(details).toMatch(/SEARCH posts USING .*INDEX .*\(folder_id=\?/);
    expect(sql).toContain('AND posts.folder_id IN (SELECT gallery_folder_id FROM selected_folders)');
  });

  it('does not make an ambiguous legacy folder readable by filtering away its other owner', () => {
    const folder = repos.folderRepository.getBySlug('first')!;
    // Isolated damaged-legacy fixture: production keeps this unique index.
    db.connection.exec('DROP INDEX idx_catalog_folder_gallery_active');
    const inserted = db.connection.prepare(`INSERT INTO archive_catalog_local_creator_folders
      (creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES (2,?,?,'Ambiguous',?,'Ambiguous','matched','2026-01-01')`).run(folder.id, root, path.join(root, 'Ambiguous'));
    try {
      expect(repos.canonicalCreatorGalleryRepository.listFolderCandidates(1)).toEqual(
        repos.canonicalCreatorGalleryRepository.listFolderCandidates().filter(item => item.canonicalCreatorId === 1));
      expect(gallery.getCanonicalCreator(1)?.folderIds).not.toContain(folder.id);
      expect(gallery.getCanonicalCreatorWork(1, postIds[0]!)).toBeNull();
      expect(gallery.getCanonicalCreatorWork(2, postIds[0]!)).toBeNull();
      expect(gallery.getCanonicalCreator(2)).toBeNull();
    } finally {
      db.connection.prepare('DELETE FROM archive_catalog_local_creator_folders WHERE id=?').run(Number(inserted.lastInsertRowid));
      db.connection.exec('CREATE UNIQUE INDEX idx_catalog_folder_gallery_active ON archive_catalog_local_creator_folders(gallery_folder_id) WHERE is_active=1 AND gallery_folder_id IS NOT NULL');
    }
  });

  it('preserves same-page IDs, stable ordering, cover fields, labels, counts and mixed details across physical folders', async () => {
    const first = await requestTestApp(app, 'GET', '/api/cos-gallery/creators/1/works?page=1&limit=24');
    const second = await requestTestApp(app, 'GET', '/api/cos-gallery/creators/1/works?page=2&limit=24');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, limit: 24, total: 27, hasMore: true });
    expect(second.body).toMatchObject({ page: 2, limit: 24, total: 27, hasMore: false });
    const cards = [...first.body.items, ...second.body.items];
    expect(cards.map(item => item.id)).toEqual([...postIds].reverse());
    expect(new Set(cards.map(item => item.folderId)).size).toBe(2);
    for (const card of cards) {
      expect(card).not.toHaveProperty('mediaItems');
      const detail = gallery.getCanonicalCreatorWork(1, card.id)!;
      for (const key of ['id', 'folderId', 'folderSlug', 'folderName', 'sourcePath', 'caption', 'carouselTitle',
        'filename', 'width', 'height', 'mediaType', 'durationMs', 'thumbnailUrl', 'previewUrl', 'sortTimestamp', 'takenAt', 'isSaved', 'postType', 'itemCount'] as const) {
        expect(card[key], `${card.id}.${key}`).toEqual(detail[key]);
      }
      expect(detail.mediaItems!.map(item => item.imageId)).toEqual(mediaByPost.get(card.id));
      expect(card.imageCount).toBe(detail.mediaItems!.filter(item => item.mediaType === 'image').length);
      expect(card.videoCount).toBe(detail.mediaItems!.filter(item => item.mediaType === 'video').length);
      expect(detail.mediaItems!.every(item => item.relativePath && item.originalUrl)).toBe(true);
    }
    expect(cards.filter(item => item.caption === 'Same title')).toHaveLength(2);
  });

  it('retains oldest order, cover-media filtering and empty page semantics', () => {
    expect(repos.canonicalCreatorGalleryRepository.listVisibleWorks(1, 1, 24, 'oldest').map(item => item.id)).toEqual(postIds.slice(0, 24));
    const videos = repos.canonicalCreatorGalleryRepository.listVisibleWorks(1, 1, 24, 'oldest', 'video');
    expect(videos.map(item => item.id)).toEqual(postIds.filter((_, index) => index % 3 === 0));
    expect(repos.canonicalCreatorGalleryRepository.countVisibleWorks(1, 'video')).toBe(videos.length);
    expect(repos.canonicalCreatorGalleryRepository.listVisibleWorks(1, 3, 24)).toEqual([]);
    expect(gallery.getCanonicalCreatorWorks(999, 1, 24)).toBeNull();
  });

  it('keeps canonical ownership and deleted/trashed visibility checks on lists and details', async () => {
    const postId = postIds[0]!;
    expect((await requestTestApp(app, 'GET', `/api/cos-gallery/creators/2/works/${postId}`)).status).toBe(404);
    for (const column of ['is_deleted', 'is_trashed']) {
      db.connection.prepare(`UPDATE posts SET ${column}=1 WHERE id=?`).run(postId);
      try {
        expect(gallery.getCanonicalCreatorWorks(1, 1, 100)?.items.some(item => item.id === postId)).toBe(false);
        expect((await requestTestApp(app, 'GET', `/api/cos-gallery/creators/1/works/${postId}`)).status).toBe(404);
      } finally { db.connection.prepare(`UPDATE posts SET ${column}=0 WHERE id=?`).run(postId); }
    }
  });
});
