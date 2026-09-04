import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type express from 'express';

import {
  getMediaTypeFromExtension,
  getPreviewRelativePath,
  getThumbnailRelativePath
} from '../src/utils/image-utils.js';
import { getRelativeGalleryPath } from '../src/utils/path-utils.js';
import { requestTestApp } from './http-test-utils.js';

const generateDerivativesMock = vi.fn();
const generateThumbnailDerivativeMock = vi.fn();
const readMediaMetadataMock = vi.fn();

describe.sequential('COS gallery mode', () => {
  let tempRoot = '';
  let appConfig: typeof import('../src/config/env.js')['appConfig'];
  let scannerService: typeof import('../src/services/scanner-service.js')['scannerService'];
  let galleryService: typeof import('../src/services/gallery-service.js')['galleryService'];
  let postRepository: typeof import('../src/db/repositories.js')['postRepository'];
  let creatorRatingRepository: typeof import('../src/db/repositories.js')['creatorRatingRepository'];
  let maintenanceRepository: typeof import('../src/db/repositories.js')['maintenanceRepository'];
  let databaseManager: typeof import('../src/db/database.js')['databaseManager'];
  let app: express.Application;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-cos-gallery-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COS_GALLERY_MODE', '1');
    vi.stubEnv('PUBLIC_DEMO_MODE', '1');
    vi.stubEnv('DERIVATIVE_MODE', 'lazy');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  });

  beforeEach(async () => {
    generateDerivativesMock.mockReset();
    generateThumbnailDerivativeMock.mockReset();
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
    ({ scannerService } = await import('../src/services/scanner-service.js'));
    ({ galleryService } = await import('../src/services/gallery-service.js'));
    ({ postRepository, creatorRatingRepository, maintenanceRepository } = await import('../src/db/repositories.js'));
    ({ databaseManager } = await import('../src/db/database.js'));
    app = (await import('../src/app.js')).createApp();

    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);

    readMediaMetadataMock.mockImplementation(async (absolutePath: string) => {
      const extension = path.extname(absolutePath).toLowerCase();
      const mediaType = getMediaTypeFromExtension(extension);
      const relativePath = getRelativeGalleryPath(appConfig.galleryRoot, absolutePath);

      return {
        width: mediaType === 'video' ? 1080 : 1440,
        height: mediaType === 'video' ? 1920 : 960,
        takenAt: null,
        durationMs: mediaType === 'video' ? 4_000 : null,
        mediaType,
        playbackStrategy: 'preview',
        isAnimated: false,
        thumbnailPath: getThumbnailRelativePath(relativePath),
        previewPath: getPreviewRelativePath(relativePath, mediaType),
        generatedThumbnail: false,
        generatedPreview: false
      };
    });

    maintenanceRepository.resetLibraryIndex();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.doUnmock('../src/services/derivative-service.js');
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('indexes creators, direct-child works, recursive media, and unrestricted item counts', async () => {
    const creatorPath = path.join(appConfig.galleryRoot, 'Creator A');
    const firstWorkPath = path.join(creatorPath, 'Creator A NO.001 First work');
    const nestedPath = path.join(firstWorkPath, 'nested');
    const secondWorkPath = path.join(creatorPath, 'Creator A NO.002 Video work');
    await Promise.all([
      fs.mkdir(nestedPath, { recursive: true }),
      fs.mkdir(secondWorkPath, { recursive: true })
    ]);

    for (let index = 1; index <= 25; index += 1) {
      await fs.writeFile(path.join(firstWorkPath, `${String(index).padStart(2, '0')}.jpg`), 'image');
    }
    await fs.writeFile(path.join(nestedPath, '26.jpg'), 'nested-image');
    await fs.writeFile(path.join(nestedPath, '27.mp4'), 'nested-video');
    await fs.writeFile(path.join(secondWorkPath, 'only-video.mp4'), 'video');
    await fs.writeFile(path.join(creatorPath, 'costuan-ad.txt'), 'ignored');

    const summary = await scannerService.scanAll('test');

    expect(summary.status).toBe('completed');
    expect(summary.scanned_files).toBe(28);
    expect(galleryService.listFolders()).toEqual([
      expect.objectContaining({ name: 'Creator A', imageCount: 2, postCount: 2, contentRating: 'R15' })
    ]);

    const works = postRepository.listCosGalleryWorks(1, 10);
    expect(works).toHaveLength(2);
    expect(works.map((work) => work.itemCount).sort((left, right) => left - right)).toEqual([1, 27]);
    expect(works.every((work) => work.mediaItems.length === 0)).toBe(true);

    const largeWork = works.find((work) => work.itemCount === 27)!;
    const detail = galleryService.getImageDetail(largeWork.id);
    expect(detail?.itemCount).toBe(27);
    expect(detail?.mediaItems).toHaveLength(27);
    expect(detail?.mediaItems.some((item) => item.relativePath?.endsWith('nested/27.mp4'))).toBe(true);

    const creators = creatorRatingRepository.listCreators();
    expect(creators).toEqual([
      expect.objectContaining({
        name: 'Creator A',
        workCount: 2,
        contentRating: null,
        coverImageId: expect.any(Number)
      })
    ]);
    expect(detail?.mediaItems.some((item) => item.imageId === creators[0].coverImageId)).toBe(true);
  });

  it('allows only creator rating changes in public demo mode', async () => {
    const workPath = path.join(appConfig.galleryRoot, 'Creator B', 'Creator B NO.001');
    await fs.mkdir(workPath, { recursive: true });
    await fs.writeFile(path.join(workPath, '01.jpg'), 'image');
    await scannerService.scanAll('test');

    const creator = creatorRatingRepository.listCreators()[0]!;
    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    const managed = new ManagedCreatorService(databaseManager.connection, appConfig.galleryRoot);
    managed.linkFolder(creator.id, { creatorId: managed.create({name:creator.name}).id });
    const ratingResponse = await requestTestApp(
      app,
      'PATCH',
      `/api/cos-gallery/creators/${creator.id}/content-rating`,
      { 'x-foldergram-intent': '1' },
      { contentRating: 'R18' }
    );
    expect(ratingResponse.status).toBe(200);
    expect(ratingResponse.body.creator).toMatchObject({ id: creator.id, contentRating: 'R18' });
    expect(creatorRatingRepository.listCreators()[0]).toMatchObject({ name: 'Creator B', contentRating: 'R18' });

    const blockedPostRating = await requestTestApp(
      app,
      'PATCH',
      `/api/posts/${postRepository.listCosGalleryWorks(1, 10)[0]!.id}/content-rating`,
      { 'x-foldergram-intent': '1' },
      { contentRating: 'R18' }
    );
    expect(blockedPostRating.status).toBe(403);

    const blockedResponse = await requestTestApp(
      app,
      'POST',
      '/api/admin/rescan',
      { 'x-foldergram-intent': '1' }
    );
    expect(blockedResponse.status).toBe(403);
  });

  it('scans one creator without deleting another creator from the existing index', async () => {
    for (const creator of ['Creator Scoped A', 'Creator Scoped B']) {
      const workPath = path.join(appConfig.galleryRoot, creator, `${creator} NO.001`);
      await fs.mkdir(workPath, { recursive: true });
      await fs.writeFile(path.join(workPath, '01.jpg'), creator);
    }
    await scannerService.scanAll('initial-test');

    const summary = await scannerService.scanCosCreators(['Creator Scoped A'], 'scoped-test');

    expect(summary?.status).toBe('completed');
    expect(summary?.scanned_files).toBe(1);
    expect(galleryService.listFolders().map((folder) => folder.name).sort()).toEqual([
      'Creator Scoped A',
      'Creator Scoped B'
    ]);
  });

  it('reuses a legacy post by exact media membership when its source path changed', async () => {
    const creator = 'Creator Legacy';
    const workRelativePath = `${creator}/${creator} NO.001`;
    const workPath = path.join(appConfig.galleryRoot, creator, `${creator} NO.001`);
    await fs.mkdir(workPath, { recursive: true });
    await fs.writeFile(path.join(workPath, '01.jpg'), 'first');
    await fs.writeFile(path.join(workPath, '02.jpg'), 'second');
    await scannerService.scanAll('initial-test');
    const original = postRepository.listCosGalleryWorks(1, 10)[0]!;

    databaseManager.connection.prepare('UPDATE posts SET source_path = ? WHERE id = ?').run('legacy/source/path', original.id);
    const summary = await scannerService.scanCosCreators([creator], 'legacy-recovery-test');

    expect(summary?.status).toBe('completed');
    const recovered = postRepository.listCosGalleryWorks(1, 10);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: original.id, sourcePath: workRelativePath, itemCount: 2 });
  });

  it('reads canonical ratings through explicit folder links and permits null', async () => {
    for (const creator of ['lunananya', 'Machi馬吉']) {
      const workPath = path.join(appConfig.galleryRoot, creator, `${creator} NO.001`);
      await fs.mkdir(workPath, { recursive: true });
      await fs.writeFile(path.join(workPath, '01.jpg'), 'image');
    }
    await scannerService.scanAll('test');

    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    const managed = new ManagedCreatorService(databaseManager.connection, appConfig.galleryRoot);
    const lunana = managed.create({name:'lunana',rating:'R15'});
    const machi = managed.create({name:'MACHI',rating:'R18'});
    for (const folder of creatorRatingRepository.listCreators()) {
      managed.linkFolder(folder.id,{creatorId:folder.name === 'lunananya' ? lunana.id : machi.id});
    }
    expect(creatorRatingRepository.listCreators().find(creator => creator.canonicalCreatorId === lunana.id)).toMatchObject({contentRating:'R15'});
    expect(creatorRatingRepository.listCreators().find(creator => creator.canonicalCreatorId === machi.id)).toMatchObject({contentRating:'R18'});
    managed.update(lunana.id,{rating:'R18'});
    expect(creatorRatingRepository.listCreators().find(creator => creator.canonicalCreatorId === lunana.id)).toMatchObject({contentRating:'R18'});
    managed.update(lunana.id,{rating:null});
    expect(creatorRatingRepository.listCreators().find(creator => creator.canonicalCreatorId === lunana.id)).toMatchObject({contentRating:null});
    expect(databaseManager.connection.prepare('SELECT count(*) AS count FROM creator_rating_sources').get()).toEqual({count:0});

  });
});
