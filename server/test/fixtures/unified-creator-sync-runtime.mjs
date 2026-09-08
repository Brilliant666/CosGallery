// Opt-in isolated app runtime: Node --import tsx, cwd server/, <temp-root> <port> [seed].
// All history and media are synthetic. No production fallback or real Recycle Bin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = await fs.realpath(path.resolve(process.argv[2] ?? ''));
const temporary = await fs.realpath(os.tmpdir());
assert(path.dirname(root) === temporary && path.basename(root).startsWith('cosgallery-unified-e2e-'));
const port = Number(process.argv[3]);
assert(Number.isSafeInteger(port) && port > 4400 && port < 4900);
assert(process.env.ROSTER_E2E_7ZIP && path.isAbsolute(process.env.ROSTER_E2E_7ZIP));
await fs.access(process.env.ROSTER_E2E_7ZIP);
const paths = {
  DATA_ROOT: root, DB_DIR: path.join(root, 'db'), GALLERY_ROOT: path.join(root, 'gallery'),
  THUMBNAILS_DIR: path.join(root, 'thumbnails'), PREVIEWS_DIR: path.join(root, 'previews')
};
for (const [key, value] of Object.entries(paths)) {
  process.env[key] = value;
  await fs.mkdir(value, { recursive: true });
}
Object.assign(process.env, {
  NODE_ENV: 'production', SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port),
  LOCAL_INGEST_STARTUP_SCAN: 'false', COS_GALLERY_MODE: 'true', DERIVATIVE_MODE: 'lazy',
  LOCAL_INGEST_ARCHIVE_PASSWORD: 'fixture-password-not-a-real-secret'
});
const load = relative => import(pathToFileURL(path.resolve('src', relative)).href);
const { databaseManager } = await load('db/database.ts');
const db = databaseManager.connection;
const { recycleBinAdapter } = await load('services/recycle-bin-adapter.ts');
recycleBinAdapter.recycle = async target => {
  const absolute = path.resolve(target);
  assert([path.join(root, 'inbox'), path.join(root, 'processing')].some(base => absolute.startsWith(base + path.sep)));
  const recycled = path.join(root, 'simulated-recycle');
  await fs.mkdir(recycled, { recursive: true });
  await fs.rename(absolute, path.join(recycled, `${randomUUID()}-${path.basename(absolute)}`));
  return { targetPath: absolute, recycled: true };
};
if (process.argv[4] === 'seed') {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM archive_catalog_creators').get().n, 0);
  const inboxRoot = path.join(root, 'inbox');
  const processingRoot = path.join(root, 'processing');
  await fs.mkdir(inboxRoot, { recursive: true });
  await fs.mkdir(processingRoot, { recursive: true });
  db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run('archive_catalog.inbox_root', inboxRoot);
  const { ManagedCreatorService } = await load('services/managed-creator-service.ts');
  const managed = new ManagedCreatorService(db, paths.GALLERY_ROOT);
  const first = managed.create({ name: '统一检查样本', preference: 'liked', rating: 'R18' });
  const outsider = managed.create({ name: '范围外样本', preference: 'liked', rating: 'R15' });
  const { ArchiveCatalogService } = await load('services/archive-catalog-service.ts');
  new ArchiveCatalogService(db).importCostuanRecord({ creatorName: outsider.name, costuan: {
    postId: 'fixture-outside', title: '范围外样本 COS写真图片包合集[1套][持续更新]',
    rawDirectoryText: '范围外样本 NO.001 既有 [1P-1MB]',
    works: [{ order: 1, sourceOrder: 'NO.001', label: '既有 [1P-1MB]' }]
  }, baidu: { sourceFolderName: 'fixture-outside', destinationPath: '我的网盘/cos图集', status: 'saved' } });
  const existing = path.join(paths.GALLERY_ROOT, outsider.name, '范围外样本 NO.001 既有 [1P-1MB]');
  await fs.mkdir(existing, { recursive: true });
  const { default: sharp } = await import('sharp');
  await sharp({ create: { width: 12, height: 18, channels: 3, background: '#4169e1' } }).jpeg().toFile(path.join(existing, '01.jpg'));
  const { scannerService } = await load('services/scanner-service.ts');
  await scannerService.scanAll('isolated-unified-fixture-seed');
  let scanned = false;
  for (let tries = 0; tries < 200; tries++) {
    if (!db.prepare("SELECT COUNT(*) n FROM scan_runs WHERE status='running'").get().n && db.prepare('SELECT COUNT(*) n FROM posts WHERE deleted_at IS NULL').get().n) { scanned = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(scanned, 'Synthetic initial scan did not finish');
  const { ArchiveCatalogPipelineService } = await load('services/archive-catalog-pipeline-service.ts');
  await new ArchiveCatalogPipelineService(db).refreshAfterGalleryScan({ galleryRoot: paths.GALLERY_ROOT, defaultInboxRoot: inboxRoot });
  const { ArchiveMetadataTaskService } = await load('services/archive-metadata-task-service.ts');
  new ArchiveMetadataTaskService(db).planSelected({ creatorIds: [outsider.id], requestId: 'synthetic-outside-pending' });
  // Deliberately synthetic historical rows: protect every field, including attempt_count and warnings.
  // They do not assert anything about or borrow any production Job IDs or source packages.
  const insert = db.prepare(`INSERT INTO local_ingest_jobs (creator_id,source_archive_path,source_archive_name,
    source_archive_size,source_archive_mtime,source_archive_sha256,status,phase,validation_status,cleanup_status,
    attempt_count,summary_json,completed_at) VALUES (?,?,?,?,?,?,'ingested','done','passed','recycled',1,?,?)`);
  for (let index = 0; index < 588; index++) {
    const name = `synthetic-history-${index + 1}.7z`;
    insert.run(outsider.id, path.join(root, 'synthetic-history', name), name, 1, 1,
      createHash('sha256').update(name).digest('hex'), JSON.stringify({ synthetic: true, warnings: ['fixture historical warning'] }), '2026-01-01T00:00:00.000Z');
  }
  const { localIngestSettingsService } = await load('services/local-ingest-settings-service.ts');
  localIngestSettingsService.save({ libraryRoot: paths.GALLERY_ROOT, inboxRoot, processingRoot,
    sevenZipPath: process.env.ROSTER_E2E_7ZIP, fileStableSeconds: 1, recycleAfterIngest: true,
    maxExtractionDepth: 2, allowlist: [first.name] });
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  await fs.writeFile(path.join(root, 'fixture-ids.json'), JSON.stringify({ first, outsider, syntheticHistoricalJobs: 588 }));
}
await load('index.ts');
