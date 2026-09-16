import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe.sequential('admitted Work primary-copy gallery projection', () => {
  let root: string;
  let db: typeof import('../src/db/database.js')['databaseManager'];
  let repos: typeof import('../src/db/repositories.js');
  let gallery: typeof import('../src/services/gallery-service.js')['galleryService'];
  let primary: number;
  let secondary: number;
  let independent: number;
  let primaryLocal: number;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'admission-gallery-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COS_GALLERY_MODE', '1');
    for (const key of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      const dir = path.join(root, key);
      await fs.mkdir(dir, { recursive: true });
      vi.stubEnv(key, dir);
    }
    vi.resetModules();
    ({ databaseManager: db } = await import('../src/db/database.js'));
    repos = await import('../src/db/repositories.js');
    ({ galleryService: gallery } = await import('../src/services/gallery-service.js'));
    db.connection.exec(`INSERT INTO archive_catalog_creators (id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES (1,'Synthetic Creator','synthetic creator','test','synthetic');
      INSERT INTO archive_catalog_works (id,creator_id,display_title,title_policy) VALUES (1,1,'Same title','manual'),(2,1,'Same title','manual');`);
    const folder = repos.folderRepository.upsert({ slug: 'synthetic', name: 'Synthetic Creator', folderPath: 'Synthetic' });
    db.connection.prepare(`INSERT INTO archive_catalog_local_creator_folders
      (id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES (1,1,?,?,'Synthetic',?,'Synthetic','matched','2026-01-01')`).run(folder.id, root, path.join(root, 'Synthetic'));
    const add = (name: string, work: number, time: number) => {
      const sourcePath = `Synthetic/${name}`;
      const source = repos.folderRepository.upsert({ slug: name, name, folderPath: sourcePath, role: 'carousel_source', carouselOwnerFolderId: folder.id });
      const image = repos.imageRepository.upsert({ folderId: source.id, filename: '1.jpg', extension: '.jpg',
        relativePath: `${sourcePath}/1.jpg`, absolutePath: path.join(root, sourcePath, '1.jpg'),
        fileSize: 100, width: 20, height: 30, mediaType: 'image', mimeType: 'image/jpeg', durationMs: null,
        isAnimated: false, fingerprint: name, mtimeMs: time, firstSeenAt: '2026-01-01', sortTimestamp: time,
        takenAt: null, takenAtSource: 'mtime', exifJson: null, thumbnailPath: `${name}.webp`, previewPath: `${name}.webp`, playbackStrategy: 'preview' });
      const post = repos.postRepository.upsertPostWithItems({ folderId: folder.id, sourcePath, postType: 'single', sortTimestamp: time,
        takenAt: null, takenAtSource: 'mtime' }, [{ imageId: image.id, position: 1 }]);
      const local = db.connection.prepare(`INSERT INTO archive_catalog_local_works
        (local_creator_folder_id,work_id,identity_policy,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES (1,?,'manual',?,?,?,?,'matched','2026-01-01')`).run(work,post.id,name,path.join(root,sourcePath),name);
      return { postId: post.id, localId: Number(local.lastInsertRowid), imageId: image.id };
    };
    const a = add('original', 1, 1000);
    primary = a.postId;
    primaryLocal = a.localId;
    secondary = add('different-bytes-copy', 1, 3000).postId;
    independent = add('same-title-different-work', 2, 2000).postId;
  });
  afterAll(async () => { db?.close(); vi.unstubAllEnvs(); vi.resetModules(); await fs.rm(root, { recursive: true, force: true }); });

  it('retains unmarked legacy posts without guessing by title or shared Work', () => {
    expect(repos.canonicalCreatorGalleryRepository.countVisibleWorks(1)).toBe(3);
  });
  it('uses one explicit primary across lists, totals, cover, and media while retaining direct IDs', () => {
    db.connection.prepare('UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=1').run(primaryLocal);
    expect(repos.canonicalCreatorGalleryRepository.listVisibleWorks(1, 1, 10).map(p => p.id)).toEqual([independent, primary]);
    expect(repos.canonicalCreatorGalleryRepository.countVisibleWorks(1)).toBe(2);
    expect(repos.canonicalCreatorGalleryRepository.getVisibleMediaSummary(1).imageCount).toBe(2);
    const candidate = repos.canonicalCreatorGalleryRepository.listFolderCandidates()[0]!;
    expect(repos.canonicalCreatorGalleryRepository.listFolderCandidates(1)).toEqual([candidate]);
    expect(candidate.workCount).toBe(2);
    const cover = repos.postRepository.findById(independent)!;
    expect(candidate.latestWorkAt).toBe(cover.sort_timestamp);
    expect(repos.postRepository.countCosGalleryWorks()).toBe(2);
    expect(repos.postRepository.countFeed()).toBe(2);
    expect(gallery.getCanonicalCreatorWorks(1, 1, 10)?.items.map(item => item.carouselTitle)).toEqual(['Same title', 'Same title']);
    expect(repos.canonicalCreatorGalleryRepository.ownsVisiblePost(1, secondary)).toBe(true);
    expect(gallery.getCanonicalCreatorWork(1, secondary)?.id).toBe(secondary);
    expect(gallery.getCanonicalCreatorWork(1, primary)?.carouselTitle).toBe('Same title');
    expect(gallery.getCanonicalCreatorWork(1, secondary)?.carouselTitle).toBe('Same title');
  });
  it('keeps an offline primary explicit and never promotes a remaining copy', () => {
    db.connection.prepare('UPDATE archive_catalog_local_works SET is_active=0 WHERE id=?').run(primaryLocal);
    expect(repos.canonicalCreatorGalleryRepository.listVisibleWorks(1, 1, 10).map(p => p.id)).toEqual([independent]);
    expect(repos.canonicalCreatorGalleryRepository.getVisibleMediaSummary(1).imageCount).toBe(1);
    expect(gallery.getCanonicalCreator(1)?.unavailablePrimaryWorks).toEqual([
      expect.objectContaining({ workId: 1, postId: primary, title: 'Same title' })
    ]);
    // Removing the remaining independent card still retains the creator and offline explanation.
    db.connection.prepare('UPDATE posts SET is_deleted=1 WHERE id=?').run(independent);
    expect(gallery.getCanonicalCreator(1)).toMatchObject({ workCount: 0, imageCount: 0 });
    db.connection.prepare('UPDATE archive_catalog_local_creator_folders SET is_active=0 WHERE id=1').run();
    expect(gallery.getCanonicalCreator(1)?.unavailablePrimaryWorks).toHaveLength(1);
    expect(repos.canonicalCreatorGalleryRepository.listFolderCandidates(1)).toEqual(
      repos.canonicalCreatorGalleryRepository.listFolderCandidates().filter(item => item.canonicalCreatorId === 1));
    expect(repos.postRepository.findById(secondary)).toBeDefined();
  });
});
