import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import {
  LocalIngestService,
  type LocalIngestRuntimeDependencies
} from '../src/services/local-ingest-service.js';
import { LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';
import type { RecycleBinAdapter } from '../src/services/recycle-bin-adapter.js';
import {
  assertLocalIngestRootPolicy,
  assertLocalIngestRootPolicySync
} from '../src/utils/local-ingest-paths.js';
import { runProcessWithTimeout } from '../src/utils/run-process.js';

type CommandCounts = { list: number; test: number; outer: number; inner: number };

type CommonFixture = {
  root: string;
  libraryRoot: string;
  inboxRoot: string;
  processingRoot: string;
  creatorName: string;
  sourcePath: string;
  database: DatabaseSync;
  service: LocalIngestService;
  settings: ReturnType<typeof makeSettings>;
  advance: (milliseconds: number) => void;
  commandCounts: CommandCounts;
  recycleCalls: string[];
  rescanCalls: () => number;
};

const roots: string[] = [];

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function seedLedger(database: DatabaseSync, creatorName: string): void {
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
     ) VALUES (1, 1, 'costuan', 'collection-1', 'Fixture', ?, 1, ?, ?)`
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
     ) VALUES (1, 1, 1, 'costuan', 'work-007', 7, 'NO.007', ?, ?, '1P-1MB', 1, ?, ?)`
  ).run(`${creatorName} NO.007 Sample`, `${creatorName} NO.007 Sample [1P-1MB]`, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_download_tasks (
       id, source_work_id, provider, target_root, target_relative_directory,
       target_filename, status, created_at, updated_at
     ) VALUES (1, 1, 'baidu', 'inbox', ?, '007.7z', 'staged', ?, ?)`
  ).run(creatorName, now, now);
}

function makeSettings(libraryRoot: string, inboxRoot: string, processingRoot: string, creatorName: string) {
  return {
    get: () => ({
      libraryRoot,
      inboxRoot,
      processingRoot,
      sevenZipPath: 'synthetic-7z',
      fileStableSeconds: 1,
      recycleAfterIngest: false,
      maxExtractionDepth: 2 as const,
      allowlist: [creatorName],
      archivePasswordConfigured: true
    }),
    getArchivePassword: () => 'synthetic-password'
  } as unknown as LocalIngestSettingsService;
}

async function createFixture(options: {
  hashFile?: LocalIngestRuntimeDependencies['hashFile'];
  runCommand?: LocalIngestRuntimeDependencies['runCommand'];
  recycleAfterIngest?: boolean;
  recycle?: (targetPath: string) => Promise<{ targetPath: string; recycled: boolean }>;
} = {}): Promise<CommonFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-hardening-'));
  roots.push(root);
  const libraryRoot = path.join(root, 'library');
  const inboxRoot = path.join(root, 'inbox');
  const processingRoot = path.join(root, 'processing');
  const creatorName = 'Creator Alpha';
  await Promise.all([libraryRoot, inboxRoot, processingRoot].map((directory) => fs.mkdir(directory, { recursive: true })));
  const sourcePath = path.join(inboxRoot, creatorName, '007.7z');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, 'synthetic outer archive');
  const database = new DatabaseSync(':memory:');
  database.exec(schemaSql);
  seedLedger(database, creatorName);
  const settings = makeSettings(libraryRoot, inboxRoot, processingRoot, creatorName);
  if (options.recycleAfterIngest !== undefined) {
    const originalGet = settings.get.bind(settings);
    settings.get = () => ({ ...originalGet(), recycleAfterIngest: options.recycleAfterIngest! });
  }
  let clock = Date.now();
  let rescans = 0;
  const commandCounts: CommandCounts = { list: 0, test: 0, outer: 0, inner: 0 };
  const syntheticCommand = options.runCommand ?? (async (_command, args) => {
    const action = args[0];
    if (action === 'l') {
      commandCounts.list += 1;
      return { code: 0, stdout: '----------\nPath = safe-entry', stderr: '' };
    }
    if (action === 't') {
      commandCounts.test += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { code: 0, stdout: '', stderr: '' };
    }
    const outputArgument = args.find((argument) => argument.startsWith('-o'));
    if (!outputArgument) throw new Error('Synthetic extraction is missing an output path');
    const output = outputArgument.slice(2);
    await fs.mkdir(output, { recursive: true });
    if (output.endsWith('level-1')) {
      commandCounts.outer += 1;
      await fs.writeFile(path.join(output, '007.7zz'), 'synthetic inner archive');
    } else {
      commandCounts.inner += 1;
      await sharp({ create: { width: 4, height: 4, channels: 3, background: '#778899' } })
        .jpeg()
        .toFile(path.join(output, 'cover.jpg'));
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { code: 0, stdout: '', stderr: '' };
  });
  const recycleCalls: string[] = [];
  const recycle = {
    recycle: options.recycle ?? (async (targetPath: string) => {
      recycleCalls.push(targetPath);
      await fs.rm(targetPath, { recursive: true, force: true });
      return { targetPath, recycled: true };
    }),
    smokeTest: async () => ({ targetPath: '', recycled: true })
  } as unknown as RecycleBinAdapter;
  const rescan = async (db: DatabaseSync) => {
    rescans += 1;
    const now = new Date().toISOString();
    const target = db.prepare('SELECT target_path FROM local_ingest_jobs WHERE id = 1').get() as { target_path: string };
    db.prepare(
      `INSERT OR IGNORE INTO archive_catalog_local_creator_folders (
         id, creator_id, root_path, relative_path, absolute_path, folder_name,
         match_status, match_method, is_active, scanned_at, created_at, updated_at
       ) VALUES (1, 1, ?, ?, ?, ?, 'matched', 'synthetic', 1, ?, ?, ?)`
    ).run(libraryRoot, creatorName, path.join(libraryRoot, creatorName), creatorName, now, now, now);
    db.prepare(
      `INSERT OR IGNORE INTO archive_catalog_local_works (
         id, local_creator_folder_id, work_id, relative_path, absolute_path,
         folder_name, parsed_source_order, image_count, video_count,
         advertisement_file_count, other_file_count, total_bytes, match_status,
         match_method, is_active, scanned_at, created_at, updated_at
       ) VALUES (1, 1, 1, ?, ?, ?, 7, 1, 0, 0, 0, 1, 'matched', 'synthetic', 1, ?, ?, ?)`
    ).run(path.relative(libraryRoot, target.target_path), target.target_path, path.basename(target.target_path), now, now, now);
    db.prepare("UPDATE archive_catalog_download_tasks SET status = 'ingested' WHERE id = 1").run();
  };
  const service = new LocalIngestService(database, settings, recycle, rescan, {
    now: () => new Date(clock),
    hashFile: options.hashFile,
    runCommand: syntheticCommand,
    expectedGalleryRoot: libraryRoot,
    claimLeaseMs: 1_000
  });
  return {
    root,
    libraryRoot,
    inboxRoot,
    processingRoot,
    creatorName,
    sourcePath,
    database,
    service,
    settings,
    advance(milliseconds) { clock += milliseconds; },
    commandCounts,
    recycleCalls,
    rescanCalls: () => rescans
  };
}

async function discoverStable(fixture: CommonFixture) {
  await fixture.service.scanInbox();
  fixture.advance(1_100);
  return fixture.service.scanInbox();
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

describe.sequential('LocalIngest cross-platform hardening', () => {
  it('does not hash until two unchanged observations span the stability window', async () => {
    let hashCalls = 0;
    const fixture = await createFixture({
      hashFile: async (filePath) => {
        hashCalls += 1;
        return digest(await fs.readFile(filePath));
      }
    });
    const first = await fixture.service.scanInbox();
    expect(first).toMatchObject({ waitingStable: 1, createdJobs: 0 });
    expect(hashCalls).toBe(0);

    fixture.advance(1_100);
    await fs.appendFile(fixture.sourcePath, '-still-growing');
    const changed = await fixture.service.scanInbox();
    expect(changed).toMatchObject({ waitingStable: 1, createdJobs: 0 });
    expect(hashCalls).toBe(0);

    fixture.advance(1_100);
    const stable = await fixture.service.scanInbox();
    expect(stable).toMatchObject({ waitingStable: 0, createdJobs: 1 });
    expect(hashCalls).toBe(1);
    fixture.database.close();
  });

  it('discards a hash when the file changes during hashing and creates only one eventual job', async () => {
    let hashCalls = 0;
    let mutate = true;
    const fixture = await createFixture({
      hashFile: async (filePath) => {
        hashCalls += 1;
        const before = await fs.readFile(filePath);
        if (mutate) {
          mutate = false;
          await fs.appendFile(filePath, '-changed-during-hash');
        }
        return digest(before);
      }
    });
    await fixture.service.scanInbox();
    fixture.advance(1_100);
    const discarded = await fixture.service.scanInbox();
    expect(discarded).toMatchObject({ waitingStable: 1, createdJobs: 0 });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get()).toEqual({ count: 0 });
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get())
      .toEqual({ status: 'staged' });

    fixture.advance(1_100);
    const completed = await fixture.service.scanInbox();
    expect(completed.createdJobs).toBe(1);
    expect(completed.reconciledDownloadedTasks).toBe(1);
    expect(hashCalls).toBe(2);
    expect(fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get())
      .toEqual({ status: 'downloaded' });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get()).toEqual({ count: 1 });
    expect((await fixture.service.scanInbox()).existingJobs).toBe(1);
    fixture.database.close();
  });

  it('resets stability when a related temporary file appears during hashing', async () => {
    let firstHash = true;
    const fixture = await createFixture({
      hashFile: async (filePath) => {
        const value = digest(await fs.readFile(filePath));
        if (firstHash) {
          firstHash = false;
          await fs.writeFile(`${filePath}.crdownload`, 'late temporary file');
        }
        return value;
      }
    });
    await fixture.service.scanInbox();
    fixture.advance(1_100);
    expect(await fixture.service.scanInbox()).toMatchObject({ createdJobs: 0, waitingStable: 1 });
    await fs.rm(`${fixture.sourcePath}.crdownload`);
    await fixture.service.scanInbox();
    fixture.advance(1_100);
    expect(await fixture.service.scanInbox()).toMatchObject({ createdJobs: 1, waitingStable: 0 });
    fixture.database.close();
  });

  it('serializes duplicate runJob calls and increments the attempt only once', async () => {
    const fixture = await createFixture();
    const discovery = await discoverStable(fixture);
    const [first, second] = await Promise.all([
      fixture.service.runJob(discovery.jobs[0].id),
      fixture.service.runJob(discovery.jobs[0].id)
    ]);
    expect(first.status).toBe('ingested');
    expect(second.status).toBe('ingested');
    expect(fixture.commandCounts).toEqual({ list: 2, test: 2, outer: 1, inner: 1 });
    expect(fixture.rescanCalls()).toBe(1);
    expect(first.attemptCount).toBe(1);
    expect(await fs.readdir(path.join(fixture.libraryRoot, fixture.creatorName))).toHaveLength(1);
    fixture.database.close();
  });

  it('uses the database claim when runBatch and runJob race across service instances', async () => {
    const fixture = await createFixture();
    const discovery = await discoverStable(fixture);
    const secondService = new LocalIngestService(
      fixture.database,
      fixture.settings,
      { recycle: vi.fn(), smokeTest: vi.fn() } as unknown as RecycleBinAdapter,
      async () => undefined,
      {
        expectedGalleryRoot: fixture.libraryRoot,
        claimLeaseMs: 1_000,
        runCommand: async () => {
          throw new Error('The losing executor must not start an archive command');
        }
      }
    );
    const [single, batch] = await Promise.all([
      fixture.service.runJob(discovery.jobs[0].id),
      secondService.runBatch({ jobIds: [discovery.jobs[0].id] })
    ]);
    expect(single.status).toBe('ingested');
    expect(batch).toHaveLength(1);
    expect(fixture.commandCounts).toEqual({ list: 2, test: 2, outer: 1, inner: 1 });
    expect(fixture.rescanCalls()).toBe(1);
    expect(fixture.service.getJob(discovery.jobs[0].id).attemptCount).toBe(1);
    fixture.database.close();
  });

  it('recovers stale running phases without rerunning or changing attempts', async () => {
    const fixture = await createFixture();
    const phases = ['testing_outer', 'extracting_outer', 'extracting_inner', 'committing', 'rescanning', 'cleanup'] as const;
    const old = new Date(Date.now() - 10_000).toISOString();
    for (const [index, phase] of phases.entries()) {
      fixture.database.prepare(
        `INSERT INTO local_ingest_jobs (
           creator_id, source_archive_path, source_archive_name, source_archive_size,
           source_archive_mtime, source_archive_sha256, status, phase,
           validation_status, cleanup_status, processing_path, attempt_count,
           claim_token, claimed_at, claim_heartbeat_at, created_at, updated_at
         ) VALUES (1, ?, ?, 1, 1, ?, 'running', ?, 'unknown', 'not_ready', ?, 3, ?, ?, ?, ?, ?)`
      ).run(
        path.join(fixture.inboxRoot, fixture.creatorName, `${index}.7z`),
        `${index}.7z`,
        digest(String(index)),
        phase,
        path.join(fixture.processingRoot, String(index + 10)),
        `claim-${index}`,
        old,
        old,
        old,
        old
      );
    }
    fixture.database.prepare(
      `INSERT INTO local_ingest_jobs (
         creator_id, source_archive_path, source_archive_name, source_archive_size,
         source_archive_mtime, source_archive_sha256, status, phase,
         validation_status, cleanup_status, attempt_count, claim_token,
         claimed_at, claim_heartbeat_at, created_at, updated_at
       ) VALUES (1, ?, 'reconcile.7z', 1, 1, 'RECONCILE', 'reconciling', 'rescanning',
         'passed', 'pending', 1, 'reconcile-claim', ?, ?, ?, ?)`
    ).run(path.join(fixture.inboxRoot, fixture.creatorName, 'reconcile.7z'), old, old, old, old);
    fixture.database.prepare(
      `INSERT INTO local_ingest_jobs (
         creator_id, source_archive_path, source_archive_name, source_archive_size,
         source_archive_mtime, source_archive_sha256, status, phase,
         validation_status, cleanup_status, attempt_count, claim_token,
         claimed_at, claim_heartbeat_at, created_at, updated_at
       ) VALUES (1, ?, 'cleanup.7z', 1, 1, 'CLEANUP', 'ingested', 'cleanup',
         'passed', 'recycling', 1, 'cleanup-claim', ?, ?, ?, ?)`
    ).run(path.join(fixture.inboxRoot, fixture.creatorName, 'cleanup.7z'), old, old, old, old);
    expect(await fixture.service.recoverInterruptedJobs()).toBe(phases.length + 2);
    const rows = fixture.database.prepare(
      "SELECT status, phase, error_code, attempt_count, processing_path FROM local_ingest_jobs WHERE status = 'failed' ORDER BY id"
    ).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(phases.length);
    expect(rows.map((row) => row.phase)).toEqual(phases);
    expect(rows.every((row) => row.error_code === 'INTERRUPTED_PROCESS' && row.attempt_count === 3)).toBe(true);
    expect(fixture.database.prepare("SELECT status, error_code FROM local_ingest_jobs WHERE source_archive_sha256 = 'RECONCILE'").get())
      .toEqual({ status: 'reconciling', error_code: 'INTERRUPTED_PROCESS' });
    expect(fixture.database.prepare("SELECT status, cleanup_status, error_code FROM local_ingest_jobs WHERE source_archive_sha256 = 'CLEANUP'").get())
      .toEqual({ status: 'ingested', cleanup_status: 'failed', error_code: 'INTERRUPTED_PROCESS' });
    expect(fixture.commandCounts).toEqual({ list: 0, test: 0, outer: 0, inner: 0 });
    fixture.database.close();
  });

  it('rejects a database-replaced source path before archive execution', async () => {
    const fixture = await createFixture();
    const discovery = await discoverStable(fixture);
    const outside = path.join(fixture.root, 'outside.7z');
    await fs.writeFile(outside, 'outside');
    fixture.database.prepare('UPDATE local_ingest_jobs SET source_archive_path = ? WHERE id = ?').run(outside, discovery.jobs[0].id);
    const result = await fixture.service.runJob(discovery.jobs[0].id);
    expect(result).toMatchObject({ status: 'awaiting_review', errorCode: 'SOURCE_PATH_OUTSIDE_ALLOWED_ROOT', attemptCount: 0 });
    expect(fixture.commandCounts).toEqual({ list: 0, test: 0, outer: 0, inner: 0 });
    fixture.database.close();
  });

  it('rejects target and processing path escapes before writing or rescanning', async () => {
    const fixture = await createFixture();
    const discovery = await discoverStable(fixture);
    const outsideProcessing = path.join(fixture.root, 'outside-processing');
    await fs.mkdir(outsideProcessing);
    fixture.database.prepare('UPDATE local_ingest_jobs SET processing_path = ? WHERE id = ?').run(outsideProcessing, discovery.jobs[0].id);
    const processingResult = await fixture.service.runJob(discovery.jobs[0].id);
    expect(processingResult).toMatchObject({ status: 'awaiting_review', errorCode: 'PROCESSING_PATH_OUTSIDE_ALLOWED_ROOT', attemptCount: 0 });

    const outsideTarget = path.join(fixture.root, 'outside-target');
    await fs.mkdir(outsideTarget);
    fixture.database.prepare(
      "UPDATE local_ingest_jobs SET status = 'reconciling', phase = 'reconciling', target_path = ?, processing_path = NULL, error_code = NULL WHERE id = ?"
    ).run(outsideTarget, discovery.jobs[0].id);
    await expect(fixture.service.runJob(discovery.jobs[0].id)).rejects.toThrow(/outside its allowed root/i);
    expect(fixture.rescanCalls()).toBe(0);
    fixture.database.close();
  });

  it('marks unsafe recycle paths failed and never calls the recycle adapter', async () => {
    const fixture = await createFixture({ recycleAfterIngest: true });
    const discovery = await discoverStable(fixture);
    const outside = path.join(fixture.root, 'outside-source.7z');
    await fs.writeFile(outside, 'must remain');
    fixture.database.prepare(
      "UPDATE local_ingest_jobs SET status = 'ingested', phase = 'cleanup', cleanup_status = 'pending', source_archive_path = ? WHERE id = ?"
    ).run(outside, discovery.jobs[0].id);
    const result = await fixture.service.retryCleanup(discovery.jobs[0].id);
    expect(result).toMatchObject({ cleanupStatus: 'failed', errorCode: 'RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT' });
    expect(fixture.recycleCalls).toEqual([]);
    expect(await fs.readFile(outside, 'utf8')).toBe('must remain');
    fixture.database.close();
  });

  it('does not permanently delete when the recycle adapter fails', async () => {
    const fixture = await createFixture({
      recycleAfterIngest: true,
      recycle: async () => { throw new Error('synthetic recycle failure'); }
    });
    const discovery = await discoverStable(fixture);
    fixture.database.prepare(
      "UPDATE local_ingest_jobs SET status = 'ingested', phase = 'cleanup', cleanup_status = 'pending' WHERE id = ?"
    ).run(discovery.jobs[0].id);
    const result = await fixture.service.retryCleanup(discovery.jobs[0].id);
    expect(result).toMatchObject({ cleanupStatus: 'failed', errorCode: 'RECYCLE_FAILED' });
    await expect(fs.access(fixture.sourcePath)).resolves.toBeUndefined();
    fixture.database.close();
  });
});

describe.sequential('LocalIngest root and process boundaries', () => {
  it('rejects a saved libraryRoot that differs from the scanner GALLERY_ROOT', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-settings-'));
    roots.push(root);
    const expected = path.join(root, 'library');
    const other = path.join(root, 'other-library');
    const inbox = path.join(root, 'inbox');
    const processing = path.join(root, 'processing');
    await Promise.all([expected, other, inbox, processing].map((directory) => fs.mkdir(directory)));
    const service = new LocalIngestSettingsService(expected);
    expect(() => service.save({
      libraryRoot: other,
      inboxRoot: inbox,
      processingRoot: processing,
      sevenZipPath: '7z',
      fileStableSeconds: 5,
      recycleAfterIngest: true,
      maxExtractionDepth: 2,
      allowlist: []
    })).toThrow(/must match the GALLERY_ROOT/i);
  });

  it('preserves a legacy quarantineRoot without exposing or validating it in V1', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-legacy-quarantine-'));
    roots.push(root);
    const library = path.join(root, 'library');
    const inbox = path.join(root, 'inbox');
    const processing = path.join(root, 'processing');
    await Promise.all([library, inbox, processing].map((directory) => fs.mkdir(directory)));
    const values = new Map<string, string>([
      ['local_ingest.settings', JSON.stringify({
        libraryRoot: library,
        inboxRoot: inbox,
        processingRoot: processing,
        quarantineRoot: 'G:\\legacy-quarantine-do-not-touch',
        sevenZipPath: '7z',
        fileStableSeconds: 5,
        recycleAfterIngest: true,
        maxExtractionDepth: 2
      })],
      ['local_ingest.allowlist', '[]']
    ]);
    const repository = {
      get: (key: string) => values.get(key) ?? null,
      setMany: (entries: Array<{ key: string; value: string }>) => {
        for (const entry of entries) values.set(entry.key, entry.value);
      }
    };
    const service = new LocalIngestSettingsService(library, repository);
    const view = service.save({
      libraryRoot: library,
      inboxRoot: inbox,
      processingRoot: processing,
      sevenZipPath: '7z',
      fileStableSeconds: 10,
      recycleAfterIngest: true,
      maxExtractionDepth: 2,
      allowlist: []
    });
    expect(view).not.toHaveProperty('quarantineRoot');
    expect(JSON.parse(values.get('local_ingest.settings')!)).toMatchObject({
      fileStableSeconds: 10,
      quarantineRoot: 'G:\\legacy-quarantine-do-not-touch'
    });
  });

  it('rejects equal, nested, and non-absolute roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-roots-'));
    roots.push(root);
    const library = path.join(root, 'library');
    const inbox = path.join(root, 'inbox');
    const processing = path.join(root, 'processing');
    await Promise.all([library, inbox, processing].map((directory) => fs.mkdir(directory)));
    expect(() => assertLocalIngestRootPolicySync({
      libraryRoot: library,
      inboxRoot: library,
      processingRoot: processing
    }, library)).toThrow(/non-overlapping/i);
    expect(() => assertLocalIngestRootPolicySync({
      libraryRoot: library,
      inboxRoot: path.join(library, 'inbox'),
      processingRoot: processing
    }, library)).toThrow(/non-overlapping/i);
    expect(() => assertLocalIngestRootPolicySync({
      libraryRoot: library,
      inboxRoot: inbox,
      processingRoot: path.join(library, 'processing')
    }, library)).toThrow(/non-overlapping/i);
    const nestedLibrary = path.join(inbox, 'library');
    expect(() => assertLocalIngestRootPolicySync({
      libraryRoot: nestedLibrary,
      inboxRoot: inbox,
      processingRoot: processing
    }, nestedLibrary)).toThrow(/non-overlapping/i);
    expect(() => assertLocalIngestRootPolicySync({
      libraryRoot: library,
      inboxRoot: 'relative-inbox',
      processingRoot: processing
    }, library)).toThrow(/absolute path/i);
  });

  it('refuses discovery when the ingest write root could split from the scanner root', async () => {
    const fixture = await createFixture();
    const otherLibrary = path.join(fixture.root, 'other-library');
    await fs.mkdir(otherLibrary);
    const splitSettings = makeSettings(otherLibrary, fixture.inboxRoot, fixture.processingRoot, fixture.creatorName);
    const service = new LocalIngestService(
      fixture.database,
      splitSettings,
      {} as RecycleBinAdapter,
      async () => undefined,
      { expectedGalleryRoot: fixture.libraryRoot }
    );
    await expect(service.scanInbox()).rejects.toThrow(/must match the GALLERY_ROOT/i);
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get()).toEqual({ count: 0 });
    fixture.database.close();
  });

  it('rejects a creator name containing path characters before creating a target', async () => {
    const fixture = await createFixture();
    fixture.database.prepare("UPDATE archive_catalog_creators SET canonical_name = '../escape' WHERE id = 1").run();
    await fixture.service.scanInbox();
    fixture.advance(1_100);
    await expect(fixture.service.scanInbox()).rejects.toThrow(/reserved filename characters/i);
    await expect(fs.access(path.join(fixture.root, 'escape'))).rejects.toThrow();
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get()).toEqual({ count: 0 });
    fixture.database.close();
  });

  it('uses real paths so a junction or symlink cannot point the inbox into the library', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-links-'));
    roots.push(root);
    const library = path.join(root, 'library');
    const processing = path.join(root, 'processing');
    const linkedInbox = path.join(root, 'linked-inbox');
    await Promise.all([library, processing].map((directory) => fs.mkdir(directory)));
    await fs.symlink(library, linkedInbox, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertLocalIngestRootPolicy({
      libraryRoot: library,
      inboxRoot: linkedInbox,
      processingRoot: processing
    }, library)).rejects.toThrow(/non-overlapping/i);
  });

  it('terminates a timed-out process tree and stops descendant writes before returning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-process-tree-'));
    roots.push(root);
    const output = path.join(root, 'writes.log');
    const childScript = path.join(root, 'child.mjs');
    const parentScript = path.join(root, 'parent.mjs');
    await fs.writeFile(childScript, `
      import fs from 'node:fs';
      const target = process.argv[2];
      fs.appendFileSync(target, 'start\\n');
      setInterval(() => fs.appendFileSync(target, 'tick\\n'), 25);
    `);
    await fs.writeFile(parentScript, `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });
      child.unref();
      setInterval(() => {}, 1000);
    `);
    await expect(runProcessWithTimeout(process.execPath, [parentScript, childScript, output], 600)).rejects.toThrow(/timed out/i);
    const sizeAfterTimeout = (await fs.stat(output)).size;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await fs.stat(output)).size).toBe(sizeAfterTimeout);
    await expect(runProcessWithTimeout(process.execPath, ['-e', 'process.exit(0)'], 2_000)).resolves.toMatchObject({ code: 0 });
  }, 10_000);
});
