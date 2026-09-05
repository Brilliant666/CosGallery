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
