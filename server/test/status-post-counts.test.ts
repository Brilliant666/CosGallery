import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.sequential('combined visible Post counts', () => {
  let root: string;
  let db: typeof import('../src/db/database.js')['databaseManager'];
  let repos: typeof import('../src/db/repositories.js');
  let gallery: typeof import('../src/services/gallery-service.js')['galleryService'];
  let storage: typeof import('../src/services/storage-service.js')['storageService'];
  let ownerId: number;
  let sourceId: number;
  let serial = 0;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'status-post-counts-'));
    vi.stubEnv('NODE_ENV', 'test');
    for (const key of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      const directory = path.join(root, key);
      await fs.mkdir(directory, { recursive: true });
      vi.stubEnv(key, directory);
    }
    vi.resetModules();
    ({ databaseManager: db } = await import('../src/db/database.js'));
    repos = await import('../src/db/repositories.js');
    ({ galleryService: gallery } = await import('../src/services/gallery-service.js'));
    ({ storageService: storage } = await import('../src/services/storage-service.js'));
    ownerId = repos.folderRepository.upsert({ slug: 'synthetic', name: 'Synthetic', folderPath: 'synthetic' }).id;
    sourceId = repos.folderRepository.upsert({ slug: 'assets', name: 'Assets', folderPath: 'synthetic/assets',
      role: 'carousel_source', carouselOwnerFolderId: ownerId }).id;
  });

  beforeEach(() => {
    serial = 0;
    db.connection.exec(`UPDATE archive_catalog_works SET primary_local_work_id=NULL;
      DELETE FROM archive_catalog_local_works;
      DELETE FROM archive_catalog_works;
      DELETE FROM archive_catalog_local_creator_folders;
      DELETE FROM archive_catalog_creators;
      DELETE FROM posts;
      DELETE FROM images;`);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    db?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  function addPost(postType: 'single' | 'carousel', options: { cover?: boolean; video?: boolean; hiddenFolder?: boolean } = {}) {
    const name = `item-${++serial}`;
    const filename = options.cover ? 'cover.jpg' : `${name}.${options.video ? 'mp4' : 'jpg'}`;
    const relativePath = `synthetic/${name}/${filename}`;
    const imageInput: Parameters<typeof repos.imageRepository.upsert>[0] = {
      folderId: options.cover ? ownerId : sourceId, filename,
      extension: options.video ? '.mp4' : '.jpg', relativePath, absolutePath: path.join(root, 'GALLERY_ROOT', relativePath),
      fileSize: 100, width: 20, height: 30, mediaType: options.video ? 'video' : 'image',
      mimeType: options.video ? 'video/mp4' : 'image/jpeg', durationMs: options.video ? 1000 : null,
      fingerprint: name, mtimeMs: 1000, firstSeenAt: '2026-01-01', sortTimestamp: 1000,
      takenAt: null, takenAtSource: 'mtime', exifJson: null, thumbnailPath: `${name}.webp`, previewPath: `${name}.webp`
    };
    const image = repos.imageRepository.upsert(imageInput);
    const items = [{ imageId: image.id, position: 1 }];
    if (postType === 'carousel') {
      const second = repos.imageRepository.upsert({ ...imageInput, folderId: sourceId,
        extension: '.jpg', mediaType: 'image', mimeType: 'image/jpeg', durationMs: null,
        filename: 'second.jpg', relativePath: `synthetic/${name}/second.jpg`,
        absolutePath: path.join(root, 'GALLERY_ROOT', `synthetic/${name}/second.jpg`) });
      items.push({ imageId: second.id, position: 2 });
    }
    return repos.postRepository.upsertPostWithItems({
      folderId: options.hiddenFolder ? sourceId : ownerId, sourcePath: `synthetic/${name}`,
      postType, sortTimestamp: 1000, takenAt: null, takenAtSource: 'mtime'
    }, items).id;
  }

  function expectCounts(posts: number, carousels: number) {
    expect(repos.postRepository.countVisiblePostSummary()).toEqual({ posts, carousels });
    expect(repos.imageRepository.countVisiblePostSummary()).toEqual({ posts, carousels });
    expect(repos.postRepository.countFeed()).toBe(posts);
    expect(repos.postRepository.countVisibleCarousels()).toBe(carousels);
  }

  it('returns numeric zeroes for an empty library', () => { expectCounts(0, 0); });

  it('counts normal singles and carousels while excluding explicit covers and non-normal folders', () => {
    addPost('single');
    addPost('carousel');
    addPost('single', { video: true });
    addPost('single', { cover: true });
    addPost('carousel', { hiddenFolder: true });
    expectCounts(3, 1);
    // The existing media metric includes a cover Post; it is deliberately not
    // narrowed to the visible-Post summary's scope by this optimization.
    expect(repos.imageRepository.countVisibleMediaAssets()).toBe(5);
    expect(repos.imageRepository.countVisibleSingleVideos()).toBe(1);
    expect(gallery.getStatus()).toMatchObject({ indexedPosts: 3, indexedImages: 3,
      indexedCarousels: 1, indexedMediaAssets: 5, indexedVideos: 1 });
  });

  it('immediately reflects deleted, trashed and restored Posts without caching counts', () => {
    const single = addPost('single');
    const carousel = addPost('carousel');
    expectCounts(2, 1);
    db.connection.prepare('UPDATE posts SET is_deleted=1 WHERE id=?').run(single);
    expectCounts(1, 1);
    db.connection.prepare('UPDATE posts SET is_trashed=1 WHERE id=?').run(carousel);
    expectCounts(0, 0);
    db.connection.prepare('UPDATE posts SET is_deleted=0,is_trashed=0').run();
    expectCounts(2, 1);
  });

  it('reports carousel videos alongside standalone videos in the Reels count', () => {
    addPost('single', { video: true });
    addPost('carousel', { video: true });
    expect(repos.imageRepository.countVisibleSingleVideos()).toBe(1);
    expect(gallery.getStatus().indexedVideos).toBe(2);
    expect(gallery.getStats().indexedVideos).toBe(2);
  });

  it('preserves explicit primary-copy and active local-folder visibility without promoting a secondary copy', () => {
    const primary = addPost('carousel');
    const secondary = addPost('carousel');
    db.connection.exec(`INSERT INTO archive_catalog_creators
      (id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES (1,'Synthetic','synthetic','test','synthetic');
      INSERT INTO archive_catalog_works (id,creator_id,display_title,title_policy)
      VALUES (1,1,'Synthetic Work','manual');`);
    db.connection.prepare(`INSERT INTO archive_catalog_local_creator_folders
      (id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES (1,1,?,?,'synthetic',?,'Synthetic','matched','2026-01-01')`).run(ownerId, root, path.join(root, 'synthetic'));
    for (const [index, postId] of [primary, secondary].entries()) {
      db.connection.prepare(`INSERT INTO archive_catalog_local_works
        (id,local_creator_folder_id,work_id,identity_policy,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES (?,1,1,'manual',?,?,?,?,'matched','2026-01-01')`)
        .run(index + 1, postId, `copy-${index}`, path.join(root, `copy-${index}`), `copy-${index}`);
    }
    expectCounts(2, 2); // Unmarked legacy copies retain their old visibility.
    db.connection.exec('UPDATE archive_catalog_works SET primary_local_work_id=1 WHERE id=1');
    expectCounts(1, 1);
    db.connection.exec('UPDATE archive_catalog_local_works SET is_active=0 WHERE id=1');
    expectCounts(0, 0);
    db.connection.exec('UPDATE archive_catalog_local_works SET is_active=1 WHERE id=1');
    expectCounts(1, 1);
    db.connection.exec('UPDATE archive_catalog_local_creator_folders SET is_active=0 WHERE id=1');
    expectCounts(0, 0);
    db.connection.exec('UPDATE archive_catalog_local_creator_folders SET is_active=1 WHERE id=1');
    expectCounts(1, 1);
  });

  it.each(['getStatus', 'getStats'] as const)('%s uses one combined count and keeps media/video counts separate', method => {
    const summary = vi.spyOn(repos.imageRepository, 'countVisiblePostSummary').mockReturnValue({ posts: 11, carousels: 7 });
    const oldPosts = vi.spyOn(repos.imageRepository, 'countFeed');
    const oldCarousels = vi.spyOn(repos.imageRepository, 'countVisibleCarousels');
    const media = vi.spyOn(repos.imageRepository, 'countVisibleMediaAssets').mockReturnValue(29);
    const videos = vi.spyOn(repos.imageRepository, 'countVisibleVideoCandidates').mockReturnValue(3);
    expect(gallery[method]()).toMatchObject({ indexedImages: 11, indexedPosts: 11,
      indexedCarousels: 7, indexedMediaAssets: 29, indexedVideos: 3 });
    expect(summary).toHaveBeenCalledTimes(1);
    expect(oldPosts).not.toHaveBeenCalled();
    expect(oldCarousels).not.toHaveBeenCalled();
    expect(media).toHaveBeenCalledTimes(1);
    expect(videos).toHaveBeenCalledTimes(1);
  });

  it.each(['getStatus', 'getStats'] as const)('%s does not query visible counts when storage is unavailable', method => {
    vi.spyOn(storage, 'getState').mockReturnValue({ libraryAvailable: false, reason: 'Synthetic unavailable storage',
      usingInMemoryDatabase: true, databasePath: ':memory:' });
    const summary = vi.spyOn(repos.imageRepository, 'countVisiblePostSummary');
    const media = vi.spyOn(repos.imageRepository, 'countVisibleMediaAssets');
    const videos = vi.spyOn(repos.imageRepository, 'countVisibleVideoCandidates');
    expect(gallery[method]()).toMatchObject({ indexedImages: 0, indexedPosts: 0,
      indexedCarousels: 0, indexedMediaAssets: 0, indexedVideos: 0 });
    expect(summary).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(videos).not.toHaveBeenCalled();
  });
});
