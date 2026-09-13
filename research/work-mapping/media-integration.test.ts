/** Isolated integration proof: current media pipeline, not the proposed mapping schema.
 * Run with Node 24: node --import ./server/node_modules/tsx/dist/loader.mjs --test research/work-mapping/media-integration.test.ts
 * No server/index import, startup scan, watcher, production DB, or network sources.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

test('source-free synthetic media is browsable through existing library API and rescans retain IDs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-mapping-media-'));
  const isolated = {
    NODE_ENV: 'test', COS_GALLERY_MODE: '1', PUBLIC_DEMO_MODE: '1', DERIVATIVE_MODE: 'eager',
    DATA_ROOT: path.join(root, 'data'), GALLERY_ROOT: path.join(root, 'gallery'),
    DB_DIR: path.join(root, 'db'), THUMBNAILS_DIR: path.join(root, 'thumbnails'),
    PREVIEWS_DIR: path.join(root, 'previews')
  };
  Object.assign(process.env, isolated);
  // NODE_ENV=test prevents .env loading; all final storage paths are checked before imports can scan.
  const { appConfig } = await import('../../server/src/config/env.js');
  for (const candidate of [appConfig.dataRoot, appConfig.galleryRoot, appConfig.dbDir,
    appConfig.thumbnailsDir, appConfig.previewsDir]) {
    assert.ok(candidate && path.resolve(candidate).startsWith(`${path.resolve(root)}${path.sep}`), candidate);
    await fs.mkdir(candidate, { recursive: true });
  }
  console.log('ISOLATED_STORAGE', JSON.stringify(isolated));
  const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp');
  sharp.cache(false);
  const creatorName = 'Synthetic Legacy Creator';
  const workName = 'Old Platform NO.032 Blue Costume';
  const workPath = path.join(appConfig.galleryRoot, creatorName, workName);
  await fs.mkdir(path.join(workPath, 'nested'), { recursive: true });
  await sharp({ create: { width: 36, height: 54, channels: 3, background: '#287ac4' } })
    .jpeg().toFile(path.join(workPath, '01.jpg'));
  await sharp({ create: { width: 42, height: 63, channels: 3, background: '#dc8c28' } })
    .png().toFile(path.join(workPath, 'nested', '02.png'));
  const { databaseManager } = await import('../../server/src/db/database.js');
  try {
    const { scannerService } = await import('../../server/src/services/scanner-service.js');
    const { galleryService } = await import('../../server/src/services/gallery-service.js');
    const { ManagedCreatorService } = await import('../../server/src/services/managed-creator-service.js');
    const { ArchiveCatalogService } = await import('../../server/src/services/archive-catalog-service.js');
    const { requestTestApp } = await import('../../server/test/http-test-utils.js');
    const { createApp } = await import('../../server/src/app.js');
    const db = databaseManager.connection;
    const managed = new ManagedCreatorService(db, appConfig.galleryRoot);
    const creator = managed.create({ name: creatorName, rating: 'R15', preference: 'liked' });
    const scan = await scannerService.scanCosCreators([creatorName], 'isolated-legacy-research', { workFolderName: workName });
    assert.equal(scan?.status, 'completed');
    const folder = galleryService.listFolders().find(item => item.name === creatorName);
    assert.ok(folder);
    managed.linkFolder(folder.id, { creatorId: creator.id });
    const catalogScope = { rootPath: appConfig.galleryRoot, creators: [{ creatorId: creator.id, folderName: creatorName }], workFolderName: workName };
    await new ArchiveCatalogService(db).reconcileLocalCreators(catalogScope);
    const local = db.prepare('SELECT id, work_id, match_status FROM archive_catalog_local_works').all();
    assert.equal(local.length, 1);
    // Baseline gap intentionally explicit: source-free discovery does not create a canonical Work.
    assert.equal(local[0].work_id, null);
    const snapshot = () => ({
      images: db.prepare('SELECT id, relative_path, asset_key FROM images ORDER BY id').all(),
      posts: db.prepare('SELECT id, source_path FROM posts ORDER BY id').all(),
      items: db.prepare('SELECT * FROM post_items ORDER BY post_id, position').all(),
      local: db.prepare('SELECT id, work_id FROM archive_catalog_local_works ORDER BY id').all()
    });
    const before = snapshot();
    assert.equal(before.images.length, 2);
    assert.equal(before.posts.length, 1);
    const postId = Number(before.posts[0].id);
    const detail = galleryService.getCanonicalCreatorWork(creator.id, postId);
    assert.equal(detail?.itemCount, 2);
    assert.equal(detail?.mediaItems.length, 2);
    const app = createApp();
    const list = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${creator.id}/works?page=1&limit=10`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].id, postId);
    const response = await requestTestApp(app, 'GET', `/api/cos-gallery/creators/${creator.id}/works/${postId}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.itemCount, 2);
    // Exercise real metadata/derivative pipeline, not dummy files or derivative mocks.
    const assets = db.prepare('SELECT absolute_path, width, height, thumbnail_path, preview_path FROM images').all();
    for (const asset of assets) {
      assert.ok(Number(asset.width) > 0 && Number(asset.height) > 0);
      for (const file of [String(asset.absolute_path), path.join(appConfig.thumbnailsDir, String(asset.thumbnail_path)),
        path.join(appConfig.previewsDir, String(asset.preview_path))]) {
        const metadata = await sharp(file).metadata();
        assert.ok(metadata.width && metadata.height);
      }
    }
    const second = await scannerService.scanCosCreators([creatorName], 'isolated-legacy-replay', { workFolderName: workName });
    assert.equal(second?.status, 'completed');
    await new ArchiveCatalogService(db).reconcileLocalCreators(catalogScope);
    assert.deepEqual(snapshot(), before);
    for (const table of ['archive_catalog_source_works', 'archive_catalog_download_tasks', 'local_ingest_jobs']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n, 0, table);
    }
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    console.log('MEDIA_INTEGRATION_PASS', JSON.stringify({ root, images: 2, posts: 1, sourceWorks: 0, jobs: 0,
      apiStatus: response.status, stableIds: true, canonicalWorkCreation: 'not provided by existing scanner' }));
  } finally {
    databaseManager.close();
    // Keep isolated synthetic evidence. No cleanup of any user directory is performed.
  }
});
