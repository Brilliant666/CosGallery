// Isolated manual E2E launcher. Run with Node --import tsx from server/.
// Never accepts production paths. The caller owns the temporary fixture root.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isolatedTestEnvironment } from '../../../scripts/test-environment.mjs';

const root = await fs.realpath(path.resolve(process.argv[2] ?? ''));
const temporary = await fs.realpath(os.tmpdir());
assert(path.dirname(root) === temporary && path.basename(root).startsWith('cosgallery-roster-e2e-'));
const port = Number(process.argv[3]);
assert(Number.isSafeInteger(port) && port > 4400 && port < 4900);
const paths = isolatedTestEnvironment(root, { nodeEnv: 'production' });
Object.assign(process.env, paths);
for (const key of ['DATA_ROOT', 'DB_DIR', 'GALLERY_ROOT', 'THUMBNAILS_DIR', 'PREVIEWS_DIR', 'BACKUP_ROOT']) {
  const value = paths[key];
  assert(path.isAbsolute(value) && (value === root || value.startsWith(root + path.sep)));
  await fs.mkdir(value, { recursive: true });
}
Object.assign(process.env, {
  LOCAL_INGEST_SEVEN_ZIP_PATH: process.env.ROSTER_E2E_7ZIP ?? '',
  SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port),
  COS_GALLERY_MODE: 'true', DERIVATIVE_MODE: 'lazy',
  LOCAL_INGEST_ARCHIVE_PASSWORD: 'fixture-password-not-a-real-secret'
});
const load = relative => import(pathToFileURL(path.resolve('src', relative)).href);
const { databaseManager } = await load('db/database.ts');
const db = databaseManager.connection;
const { recycleBinAdapter } = await load('services/recycle-bin-adapter.ts');
// The real Windows Recycle Bin must never be called by this fixture.
recycleBinAdapter.recycle = async target => {
  const absolute = path.resolve(target);
  assert([path.join(root, 'inbox'), path.join(root, 'processing')].some(base => absolute.startsWith(base + path.sep)));
  const recycledRoot = path.join(root, 'simulated-recycle');
  await fs.mkdir(recycledRoot, { recursive: true });
  await fs.rename(absolute, path.join(recycledRoot, `${Date.now()}-${path.basename(absolute)}`));
  return { targetPath: absolute, recycled: true };
};
if (process.argv[4] === 'seed') {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM archive_catalog_creators').get().n, 0);
  db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run('archive_catalog.inbox_root', path.join(root, 'inbox'));
  const { ManagedCreatorService } = await load('services/managed-creator-service.ts');
  const managed = new ManagedCreatorService(db, paths.GALLERY_ROOT);
  const first = managed.create({ name: '首次样本', preference: 'liked', rating: 'R18' });
  const partial = managed.create({ name: '部分样本', preference: 'kept', rating: 'R15' });
  const outsider = managed.create({ name: '范围外样本', preference: 'liked', rating: 'R15' });
  const { ArchiveCatalogService } = await load('services/archive-catalog-service.ts');
  const archiveCatalogService = new ArchiveCatalogService(db);
  archiveCatalogService.importCostuanRecord({ creatorName: partial.name, costuan: {
    postId: 'fixture-partial', title: '部分样本 COS写真图片包合集[2套][持续更新]',
    rawDirectoryText: '部分样本 NO.001 既有 [1P-1MB]\n部分样本 NO.002 新增 [1P-1MB]',
    works: [{ order: 1, sourceOrder: 'NO.001', label: '既有 [1P-1MB]' }, { order: 2, sourceOrder: 'NO.002', label: '新增 [1P-1MB]' }]
  }, baidu: { sourceFolderName: 'fixture-partial', destinationPath: '我的网盘/cos图集', status: 'saved' } });
  const existing = path.join(paths.GALLERY_ROOT, partial.name, '部分样本 NO.001 既有 [1P-1MB]');
  await fs.mkdir(existing, { recursive: true });
  const { default: sharp } = await import('sharp');
  await sharp({ create: { width: 12, height: 18, channels: 3, background: '#4169e1' } }).jpeg().toFile(path.join(existing, '01.jpg'));
  const { scannerService } = await load('services/scanner-service.ts');
  await scannerService.scanAll('isolated-fixture-seed');
  // Seed scan may be queued. Wait until its bounded operation completes.
  for (let tries = 0; tries < 200; tries++) {
    const active = db.prepare("SELECT count(*) n FROM scan_runs WHERE status='running'").get().n;
    if (!active && db.prepare('SELECT count(*) n FROM posts WHERE deleted_at IS NULL').get().n) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const { ArchiveCatalogPipelineService } = await load('services/archive-catalog-pipeline-service.ts');
  await new ArchiveCatalogPipelineService(db).refreshAfterGalleryScan({ galleryRoot: paths.GALLERY_ROOT, defaultInboxRoot: path.join(root, 'inbox') });
  const { localIngestSettingsService } = await load('services/local-ingest-settings-service.ts');
  localIngestSettingsService.save({ libraryRoot: paths.GALLERY_ROOT, inboxRoot: path.join(root, 'inbox'),
    processingRoot: path.join(root, 'processing'), sevenZipPath: localIngestSettingsService.get().sevenZipPath,
    fileStableSeconds: 1, recycleAfterIngest: true, maxExtractionDepth: 2, allowlist: [first.name] });
  await fs.mkdir(path.join(root, 'inbox'), { recursive: true });
  await fs.mkdir(path.join(root, 'processing'), { recursive: true });
  await fs.writeFile(path.join(root, 'fixture-ids.json'), JSON.stringify({ first, partial, outsider }));
}
await load('index.ts');
