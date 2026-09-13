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
import { RETAINED_ORIGINALS_DIRECTORY } from '../src/constants/retained-originals.js';

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

  it('excludes retained originals only at the work root from media and catalog counts', async () => {
    const workPath = path.join(appConfig.galleryRoot, 'Creator A', 'NO.001 Work');
    const retainedPath = path.join(workPath, RETAINED_ORIGINALS_DIRECTORY);
    const ordinaryNestedPath = path.join(workPath, 'nested', RETAINED_ORIGINALS_DIRECTORY);
    const siblingPath = path.join(appConfig.galleryRoot, 'Creator A', 'NO.002 Sibling');
    for (const directory of [retainedPath, ordinaryNestedPath, siblingPath]) {
      await fs.mkdir(directory, { recursive: true });
    }
    for (const name of ['source.heic', 'source.tiff', 'masquerading.jpg', 'unknown.bin']) {
      await fs.writeFile(path.join(retainedPath, name), 'retained');
    }
    await fs.writeFile(path.join(workPath, '01.jpg'), 'image');
    await fs.writeFile(path.join(ordinaryNestedPath, '02.jpg'), 'nested');
    await fs.writeFile(path.join(ordinaryNestedPath, 'unknown.bin'), 'unknown');
    await fs.writeFile(path.join(siblingPath, '01.jpg'), 'sibling');

    const summary = await scannerService.scanAll('retained-originals-test');
    expect(summary).toMatchObject({ status: 'completed', scanned_files: 3 });
    const indexed = databaseManager.connection.prepare('SELECT relative_path FROM images ORDER BY relative_path').all();
    expect(indexed).toEqual([
      { relative_path: 'Creator A/NO.001 Work/01.jpg' },
      { relative_path: `Creator A/NO.001 Work/nested/${RETAINED_ORIGINALS_DIRECTORY}/02.jpg` },
      { relative_path: 'Creator A/NO.002 Sibling/01.jpg' }
    ]);

    const { ArchiveCatalogService } = await import('../src/services/archive-catalog-service.js');
    await new ArchiveCatalogService(databaseManager.connection).reconcileLocalRoot(appConfig.galleryRoot);
    const counts = databaseManager.connection.prepare(
      'SELECT folder_name, image_count, other_file_count, total_bytes FROM archive_catalog_local_works ORDER BY folder_name'
    ).all();
    expect(counts).toEqual([
      { folder_name: 'NO.001 Work', image_count: 2, other_file_count: 1, total_bytes: 18 },
      { folder_name: 'NO.002 Sibling', image_count: 1, other_file_count: 0, total_bytes: 7 }
    ]);
  });

  it('aggregates linked physical folders by canonical creator before filtering and paging', async () => {
    const roots = [
      ['lunananya', 'lunananya NO.001'],
      ['lunana', 'lunana NO.002'],
      ['lunananya', 'lunananya NO.003'],
      ['lunana', 'lunana NO.004'],
      ['Other root', 'Other NO.001'],
      ['Unlinked root', 'Unlinked NO.001']
    ] as const;
    for (const [creatorRoot, work] of roots) {
      const workPath = path.join(appConfig.galleryRoot, creatorRoot, work);
      await fs.mkdir(workPath, { recursive: true });
      await fs.writeFile(path.join(workPath, '01.jpg'), `${creatorRoot}-${work}`);
    }
    await scannerService.scanAll('canonical-gallery-test');

    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    const managed = new ManagedCreatorService(databaseManager.connection, appConfig.galleryRoot);
    const lunana = managed.create({ name: 'lunana', rating: 'R18', preference: 'liked' });
    managed.addAlias(lunana.id, { alias: 'Moon Alias' });
    const other = managed.create({ name: 'Other', rating: 'R15' });
    const folders = galleryService.listFolders();
    for (const name of ['lunananya', 'lunana']) {
      managed.linkFolder(folders.find((folder) => folder.name === name)!.id, { creatorId: lunana.id });
    }
    managed.linkFolder(folders.find((folder) => folder.name === 'Other root')!.id, { creatorId: other.id });
    const linkedFolders = folders.filter(folder => ['lunananya', 'lunana'].includes(folder.name))
      .sort((left, right) => left.id - right.id);
    linkedFolders.forEach((folder, index) => {
      databaseManager.connection.prepare('UPDATE folders SET description=? WHERE id=?')
        .run(`Existing biography ${index}`, folder.id);
    });
    const orderedSources = [
      'lunananya/lunananya NO.001',
      'lunana/lunana NO.002',
      'lunananya/lunananya NO.003',
      'lunana/lunana NO.004'
    ];
    orderedSources.forEach((sourcePath, index) => {
      databaseManager.connection.prepare('UPDATE posts SET sort_timestamp=? WHERE source_path=?')
        .run(400 - index * 100, sourcePath);
    });

    const all = await requestTestApp(app, 'GET', '/api/cos-gallery/creators?page=1&limit=50');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 3, page: 1, limit: 50, hasMore: false });
    const canonical = all.body.items.find((item: { key: string }) => item.key === `creator:${lunana.id}`);
    expect(canonical).toMatchObject({
      identityType: 'creator',
      id: lunana.id,
      canonicalCreatorId: lunana.id,
      name: 'lunana',
      workCount: 4,
      description: 'Existing biography 0',
      folderIds: expect.arrayContaining([
        folders.find((folder) => folder.name === 'lunananya')!.id,
        folders.find((folder) => folder.name === 'lunana')!.id
      ]),
      contentRating: 'R18',
      preference: 'liked'
    });
    expect(all.body.items.filter((item: { canonicalCreatorId: number | null }) => item.canonicalCreatorId === lunana.id)).toHaveLength(1);
    expect(canonical.avatarUrl).toBe(canonical.coverUrl);
    const canonicalDetail = (await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${lunana.id}`)).body.creator;
    expect(canonicalDetail).toMatchObject({ imageCount: 4, videoCount: 0 });
    expect(canonicalDetail.latestImageMtimeMs).toBeGreaterThan(0);
    expect(canonical.localFolders.map((folder: { id: number }) => folder.id)).toEqual(linkedFolders.map(folder => folder.id));
    for (const folder of linkedFolders) {
      const physical = await requestTestApp(app, 'GET', `/api/folders/${folder.slug}`);
      expect(physical.body.canonicalCreatorId).toBe(lunana.id);
      expect(physical.body.id).toBe(folder.id);
    }
    const unlinkedFolder = folders.find(folder => folder.name === 'Unlinked root')!;
    expect((await requestTestApp(app, 'GET', `/api/folders/${unlinkedFolder.slug}`)).body.canonicalCreatorId).toBeNull();
    expect(all.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: expect.stringMatching(/^folder:/), identityType: 'folder', name: 'Unlinked root' })
    ]));

    for (const query of ['lunana', 'lunananya', 'Moon Alias']) {
      const search = await requestTestApp(app, 'GET', `/api/cos-gallery/creators?q=${encodeURIComponent(query)}`);
      expect(search.body.items).toEqual([expect.objectContaining({ key: `creator:${lunana.id}`, workCount: 4 })]);
    }
    const r18 = await requestTestApp(app, 'GET', '/api/cos-gallery/creators?contentRating=R18');
    expect(r18.body.items).toEqual([expect.objectContaining({ key: `creator:${lunana.id}` })]);
    const pageOne = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${lunana.id}/works?page=1&limit=2`);
    const pageTwo = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${lunana.id}/works?page=2&limit=2`);
    expect(pageOne.body).toMatchObject({ total: 4, page: 1, limit: 2, hasMore: true });
    expect(pageTwo.body).toMatchObject({ total: 4, page: 2, limit: 2, hasMore: false });
    expect([...pageOne.body.items, ...pageTwo.body.items].map((item: { sourcePath: string }) => item.sourcePath))
      .toEqual(orderedSources);

    const coverBeforePreference = canonical.coverImageId;
    const preferredBridge = databaseManager.connection.prepare(
      `SELECT id FROM archive_catalog_local_creator_folders
       WHERE creator_id=? AND gallery_folder_id=? AND is_active=1`
    ).get(lunana.id, folders.find(folder => folder.name === 'lunana')!.id) as { id: number };
    databaseManager.connection.prepare(
      'UPDATE archive_catalog_creators SET preferred_local_creator_folder_id=? WHERE id=?'
    ).run(preferredBridge.id, lunana.id);
    const afterPreference = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${lunana.id}`);
    expect(afterPreference.body.creator).toMatchObject({
      workCount: 4, coverImageId: coverBeforePreference, description: 'Existing biography 0', imageCount: 4
    });

    const single = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${other.id}/works?limit=2`);
    expect(single.body).toMatchObject({ total: 1, hasMore: false, creator: { imageCount: 1, videoCount: 0 } });
    expect(Object.keys(single.body.creator).sort()).toEqual(Object.keys(canonicalDetail).sort());

    const otherPost = postRepository.listVisibleByFolder(
      folders.find((folder) => folder.name === 'Other root')!.id,
      1,
      1
    )[0]!;
    const rejected = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${lunana.id}/works/${otherPost.id}`);
    expect(rejected.status).toBe(404);
    const acceptedPost = pageOne.body.items[0].id;
    expect((await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${lunana.id}/works/${acceptedPost}`)).status).toBe(200);

    const ownerFolder = databaseManager.connection.prepare('SELECT folder_id FROM posts WHERE id=?')
      .get(acceptedPost) as { folder_id: number };
    databaseManager.connection.prepare("UPDATE folders SET role='story_root' WHERE id=?").run(ownerFolder.folder_id);
    expect((await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${lunana.id}/works/${acceptedPost}`)).status).toBe(404);
    databaseManager.connection.prepare("UPDATE folders SET role='normal' WHERE id=?").run(ownerFolder.folder_id);

    // A synthetic damaged legacy index must fail closed consistently. Normal
    // production schema disallows this duplicate active bridge altogether.
    databaseManager.connection.exec('DROP INDEX idx_catalog_folder_gallery_active');
    databaseManager.connection.prepare('UPDATE archive_catalog_local_creator_folders SET gallery_folder_id=? WHERE creator_id=?')
      .run(ownerFolder.folder_id, other.id);
    const damagedFolder = folders.find(folder => folder.id === ownerFolder.folder_id)!;
    expect((await requestTestApp(app, 'GET', `/api/folders/${damagedFolder.slug}`)).body.canonicalCreatorId).toBeNull();
    const scoped = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${lunana.id}/works?limit=10`);
    expect(scoped.body).toMatchObject({ total: 2, creator: { workCount: 2, imageCount: 2 } });
    expect(scoped.body.items).toHaveLength(2);
    for (const creatorId of [lunana.id, other.id]) {
      expect((await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${creatorId}/works/${acceptedPost}`)).status).toBe(404);
    }
  });

  it('keeps canonical IDs and unlinked Folder IDs in separate namespaces while excluding hidden works', async () => {
    const roots = ['Same A', 'Same B', 'Unlinked A', 'Unlinked B', 'Hidden only'];
    for (const root of roots) {
      const workPath = path.join(appConfig.galleryRoot, root, `${root} work`);
      await fs.mkdir(workPath, { recursive: true });
      await fs.writeFile(path.join(workPath, '01.jpg'), root);
    }
    await scannerService.scanAll('identity-namespace-test');

    const now = new Date().toISOString();
    const insertCreator = databaseManager.connection.prepare(
      `INSERT INTO archive_catalog_creators (
         canonical_name, normalized_name, effective_rating, is_active,
         seed_source, seed_source_creator_id, created_at, updated_at
       ) VALUES ('Same display name', ?, 'R15', 1, 'test', ?, ?, ?)`
    );
    const firstCreatorId = Number(insertCreator.run('same-display-a', 'same-a', now, now).lastInsertRowid);
    const secondCreatorId = Number(insertCreator.run('same-display-b', 'same-b', now, now).lastInsertRowid);
    const folders = galleryService.listFolders();
    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    const managed = new ManagedCreatorService(databaseManager.connection, appConfig.galleryRoot);
    managed.linkFolder(folders.find(folder => folder.name === 'Same A')!.id, { creatorId: firstCreatorId });
    managed.linkFolder(folders.find(folder => folder.name === 'Same B')!.id, { creatorId: secondCreatorId });

    const unlinked = folders.filter(folder => folder.name.startsWith('Unlinked'));
    for (const folder of unlinked) {
      databaseManager.connection.prepare("UPDATE folders SET name='Same unlinked name' WHERE id=?").run(folder.id);
    }
    const hiddenFolder = folders.find(folder => folder.name === 'Hidden only')!;
    databaseManager.connection.prepare('UPDATE posts SET is_trashed=1 WHERE folder_id=?').run(hiddenFolder.id);

    const visible = await requestTestApp(app, 'GET', '/api/cos-gallery/creators?limit=50');
    expect(visible.status).toBe(200);
    const sameCreators = visible.body.items.filter((item: { name: string }) => item.name === 'Same display name');
    expect(sameCreators.map((item: { key: string }) => item.key).sort()).toEqual([
      `creator:${firstCreatorId}`,
      `creator:${secondCreatorId}`
    ].sort());
    const sameUnlinked = visible.body.items.filter((item: { name: string }) => item.name === 'Same unlinked name');
    expect(sameUnlinked).toHaveLength(2);
    expect(new Set(sameUnlinked.map((item: { key: string }) => item.key)).size).toBe(2);
    expect(sameUnlinked.every((item: { key: string }) => item.key.startsWith('folder:'))).toBe(true);
    expect(visible.body.items.some((item: { folderIds: number[] }) => item.folderIds.includes(hiddenFolder.id))).toBe(false);

    databaseManager.connection.prepare('UPDATE archive_catalog_creators SET is_active=0, deactivated_at=? WHERE id=?')
      .run(now, secondCreatorId);
    const defaultList = await requestTestApp(app, 'GET', '/api/cos-gallery/creators?limit=50');
    expect(defaultList.body.items.some((item: { key: string }) => item.key === `creator:${secondCreatorId}`)).toBe(false);
    const inactive = await requestTestApp(app, 'GET', '/api/cos-gallery/creators?contentRating=inactive');
    expect(inactive.body.items).toEqual([expect.objectContaining({ key: `creator:${secondCreatorId}`, rosterStatus: 'inactive' })]);
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

  it('indexes one work without traversing or deleting siblings and without completing global maintenance', async () => {
    const creator = 'Creator Work Scoped';
    const creatorPath = path.join(appConfig.galleryRoot, creator);
    const siblingName = `${creator} NO.001`;
    const workFolderName = `${creator} NO.002`;
    const siblingPath = path.join(creatorPath, siblingName);
    const targetPath = path.join(creatorPath, workFolderName);
    await fs.mkdir(siblingPath, { recursive: true });
    await fs.writeFile(path.join(siblingPath, '01.jpg'), 'sibling');
    await scannerService.scanAll('initial-work-scope');
    const siblingPost = databaseManager.connection.prepare('SELECT * FROM posts WHERE source_path = ?')
      .get(`${creator}/${siblingName}`);
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, '02.jpg'), 'target');
    const { appSettingsRepository } = await import('../src/db/repositories.js');
    const { derivativeMigrationService } = await import('../src/services/derivative-migration-service.js');
    const settingKeys = await import('../src/constants/app-setting-keys.js');
    databaseManager.connection.prepare('DELETE FROM app_settings WHERE key = ?')
      .run(settingKeys.LAST_SUCCESSFUL_GALLERY_ROOT_SETTING_KEY);
    appSettingsRepository.set(settingKeys.AVIF_METADATA_REPAIR_VERSION_SETTING_KEY, 'pending');
    const settingsBefore = databaseManager.connection.prepare('SELECT * FROM app_settings ORDER BY key').all();
    const readdir = vi.spyOn(fs, 'readdir');
    const deleteMissing = vi.spyOn(postRepository, 'softDeleteMissingByFolder');
    const syncPlaces = vi.spyOn(postRepository, 'syncRepresentativePlaces');
    const cleanup = vi.spyOn(derivativeMigrationService, 'cleanupStaleDerivatives');
    const migrationComplete = vi.spyOn(derivativeMigrationService, 'isMigrationComplete');
    const migrate = vi.spyOn(derivativeMigrationService, 'ensureMigrated');
    try {
      const first = await scannerService.scanCosCreators([creator], 'one-work', { workFolderName });
      expect(first).toMatchObject({ status: 'completed', scanned_files: 1, new_files: 1, removed_files: 0 });
      expect(migrationComplete).toHaveBeenCalledTimes(1);
      const firstPosts = databaseManager.connection.prepare('SELECT id, source_path, is_deleted FROM posts ORDER BY id').all();
      const second = await scannerService.scanCosCreators([creator], 'one-work-repeat', { workFolderName });
      expect(second).toMatchObject({ status: 'completed', scanned_files: 1, new_files: 0, removed_files: 0 });
      expect(migrationComplete).toHaveBeenCalledTimes(2);
      expect(migrate).not.toHaveBeenCalled();
      expect(databaseManager.connection.prepare('SELECT id, source_path, is_deleted FROM posts ORDER BY id').all()).toEqual(firstPosts);
      expect(databaseManager.connection.prepare('SELECT * FROM posts WHERE source_path = ?').get(`${creator}/${siblingName}`)).toEqual(siblingPost);
      expect(readdir.mock.calls.some(([directory]) => String(directory) === siblingPath || String(directory) === creatorPath)).toBe(false);
      expect(deleteMissing).not.toHaveBeenCalled();
      expect(syncPlaces).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(databaseManager.connection.prepare('SELECT * FROM app_settings ORDER BY key').all()).toEqual(settingsBefore);
    } finally {
      readdir.mockRestore();
      deleteMissing.mockRestore();
      syncPlaces.mockRestore();
      cleanup.mockRestore();
      migrationComplete.mockRestore();
      migrate.mockRestore();
    }
  });

  it('rejects unsafe, missing and symbolic-link work scan scopes before indexing', async () => {
    const creator = 'Creator Scope Validation';
    const creatorPath = path.join(appConfig.galleryRoot, creator);
    const workFolderName = 'Valid Work';
    await fs.mkdir(path.join(creatorPath, workFolderName), { recursive: true });
    for (const invalid of ['', '.', '..', 'trailing.', '../escape', 'nested/work', 'nested\\work', 'C:escape', '.hidden']) {
      await expect(scannerService.scanCosCreators([creator], 'invalid-work', { workFolderName: invalid })).rejects.toThrow();
    }
    await expect(scannerService.scanCosCreators([creator, 'Other'], 'invalid-creators', { workFolderName })).rejects.toThrow('exactly one');
    await expect(scannerService.scanCosCreators([creator], 'missing-work', { workFolderName: 'missing' })).rejects.toThrow();
    const outsidePath = path.join(tempRoot, 'outside-scope');
    await fs.mkdir(outsidePath);
    await fs.symlink(outsidePath, path.join(creatorPath, 'Linked Work'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(scannerService.scanCosCreators([creator], 'linked-work', { workFolderName: 'Linked Work' })).rejects.toThrow('regular direct-child');
    await fs.symlink(creatorPath, path.join(appConfig.galleryRoot, 'Linked Creator'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(scannerService.scanCosCreators(['Linked Creator'], 'linked-creator', { workFolderName })).rejects.toThrow('regular direct-child');
    expect(databaseManager.connection.prepare('SELECT COUNT(*) AS count FROM posts').get()).toMatchObject({ count: 0 });
  });

  it('rejects a work-scoped scan when the recorded gallery root changed', async () => {
    const creator = 'Creator Changed Root';
    const workFolderName = 'New Work';
    await fs.mkdir(path.join(appConfig.galleryRoot, creator, workFolderName), { recursive: true });
    await fs.writeFile(path.join(appConfig.galleryRoot, creator, workFolderName, '01.jpg'), 'new root image');
    const { appSettingsRepository } = await import('../src/db/repositories.js');
    const { LAST_SUCCESSFUL_GALLERY_ROOT_SETTING_KEY } = await import('../src/constants/app-setting-keys.js');
    appSettingsRepository.set(LAST_SUCCESSFUL_GALLERY_ROOT_SETTING_KEY, path.join(tempRoot, 'previous-gallery'));

    await expect(scannerService.scanCosCreators([creator], 'changed-root', { workFolderName }))
      .rejects.toThrow('require a full scan after the gallery root changes');
    expect(databaseManager.connection.prepare('SELECT COUNT(*) AS count FROM posts').get()).toMatchObject({ count: 0 });
    expect(appSettingsRepository.get(LAST_SUCCESSFUL_GALLERY_ROOT_SETTING_KEY)).toBe(path.join(tempRoot, 'previous-gallery'));
    expect(readMediaMetadataMock).not.toHaveBeenCalled();
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

  it('reconciles one legacy merged work into current independent works in one creator scan', async () => {
    const creator = 'Creator Split';
    const mergedPath = path.join(appConfig.galleryRoot, creator, 'Creator Split NO.001-002');
    const nestedFirst = path.join(mergedPath, 'Creator Split NO.001');
    const nestedSecond = path.join(mergedPath, 'Creator Split NO.002');
    await Promise.all([
      fs.mkdir(nestedFirst, { recursive: true }),
      fs.mkdir(nestedSecond, { recursive: true })
    ]);
    await fs.writeFile(path.join(nestedFirst, 'a-1.jpg'), 'one');
    await fs.writeFile(path.join(nestedFirst, 'a-2.jpg'), 'two-two');
    await fs.writeFile(path.join(nestedSecond, 'b-1.jpg'), 'three-three-three');

    expect((await scannerService.scanAll('merged-layout'))?.status).toBe('completed');
    const legacy = postRepository.listCosGalleryWorks(1, 10)[0]!;
    const originalImageIds = (databaseManager.connection.prepare(
      'SELECT image_id FROM post_items WHERE post_id = ? ORDER BY position'
    ).all(legacy.id) as Array<{ image_id: number }>).map((row) => row.image_id);
    expect(originalImageIds).toHaveLength(3);

    const firstWorkPath = path.join(appConfig.galleryRoot, creator, 'Creator Split NO.001');
    const secondWorkPath = path.join(appConfig.galleryRoot, creator, 'Creator Split NO.002');
    await fs.rename(nestedFirst, firstWorkPath);
    await fs.rename(nestedSecond, secondWorkPath);
    await fs.rmdir(mergedPath);

    const summary = await scannerService.scanCosCreators([creator], 'split-layout');
    expect(summary?.status).toBe('completed');
    const works = postRepository.listCosGalleryWorks(1, 10);
    expect(works).toHaveLength(2);
    expect(works.map((work) => ({ sourcePath: work.sourcePath, itemCount: work.itemCount })).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)))
      .toEqual([
        { sourcePath: `${creator}/Creator Split NO.001`, itemCount: 2 },
        { sourcePath: `${creator}/Creator Split NO.002`, itemCount: 1 }
      ]);
    expect(databaseManager.connection.prepare('SELECT is_deleted, deleted_at FROM posts WHERE id = ?').get(legacy.id))
      .toMatchObject({ is_deleted: 1 });
    expect(databaseManager.connection.prepare('SELECT COUNT(*) AS count FROM post_items WHERE post_id = ?').get(legacy.id))
      .toEqual({ count: 0 });
    expect((databaseManager.connection.prepare(
      'SELECT image_id, COUNT(*) AS owners FROM post_items GROUP BY image_id ORDER BY image_id'
    ).all() as Array<{ image_id: number; owners: number }>).map((row) => row.image_id).sort((a, b) => a - b))
      .toEqual([...originalImageIds].sort((a, b) => a - b));

    const stableTopology = JSON.stringify({
      posts: databaseManager.connection.prepare('SELECT * FROM posts ORDER BY id').all(),
      items: databaseManager.connection.prepare('SELECT * FROM post_items ORDER BY post_id, position').all()
    });
    expect((await scannerService.scanCosCreators([creator], 'split-layout-idempotent'))?.status).toBe('completed');
    expect(JSON.stringify({
      posts: databaseManager.connection.prepare('SELECT * FROM posts ORDER BY id').all(),
      items: databaseManager.connection.prepare('SELECT * FROM post_items ORDER BY post_id, position').all()
    })).toBe(stableTopology);
  });

  it('settles a committed Stage 3 reconciliation through the creator-scoped split repair without re-extracting or recommitting', async () => {
    const creator = 'Creator Stage3 Split';
    const firstName = `${creator} NO.001 First [2P-6B]`;
    const secondName = `${creator} NO.002 Second [1P-5B]`;
    const mergedPath = path.join(appConfig.galleryRoot, creator, `${creator} NO.001-002`);
    const nestedFirst = path.join(mergedPath, firstName);
    const nestedSecond = path.join(mergedPath, secondName);
    await Promise.all([fs.mkdir(nestedFirst, { recursive: true }), fs.mkdir(nestedSecond, { recursive: true })]);
    await fs.writeFile(path.join(nestedFirst, 'a-1.jpg'), 'one');
    await fs.writeFile(path.join(nestedFirst, 'a-2.jpg'), 'two');
    await fs.writeFile(path.join(nestedSecond, 'b-1.jpg'), 'three');
    expect((await scannerService.scanAll('stage3-legacy-layout'))?.status).toBe('completed');
    const legacyPost = postRepository.listCosGalleryWorks(1, 10)[0]!;

    const firstTarget = path.join(appConfig.galleryRoot, creator, firstName);
    const secondTarget = path.join(appConfig.galleryRoot, creator, secondName);
    await fs.rename(nestedFirst, firstTarget);
    await fs.rename(nestedSecond, secondTarget);
    await fs.rmdir(mergedPath);
    const mediaBefore = await Promise.all([
      path.join(firstTarget, 'a-1.jpg'),
      path.join(firstTarget, 'a-2.jpg'),
      path.join(secondTarget, 'b-1.jpg')
    ].map(async (filePath) => ({
      filePath,
      content: await fs.readFile(filePath, 'utf8'),
      stats: await fs.stat(filePath)
    })));

    const now = '2026-09-05T00:00:00.000Z';
    databaseManager.connection.prepare(
      `INSERT INTO archive_catalog_creators (
         id, canonical_name, normalized_name, preference, effective_rating,
         seed_source, seed_source_creator_id, created_at, updated_at
       ) VALUES (1, ?, ?, 'liked', 'R15', 'test', 'creator-stage3', ?, ?)`
    ).run(creator, creator.toLocaleLowerCase().replace(/\s+/g, ''), now, now);
    databaseManager.connection.prepare(
      `INSERT INTO archive_catalog_collections (
         id, creator_id, source, source_collection_id, title, observed_at,
         is_active, created_at, updated_at
       ) VALUES (1, 1, 'costuan', 'collection-stage3', 'Stage 3 fixture', ?, 1, ?, ?)`
    ).run(now, now, now);
    const insertWork = databaseManager.connection.prepare(
      `INSERT INTO archive_catalog_works (id, creator_id, display_title, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`
    );
    insertWork.run(1, firstName.replace(/ \[.*$/u, ''), now, now);
    insertWork.run(2, secondName.replace(/ \[.*$/u, ''), now, now);
    const insertSource = databaseManager.connection.prepare(
      `INSERT INTO archive_catalog_source_works (
         id, work_id, collection_id, source, source_work_id, source_order,
         source_order_label, source_title, raw_title, media_summary, is_active,
         first_seen_at, last_seen_at
       ) VALUES (?, ?, 1, 'costuan', ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    insertSource.run(1, 1, 'stage3-work-001', 1, 'NO.001', firstName.replace(/ \[.*$/u, ''), firstName, '2P-6B', now, now);
    insertSource.run(2, 2, 'stage3-work-002', 2, 'NO.002', secondName.replace(/ \[.*$/u, ''), secondName, '1P-5B', now, now);
    const insertDownload = databaseManager.connection.prepare(
      `INSERT INTO archive_catalog_download_tasks (
         id, source_work_id, provider, target_root, target_relative_directory,
         target_filename, status, created_at, updated_at
       ) VALUES (?, ?, 'baidu', 'inbox', ?, ?, 'ingested', ?, ?)`
    );
    insertDownload.run(1, 1, creator, '001.7z', now, now);
    insertDownload.run(2, 2, creator, '002.7z', now, now);
    const insertJob = databaseManager.connection.prepare(
      `INSERT INTO local_ingest_jobs (
         id, archive_download_task_id, source_work_id, creator_id,
         source_archive_path, source_archive_name, source_archive_size,
         source_archive_mtime, source_archive_sha256, status, phase,
         validation_status, cleanup_status, target_path, attempt_count,
         error_code, error_detail, summary_json, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?, 1, 1, ?, ?, ?, 'passed', 'not_ready', ?, ?, ?, ?, ?, ?, ?)`
    );
    insertJob.run(
      1,
      1,
      1,
      path.join(tempRoot, 'inbox', creator, '001.7z'),
      '001.7z',
      '1'.padStart(64, '0'),
      'reconciling',
      'reconciling',
      firstTarget,
      1,
      'GALLERY_INDEX_INCOMPLETE',
      'legacy merged Post still owns current media',
      JSON.stringify({ imageCount: 2, videoCount: 0, warnings: [], plannedTargetPath: firstTarget }),
      now,
      now
    );
    insertJob.run(
      2,
      2,
      2,
      path.join(tempRoot, 'inbox', creator, '002.7z'),
      '002.7z',
      '2'.padStart(64, '0'),
      'awaiting_review',
      'validating',
      secondTarget,
      0,
      'SYNTHETIC_REVIEW',
      'must remain untouched',
      JSON.stringify({ imageCount: 1, videoCount: 0, warnings: [], plannedTargetPath: secondTarget }),
      now,
      now
    );
    const reviewBefore = databaseManager.connection.prepare('SELECT * FROM local_ingest_jobs WHERE id = 2').get();

    const inboxRoot = path.join(tempRoot, 'inbox');
    const processingRoot = path.join(tempRoot, 'processing');
    await Promise.all([fs.mkdir(inboxRoot, { recursive: true }), fs.mkdir(processingRoot, { recursive: true })]);
    const settings = {
      get: () => ({
        libraryRoot: appConfig.galleryRoot,
        inboxRoot,
        processingRoot,
        quarantineRoot: path.join(tempRoot, 'quarantine'),
        sevenZipPath: 'unused-for-committed-reconciliation',
        fileStableSeconds: 1,
        recycleAfterIngest: false,
        maxExtractionDepth: 2 as const,
        allowlist: [creator],
        archivePasswordConfigured: true
      }),
      getArchivePassword: () => 'unused-for-committed-reconciliation'
    };
    const recycle = {
      recycle: async () => { throw new Error('committed reconciliation must not recycle'); },
      smokeTest: async () => ({ targetPath: '', recycled: true })
    };
    const { LocalIngestService } = await import('../src/services/local-ingest-service.js');
    const service = new LocalIngestService(
      databaseManager.connection,
      settings as never,
      recycle as never,
      undefined,
      { expectedGalleryRoot: appConfig.galleryRoot }
    );

    const batch = await service.runBatch({ jobIds: [1, 2] });

    expect(batch).toMatchObject({ total: 1, examined: 1, settled: 1, ingested: 1, reconciling: 0 });
    expect(service.getJob(1)).toMatchObject({ status: 'ingested', attemptCount: 1, errorCode: null });
    expect(databaseManager.connection.prepare('SELECT * FROM local_ingest_jobs WHERE id = 2').get()).toEqual(reviewBefore);
    expect(databaseManager.connection.prepare('SELECT is_deleted FROM posts WHERE id = ?').get(legacyPost.id)).toEqual({ is_deleted: 1 });
    expect(databaseManager.connection.prepare('SELECT COUNT(*) AS count FROM post_items WHERE post_id = ?').get(legacyPost.id)).toEqual({ count: 0 });
    expect(postRepository.listCosGalleryWorks(1, 10).map((work) => work.itemCount).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(await fs.readdir(processingRoot)).toEqual([]);
    for (const before of mediaBefore) {
      const after = await fs.stat(before.filePath);
      expect(await fs.readFile(before.filePath, 'utf8')).toBe(before.content);
      expect(after.size).toBe(before.stats.size);
      expect(after.mtimeMs).toBe(before.stats.mtimeMs);
    }
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
