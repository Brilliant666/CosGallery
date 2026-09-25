import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { RETAINED_ORIGINALS_DIRECTORY } from '../src/constants/retained-originals.js';
import { LocalIngestService, type LocalIngestRuntimeDependencies } from '../src/services/local-ingest-service.js';
import type { LocalIngestReviewPlan, LocalIngestReviewRequest } from '../src/services/local-ingest-review-plan.js';
import type { LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';
import type { RecycleBinAdapter } from '../src/services/recycle-bin-adapter.js';

const fixtures: Array<{ root: string; database: DatabaseSync }> = [];
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex').toUpperCase();
const checksum = (data: Buffer) => crc32(data).toString(16).padStart(8, '0').toUpperCase();
const accepted = (plan: LocalIngestReviewPlan) => ({ ...plan, confirmed: true });
const jpeg = () => sharp({ create: { width: 8, height: 12, channels: 3, background: '#557799' } }).jpeg().toBuffer();
const webp = () => sharp({ create: { width: 8, height: 12, channels: 3, background: '#557799' } }).webp().toBuffer();
const slt = (members: Record<string, Buffer>) => 'Path = synthetic.7z\nType = 7z\n\n----------\n'
  + Object.entries(members).map(([name, bytes]) => `Path = ${name}\nSize = ${bytes.length}\nCRC = ${checksum(bytes)}\nAttributes = A\n\n`).join('');

function seed(database: DatabaseSync, creatorName: string) {
  database.prepare(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,preference,effective_rating,
    seed_source,seed_source_creator_id) VALUES(1,?,?,'liked','R15','test','review-creator')`).run(creatorName, 'reviewcreator');
  database.exec(`INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at,is_active)
    VALUES(1,1,'costuan','review-source','Review source','2024-01-01T00:00:00Z',1);
    INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Synthetic review work');
    INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order,source_order_label,
      source_title,raw_title,media_summary,is_active,first_seen_at,last_seen_at)
    VALUES(1,1,1,'costuan','review-007',7,'NO.007','Synthetic review work','NO.007 Synthetic review work [2P]','2P',1,
      '2024-01-01T00:00:00Z','2024-01-01T00:00:00Z')`);
  database.prepare(`INSERT INTO archive_catalog_download_tasks(id,source_work_id,provider,target_root,target_relative_directory,
    target_filename,status,updated_at,claimed_by,attempt_count) VALUES(1,1,'baidu','inbox',?,'007.7z','staged',
    '2024-01-01T00:00:00Z','historical-worker',3)`).run(creatorName);
}

async function makeFixture(members: Record<string, Buffer>, options: { scanFailures?: number; historicalWebp?: boolean; normalIngest?: boolean; allowRecycle?: boolean; recycleAfterIngest?: boolean; interruptCommit?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage3-review-recovery-'));
  const libraryRoot = path.join(root, 'library'), inboxRoot = path.join(root, 'inbox'), processingRoot = path.join(root, 'processing');
  const creatorName = 'Review Creator';
  for (const directory of [libraryRoot, inboxRoot, processingRoot, path.join(inboxRoot, creatorName)]) await fs.mkdir(directory, { recursive: true });
  const sourcePath = path.join(inboxRoot, creatorName, '007.7z');
  const outerBytes = Buffer.from('synthetic outer archive'), innerBytes = Buffer.from('synthetic inner archive');
  await fs.writeFile(sourcePath, outerBytes);
  const database = new DatabaseSync(path.join(root, 'isolated.sqlite'));
  fixtures.push({ root, database });
  // Fixture setup is not the recovery under test: publish the schema and seed
  // together instead of paying a durable disk commit for every DDL statement.
  // Keep the real on-disk database and enable FK checks before the transaction.
  database.exec('PRAGMA foreign_keys = ON; BEGIN');
  try {
    database.exec(schemaSql);
    seed(database, creatorName);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  expect(database.isTransaction).toBe(false);
  const settings = {
    get: () => ({ libraryRoot, inboxRoot, processingRoot, sevenZipPath: 'synthetic-7z', fileStableSeconds: 1,
      recycleAfterIngest: options.recycleAfterIngest ?? false, maxExtractionDepth: 2 as const, allowlist: [creatorName], archivePasswordConfigured: true }),
    getArchivePassword: () => 'synthetic-password'
  } as unknown as LocalIngestSettingsService;
  const counts = { list: 0, test: 0, outer: 0, inner: 0, scan: 0, recycle: 0 };
  const sevenZipCalls: string[][] = [];
  let clock = Date.now(), remainingScanFailures = options.scanFailures ?? 0;
  const runCommand: NonNullable<LocalIngestRuntimeDependencies['runCommand']> = async (_command, args) => {
    sevenZipCalls.push([...args]);
    const action = args[0], archive = args.at(-1)!;
    if (action === 'l') {
      counts.list++;
      return { code: 0, stdout: slt(archive === sourcePath ? { '007.7zz': innerBytes } : members), stderr: '' };
    }
    if (action === 't') { counts.test++; return { code: 0, stdout: '', stderr: '' }; }
    if (action !== 'x') throw new Error('Unexpected synthetic 7z command');
    const output = args.find(value => value.startsWith('-o'))!.slice(2);
    await fs.mkdir(output, { recursive: true });
    if (path.basename(output) === 'level-1') {
      counts.outer++;
      await fs.writeFile(path.join(output, '007.7zz'), innerBytes);
    } else {
      counts.inner++;
      for (const [relative, bytes] of Object.entries(members)) {
        const filename = path.join(output, relative);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, bytes);
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const rescan = vi.fn(async (db: DatabaseSync, gallery: string, creatorId: number, folderName: string, workFolderName?: string) => {
    counts.scan++;
    if (remainingScanFailures-- > 0) throw new Error('Synthetic scoped index interruption');
    const row = db.prepare('SELECT target_path,summary_json FROM local_ingest_jobs WHERE id=1').get() as { target_path: string; summary_json: string };
    expect(gallery).toBe(libraryRoot);
    expect(creatorId).toBe(1);
    expect(folderName).toBe(creatorName);
    expect(workFolderName).toBe(path.basename(row.target_path));
    const summary = JSON.parse(row.summary_json);
    const canonicalLibrary = await fs.realpath(libraryRoot);
    const targetRelative = path.relative(canonicalLibrary, await fs.realpath(row.target_path)).replace(/\\/g, '/');
    const mediaPaths: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name === RETAINED_ORIGINALS_DIRECTORY) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (/\.(?:jpe?g|png|webp|gif)$/iu.test(entry.name)) mediaPaths.push(absolute);
      }
    };
    await walk(row.target_path);
    expect(mediaPaths).toHaveLength(summary.imageCount);
    db.prepare(`INSERT OR IGNORE INTO folders(id,slug,name,folder_path,role) VALUES(700,'review-folder','review',?,'carousel_source')`).run(targetRelative);
    db.prepare(`INSERT OR IGNORE INTO posts(id,folder_id,source_path,post_type,sort_timestamp) VALUES(701,700,?,'carousel',1700000000000)`).run(targetRelative);
    for (const [index, filename] of mediaPaths.sort().entries()) {
      const content = await fs.readFile(filename), stat = await fs.stat(filename), metadata = await sharp(filename).metadata();
      const relative = path.relative(canonicalLibrary, await fs.realpath(filename)).replace(/\\/g, '/');
      db.prepare(`INSERT OR IGNORE INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,
        mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
        VALUES(?,700,?,?,?,?,?,?,?,'image/jpeg',?,?,'2024-01-01',1700000000000,?,?)`)
        .run(800 + index, path.basename(filename), path.extname(filename), relative, filename, content.length,
          metadata.width!, metadata.height!, hash(content), stat.mtimeMs, `thumb-${index}.webp`, `preview-${index}.webp`);
      db.prepare('INSERT OR IGNORE INTO post_items(post_id,image_id,position) VALUES(701,?,?)').run(800 + index, index + 1);
    }
    db.prepare(`INSERT OR IGNORE INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,
      match_status,match_method,is_active,scanned_at) VALUES(500,1,?,?,?,?, 'matched','synthetic',1,'2024-01-01')`)
      .run(libraryRoot, creatorName, path.join(libraryRoot, creatorName), creatorName);
    db.prepare(`INSERT OR IGNORE INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,
      parsed_source_order,image_count,video_count,total_bytes,match_status,match_method,is_active,scanned_at)
      VALUES(501,500,1,701,?,?,?,7,?,0,?,'matched','synthetic',1,'2024-01-01')`)
      .run(targetRelative, row.target_path, path.basename(row.target_path), summary.imageCount, summary.totalBytes);
    db.exec('UPDATE archive_catalog_works SET primary_local_work_id=501 WHERE id=1');
    db.exec("UPDATE archive_catalog_download_tasks SET status='ingested' WHERE id=1");
    return { scanRunId: 123, scanStatus: 'completed', scanError: null };
  });
  const recycled: Array<{ original: string; preserved: string }> = [];
  const recycle = { recycle: async (targetPath: string) => {
      counts.recycle++;
      if (!options.allowRecycle) throw new Error('Not authorized in review fixture');
      const canonical = await fs.realpath(targetPath), canonicalRoot = await fs.realpath(root);
      const relative = path.relative(canonicalRoot, canonical);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Synthetic recycle target escaped temp fixture');
      const allowed = [sourcePath, path.join(processingRoot, '1')];
      const allowedExisting = await Promise.all(allowed.map(value => fs.realpath(value).catch(() => null)));
      if (!allowedExisting.includes(canonical)) throw new Error('Unexpected synthetic recycle target');
      const preserved = path.join(root, 'synthetic-recycle', `${counts.recycle}-${path.basename(targetPath)}`);
      await fs.mkdir(path.dirname(preserved), { recursive: true });
      await fs.rename(targetPath, preserved);
      recycled.push({ original: targetPath, preserved });
      return { targetPath, recycled: true };
    },
    smokeTest: async () => ({ targetPath: '', recycled: true }) } as unknown as RecycleBinAdapter;
  const restart = () => new LocalIngestService(database, settings, recycle, rescan, {
    now: () => new Date(clock), expectedGalleryRoot: libraryRoot, runCommand, claimLeaseMs: 1_000
  });
  const service = restart();
  await service.scanInbox(); clock += 1100;
  const discovery = await service.scanInbox();
  expect(discovery.jobs).toHaveLength(1);
  const jobId = discovery.jobs[0].id;
  const processing = path.join(processingRoot, String(jobId)), levelTwo = path.join(processing, 'level-2');
  if (options.historicalWebp) {
    // A pre-WebP validator's persisted checkpoint. No current validator is mocked.
    await fs.mkdir(path.join(processing, 'level-1'), { recursive: true });
    await fs.mkdir(levelTwo);
    await fs.writeFile(path.join(processing, 'level-1', '007.7z'), innerBytes);
    for (const [relative, bytes] of Object.entries(members)) await fs.writeFile(path.join(levelTwo, relative), bytes);
    await fs.writeFile(path.join(processing, '.level-1-complete'), '2024-01-01');
    await fs.writeFile(path.join(processing, '.level-2-complete'), '2024-01-01');
    const current = service.getJob(jobId);
    database.prepare(`UPDATE local_ingest_jobs SET processing_path=?,status='awaiting_review',phase='validating',attempt_count=1,
      validation_status='failed',error_code='UNKNOWN_FILE_TYPE',error_detail='Historical WebP whitelist',summary_json=? WHERE id=?`)
      .run(processing, JSON.stringify({ ...current.summary, levelOneOutput: ['007.7zz'], innerOriginalName: '007.7zz', innerWorkingName: '007.7z' }), jobId);
  } else {
    const rename = fs.rename.bind(fs);
    const interruption = options.interruptCommit ? vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (path.basename(String(source)) === 'ready') throw new Error('Synthetic commit interruption');
      return rename(source, destination);
    }) : null;
    try {
      const failed = await service.runJob(jobId);
      expect(failed.status, failed.errorDetail ?? '').toBe(options.interruptCommit ? 'failed' : options.normalIngest ? 'ingested' : 'awaiting_review');
      if (!options.normalIngest && !options.interruptCommit) expect(failed.phase).toBe('validating');
    } finally { interruption?.mockRestore(); }
  }
  const request = (overrides: Partial<LocalIngestReviewRequest> = {}): LocalIngestReviewRequest => ({ jobId,
    removedFiles: [], retainedFiles: [], note: 'User approved only the exact synthetic recovery scope', ...overrides });
  const row = () => database.prepare('SELECT * FROM local_ingest_jobs WHERE id=?').get(jobId)!;
  return { root, libraryRoot, inboxRoot, processingRoot, sourcePath, database, service, restart, jobId,
    processing, levelTwo, members, counts, sevenZipCalls, recycled, rescan, request, row };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function removableFixture(options: { scanFailures?: number } = {}) {
  const f = await makeFixture({ 'cover.jpg': await jpeg(), 'broken.jpg': Buffer.alloc(0) }, options);
  await fs.rm(path.join(f.levelTwo, 'broken.jpg'));
  const request = f.request({ removedFiles: [{ relativePath: 'broken.jpg', size: 0 }] });
  return { ...f, approvedRequest: request, plan: await f.service.previewReview(request) };
}

describe.sequential('explicit Stage3 review recovery', () => {
  it('excludes exact known JPG ads before decoding and preserves them through ordinary cleanup', async () => {
    const cover = await jpeg(), normalJpeg = await jpeg();
    const members = { 'cover.jpg': cover, '492.jpeg': normalJpeg,
      'nested/492.jpg': Buffer.from('known ad need not decode'), '009-01.JPG': Buffer.from('known ad need not decode either') };
    const f = await makeFixture(members, { normalIngest: true, allowRecycle: true, recycleAfterIngest: true });
    const job = f.service.getJob(f.jobId);
    expect(job).toMatchObject({ status: 'ingested', cleanupStatus: 'recycled' });
    expect(job.summary).toMatchObject({ imageAdvertisementPolicy: 1, imageCount: 2, totalMediaCount: 2,
      totalBytes: cover.length + normalJpeg.length, advertisementFileCount: 2 });
    expect(await fs.readdir(job.targetPath!)).toEqual(['492.jpeg', 'cover.jpg']);
    expect(f.database.prepare('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 2 });
    const preserved = f.recycled.find(item => item.original === f.processing)!.preserved;
    for (const name of ['nested/492.jpg', '009-01.JPG']) {
      expect(await fs.readFile(path.join(preserved, 'level-2', name))).toEqual(members[name as keyof typeof members]);
    }
    const counts = { ...f.counts };
    await f.restart().runJob(f.jobId);
    expect(f.counts).toEqual(counts);
  });

  it('does not admit an archive whose only images are known advertisements', async () => {
    const f = await makeFixture({ '492.jpg': Buffer.from('ad'), '009-01.jpg': Buffer.from('ad') });
    expect(f.service.getJob(f.jobId)).toMatchObject({ status: 'awaiting_review', errorCode: 'NO_VALID_MEDIA' });
    expect(f.counts).toMatchObject({ scan: 0, recycle: 0 });
    expect(await fs.readFile(path.join(f.levelTwo, '492.jpg'), 'utf8')).toBe('ad');
    expect(await fs.readdir(f.libraryRoot)).toEqual([]);
  });

  it('persists the new advertisement policy through copy-path ready replay without deleting originals', async () => {
    const cover = await jpeg(), advertisement = Buffer.from('undecodable known ad'), original = Buffer.from('retained TIFF');
    const f = await makeFixture({ 'cover.jpg': cover, '492.jpg': advertisement, 'original.tiff': original }, { interruptCommit: true });
    expect(f.service.getJob(f.jobId).summary).toMatchObject({ imageAdvertisementPolicy: 1, imageCount: 1, advertisementFileCount: 1 });
    await expect(fs.stat(path.join(f.processing, '.staging-move.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const job = await f.restart().runJob(f.jobId);
    expect(job.status, job.errorDetail ?? '').toBe('ingested');
    expect(job.summary).toMatchObject({ imageCount: 1, totalMediaCount: 1, totalBytes: cover.length, advertisementFileCount: 1 });
    expect(await fs.readFile(path.join(f.levelTwo, '492.jpg'))).toEqual(advertisement);
    expect(await fs.readFile(path.join(job.targetPath!, RETAINED_ORIGINALS_DIRECTORY, 'original.tiff'))).toEqual(original);
    await expect(fs.stat(path.join(job.targetPath!, '492.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves pre-policy ready media and exact review plans instead of silently reclassifying their JPG files', async () => {
    const members = { 'cover.jpg': await jpeg(), '492.jpg': await jpeg() };
    const legacy = await makeFixture(members, { historicalWebp: true });
    const ready = path.join(legacy.processing, 'ready');
    await fs.mkdir(ready);
    for (const [name, bytes] of Object.entries(members)) await fs.writeFile(path.join(ready, name), bytes);
    legacy.database.exec("UPDATE local_ingest_jobs SET status='failed', error_code=NULL WHERE id=1");
    const resumed = await legacy.restart().runJob(legacy.jobId);
    expect(resumed.status, resumed.errorDetail ?? '').toBe('ingested');
    expect(resumed.summary).toMatchObject({ imageCount: 2, advertisementFileCount: 0 });
    expect(resumed.summary!.imageAdvertisementPolicy).toBeUndefined();
    expect(await fs.readFile(path.join(resumed.targetPath!, '492.jpg'))).toEqual(members['492.jpg']);

    const reviewed = await makeFixture({ ...members, 'broken.jpg': Buffer.alloc(0) });
    await fs.rm(path.join(reviewed.levelTwo, 'broken.jpg'));
    const plan = await reviewed.service.previewReview(reviewed.request({ removedFiles: [{ relativePath: 'broken.jpg', size: 0 }] }));
    const immutable = JSON.stringify(plan);
    const result = await reviewed.service.resumeReview(accepted(plan));
    expect(result.status, result.errorDetail ?? '').toBe('ingested');
    expect(result.summary).toMatchObject({ imageCount: 2, advertisementFileCount: 0 });
    expect(await fs.readFile(path.join(result.targetPath!, '492.jpg'))).toEqual(members['492.jpg']);
    expect(JSON.stringify(plan)).toBe(immutable);
    expect(result.summary!.reviewRecovery).toMatchObject({ plan });
  });

  it('previews without DB mutation and resumes exact removed-file approval on the original job', async () => {
    const f = await makeFixture({ 'cover.jpg': await jpeg(), 'broken.jpg': Buffer.alloc(0) });
    const before = f.row();
    // Normal discovery already reconciled staged -> downloaded; review must
    // preserve the history present at this existing awaiting_review checkpoint.
    const history = f.database.prepare('SELECT claimed_by,attempt_count FROM archive_catalog_download_tasks WHERE id=1').get();
    expect(f.service.getJob(f.jobId).errorCode).toBe('UNSAFE_OR_EMPTY_FILE');
    await fs.rm(path.join(f.levelTwo, 'broken.jpg'));
    const plan = await f.service.previewReview(f.request({ removedFiles: [{ relativePath: 'broken.jpg', size: 0 }] }));
    expect(plan).toMatchObject({ version: 1, confirmed: false, creatorId: 1, sourceWorkId: 1, downloadTaskId: 1, workId: 1 });
    // The child output is decoded as UTF-8 on every platform, including Windows
    // machines whose 7-Zip console default is a different code page.
    expect(new Set(f.sevenZipCalls.map(args => args[0]))).toEqual(new Set(['l', 't', 'x']));
    expect(f.sevenZipCalls.every(args => args.filter(arg => arg === '-sccUTF-8').length === 1)).toBe(true);
    expect(f.row()).toEqual(before);
    const result = await f.service.resumeReview(accepted(plan));
    expect(result.status, result.errorDetail ?? '').toBe('ingested');
    expect(f.counts).toMatchObject({ outer: 1, inner: 1, scan: 1, recycle: 0 });
    expect(result.attemptCount).toBe(2);
    expect(await fs.readFile(path.join(result.targetPath!, 'cover.jpg'))).toEqual(f.members['cover.jpg']);
    await expect(fs.stat(path.join(result.targetPath!, 'broken.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.database.prepare('SELECT id,work_id,post_id FROM archive_catalog_local_works').all()).toEqual([{ id: 501, work_id: 1, post_id: 701 }]);
    expect(f.database.prepare('SELECT image_id,position FROM post_items').all()).toEqual([{ image_id: 800, position: 1 }]);
    expect(f.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(f.database.prepare('SELECT claimed_by,attempt_count FROM archive_catalog_download_tasks WHERE id=1').get())
      .toEqual(history);
    expect(f.database.prepare("SELECT value FROM app_settings WHERE key='archive.download-task.staged-at.1'").get())
      .toEqual({ value: '2024-01-01T00:00:00Z' });
    expect(result.summary!.reviewRecovery).toMatchObject({ plan: { confirmed: false, originalFailure: { code: 'UNSAFE_OR_EMPTY_FILE', attemptCount: 1 } } });
    const recorded = f.row(), counts = { ...f.counts };
    expect((await f.restart().resumeReview(accepted(plan))).status).toBe('ingested');
    expect(f.row()).toEqual(recorded);
    expect(f.counts).toEqual(counts);
    expect(f.database.prepare('SELECT COUNT(*) AS n FROM local_ingest_jobs').get()).toEqual({ n: 1 });
  });

  it('retains an approved PDF byte-for-byte outside display media and excludes its bytes from counts', async () => {
    const pdf = Buffer.from('%PDF-1.4\nsynthetic retained document\n%%EOF');
    const cover = await jpeg();
    const f = await makeFixture({ 'nested/cover.jpg': cover, 'nested/book.pdf': pdf });
    expect(f.service.getJob(f.jobId).errorCode).toBe('UNKNOWN_FILE_TYPE');
    const plan = await f.service.previewReview(f.request({ retainedFiles: [{ relativePath: 'nested/book.pdf', reason: 'attachment' }] }));
    const result = await f.service.resumeReview(accepted(plan));
    expect(result.status, result.errorDetail ?? '').toBe('ingested');
    expect(result.summary).toMatchObject({ imageCount: 1, totalMediaCount: 1, totalBytes: cover.length, retainedAttachmentCount: 1, retainedOriginalCount: 0 });
    expect(await fs.readFile(path.join(result.targetPath!, RETAINED_ORIGINALS_DIRECTORY, 'book.pdf'))).toEqual(pdf);
    expect(f.database.prepare('SELECT filename FROM images').all()).toEqual([{ filename: 'cover.jpg' }]);
    expect(f.counts).toMatchObject({ outer: 1, inner: 1, scan: 1, recycle: 0 });
  });

  it('recovers a historical WebP-only unknown-type checkpoint without re-extraction or decoder mocks', async () => {
    const content = await webp();
    const f = await makeFixture({ '0002.webp': content, '0003.webp': content, '0004.webp': content }, { historicalWebp: true });
    const plan = await f.service.previewReview(f.request());
    const result = await f.service.resumeReview(accepted(plan));
    expect(result.status, result.errorDetail ?? '').toBe('ingested');
    expect(result.summary).toMatchObject({ imageCount: 3, totalMediaCount: 3 });
    expect(f.counts).toMatchObject({ outer: 0, inner: 0, scan: 1, recycle: 0 });
    expect(f.database.prepare('SELECT COUNT(*) AS n FROM post_items').get()).toEqual({ n: 3 });
  });

  it('runs newly discovered WebP through ordinary staging-move and scoped reconciliation without review approval', async () => {
    const content = await webp();
    const f = await makeFixture({ '0002.webp': content, '0003.webp': content }, { normalIngest: true });
    const result = f.service.getJob(f.jobId);
    expect(result.status).toBe('ingested');
    expect(result.summary).toMatchObject({ imageCount: 2, totalMediaCount: 2 });
    expect(result.summary!.reviewRecovery).toBeUndefined();
    expect(f.counts).toMatchObject({ outer: 1, inner: 1, scan: 1, recycle: 0 });
    const names = (await fs.readdir(f.processing)).filter(name => name.includes('staging'));
    expect(names.length).toBeGreaterThan(0);
    const target = result.targetPath!;
    expect(await fs.readFile(path.join(target, '0002.webp'))).toEqual(content);
    expect(f.database.prepare('SELECT COUNT(*) AS n FROM post_items').get()).toEqual({ n: 2 });
    expect((await f.service.runJob(f.jobId)).status).toBe('ingested');
    expect(f.counts.scan).toBe(1);
  });

  it('retains a JPEG proven to exceed default pixel limits without disabling that limit', async () => {
    const oversized = Buffer.from(await jpeg());
    let patched = false;
    for (let offset = 2; offset + 8 < oversized.length;) {
      if (oversized[offset] !== 0xff) throw new Error('Unexpected synthetic JPEG marker');
      const marker = oversized[offset + 1], length = oversized.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        oversized.writeUInt16BE(20000, offset + 5); oversized.writeUInt16BE(20000, offset + 7);
        patched = true; break;
      }
      offset += length + 2;
    }
    expect(patched).toBe(true);
    await expect(sharp(oversized).metadata()).rejects.toThrow('Input image exceeds pixel limit');
    const f = await makeFixture({ 'cover.jpg': await jpeg(), 'oversized.jpeg': oversized });
    expect(f.service.getJob(f.jobId).errorCode).toBe('MEDIA_UNREADABLE');
    const plan = await f.service.previewReview(f.request({ retainedFiles: [{ relativePath: 'oversized.jpeg', reason: 'pixel_limit' }] }));
    const result = await f.service.resumeReview(accepted(plan));
    expect(result.status, result.errorDetail ?? '').toBe('ingested');
    expect(result.summary).toMatchObject({ imageCount: 1, retainedOriginalCount: 1, retainedAttachmentCount: 0 });
    const target = path.join(result.targetPath!, RETAINED_ORIGINALS_DIRECTORY, 'oversized.jpeg');
    expect(await fs.readFile(target)).toEqual(oversized);
    await expect(sharp(target).metadata()).rejects.toThrow('Input image exceeds pixel limit');
    expect(f.database.prepare('SELECT filename FROM images').all()).toEqual([{ filename: 'cover.jpg' }]);
  });

  it.each(['extra', 'missing', 'same-size'])('rejects an unapproved %s change before accepting a plan', async kind => {
    const f = await removableFixture();
    const before = f.row();
    if (kind === 'extra') await fs.writeFile(path.join(f.levelTwo, 'unapproved.jpg'), await jpeg());
    else if (kind === 'missing') await fs.rm(path.join(f.levelTwo, 'cover.jpg'));
    else {
      const changed = Buffer.from(f.members['cover.jpg']); changed[changed.length - 1] ^= 1;
      await fs.writeFile(path.join(f.levelTwo, 'cover.jpg'), changed);
    }
    await expect(f.service.previewReview(f.approvedRequest)).rejects.toThrow();
    await expect(f.service.resumeReview(accepted(f.plan))).rejects.toThrow();
    expect(f.row()).toEqual(before);
    expect(f.counts.scan).toBe(0);
    expect(f.counts.inner).toBe(1);
  });

  it('rejects unconfirmed and mutated facts; accepted payload cannot later be replaced', async () => {
    const f = await removableFixture();
    await expect(f.service.resumeReview(f.plan)).rejects.toThrow('confirmed');
    const changed = structuredClone(f.plan); changed.files[0].sha256 = 'F'.repeat(64);
    await expect(f.service.resumeReview(accepted(changed))).rejects.toThrow('changed');
    expect(f.service.getJob(f.jobId).summary!.reviewRecovery).toBeUndefined();
    const result = await f.service.resumeReview(accepted(f.plan));
    expect(result.status, result.errorDetail ?? '').toBe('ingested');
    const row = f.row();
    await expect(f.restart().resumeReview(accepted({ ...f.plan, request: { ...f.plan.request, note: 'Changed approval' } }))).rejects.toThrow('cannot be replaced');
    expect(f.row()).toEqual(row);
  });

  it.each(['claimed', 'downloading', 'stage3-claim'])('preserves an active %s owner and performs no recovery', async kind => {
    const f = await removableFixture();
    if (kind === 'stage3-claim') f.database.prepare('UPDATE local_ingest_jobs SET claim_token=?,claimed_at=?,claim_heartbeat_at=? WHERE id=?')
      .run('other-owner', new Date().toISOString(), new Date().toISOString(), f.jobId);
    else f.database.prepare('UPDATE archive_catalog_download_tasks SET status=?,claimed_at=?,claimed_by=? WHERE id=1')
      .run(kind, new Date().toISOString(), 'active-worker');
    const job = f.row(), task = f.database.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=1').get();
    await expect(f.service.previewReview(f.approvedRequest)).rejects.toThrow('active');
    await expect(f.service.resumeReview(accepted(f.plan))).rejects.toThrow('active');
    expect(f.row()).toEqual(job);
    expect(f.database.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=1').get()).toEqual(task);
    expect(f.counts.scan).toBe(0);
  });

  it('blocks another active Stage3 job for the same creator without clearing its ownership', async () => {
    const f = await removableFixture();
    f.database.prepare(`INSERT INTO local_ingest_jobs(id,creator_id,source_archive_path,source_archive_name,source_archive_size,
      source_archive_mtime,source_archive_sha256,status,phase,claim_token,claimed_at,claim_heartbeat_at)
      VALUES(2,1,?,'008.7z',1,1,?,'running','validating','related-owner',?,?)`)
      .run(path.join(f.inboxRoot, 'related.7z'), 'A'.repeat(64), new Date().toISOString(), new Date().toISOString());
    const related = f.database.prepare('SELECT * FROM local_ingest_jobs WHERE id=2').get();
    await expect(f.service.previewReview(f.approvedRequest)).rejects.toThrow('active');
    await expect(f.service.resumeReview(accepted(f.plan))).rejects.toThrow('active');
    expect(f.database.prepare('SELECT * FROM local_ingest_jobs WHERE id=2').get()).toEqual(related);
    expect(f.counts.scan).toBe(0);
  });

  it.each(['marker', 'outer', 'inner', 'target'])('rejects a changed %s binding without rebuilding an extraction checkpoint', async kind => {
    const f = await removableFixture();
    if (kind === 'marker') await fs.rm(path.join(f.processing, '.level-2-complete'));
    if (kind === 'outer') await fs.appendFile(f.sourcePath, '!');
    if (kind === 'inner') await fs.appendFile(path.join(f.processing, 'level-1', '007.7z'), '!');
    if (kind === 'target') f.database.prepare('UPDATE local_ingest_jobs SET target_path=? WHERE id=?').run(path.join(f.libraryRoot, 'elsewhere'), f.jobId);
    const before = f.row();
    await expect(f.service.resumeReview(accepted(f.plan))).rejects.toThrow();
    expect(f.row()).toEqual(before);
    expect(f.counts).toMatchObject({ outer: 1, inner: 1, scan: 0 });
  });

  it('rejects preexisting unapproved ready content before committing approval', async () => {
    const f = await removableFixture();
    await fs.mkdir(path.join(f.processing, 'ready'));
    await fs.writeFile(path.join(f.processing, 'ready', 'injected.jpg'), await jpeg());
    await expect(f.service.previewReview(f.approvedRequest)).rejects.toThrow('staging checkpoint');
    await expect(f.service.resumeReview(accepted(f.plan))).rejects.toThrow('staging checkpoint');
    expect(f.service.getJob(f.jobId).summary!.reviewRecovery).toBeUndefined();
    expect(f.counts.scan).toBe(0);
  });

  it('rejects a target created after failure rather than adopting somebody else\'s directory', async () => {
    const f = await removableFixture();
    await fs.mkdir(f.plan.targetPath, { recursive: true });
    await fs.writeFile(path.join(f.plan.targetPath, 'unrelated.txt'), 'Do not adopt or overwrite');
    const before = f.row();
    await expect(f.service.previewReview(f.approvedRequest)).rejects.toThrow();
    await expect(f.service.resumeReview(accepted(f.plan))).rejects.toThrow();
    expect(f.row()).toEqual(before);
    expect(await fs.readFile(path.join(f.plan.targetPath, 'unrelated.txt'), 'utf8')).toBe('Do not adopt or overwrite');
  });

  it('rejects retaining a file outside the selected content root instead of silently dropping the approval', async () => {
    const f = await makeFixture({ 'album/cover.jpg': await jpeg(), 'album/broken.jpg': Buffer.alloc(0),
      '__MACOSX/book.pdf': Buffer.from('%PDF-1.4\nExcluded wrapper document') });
    await fs.rm(path.join(f.levelTwo, 'album', 'broken.jpg'));
    await expect(f.service.previewReview(f.request({
      removedFiles: [{ relativePath: 'album/broken.jpg', size: 0 }],
      retainedFiles: [{ relativePath: '__MACOSX/book.pdf', reason: 'attachment' }]
    }))).rejects.toThrow();
    expect(f.service.getJob(f.jobId).summary!.reviewRecovery).toBeUndefined();
    expect(f.counts.scan).toBe(0);
  });

  it('keeps approval and ready checkpoint after commit interruption, detects pollution, and retries the same plan', async () => {
    const f = await removableFixture();
    const originalRename = fs.rename.bind(fs);
    let interrupt = true;
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (interrupt && path.basename(String(source)) === 'ready' && path.basename(String(destination)) === path.basename(f.plan.targetPath)) {
        interrupt = false; throw new Error('Synthetic commit interruption');
      }
      return originalRename(source, destination);
    });
    const partial = await f.service.resumeReview(accepted(f.plan));
    expect(partial.status).toBe('failed');
    expect(partial.summary!.reviewRecovery).toBeDefined();
    const injected = path.join(f.processing, 'ready', 'injected.jpg');
    await fs.writeFile(injected, await jpeg());
    const blocked = await f.restart().resumeReview(accepted(f.plan));
    expect(blocked.status).toBe('awaiting_review');
    expect(blocked.errorCode).toBe('REVIEW_RECOVERY_CHANGED');
    expect(f.counts.scan).toBe(0);
    await fs.rm(injected);
    const completed = await f.restart().resumeReview(accepted(f.plan));
    expect(completed.status, completed.errorDetail ?? '').toBe('ingested');
    expect(f.counts).toMatchObject({ outer: 1, inner: 1, scan: 1 });
  });

  it('reconciles an already committed recovery after index failure without another move or duplicate identities', async () => {
    const f = await removableFixture({ scanFailures: 1 });
    const partial = await f.service.resumeReview(accepted(f.plan));
    expect(partial.status, partial.errorDetail ?? '').toBe('reconciling');
    expect(partial.errorDetail).toContain('Synthetic scoped index interruption');
    const stat = await fs.stat(partial.targetPath!, { bigint: true });
    const planPayload = (partial.summary!.reviewRecovery as { plan: unknown }).plan;
    const completed = await f.restart().resumeReview(accepted(f.plan));
    expect(completed.status, completed.errorDetail ?? '').toBe('ingested');
    expect((await fs.stat(completed.targetPath!, { bigint: true })).ino).toBe(stat.ino);
    expect((completed.summary!.reviewRecovery as { plan: unknown }).plan).toEqual(planPayload);
    expect(f.counts).toMatchObject({ outer: 1, inner: 1, scan: 2 });
    const rows = f.database.prepare('SELECT id,work_id,post_id FROM archive_catalog_local_works').all();
    expect(rows).toEqual([{ id: 501, work_id: 1, post_id: 701 }]);
    expect((await f.restart().resumeReview(accepted(f.plan))).status).toBe('ingested');
    expect(f.database.prepare('SELECT id,work_id,post_id FROM archive_catalog_local_works').all()).toEqual(rows);
    expect(f.counts.scan).toBe(2);
  });

  it('does not turn an ordinary JPEG into a retained original just because approval claims pixel_limit', async () => {
    const f = await removableFixture();
    await expect(f.service.previewReview({ ...f.approvedRequest, retainedFiles: [{ relativePath: 'cover.jpg', reason: 'pixel_limit' }] }))
      .rejects.toThrow('did not confirm');
    expect(f.service.getJob(f.jobId).summary!.reviewRecovery).toBeUndefined();
  });

  it('refuses a replaced committed target even when its visible files have the same bytes', async () => {
    const f = await removableFixture({ scanFailures: 1 });
    const partial = await f.service.resumeReview(accepted(f.plan));
    expect(partial.status, partial.errorDetail ?? '').toBe('reconciling');
    const displaced = path.join(f.root, 'original-commit');
    await fs.rename(partial.targetPath!, displaced);
    await fs.cp(displaced, partial.targetPath!, { recursive: true, errorOnExist: true, force: false });
    const blocked = await f.restart().resumeReview(accepted(f.plan));
    expect(blocked.status).toBe('reconciling');
    expect(blocked.errorCode).toBe('REVIEW_RECOVERY_CHANGED');
    expect(f.counts.scan).toBe(1);
    expect(f.database.prepare('SELECT COUNT(*) AS n FROM archive_catalog_local_works').get()).toEqual({ n: 0 });
  });

  it('resumes an accepted checkpoint after its previous process claim expires without replacing approval', async () => {
    const f = await removableFixture({ scanFailures: 1 });
    const partial = await f.service.resumeReview(accepted(f.plan));
    expect(partial.status, partial.errorDetail ?? '').toBe('reconciling');
    const recovery = partial.summary!.reviewRecovery;
    f.database.prepare("UPDATE local_ingest_jobs SET claim_token='crashed-owner',claimed_at='2000-01-01T00:00:00Z',claim_heartbeat_at='2000-01-01T00:00:00Z' WHERE id=?")
      .run(f.jobId);
    const completed = await f.restart().resumeReview(accepted(f.plan));
    expect(completed.status, completed.errorDetail ?? '').toBe('ingested');
    expect(completed.summary!.reviewRecovery).toEqual(recovery);
    expect(f.row().claim_token).toBeNull();
    expect(f.counts).toMatchObject({ outer: 1, inner: 1, scan: 2 });
  });

  it('preserves a decomposed Unicode PDF filename while comparing inventory keys canonically', async () => {
    const relativePath = 're\u0301sume\u0301.pdf', pdf = Buffer.from('%PDF-1.4\nUnicode filename retention');
    const f = await makeFixture({ 'cover.jpg': await jpeg(), [relativePath]: pdf });
    const plan = await f.service.previewReview(f.request({ retainedFiles: [{ relativePath, reason: 'attachment' }] }));
    expect(plan.files.some(file => file.relativePath === relativePath)).toBe(true);
    const completed = await f.service.resumeReview(accepted(plan));
    expect(completed.status, completed.errorDetail ?? '').toBe('ingested');
    expect(await fs.readdir(path.join(completed.targetPath!, RETAINED_ORIGINALS_DIRECTORY))).toEqual([relativePath]);
    expect(await fs.readFile(path.join(completed.targetPath!, RETAINED_ORIGINALS_DIRECTORY, relativePath))).toEqual(pdf);
  });

  it.each(['target-media', 'retained-original', 'source-archive', 'extraction'])
    ('blocks cleanup after %s changes and never invokes recycle', async kind => {
      const f = await makeFixture({ 'cover.jpg': await jpeg(), 'book.pdf': Buffer.from('%PDF-1.4\nRetain document') }, { allowRecycle: true });
      const plan = await f.service.previewReview(f.request({ retainedFiles: [{ relativePath: 'book.pdf', reason: 'attachment' }] }));
      const completed = await f.service.resumeReview(accepted(plan));
      expect(completed.status, completed.errorDetail ?? '').toBe('ingested');
      const mutation = kind === 'target-media' ? path.join(completed.targetPath!, 'cover.jpg')
        : kind === 'retained-original' ? path.join(completed.targetPath!, RETAINED_ORIGINALS_DIRECTORY, 'book.pdf')
          : kind === 'source-archive' ? f.sourcePath : path.join(f.levelTwo, 'cover.jpg');
      await fs.appendFile(mutation, '!');
      const blocked = await f.restart().retryCleanup(f.jobId);
      expect(blocked.status).toBe('ingested');
      expect(blocked.cleanupStatus).toBe('failed');
      expect(blocked.errorCode).toBe('RECYCLE_FAILED');
      expect(blocked.errorDetail).toMatch(/differs|changed/iu);
      expect(f.counts.recycle).toBe(0);
      expect(f.recycled).toEqual([]);
      expect((await fs.stat(f.sourcePath)).isFile()).toBe(true);
      expect((await fs.stat(f.processing)).isDirectory()).toBe(true);
    });

  it('recycles only unchanged source/checkpoint into a recoverable temp location and keeps plan replay a no-op', async () => {
    const pdf = Buffer.from('%PDF-1.4\nRetain document');
    const f = await makeFixture({ 'cover.jpg': await jpeg(), 'book.pdf': pdf }, { allowRecycle: true });
    const plan = await f.service.previewReview(f.request({ retainedFiles: [{ relativePath: 'book.pdf', reason: 'attachment' }] }));
    const completed = await f.service.resumeReview(accepted(plan));
    expect(completed.status, completed.errorDetail ?? '').toBe('ingested');
    const cleanup = await f.restart().retryCleanup(f.jobId);
    expect(cleanup.cleanupStatus, cleanup.errorDetail ?? '').toBe('recycled');
    expect(cleanup.status).toBe('ingested');
    expect(f.counts.recycle).toBe(2);
    expect(f.recycled).toHaveLength(2);
    expect(await fs.readFile(f.recycled[0].preserved, 'utf8')).toBe('synthetic outer archive');
    expect(await fs.readFile(path.join(f.recycled[1].preserved, 'level-2', 'book.pdf'))).toEqual(pdf);
    expect(await fs.readFile(path.join(cleanup.targetPath!, RETAINED_ORIGINALS_DIRECTORY, 'book.pdf'))).toEqual(pdf);
    await expect(fs.stat(f.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(f.processing)).rejects.toMatchObject({ code: 'ENOENT' });
    const row = f.row(), counts = { ...f.counts };
    expect((await f.restart().resumeReview(accepted(plan))).status).toBe('ingested');
    expect(f.row()).toEqual(row);
    expect(f.counts).toEqual(counts);
  });

  it.each(['unchanged', 'truncated', 'extra'])
    ('checks and resumes an interrupted approved copy staging with %s partial content', async change => {
      const cover = await jpeg(), pdf = Buffer.from('%PDF-1.4\nCopy interruption fixture');
      const f = await makeFixture({ 'cover.jpg': cover, 'book.pdf': pdf });
      const plan = await f.service.previewReview(f.request({ retainedFiles: [{ relativePath: 'book.pdf', reason: 'attachment' }] }));
      const originalCopy = fs.copyFile.bind(fs);
      const copies: Array<{ source: string; destination: string }> = [];
      vi.spyOn(fs, 'copyFile').mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
        copies.push({ source: String(args[0]), destination: String(args[1]) });
        if (copies.length === 2) throw new Error('Synthetic interruption before second staging copy');
        return originalCopy(...args);
      });
      const interrupted = await f.service.resumeReview(accepted(plan));
      expect(interrupted.status).toBe('failed');
      expect(interrupted.errorDetail).toContain('before second staging copy');
      expect(interrupted.summary!.reviewRecovery).toBeDefined();
      expect(copies).toHaveLength(2);
      const first = copies[0].destination;
      const firstBefore = await fs.stat(first, { bigint: true });
      expect(await fs.readFile(first)).toEqual(cover);
      const builders = (await fs.readdir(f.processing)).filter(name => name.startsWith('ready-building'));
      expect(builders).toEqual([`ready-building-review-${plan.planId}`]);
      const buildRoot = path.join(f.processing, `ready-building-review-${plan.planId}`);
      const extra = path.join(buildRoot, 'unapproved.bin');
      if (change === 'truncated') await fs.writeFile(first, cover.subarray(0, Math.floor(cover.length / 2)));
      if (change === 'extra') await fs.writeFile(extra, 'unapproved extra bytes must remain for review');
      const beforeRetry = await fs.readFile(first);
      const retried = await f.restart().resumeReview(accepted(plan));
      expect(f.counts).toMatchObject({ outer: 1, inner: 1, recycle: 0 });
      expect(retried.summary!.reviewRecovery).toEqual(interrupted.summary!.reviewRecovery);
      if (change === 'unchanged') {
        expect(retried.status, retried.errorDetail ?? '').toBe('ingested');
        expect(copies).toHaveLength(3);
        expect(copies.filter(copy => path.basename(copy.source) === 'cover.jpg')).toHaveLength(1);
        const targetCover = path.join(retried.targetPath!, 'cover.jpg');
        expect((await fs.stat(targetCover, { bigint: true })).ino).toBe(firstBefore.ino);
        expect(await fs.readFile(targetCover)).toEqual(cover);
        expect(await fs.readFile(path.join(retried.targetPath!, RETAINED_ORIGINALS_DIRECTORY, 'book.pdf'))).toEqual(pdf);
        expect(f.counts.scan).toBe(1);
      } else {
        expect(retried.status).toBe('awaiting_review');
        expect(retried.errorCode).toBe('REVIEW_RECOVERY_CHANGED');
        expect(copies).toHaveLength(2);
        expect(f.counts.scan).toBe(0);
        expect(await fs.readFile(first)).toEqual(beforeRetry);
        if (change === 'extra') expect(await fs.readFile(extra, 'utf8')).toBe('unapproved extra bytes must remain for review');
        await expect(fs.stat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
});
