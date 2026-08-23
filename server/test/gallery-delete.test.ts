import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFingerprint,
  getMediaTypeFromExtension,
  getMimeTypeFromExtension,
  getPreviewRelativePath,
  getThumbnailRelativePath
} from '../src/utils/image-utils.js';

type AppConfigModule = typeof import('../src/config/env.js');
type GalleryServiceModule = typeof import('../src/services/gallery-service.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type ModelsModule = typeof import('../src/types/models.js');

type FolderRecord = ModelsModule['FolderRecord'];
type ImageRecord = ModelsModule['ImageRecord'];

describe.sequential('gallery folder deletion', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let galleryService: GalleryServiceModule['galleryService'];
  let folderRepository: RepositoriesModule['folderRepository'];
  let imageRepository: RepositoriesModule['imageRepository'];
  let postRepository: RepositoriesModule['postRepository'];
  let folderScanStateRepository: RepositoriesModule['folderScanStateRepository'];
  let maintenanceRepository: RepositoriesModule['maintenanceRepository'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-gallery-delete-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));

    vi.resetModules();

    ({ appConfig } = await import('../src/config/env.js'));
    ({ galleryService } = await import('../src/services/gallery-service.js'));

    ({
      folderRepository,
      imageRepository,
      postRepository,
      folderScanStateRepository,
      maintenanceRepository
    } = await import('../src/db/repositories.js'));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    maintenanceRepository.resetLibraryIndex();
    await Promise.all([
      fs.rm(appConfig.galleryRoot, { recursive: true, force: true }),
      fs.rm(appConfig.thumbnailsDir, { recursive: true, force: true }),
      fs.rm(appConfig.previewsDir, { recursive: true, force: true })
    ]);
    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);
  });

  it('deletes a direct-image folder cleanly and removes its empty directories', async () => {
    await createIndexedFolder('parent', ['photo-1.jpg']);

    const result = await galleryService.deleteFolder('parent');

    expect(result).toEqual({
      slug: 'parent',
      deletedImageCount: 1,
      deletedFolderCount: 1,
      deletedSourceFolder: false
    });
    expect(folderRepository.getBySlug('parent')).toBeUndefined();
    expect(imageRepository.getByRelativePath('parent/photo-1.jpg')).toBeUndefined();
    expect(folderScanStateRepository.getAll()).toEqual([]);
    await expectPathMissing(path.join(appConfig.galleryRoot, 'parent'));
    await expectPathMissing(path.join(appConfig.thumbnailsDir, 'parent'));
    await expectPathMissing(path.join(appConfig.previewsDir, 'parent'));
  });

  it('deletes indexed videos and their generated preview mp4 files', async () => {
    await createIndexedFolder('clips', ['clip-1.mp4']);

    const result = await galleryService.deleteFolder('clips');

    expect(result).toEqual({
      slug: 'clips',
      deletedImageCount: 1,
      deletedFolderCount: 1,
      deletedSourceFolder: false
    });
    await expectPathMissing(path.join(appConfig.galleryRoot, 'clips'));
    await expectPathMissing(path.join(appConfig.thumbnailsDir, 'clips'));
    await expectPathMissing(path.join(appConfig.previewsDir, 'clips'));
  });

  it('keeps child source folders on disk and in the database when only direct images are deleted', async () => {
    await createIndexedFolder('parent', ['photo-1.jpg']);
    await createIndexedFolder('parent/child-a', ['photo-2.jpg']);

    const result = await galleryService.deleteFolder('parent');

    expect(result).toEqual({
      slug: 'parent',
      deletedImageCount: 1,
      deletedFolderCount: 1,
      deletedSourceFolder: false
    });
    expect(folderRepository.getBySlug('parent')).toBeUndefined();
    expect(folderRepository.getBySlug('parent-child-a')).toBeDefined();
    expect(imageRepository.getByRelativePath('parent/photo-1.jpg')).toBeUndefined();
    expect(imageRepository.getByRelativePath('parent/child-a/photo-2.jpg')).toBeDefined();
    expect(folderScanStateRepository.getAll().map((entry) => entry.folder_path)).toEqual(['parent/child-a']);
    await expectPathMissing(path.join(appConfig.galleryRoot, 'parent', 'photo-1.jpg'));
    await expectPathPresent(path.join(appConfig.galleryRoot, 'parent'));
    await expectPathPresent(path.join(appConfig.galleryRoot, 'parent', 'child-a'));
    await expectPathPresent(path.join(appConfig.galleryRoot, 'parent', 'child-a', 'photo-2.jpg'));
    await expectPathPresent(path.join(appConfig.thumbnailsDir, 'parent', 'child-a'));
    await expectPathPresent(path.join(appConfig.previewsDir, 'parent', 'child-a'));
  });

  it('removes the full source subtree when subtree deletion is requested', async () => {
    await createIndexedFolder('parent', ['photo-1.jpg']);
    await createIndexedFolder('parent/child-a', ['photo-2.jpg']);
    await fs.writeFile(path.join(appConfig.galleryRoot, 'parent', 'notes.txt'), 'keep me only in direct-delete mode');
    await fs.writeFile(path.join(appConfig.galleryRoot, 'parent', 'child-a', 'clip.mp4'), 'also deleted in subtree mode');

    const result = await galleryService.deleteFolder('parent', {
      deleteSourceFolder: true
    });

    expect(result).toEqual({
      slug: 'parent',
      deletedImageCount: 2,
      deletedFolderCount: 2,
      deletedSourceFolder: true
    });
    expect(folderRepository.getBySlug('parent')).toBeUndefined();
    expect(folderRepository.getBySlug('parent-child-a')).toBeUndefined();
    expect(imageRepository.getByRelativePath('parent/photo-1.jpg')).toBeUndefined();
    expect(imageRepository.getByRelativePath('parent/child-a/photo-2.jpg')).toBeUndefined();
    expect(folderScanStateRepository.getAll()).toEqual([]);
    await expectPathMissing(path.join(appConfig.galleryRoot, 'parent'));
    await expectPathMissing(path.join(appConfig.thumbnailsDir, 'parent'));
    await expectPathMissing(path.join(appConfig.previewsDir, 'parent'));
  });

  it('deletes owned carousel originals, derivatives, source folders, and database rows in default mode', async () => {
    const owner = await createIndexedFolder('album', ['normal.jpg']);
    const firstCarousel = await createIndexedFolder('album/carousels/first', ['01.jpg', '02.jpg'], {
      role: 'carousel_source',
      carouselOwnerFolderId: owner.folder.id
    });
    const secondCarousel = await createIndexedFolder('album/carousels/second', ['01.jpg', '02.jpg'], {
      role: 'carousel_source',
      carouselOwnerFolderId: owner.folder.id
    });
    for (const carousel of [firstCarousel, secondCarousel]) {
      postRepository.upsertPostWithItems({
        folderId: owner.folder.id,
        sourcePath: carousel.folder.folder_path,
        postType: 'carousel',
        sortTimestamp: carousel.images[0].sort_timestamp,
        isDeleted: 0,
        isTrashed: 0
      }, carousel.images.map((image, index) => ({ imageId: image.id, position: index + 1 })));
    }

    const result = await galleryService.deleteFolder('album');
    expect(result).toEqual({
      slug: 'album',
      deletedImageCount: 5,
      deletedFolderCount: 1,
      deletedSourceFolder: false
    });
    expect(folderRepository.getBySlug('album')).toBeUndefined();
    expect(folderRepository.getByFolderPath('album/carousels/first')).toBeUndefined();
    expect(folderRepository.getByFolderPath('album/carousels/second')).toBeUndefined();
    expect(postRepository.countAll()).toBe(0);
    for (const image of [...owner.images, ...firstCarousel.images, ...secondCarousel.images]) {
      expect(imageRepository.getById(image.id)).toBeUndefined();
    }
    await expectPathMissing(path.join(appConfig.galleryRoot, 'album'));
    await expectPathMissing(path.join(appConfig.thumbnailsDir, 'album'));
    await expectPathMissing(path.join(appConfig.previewsDir, 'album'));
  });

  it('includes owned carousel sources in full source-subtree deletion counts', async () => {
    const owner = await createIndexedFolder('album', ['normal.jpg']);
    const firstCarousel = await createIndexedFolder('album/carousels/first', ['01.jpg', '02.jpg'], {
      role: 'carousel_source',
      carouselOwnerFolderId: owner.folder.id
    });
    const secondCarousel = await createIndexedFolder('album/carousels/second', ['01.jpg', '02.jpg'], {
      role: 'carousel_source',
      carouselOwnerFolderId: owner.folder.id
    });
    await fs.writeFile(path.join(appConfig.galleryRoot, 'album', 'notes.txt'), 'also removed');

    const result = await galleryService.deleteFolder('album', { deleteSourceFolder: true });
    expect(result).toEqual({
      slug: 'album',
      deletedImageCount: 5,
      deletedFolderCount: 3,
      deletedSourceFolder: true
    });
    expect(folderRepository.getBySlug('album')).toBeUndefined();
    expect(folderRepository.getByFolderPath(firstCarousel.folder.folder_path)).toBeUndefined();
    expect(folderRepository.getByFolderPath(secondCarousel.folder.folder_path)).toBeUndefined();
    await expectPathMissing(path.join(appConfig.galleryRoot, 'album'));
    await expectPathMissing(path.join(appConfig.thumbnailsDir, 'album'));
    await expectPathMissing(path.join(appConfig.previewsDir, 'album'));
  });

  it.each([
    { mode: 'default', deleteSourceFolder: false, deletedFolderCount: 1 },
    { mode: 'full subtree', deleteSourceFolder: true, deletedFolderCount: 2 }
  ])('removes soft-deleted and trashed carousel derivatives during $mode deletion', async ({
    deleteSourceFolder,
    deletedFolderCount
  }) => {
    const owner = await createIndexedFolder('album', ['normal.jpg']);
    const carousel = await createIndexedFolder('album/carousels/video-post', ['cover.jpg', 'clip.mp4'], {
      role: 'carousel_source',
      carouselOwnerFolderId: owner.folder.id
    });
    const post = postRepository.upsertPostWithItems({
      folderId: owner.folder.id,
      sourcePath: carousel.folder.folder_path,
      postType: 'carousel',
      sortTimestamp: carousel.images[0].sort_timestamp,
      isDeleted: 0,
      isTrashed: 0
    }, carousel.images.map((image, index) => ({ imageId: image.id, position: index + 1 })));

    expect(postRepository.trashPost(post.id)).toBe(true);
    const softDeletedVideo = carousel.images.find((image) => image.media_type === 'video')!;
    imageRepository.markDeleted(softDeletedVideo.relative_path);
    await fs.rm(softDeletedVideo.absolute_path);
    expect(softDeletedVideo.preview_path).toMatch(/\.mp4$/);
    await expectPathPresent(path.join(appConfig.thumbnailsDir, softDeletedVideo.thumbnail_path));
    await expectPathPresent(path.join(appConfig.previewsDir, softDeletedVideo.preview_path));

    const result = await galleryService.deleteFolder('album', { deleteSourceFolder });
    expect(result).toEqual({
      slug: 'album',
      deletedImageCount: 3,
      deletedFolderCount,
      deletedSourceFolder: deleteSourceFolder
    });

    for (const image of [...owner.images, ...carousel.images]) {
      expect(imageRepository.getById(image.id)).toBeUndefined();
      await expectPathMissing(path.join(appConfig.galleryRoot, image.relative_path));
      await expectPathMissing(path.join(appConfig.thumbnailsDir, image.thumbnail_path));
      await expectPathMissing(path.join(appConfig.previewsDir, image.preview_path));
    }
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

  async function expectPathPresent(targetPath: string): Promise<void> {
    await expect(fs.stat(targetPath)).resolves.toBeDefined();
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    await expect(fs.stat(targetPath)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  }
});
