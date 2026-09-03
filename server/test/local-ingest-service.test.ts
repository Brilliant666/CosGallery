import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appConfig } from '../src/config/env.js';
import { schemaSql } from '../src/db/schema.js';
import { assertSafeArchiveEntry, LocalIngestService } from '../src/services/local-ingest-service.js';
import type { LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';
import type { RecycleBinAdapter } from '../src/services/recycle-bin-adapter.js';

const sevenZipPath = 'C:\\Program Files\\NVIDIA Corporation\\NVIDIA app\\7z.exe';
const fixturePassword = 'fixture-password-not-a-real-secret';
const ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH ?? 'ffprobe';
const originalFfprobePath = appConfig.ffprobePath;

type FixtureOptions = {
  password?: string;
  innerCount?: number;
  includeUnknown?: boolean;
  includeImage?: boolean;
  includeVideo?: boolean;
  includeNestedArchive?: boolean;
  noInner?: boolean;
  corruptImage?: boolean;
  zeroByteMedia?: boolean;
  useMediaSubdirectories?: boolean;
  mediaSummary?: string;
  recent?: boolean;
  temporarySibling?: boolean;
  recycleFailures?: number;
  reconciliationFailures?: number;
  recycleAfterIngest?: boolean;
};

type Fixture = {
  root: string;
  libraryRoot: string;
  inboxRoot: string;
  processingRoot: string;
  quarantineRoot: string;
  recycleRoot: string;
  creatorName: string;
  sourceArchivePath: string;
  database: DatabaseSync;
  service: LocalIngestService;
  recycleCalls: string[];
  rescanCalls: number;
  rescanScopes: Array<{ libraryRoot: string; creatorId: number; creatorFolderName: string }>;
  advanceTime: (milliseconds: number) => void;
};

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(output)));
  });
}

function seedLedger(database: DatabaseSync, creatorName: string, filename = '007.7z', mediaSummary = '1P-1MB'): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO archive_catalog_creators (
       id, canonical_name, normalized_name, preference, effective_rating,
       seed_source, seed_source_creator_id, created_at, updated_at
     ) VALUES (1, ?, ?, 'liked', 'R15', 'test', 'creator-1', ?, ?)`
  ).run(creatorName, creatorName.toLocaleLowerCase().replace(/\s+/g, ''), now, now);
  database.prepare(
    `INSERT INTO archive_catalog_collections (
       id, creator_id, source, source_collection_id, title, observed_at,
       is_active, created_at, updated_at
     ) VALUES (1, 1, 'costuan', 'collection-1', 'Fixture collection', ?, 1, ?, ?)`
  ).run(now, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_works (id, creator_id, display_title, created_at, updated_at)
     VALUES (1, 1, ?, ?, ?)`
  ).run(`${creatorName} NO.007 Sample`, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_source_works (
       id, work_id, collection_id, source, source_work_id, source_order,
       source_order_label, source_title, raw_title, media_summary, is_active,
       first_seen_at, last_seen_at
     ) VALUES (1, 1, 1, 'costuan', 'work-007', 7, 'NO.007', ?, ?, ?, 1, ?, ?)`
  ).run(`${creatorName} NO.007 Sample`, `${creatorName} NO.007 Sample [${mediaSummary}]`, mediaSummary, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_download_tasks (
       id, source_work_id, provider, target_root, target_relative_directory,
       target_filename, status, created_at, updated_at
     ) VALUES (1, 1, 'baidu', ?, ?, ?, 'staged', ?, ?)`
  ).run('inbox', creatorName, filename, now, now);
}

function seedAdditionalWork(database: DatabaseSync, creatorName: string, order: number, filename: string): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO archive_catalog_works (id, creator_id, display_title, created_at, updated_at)
     VALUES (2, 1, ?, ?, ?)`
  ).run(`${creatorName} NO.${String(order).padStart(3, '0')} Sample`, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_source_works (
       id, work_id, collection_id, source, source_work_id, source_order,
       source_order_label, source_title, raw_title, media_summary, is_active,
       first_seen_at, last_seen_at
     ) VALUES (2, 2, 1, 'costuan', ?, ?, ?, ?, ?, '1P-1MB', 1, ?, ?)`
  ).run(
    `work-${String(order).padStart(3, '0')}`,
    order,
    `NO.${String(order).padStart(3, '0')}`,
    `${creatorName} NO.${String(order).padStart(3, '0')} Sample`,
    `${creatorName} NO.${String(order).padStart(3, '0')} Sample [1P-1MB]`,
    now,
    now
  );
  database.prepare(
    `INSERT INTO archive_catalog_download_tasks (
       id, source_work_id, provider, target_root, target_relative_directory,
       target_filename, status, created_at, updated_at
     ) VALUES (2, 2, 'baidu', 'inbox', ?, ?, 'staged', ?, ?)`
  ).run(creatorName, filename, now, now);
}

function seedSecondCreator(database: DatabaseSync, creatorName: string, filename = '007.7z'): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO archive_catalog_creators (
       id, canonical_name, normalized_name, preference, effective_rating,
       seed_source, seed_source_creator_id, created_at, updated_at
     ) VALUES (2, ?, ?, 'kept', 'R18', 'test', 'creator-2', ?, ?)`
  ).run(creatorName, creatorName.toLocaleLowerCase().replace(/\s+/g, ''), now, now);
  database.prepare(
    `INSERT INTO archive_catalog_collections (
       id, creator_id, source, source_collection_id, title, observed_at,
       is_active, created_at, updated_at
     ) VALUES (2, 2, 'costuan', 'collection-2', 'Second fixture collection', ?, 1, ?, ?)`
  ).run(now, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_works (id, creator_id, display_title, created_at, updated_at)
     VALUES (3, 2, ?, ?, ?)`
  ).run(`${creatorName} NO.007 Sample`, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_source_works (
       id, work_id, collection_id, source, source_work_id, source_order,
       source_order_label, source_title, raw_title, media_summary, is_active,
       first_seen_at, last_seen_at
     ) VALUES (3, 3, 2, 'costuan', 'work-beta-007', 7, 'NO.007', ?, ?, '1P-1MB', 1, ?, ?)`
  ).run(`${creatorName} NO.007 Sample`, `${creatorName} NO.007 Sample [1P-1MB]`, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_download_tasks (
       id, source_work_id, provider, target_root, target_relative_directory,
       target_filename, status, created_at, updated_at
     ) VALUES (3, 3, 'baidu', 'inbox', ?, ?, 'staged', ?, ?)`
  ).run(creatorName, filename, now, now);
}

async function makeNestedArchive(
  root: string,
  sourceArchivePath: string,
  options: FixtureOptions = {}
): Promise<void> {
  const password = options.password ?? fixturePassword;
  const payload = path.join(root, 'payload');
  await fs.mkdir(payload, { recursive: true });
  if (options.includeImage !== false) {
    const imageDirectory = options.useMediaSubdirectories ? path.join(payload, '图片') : payload;
    await fs.mkdir(imageDirectory, { recursive: true });
    const imagePath = path.join(imageDirectory, 'cover.jpg');
    if (options.zeroByteMedia) await fs.writeFile(imagePath, '');
    else if (options.corruptImage) await fs.writeFile(imagePath, 'not-an-image');
    else {
      await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#bada55' }
      }).jpeg().toFile(imagePath);
    }
  }
  if (options.includeVideo) {
    const videoDirectory = options.useMediaSubdirectories ? path.join(payload, '视频') : payload;
    await fs.mkdir(videoDirectory, { recursive: true });
    await run(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.2',
      '-an', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', path.join(videoDirectory, 'clip.mp4')
    ]);
  }
  await fs.writeFile(path.join(payload, 'advertisement.txt'), 'not part of the final gallery');
  if (options.includeUnknown) await fs.writeFile(path.join(payload, 'unknown.exe'), 'fixture');
  if (options.includeNestedArchive) {
    const nestedSource = path.join(root, 'nested-source');
    await fs.mkdir(nestedSource, { recursive: true });
    await fs.writeFile(path.join(nestedSource, 'note.txt'), 'nested archive fixture');
    await run(sevenZipPath, ['a', '-t7z', path.join(payload, 'leftover.7z'), '.'], nestedSource);
  }
  const outerContent = path.join(root, 'outer-content');
  await fs.mkdir(outerContent, { recursive: true });
  const innerCount = options.innerCount ?? 1;
  if (!options.noInner) {
    for (let index = 0; index < innerCount; index += 1) {
      const inner7z = path.join(outerContent, `${String(7 + index).padStart(3, '0')}.7z`);
      await run(sevenZipPath, ['a', '-t7z', `-p${password}`, '-mhe=on', inner7z, '.'], payload);
      await fs.rename(inner7z, `${inner7z}z`);
    }
  }
  await fs.writeFile(path.join(outerContent, 'outer-note.html'), '<p>fixture</p>');
  await fs.mkdir(path.dirname(sourceArchivePath), { recursive: true });
  await run(sevenZipPath, ['a', '-t7z', `-p${password}`, '-mhe=on', sourceArchivePath, '.'], outerContent);
  if (!options.recent) {
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(sourceArchivePath, old, old);
  }
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-local-ingest-'));
  const libraryRoot = path.join(root, 'library');
  const inboxRoot = path.join(root, 'inbox');
  const processingRoot = path.join(root, 'processing');
  const quarantineRoot = path.join(root, 'quarantine');
  const recycleRoot = path.join(root, 'recycle');
  const creatorName = 'Creator Alpha';
  await Promise.all([libraryRoot, inboxRoot, processingRoot, quarantineRoot, recycleRoot].map((directory) => fs.mkdir(directory, { recursive: true })));
  const sourceArchivePath = path.join(inboxRoot, creatorName, '007.7z');
  await makeNestedArchive(root, sourceArchivePath, options);
  if (options.temporarySibling) await fs.writeFile(`${sourceArchivePath}.crdownload`, 'in progress');
  const database = new DatabaseSync(':memory:');
  database.exec(schemaSql);
  seedLedger(database, creatorName, '007.7z', options.mediaSummary ?? '1P-1MB');
  const settings = {
    get: () => ({
      libraryRoot,
      inboxRoot,
      processingRoot,
      quarantineRoot,
      sevenZipPath,
      fileStableSeconds: 1,
      recycleAfterIngest: options.recycleAfterIngest ?? true,
      maxExtractionDepth: 2 as const,
      allowlist: [creatorName],
      archivePasswordConfigured: true
    }),
    getArchivePassword: () => options.password ?? fixturePassword
  } as unknown as LocalIngestSettingsService;
  const recycleCalls: string[] = [];
  let remainingRecycleFailures = options.recycleFailures ?? 0;
  const recycle = {
    recycle: async (targetPath: string) => {
      recycleCalls.push(targetPath);
      if (remainingRecycleFailures > 0) {
        remainingRecycleFailures -= 1;
        throw new Error('synthetic recycle failure');
      }
      const target = path.join(recycleRoot, `${path.basename(targetPath)}-${Date.now()}-${Math.random()}`);
      await fs.rename(targetPath, target);
      return { targetPath, recycled: true };
    },
    smokeTest: async () => ({ targetPath: '', recycled: true })
  } as unknown as RecycleBinAdapter;
  let rescanCalls = 0;
  const rescanScopes: Array<{ libraryRoot: string; creatorId: number; creatorFolderName: string }> = [];
  let remainingReconciliationFailures = options.reconciliationFailures ?? 0;
  const rescan = async (
    db: DatabaseSync,
    scopedLibraryRoot: string,
    creatorId: number,
    creatorFolderName: string
  ) => {
    rescanCalls += 1;
    rescanScopes.push({ libraryRoot: scopedLibraryRoot, creatorId, creatorFolderName });
    if (remainingReconciliationFailures > 0) {
      remainingReconciliationFailures -= 1;
      return;
    }
    const now = new Date().toISOString();
    const target = db.prepare('SELECT target_path FROM local_ingest_jobs WHERE id = 1').get() as { target_path: string };
    db.prepare(
      `INSERT OR IGNORE INTO archive_catalog_local_creator_folders (
         id, creator_id, root_path, relative_path, absolute_path, folder_name,
         match_status, match_method, is_active, scanned_at, created_at, updated_at
       ) VALUES (1, 1, ?, ?, ?, ?, 'matched', 'test', 1, ?, ?, ?)`
    ).run(libraryRoot, creatorName, path.join(libraryRoot, creatorName), creatorName, now, now, now);
    db.prepare(
      `INSERT OR IGNORE INTO archive_catalog_local_works (
         id, local_creator_folder_id, work_id, relative_path, absolute_path,
         folder_name, parsed_source_order, image_count, video_count,
         advertisement_file_count, other_file_count, total_bytes, match_status,
         match_method, is_active, scanned_at, created_at, updated_at
       ) VALUES (1, 1, 1, ?, ?, ?, 7, 1, 0, 0, 0, 1, 'matched', 'test', 1, ?, ?, ?)`
    ).run(path.relative(libraryRoot, target.target_path), target.target_path, path.basename(target.target_path), now, now, now);
    db.prepare("UPDATE archive_catalog_download_tasks SET status = 'ingested' WHERE id = 1").run();
  };
  let clock = Date.now();
  const service = new LocalIngestService(database, settings, recycle, rescan, {
    now: () => new Date(clock),
    wait: async (milliseconds) => { clock += milliseconds; },
    expectedGalleryRoot: libraryRoot
  });
  return {
    root,
    libraryRoot,
    inboxRoot,
    processingRoot,
    quarantineRoot,
    recycleRoot,
    creatorName,
    sourceArchivePath,
    database,
    service,
    recycleCalls,
    rescanScopes,
    advanceTime(milliseconds: number) { clock += milliseconds; },
    get rescanCalls() { return rescanCalls; }
  };
}

async function discoverStable(fixture: Fixture, allowlist = [fixture.creatorName]) {
  await fixture.service.scanInbox(allowlist);
  fixture.advanceTime(1_100);
  return fixture.service.scanInbox(allowlist);
}

describe.sequential('LocalIngestService', () => {
  let fixture: Fixture | null = null;

  beforeEach(() => {
    fixture = null;
    appConfig.ffprobePath = ffprobePath;
  });

  afterAll(() => {
    appConfig.ffprobePath = originalFfprobePath;
  });

  afterEach(async () => {
    fixture?.database.close();
    if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')('discovers, maps, extracts twice, commits, reconciles, recycles, and reruns idempotently', async () => {
    fixture = await createFixture();
    const discovery = await discoverStable(fixture);
    expect(discovery.createdJobs).toBe(1);
    expect(discovery.jobs[0]).toMatchObject({ sourceWorkId: 1, archiveDownloadTaskId: 1, status: 'queued' });
    const duplicateDiscovery = await fixture.service.scanInbox([fixture.creatorName]);
    expect(duplicateDiscovery).toMatchObject({ createdJobs: 0, existingJobs: 1 });

    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'ingested', phase: 'done', cleanupStatus: 'recycled' });
    expect(fixture.rescanScopes).toEqual([{
      libraryRoot: fixture.libraryRoot,
      creatorId: 1,
      creatorFolderName: fixture.creatorName
    }]);
    expect(result.summary).toMatchObject({
      imageCount: 1,
      videoCount: 0,
      advertisementFileCount: 1,
      levelOneOutput: ['007.7zz', 'outer-note.html'],
      innerOriginalName: '007.7zz',
      innerWorkingName: '007.7z',
      declaredImageCount: 1,
      declaredTotalBytes: 1024 * 1024,
      sourceReconciled: true,
      missingDifferenceCleared: true,
      sourceArchiveRecycled: true,
      processingDirectoryRecycled: true
    });
    expect(await fs.readdir(path.join(fixture.libraryRoot, fixture.creatorName, `${fixture.creatorName} NO.007 Sample [1P-1MB]`))).toEqual(['cover.jpg']);
    expect(await fs.access(fixture.sourceArchivePath).then(() => true, () => false)).toBe(false);
    expect(fixture.recycleCalls).toHaveLength(2);
    const rerun = await fixture.service.runJob(result.id);
    expect(rerun).toMatchObject({ status: 'ingested', cleanupStatus: 'recycled', attemptCount: 1 });
    expect(fixture.recycleCalls).toHaveLength(2);
    expect(JSON.stringify(rerun)).not.toContain(fixturePassword);

    const recycledArchiveName = (await fs.readdir(fixture.recycleRoot)).find((name) => name.startsWith('007.7z-'));
    expect(recycledArchiveName).toBeTruthy();
    await fs.mkdir(path.dirname(fixture.sourceArchivePath), { recursive: true });
    await fs.copyFile(path.join(fixture.recycleRoot, recycledArchiveName!), fixture.sourceArchivePath);
    const rediscovery = await discoverStable(fixture);
    expect(rediscovery).toMatchObject({ createdJobs: 0, existingJobs: 1 });
    expect(rediscovery.jobs[0]).toMatchObject({ id: result.id, status: 'ingested', attemptCount: 1 });
  }, 60_000);

  it.runIf(process.platform === 'win32')('confirms a stable exact local handoff in one scan operation and advances only staged tasks', async () => {
    fixture = await createFixture();
    const discovery = await fixture.service.scanInboxWithStableRecheck();
    expect(discovery).toMatchObject({
      discoveredCreators: 1,
      discoveredArchives: 1,
      createdJobs: 1,
      waitingStable: 0,
      reconciledDownloadedTasks: 1
    });
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get())
      .toEqual({ status: 'downloaded' });

    const repeated = await fixture.service.scanInboxWithStableRecheck();
    expect(repeated).toMatchObject({ existingJobs: 1, reconciledDownloadedTasks: 0 });
    fixture.database.prepare("UPDATE archive_catalog_download_tasks SET status = 'ingested' WHERE id = 1").run();
    await fixture.service.scanInboxWithStableRecheck();
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get())
      .toEqual({ status: 'ingested' });
  }, 60_000);

  it.runIf(process.platform === 'win32')('keeps unstable, unmapped, ambiguous, and cancelled handoffs out of downloaded', async () => {
    fixture = await createFixture({ temporarySibling: true });
    const unstable = await fixture.service.scanInboxWithStableRecheck();
    expect(unstable).toMatchObject({ waitingStable: 1, reconciledDownloadedTasks: 0 });
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get())
      .toEqual({ status: 'staged' });
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });

    fixture = await createFixture();
    await fs.rename(fixture.sourceArchivePath, path.join(path.dirname(fixture.sourceArchivePath), '008.7z'));
    const unmapped = await fixture.service.scanInboxWithStableRecheck();
    expect(unmapped).toMatchObject({ awaitingReview: 1, reconciledDownloadedTasks: 0 });
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get())
      .toEqual({ status: 'staged' });
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });

    fixture = await createFixture();
    seedAdditionalWork(fixture.database, fixture.creatorName, 8, '007.7z');
    const ambiguous = await fixture.service.scanInboxWithStableRecheck();
    expect(ambiguous).toMatchObject({ awaitingReview: 1, reconciledDownloadedTasks: 0 });
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks ORDER BY id').all())
      .toEqual([{ status: 'staged' }, { status: 'staged' }]);
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });

    fixture = await createFixture();
    fixture.database.prepare("UPDATE archive_catalog_download_tasks SET status = 'cancelled' WHERE id = 1").run();
    const cancelled = await fixture.service.scanInboxWithStableRecheck();
    expect(cancelled).toMatchObject({ createdJobs: 1, reconciledDownloadedTasks: 0 });
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get())
      .toEqual({ status: 'cancelled' });
  }, 60_000);

  it.runIf(process.platform === 'win32')('rolls back job creation when the staged handoff update fails', async () => {
    fixture = await createFixture();
    fixture.database.exec(
      `CREATE TRIGGER fail_downloaded_handoff
       BEFORE UPDATE OF status ON archive_catalog_download_tasks
       WHEN NEW.status = 'downloaded'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic handoff failure');
       END`
    );
    await expect(fixture.service.scanInboxWithStableRecheck()).rejects.toThrow(/synthetic handoff failure/i);
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get()).toEqual({ count: 0 });
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get())
      .toEqual({ status: 'staged' });
  }, 60_000);

  it('rejects traversal, absolute, and drive-qualified archive entry paths', () => {
    expect(() => assertSafeArchiveEntry('../escape.jpg')).toThrow(/unsafe path/i);
    expect(() => assertSafeArchiveEntry('folder/../../escape.jpg')).toThrow(/unsafe path/i);
    expect(() => assertSafeArchiveEntry('/absolute/escape.jpg')).toThrow(/unsafe path/i);
    expect(() => assertSafeArchiveEntry('C:\\escape.jpg')).toThrow(/unsafe path/i);
    expect(() => assertSafeArchiveEntry('safe/subfolder/image.jpg')).not.toThrow();
  });

  it.runIf(process.platform === 'win32')('does not claim a file that is still downloading, then resumes after it becomes stable', async () => {
    fixture = await createFixture({ recent: true, temporarySibling: true });
    const discovery = await fixture.service.scanInbox([fixture.creatorName]);
    expect(discovery).toMatchObject({ createdJobs: 0, waitingStable: 1 });
    expect(discovery.jobs).toEqual([]);

    await fs.rm(`${fixture.sourceArchivePath}.crdownload`);
    await fixture.service.scanInbox([fixture.creatorName]);
    fixture.advanceTime(1_100);
    const stableDiscovery = await fixture.service.scanInbox([fixture.creatorName]);
    expect(stableDiscovery).toMatchObject({ createdJobs: 1, existingJobs: 0 });
    expect(stableDiscovery.jobs[0]).toMatchObject({ phase: 'discovered', attemptCount: 0 });
    expect(await fixture.service.runJob(stableDiscovery.jobs[0].id)).toMatchObject({ status: 'ingested', attemptCount: 1 });
  }, 60_000);

  it.runIf(process.platform === 'win32')('reports a corrupt outer archive without changing the source file', async () => {
    fixture = await createFixture();
    await fs.writeFile(fixture.sourceArchivePath, 'not a real archive');
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(fixture.sourceArchivePath, old, old);
    const before = await fs.readFile(fixture.sourceArchivePath);
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'ARCHIVE_CORRUPT' });
    expect(await fs.readFile(fixture.sourceArchivePath)).toEqual(before);
  }, 60_000);

  it.runIf(process.platform === 'win32')('requests review when the outer layer has no inner archive', async () => {
    fixture = await createFixture({ noInner: true });
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'INNER_ARCHIVE_MISSING' });
    expect(await fs.access(fixture.sourceArchivePath).then(() => true, () => false)).toBe(true);
  }, 60_000);

  it.runIf(process.platform === 'win32')('stops at the fixed extraction depth when another archive remains', async () => {
    fixture = await createFixture({ includeNestedArchive: true });
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'NESTED_DEPTH_EXCEEDED' });
    expect(await fs.readdir(path.join(fixture.libraryRoot, fixture.creatorName)).catch(() => [])).toEqual([]);
  }, 60_000);

  it.runIf(process.platform === 'win32')('requires at least one valid media file', async () => {
    fixture = await createFixture({ includeImage: false });
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'NO_VALID_MEDIA' });
  }, 60_000);

  it.runIf(process.platform === 'win32')('blocks unreadable and zero-byte media', async () => {
    fixture = await createFixture({ corruptImage: true });
    let discovery = await discoverStable(fixture);
    let result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'MEDIA_UNREADABLE' });
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });

    fixture = await createFixture({ zeroByteMedia: true });
    discovery = await discoverStable(fixture);
    result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'UNSAFE_OR_EMPTY_FILE' });
  }, 60_000);

  it.runIf(process.platform === 'win32' && existsSync(ffmpegPath) && existsSync(ffprobePath))('preserves image/video subdirectories while excluding advertisements from a mixed work', async () => {
    fixture = await createFixture({ includeVideo: true, useMediaSubdirectories: true, mediaSummary: '1P-1V-1MB' });
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'ingested' });
    expect(result.summary).toMatchObject({ imageCount: 1, videoCount: 1, mediaType: 'mixed', advertisementFileCount: 1 });
    const target = result.targetPath!;
    expect(await fs.readdir(target)).toEqual(['图片', '视频']);
    expect(await fs.readdir(path.join(target, '图片'))).toEqual(['cover.jpg']);
    expect(await fs.readdir(path.join(target, '视频'))).toEqual(['clip.mp4']);
  }, 60_000);

  it.runIf(process.platform === 'win32' && existsSync(ffmpegPath) && existsSync(ffprobePath))('ingests a video-only work', async () => {
    fixture = await createFixture({ includeImage: false, includeVideo: true, mediaSummary: '1V-1MB' });
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'ingested', validationStatus: 'passed' });
    expect(result.summary).toMatchObject({ imageCount: 0, videoCount: 1, mediaType: 'video' });
    expect(await fs.readdir(result.targetPath!)).toEqual(['clip.mp4']);
  }, 60_000);

  it.runIf(process.platform === 'win32')('records declared-count differences as warnings without blocking ingest', async () => {
    fixture = await createFixture({ mediaSummary: '2P-10MB' });
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'ingested', validationStatus: 'warning' });
    expect(result.summary?.warnings).toEqual(['Declared 2 images; extracted 1']);
    expect(result.summary).toMatchObject({ declaredImageCount: 2, declaredTotalBytes: 10 * 1024 * 1024 });
  }, 60_000);

  it.runIf(process.platform === 'win32')('keeps a target conflict in review even when the run endpoint is called explicitly', async () => {
    fixture = await createFixture();
    const target = path.join(fixture.libraryRoot, fixture.creatorName, `${fixture.creatorName} NO.007 Sample [1P-1MB]`);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'existing.jpg'), 'do not overwrite');
    const discovery = await discoverStable(fixture);
    expect(discovery.jobs[0]).toMatchObject({ status: 'awaiting_review', errorCode: 'TARGET_EXISTS', attemptCount: 0 });
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'TARGET_EXISTS', attemptCount: 0 });
    expect(await fs.readFile(path.join(target, 'existing.jpg'), 'utf8')).toBe('do not overwrite');
  }, 60_000);

  it.runIf(process.platform === 'win32')('recovers after the atomic move when reconciliation initially fails', async () => {
    fixture = await createFixture({ reconciliationFailures: 1 });
    const discovery = await discoverStable(fixture);
    const first = await fixture.service.runJob(discovery.jobs[0].id);
    expect(first).toMatchObject({ status: 'reconciling', phase: 'reconciling', errorCode: 'RECONCILIATION_INCOMPLETE', attemptCount: 1 });
    expect(await fs.access(first.targetPath!).then(() => true, () => false)).toBe(true);
    expect(await fs.access(fixture.sourceArchivePath).then(() => true, () => false)).toBe(true);

    const recovered = await fixture.service.runJob(first.id);
    expect(recovered).toMatchObject({ status: 'ingested', phase: 'done', cleanupStatus: 'recycled', attemptCount: 1 });
    expect(fixture.rescanCalls).toBe(2);
    expect((await fs.readdir(path.join(fixture.libraryRoot, fixture.creatorName))).filter((name) => name.includes('NO.007'))).toHaveLength(1);
  }, 60_000);

  it.runIf(process.platform === 'win32')('retries only cleanup after an ingested work fails to enter the recycle bin', async () => {
    fixture = await createFixture({ recycleFailures: 1 });
    const discovery = await discoverStable(fixture);
    const first = await fixture.service.runJob(discovery.jobs[0].id);
    expect(first).toMatchObject({ status: 'ingested', phase: 'cleanup', cleanupStatus: 'failed', errorCode: 'RECYCLE_FAILED', attemptCount: 1 });
    expect(await fs.access(first.targetPath!).then(() => true, () => false)).toBe(true);
    expect(await fs.access(fixture.sourceArchivePath).then(() => true, () => false)).toBe(true);

    const recovered = await fixture.service.retryCleanup(first.id);
    expect(recovered).toMatchObject({ status: 'ingested', phase: 'done', cleanupStatus: 'recycled', attemptCount: 1 });
    expect(fixture.rescanCalls).toBe(1);
    expect((await fs.readdir(path.join(fixture.libraryRoot, fixture.creatorName))).filter((name) => name.includes('NO.007'))).toHaveLength(1);
  }, 60_000);

  it.runIf(process.platform === 'win32')('does not merge identical archive hashes that map to different source works', async () => {
    fixture = await createFixture();
    seedAdditionalWork(fixture.database, fixture.creatorName, 8, '008.7z');
    const secondArchive = path.join(fixture.inboxRoot, fixture.creatorName, '008.7z');
    await fs.copyFile(fixture.sourceArchivePath, secondArchive);
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(secondArchive, old, old);
    const discovery = await discoverStable(fixture);
    expect(discovery.createdJobs).toBe(2);
    expect(new Set(discovery.jobs.map((job) => job.sourceWorkId))).toEqual(new Set([1, 2]));
    expect(new Set(discovery.jobs.map((job) => job.sourceArchiveSha256)).size).toBe(1);
  }, 60_000);

  it.runIf(process.platform === 'win32')('records an unmapped archive for review and leaves it untouched', async () => {
    fixture = await createFixture();
    const unmappedArchive = path.join(fixture.inboxRoot, fixture.creatorName, '999.7z');
    await fs.rename(fixture.sourceArchivePath, unmappedArchive);
    const discovery = await discoverStable(fixture);
    expect(discovery.jobs[0]).toMatchObject({
      sourceWorkId: null,
      archiveDownloadTaskId: null,
      status: 'awaiting_review',
      phase: 'mapping',
      errorCode: 'MAPPING_NOT_FOUND',
      attemptCount: 0
    });
    expect(await fixture.service.runJob(discovery.jobs[0].id)).toMatchObject({ status: 'awaiting_review', attemptCount: 0 });
    expect(await fs.access(unmappedArchive).then(() => true, () => false)).toBe(true);
  }, 60_000);

  it.runIf(process.platform === 'win32')('resumes safely after the first extraction layer completed', async () => {
    fixture = await createFixture();
    const discovery = await discoverStable(fixture);
    const jobId = discovery.jobs[0].id;
    const processingPath = path.join(fixture.processingRoot, String(jobId));
    const levelOne = path.join(processingPath, 'level-1');
    await fs.mkdir(levelOne, { recursive: true });
    await run(sevenZipPath, ['x', '-y', `-p${fixturePassword}`, `-o${levelOne}`, fixture.sourceArchivePath]);
    await fs.writeFile(path.join(processingPath, '.level-1-complete'), new Date().toISOString());
    fixture.database.prepare(
      "UPDATE local_ingest_jobs SET status = 'failed', phase = 'extracting_outer', processing_path = ?, attempt_count = 1 WHERE id = ?"
    ).run(processingPath, jobId);

    const result = await fixture.service.runJob(jobId);
    expect(result).toMatchObject({ status: 'ingested', phase: 'done', cleanupStatus: 'recycled', attemptCount: 2 });
    expect(result.summary).toMatchObject({ innerOriginalName: '007.7zz', innerWorkingName: '007.7z' });
    expect((await fs.readdir(result.targetPath!))).toEqual(['cover.jpg']);
  }, 60_000);

  it.runIf(process.platform === 'win32')('resumes safely after both extraction layers completed', async () => {
    fixture = await createFixture();
    const discovery = await discoverStable(fixture);
    const jobId = discovery.jobs[0].id;
    const processingPath = path.join(fixture.processingRoot, String(jobId));
    const levelOne = path.join(processingPath, 'level-1');
    const levelTwo = path.join(processingPath, 'level-2');
    await Promise.all([levelOne, levelTwo].map((directory) => fs.mkdir(directory, { recursive: true })));
    await run(sevenZipPath, ['x', '-y', `-p${fixturePassword}`, `-o${levelOne}`, fixture.sourceArchivePath]);
    const innerOriginal = path.join(levelOne, '007.7zz');
    const innerWorking = path.join(levelOne, '007.7z');
    await fs.rename(innerOriginal, innerWorking);
    await run(sevenZipPath, ['x', '-y', `-p${fixturePassword}`, `-o${levelTwo}`, innerWorking]);
    await fs.writeFile(path.join(processingPath, '.level-1-complete'), new Date().toISOString());
    await fs.writeFile(path.join(processingPath, '.level-2-complete'), new Date().toISOString());
    fixture.database.prepare(
      `UPDATE local_ingest_jobs
       SET status = 'failed', phase = 'extracting_inner', processing_path = ?, attempt_count = 1,
           summary_json = '{"levelOneOutput":["007.7zz","outer-note.html"],"innerOriginalName":"007.7zz","innerWorkingName":"007.7z"}'
       WHERE id = ?`
    ).run(processingPath, jobId);

    const result = await fixture.service.runJob(jobId);
    expect(result).toMatchObject({ status: 'ingested', phase: 'done', cleanupStatus: 'recycled', attemptCount: 2 });
    expect(result.summary).toMatchObject({ imageCount: 1, innerOriginalName: '007.7zz', innerWorkingName: '007.7z' });
    expect((await fs.readdir(result.targetPath!))).toEqual(['cover.jpg']);
  }, 60_000);

  it.runIf(process.platform === 'win32')('isolates identical filenames and hashes by creator and exact source work', async () => {
    fixture = await createFixture();
    const secondCreator = 'Creator Beta';
    seedSecondCreator(fixture.database, secondCreator);
    const secondArchive = path.join(fixture.inboxRoot, secondCreator, '007.7z');
    await fs.mkdir(path.dirname(secondArchive), { recursive: true });
    await fs.copyFile(fixture.sourceArchivePath, secondArchive);
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(secondArchive, old, old);
    const discovery = await discoverStable(fixture, [fixture.creatorName, secondCreator]);
    expect(discovery.createdJobs).toBe(2);
    expect(discovery.jobs.map((job) => [job.creatorName, job.sourceWorkId, job.archiveDownloadTaskId])).toEqual([
      [fixture.creatorName, 1, 1],
      [secondCreator, 3, 3]
    ]);
  }, 60_000);

  it.runIf(process.platform === 'win32')('stops for review when the first layer contains multiple inner archives', async () => {
    fixture = await createFixture({ innerCount: 2 });
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'INNER_ARCHIVE_AMBIGUOUS' });
    expect(await fs.access(fixture.sourceArchivePath).then(() => true, () => false)).toBe(true);
  }, 60_000);

  it.runIf(process.platform === 'win32')('keeps unknown binaries out of the gallery and requests review', async () => {
    fixture = await createFixture({ includeUnknown: true });
    const discovery = await discoverStable(fixture);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'UNKNOWN_FILE_TYPE' });
    expect(await fs.readdir(path.join(fixture.libraryRoot, fixture.creatorName)).catch(() => [])).toEqual([]);
  }, 60_000);

  it.runIf(process.platform === 'win32')('reports a password error without persisting the configured secret', async () => {
    fixture = await createFixture({ password: fixturePassword });
    const wrongSettings = {
      get: () => ({
        libraryRoot: fixture!.libraryRoot,
        inboxRoot: fixture!.inboxRoot,
        processingRoot: fixture!.processingRoot,
        sevenZipPath,
        fileStableSeconds: 1,
        recycleAfterIngest: true,
        maxExtractionDepth: 2 as const,
        allowlist: [fixture!.creatorName],
        archivePasswordConfigured: true
      }),
      getArchivePassword: () => 'definitely-wrong-password'
    } as unknown as LocalIngestSettingsService;
    const sourceStats = await fs.stat(fixture.sourceArchivePath);
    const observedAt = new Date(Date.now() - 2_000).toISOString();
    fixture.database.prepare(
      `INSERT INTO local_ingest_file_observations (
         source_archive_path, creator_id, source_archive_name, observed_size,
         observed_mtime, stable_since, last_observed_at
       ) VALUES (?, 1, '007.7z', ?, ?, ?, ?)`
    ).run(fixture.sourceArchivePath, sourceStats.size, sourceStats.mtimeMs, observedAt, observedAt);
    const service = new LocalIngestService(
      fixture.database,
      wrongSettings,
      {} as RecycleBinAdapter,
      async () => undefined,
      { expectedGalleryRoot: fixture.libraryRoot }
    );
    const discovery = await service.scanInbox([fixture.creatorName]);
    const result = await service.runJob(discovery.jobs[0].id);
    expect(result.status).toBe('failed');
    expect(['PASSWORD_INVALID', 'ARCHIVE_CORRUPT']).toContain(result.errorCode);
    expect(JSON.stringify(result)).not.toContain('definitely-wrong-password');
  }, 60_000);
});
