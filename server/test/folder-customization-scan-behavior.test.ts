import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPreviewRelativePath, getThumbnailRelativePath } from '../src/utils/image-utils.js';

type AppConfigModule = typeof import('../src/config/env.js');
type GalleryServiceModule = typeof import('../src/services/gallery-service.js');
type ScannerServiceModule = typeof import('../src/services/scanner-service.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type AppSettingKeysModule = typeof import('../src/constants/app-setting-keys.js');

const generateThumbnailDerivativeMock = vi.fn();
const generateDerivativesMock = vi.fn();
const readMediaMetadataMock = vi.fn();

describe.sequential('folder customization scan behavior', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let galleryService: GalleryServiceModule['galleryService'];
  let scannerService: ScannerServiceModule['scannerService'];
  let imageRepository: RepositoriesModule['imageRepository'];
  let folderRepository: RepositoriesModule['folderRepository'];
  let maintenanceRepository: RepositoriesModule['maintenanceRepository'];
  let appSettingsRepository: RepositoriesModule['appSettingsRepository'];
  let FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY: AppSettingKeysModule['FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-folder-customization-scan-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  });

  beforeEach(async () => {
    generateThumbnailDerivativeMock.mockReset();
    generateDerivativesMock.mockReset();
    readMediaMetadataMock.mockReset();

    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });

    vi.resetModules();
    vi.doMock('../src/services/derivative-service.js', () => ({
      generateDerivatives: generateDerivativesMock,
      generateThumbnailDerivative: generateThumbnailDerivativeMock,
      readMediaMetadata: readMediaMetadataMock
    }));

    ({ appConfig } = await import('../src/config/env.js'));
    ({ galleryService } = await import('../src/services/gallery-service.js'));
    ({ scannerService } = await import('../src/services/scanner-service.js'));
    ({ imageRepository, folderRepository, maintenanceRepository, appSettingsRepository } = await import('../src/db/repositories.js'));
    ({ FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY } = await import('../src/constants/app-setting-keys.js'));

    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);

    readMediaMetadataMock.mockResolvedValue({
      width: 1000,
      height: 1000,
      takenAt: null,
      durationMs: null,
      mediaType: 'image',
      playbackStrategy: 'preview',
      isAnimated: false
    });

    generateDerivativesMock.mockImplementation(async (_sourcePath: string, relativePath: string) => ({
      width: 1000,
      height: 1000,
      takenAt: null,
      durationMs: null,
      mediaType: 'image',
      playbackStrategy: 'preview',
      isAnimated: false,
      thumbnailPath: getThumbnailRelativePath(relativePath),
      previewPath: getPreviewRelativePath(relativePath, 'image'),
      generatedThumbnail: true,
      generatedPreview: true
    }));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('preserves a customized folder name and description across normal rescans', async () => {
    maintenanceRepository.resetLibraryIndex();

    await createSourceFile('albums/photo-1.jpg');
    await scannerService.scanAll('manual');

    const updatedFolder = galleryService.updateFolderMetadata('albums', 'Custom Album', 'Hand-picked description');
    expect(updatedFolder?.name).toBe('Custom Album');
    expect(updatedFolder?.description).toBe('Hand-picked description');

    await createSourceFile('albums/photo-2.jpg');
    await scannerService.scanAll('manual');

    const rescannedFolder = folderRepository.getBySlug('albums');
    expect(rescannedFolder?.name).toBe('Custom Album');
    expect(rescannedFolder?.description).toBe('Hand-picked description');
  });

  it('preserves a manually selected cover across normal rescans', async () => {
    maintenanceRepository.resetLibraryIndex();

    await createSourceFile('albums/photo-1.jpg', 1000);
    await createSourceFile('albums/photo-2.jpg');
    await scannerService.scanAll('manual');

    const manualCover = imageRepository.getByRelativePath('albums/photo-1.jpg');
    expect(manualCover).toBeDefined();
    expect(galleryService.setFolderAvatar('albums', manualCover!.id)).toBe(true);

    await createSourceFile('albums/photo-3.jpg');
    await scannerService.scanAll('manual');

    const rescannedFolder = folderRepository.getBySlug('albums');
    expect(rescannedFolder?.avatar_image_id).toBe(manualCover!.id);
    expect(rescannedFolder?.avatar_source).toBe('manual');
  });

  it('preserves every manually selected carousel cover across rescans with or without a direct cover file', async () => {
    maintenanceRepository.resetLibraryIndex();

    for (const ownerPath of ['with-cover', 'without-cover']) {
      await createSourceFile(`${ownerPath}/photo.jpg`);
      if (ownerPath === 'with-cover') {
        await createSourceFile(`${ownerPath}/cover.jpg`);
      }
      await createSourceFile(`${ownerPath}/carousels/trip/01.jpg`);
      await createSourceFile(`${ownerPath}/carousels/trip/02.jpg`);
      await createSourceFile(`${ownerPath}/carousels/trip/03.jpg`);
    }

    await scannerService.scanAll('manual');

    for (const ownerPath of ['with-cover', 'without-cover']) {
      const owner = folderRepository.getByFolderPath(ownerPath)!;
      const carouselItems = [1, 2, 3].map((position) => (
        imageRepository.getByRelativePath(`${ownerPath}/carousels/trip/0${position}.jpg`)!
      ));

      for (const item of carouselItems) {
        expect(galleryService.setFolderAvatar(owner.slug, item.id)).toBe(true);
        await scannerService.scanAll('manual');

        const rescannedOwner = folderRepository.getById(owner.id);
        expect(rescannedOwner?.avatar_image_id).toBe(item.id);
        expect(rescannedOwner?.avatar_source).toBe('manual');
        expect(galleryService.getFolderBySlug(owner.slug)).toMatchObject({
          avatarImageId: item.id,
          avatarUrl: expect.stringContaining(item.thumbnail_path.replaceAll('\\', '/'))
        });
        expect(galleryService.getFolderImages(owner.slug, 1, 10)?.folder).toMatchObject({
          avatarImageId: item.id,
          avatarUrl: expect.stringContaining(item.thumbnail_path.replaceAll('\\', '/'))
        });
        expect(galleryService.listFolders()).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: owner.id, avatarImageId: item.id })
        ]));
      }

      const staleSelection = carouselItems.at(-1)!;
      imageRepository.markDeleted(staleSelection.relative_path);
      expect(galleryService.getFolderBySlug(owner.slug)?.avatarImageId).not.toBe(staleSelection.id);
    }
  });

  it('preserves a custom caption across normal rescans', async () => {
    maintenanceRepository.resetLibraryIndex();

    await createSourceFile('albums/photo-1.jpg');
    await scannerService.scanAll('manual');

    const image = imageRepository.getByRelativePath('albums/photo-1.jpg');
    expect(image).toBeDefined();

    const updated = galleryService.updateImageCaption(image!.id, 'Golden hour on the ridge');
    expect(updated?.caption).toBe('Golden hour on the ridge');

    await createSourceFile('albums/photo-2.jpg');
    await scannerService.scanAll('manual');

    expect(imageRepository.getById(image!.id)?.caption).toBeNull();
    expect(galleryService.getImageDetail(image!.id)?.caption).toBe('Golden hour on the ridge');
  });

  it('detects case-insensitive cover files in child albums and hides them from the feed, folder grid, and detail view', async () => {
    maintenanceRepository.resetLibraryIndex();

    await createSourceFile('family/trip/photo-1.jpg');
    await createSourceFile('family/trip/Cover.JPG', 1000);
    await scannerService.scanAll('manual');

    const folder = folderRepository.getByFolderPath('family/trip');
    const coverImage = imageRepository.getByRelativePath('family/trip/Cover.JPG');
    const visiblePhoto = imageRepository.getByRelativePath('family/trip/photo-1.jpg');

    expect(folder).toBeDefined();
    expect(coverImage).toBeDefined();
    expect(visiblePhoto).toBeDefined();
    expect(folder?.avatar_image_id).toBe(coverImage?.id);
    expect(folder?.avatar_source).toBe('cover');

    const folderPayload = galleryService.getFolderImages(folder!.slug, 1, 24);
    expect(folderPayload?.total).toBe(1);
    expect(folderPayload?.folder.avatarImageId).toBe(coverImage!.id);
    expect(folderPayload?.items.map((item) => item.id)).toEqual([visiblePhoto!.id]);
    expect(folderPayload?.items.map((item) => item.id)).not.toContain(coverImage!.id);

    const feedPayload = galleryService.getFeed(1, 24, 'recent');
    expect(feedPayload.items.map((item) => item.id)).not.toContain(coverImage!.id);

    expect(galleryService.getImageDetail(coverImage!.id)).toBeNull();
    expect(galleryService.getImageDetail(coverImage!.id, undefined, { isLegacyImageAlias: true })).toBeNull();
  });

  it('uses the saved app folder photo order for folder grids and detail navigation', async () => {
    maintenanceRepository.resetLibraryIndex();

    await createSourceFile('albums/older.jpg', 20_000);
    await createSourceFile('albums/newer.jpg');
    await scannerService.scanAll('manual');

    const olderImage = imageRepository.getByRelativePath('albums/older.jpg');
    const newerImage = imageRepository.getByRelativePath('albums/newer.jpg');

    expect(olderImage).toBeDefined();
    expect(newerImage).toBeDefined();

    expect(galleryService.getFolderImages('albums', 1, 24)?.items.map((item) => item.id)).toEqual([
      newerImage!.id,
      olderImage!.id
    ]);

    appSettingsRepository.set(FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY, 'oldest');

    expect(galleryService.getFolderImages('albums', 1, 24)?.items.map((item) => item.id)).toEqual([
      olderImage!.id,
      newerImage!.id
    ]);
    expect(galleryService.getImageDetail(olderImage!.id)?.nextImageId).toBe(newerImage!.id);
    expect(galleryService.getImageDetail(newerImage!.id)?.previousImageId).toBe(olderImage!.id);
  });

  async function createSourceFile(relativePath: string, mtimeOffsetMs = 0): Promise<void> {
    const absolutePath = path.join(appConfig.galleryRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `source:${relativePath}`);

    if (mtimeOffsetMs) {
      const now = new Date();
      now.setMilliseconds(now.getMilliseconds() - mtimeOffsetMs);
      await fs.utimes(absolutePath, now, now);
    }
  }
});
