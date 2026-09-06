import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import {
  LocalIngestService,
  type LocalIngestManualPlacementInput
} from '../src/services/local-ingest-service.js';
import type { LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';
import type { RecycleBinAdapter } from '../src/services/recycle-bin-adapter.js';

type ManualFixture = {
  root: string;
  libraryRoot: string;
  inboxRoot: string;
  processingRoot: string;
  targetPath: string;
  sourcePath: string;
  database: DatabaseSync;
  service: LocalIngestService;
  input: LocalIngestManualPlacementInput;
  recycleCalls: string[];
  sideEffects: { command: number; rescan: number };
};

function fileHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex').toUpperCase();
}

async function createManualFixture(options: {
  declaredMedia?: string;
  retainedJfif?: boolean;
  existingLocalRelation?: boolean;
} = {}): Promise<ManualFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-manual-placement-'));
  const libraryRoot = path.join(root, 'library');
  const inboxRoot = path.join(root, 'inbox');
  const processingRoot = path.join(root, 'processing');
  const recycleRoot = path.join(root, 'recycle');
  const creatorName = 'Creator Alpha';
  const rawTitle = `${creatorName} NO.007 Sample [${options.declaredMedia ?? '1P-1MB'}]`;
  const targetPath = path.join(libraryRoot, creatorName, rawTitle);
  const sourcePath = path.join(inboxRoot, creatorName, '007.7z');
  const processingPath = path.join(processingRoot, '1');
  await Promise.all([
    fs.mkdir(targetPath, { recursive: true }),
    fs.mkdir(path.dirname(sourcePath), { recursive: true }),
    fs.mkdir(processingPath, { recursive: true }),
    fs.mkdir(recycleRoot, { recursive: true })
  ]);
  await sharp({ create: { width: 4, height: 4, channels: 3, background: '#7851a9' } })
    .jpeg()
    .toFile(path.join(targetPath, 'cover.jpg'));
  if (options.retainedJfif) await fs.writeFile(path.join(targetPath, 'discarded.jfif'), 'still present');
  const sourceContent = Buffer.from('manual-placement-source-fixture');
  await fs.writeFile(sourcePath, sourceContent);
  await fs.writeFile(path.join(processingPath, '.level-2-complete'), 'historical extraction marker');
  const sourceStats = await fs.stat(sourcePath);

  const database = new DatabaseSync(':memory:');
  database.exec(schemaSql);
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO archive_catalog_creators (
       id, canonical_name, normalized_name, preference, effective_rating,
       seed_source, seed_source_creator_id, created_at, updated_at
     ) VALUES (1, ?, 'creatoralpha', 'liked', 'R15', 'test', 'creator-1', ?, ?)`
  ).run(creatorName, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_creator_aliases (
       creator_id, alias, normalized_alias, source, created_at
     ) VALUES (1, ?, 'creatoralpha', 'test', ?)`
  ).run(creatorName, now);
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
  ).run(`${creatorName} NO.007 Sample`, rawTitle, options.declaredMedia ?? '1P-1MB', now, now);
  database.prepare(
    `INSERT INTO archive_catalog_download_tasks (
       id, source_work_id, provider, target_root, target_relative_directory,
       target_filename, status, created_at, updated_at
     ) VALUES (1, 1, 'baidu', ?, ?, '007.7z', 'downloaded', ?, ?)`
  ).run(inboxRoot, creatorName, now, now);
  database.prepare(
    `INSERT INTO archive_catalog_local_creator_folders (
       id, creator_id, root_path, relative_path, absolute_path, folder_name,
       match_status, match_method, is_active, scanned_at, created_at, updated_at
     ) VALUES (1, 1, ?, 'Historical Alias', ?, 'Historical Alias',
       'matched', 'explicit-test-bridge', 1, ?, ?, ?)`
  ).run(libraryRoot, path.join(libraryRoot, 'Historical Alias'), now, now, now);
  database.prepare(
    `INSERT INTO local_ingest_jobs (
       id, archive_download_task_id, source_work_id, creator_id,
       source_archive_path, source_archive_name, source_archive_size,
       source_archive_mtime, source_archive_sha256, status, phase,
       validation_status, cleanup_status, processing_path, target_path,
       attempt_count, error_code, error_detail, summary_json, created_at, updated_at
     ) VALUES (1, 1, 1, 1, ?, '007.7z', ?, ?, ?, 'awaiting_review', 'validating',
       'failed', 'not_ready', ?, ?, 1, 'UNKNOWN_FILE_TYPE',
       'Unknown files require review: discarded.jfif', ?, ?, ?)`
  ).run(
    sourcePath,
    sourceStats.size,
    sourceStats.mtimeMs,
    fileHash(sourceContent),
    processingPath,
    targetPath,
    JSON.stringify({ levelOneOutput: ['007.7zz'], innerOriginalName: '007.7zz', innerWorkingName: '007.7z' }),
    now,
    now
  );
  if (options.existingLocalRelation) {
    database.prepare(
      `INSERT INTO archive_catalog_local_creator_folders (
         id, creator_id, root_path, relative_path, absolute_path, folder_name,
         match_status, match_method, is_active, scanned_at, created_at, updated_at
       ) VALUES (2, 1, ?, ?, ?, ?, 'matched', 'prior-scan', 1, ?, ?, ?)`
    ).run(libraryRoot, creatorName, path.join(libraryRoot, creatorName), creatorName, now, now, now);
    database.prepare(
      `INSERT INTO archive_catalog_local_works (
         id, local_creator_folder_id, work_id, relative_path, absolute_path,
         folder_name, parsed_source_order, image_count, video_count,
         advertisement_file_count, other_file_count, total_bytes, match_status,
         match_method, is_active, scanned_at, created_at, updated_at
       ) VALUES (1, 2, 1, ?, ?, ?, 7, 1, 0, 0, 0, 1,
         'matched', 'prior-scan', 1, ?, ?, ?)`
    ).run(
      path.relative(path.join(libraryRoot, creatorName), targetPath),
      targetPath,
      path.basename(targetPath),
      now,
      now,
      now
    );
  }

  const settings = {
    get: () => ({
      libraryRoot,
      inboxRoot,
      processingRoot,
      quarantineRoot: path.join(root, 'unused-quarantine'),
      sevenZipPath: 'unused-7z',
      fileStableSeconds: 1,
      recycleAfterIngest: true,
      maxExtractionDepth: 2 as const,
      allowlist: [creatorName],
      archivePasswordConfigured: true
    }),
    getArchivePassword: () => 'unused-password'
  } as unknown as LocalIngestSettingsService;
  const recycleCalls: string[] = [];
  const recycle = {
    recycle: async (target: string) => {
      recycleCalls.push(target);
      await fs.rename(target, path.join(recycleRoot, `${path.basename(target)}-${recycleCalls.length}`));
      return { targetPath: target, recycled: true };
    },
    smokeTest: async () => ({ targetPath: '', recycled: true })
  } as unknown as RecycleBinAdapter;
  const sideEffects = { command: 0, rescan: 0 };
  const rescan = async (db: DatabaseSync) => {
    sideEffects.rescan += 1;
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO archive_catalog_local_creator_folders (
         id, creator_id, root_path, relative_path, absolute_path, folder_name,
         match_status, match_method, is_active, scanned_at, created_at, updated_at
       ) VALUES (2, 1, ?, ?, ?, ?, 'matched', 'manual-placement-test', 1, ?, ?, ?)`
    ).run(libraryRoot, creatorName, path.join(libraryRoot, creatorName), creatorName, timestamp, timestamp, timestamp);
    db.prepare(
      `INSERT OR IGNORE INTO archive_catalog_local_works (
         id, local_creator_folder_id, work_id, relative_path, absolute_path,
         folder_name, parsed_source_order, image_count, video_count,
         advertisement_file_count, other_file_count, total_bytes, match_status,
         match_method, is_active, scanned_at, created_at, updated_at
       ) VALUES (1, 2, 1, ?, ?, ?, 7, 1, 0, 0, 0, 1,
         'matched', 'manual-placement-test', 1, ?, ?, ?)`
    ).run(
      path.relative(path.join(libraryRoot, creatorName), targetPath),
      targetPath,
      path.basename(targetPath),
      timestamp,
      timestamp,
      timestamp
    );
    db.prepare("UPDATE archive_catalog_download_tasks SET status = 'ingested' WHERE id = 1").run();
  };
  const service = new LocalIngestService(database, settings, recycle, rescan, {
    expectedGalleryRoot: libraryRoot,
    hashFile: async (filePath) => fileHash(await fs.readFile(filePath)),
    runCommand: async () => {
      sideEffects.command += 1;
      throw new Error('Archive tooling must not run while adopting a manual placement');
    }
  });
  return {
    root,
    libraryRoot,
    inboxRoot,
    processingRoot,
    targetPath,
    sourcePath,
    database,
    service,
    input: {
      jobId: 1,
      expectedCreatorId: 1,
      expectedSourceWorkId: 1,
      expectedDownloadTaskId: 1,
      expectedTargetPath: targetPath,
      removedUnknownFiles: ['discarded.jfif'],
      note: 'User manually placed the retained media after intentionally removing the unsupported JFIF file.'
    },
    recycleCalls,
    sideEffects
  };
}

describe.sequential('LocalIngestService manual placement adoption', () => {
  let fixture: ManualFixture | null = null;

  afterEach(async () => {
    fixture?.database.close();
    if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
    fixture = null;
  });

  it('validates, reconciles, and recycles an exact manual placement without extraction or target writes', async () => {
    fixture = await createManualFixture({ declaredMedia: '2P1V-1MB' });
    const targetBefore = await fs.readFile(path.join(fixture.targetPath, 'cover.jpg'));

    const result = await fixture.service.adoptManualPlacement(fixture.input);

    expect(result).toMatchObject({
      id: 1,
      status: 'ingested',
      phase: 'done',
      validationStatus: 'warning',
      cleanupStatus: 'recycled',
      attemptCount: 1,
      errorCode: null
    });
    expect(result.summary).toMatchObject({
      imageCount: 1,
      videoCount: 0,
      totalMediaCount: 1,
      sourceReconciled: true,
      missingDifferenceCleared: true,
      sourceArchiveRecycled: true,
      processingDirectoryRecycled: true,
      manualPlacement: {
        removedUnknownFiles: ['discarded.jfif'],
        removedUnknownFileCount: 1,
        previousErrorCode: 'UNKNOWN_FILE_TYPE',
        extractionReused: false,
        targetCommitPerformed: false
      }
    });
    expect((result.summary?.warnings as string[]).join('\n')).toContain('Declared 2 images; retained 1');
    expect((result.summary?.warnings as string[]).join('\n')).toContain('Declared 1 videos; retained 0');
    expect(fixture.sideEffects).toEqual({ command: 0, rescan: 1 });
    expect(fixture.recycleCalls).toEqual([fixture.sourcePath, path.join(fixture.processingRoot, '1')]);
    expect(await fs.readFile(path.join(fixture.targetPath, 'cover.jpg'))).toEqual(targetBefore);
    expect((fixture.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = 1').get() as { status: string }).status).toBe('ingested');
    expect((fixture.database.prepare("SELECT is_active FROM archive_catalog_local_creator_folders WHERE relative_path = 'Historical Alias'").get() as { is_active: number }).is_active).toBe(1);

    const repeated = await fixture.service.adoptManualPlacement(fixture.input);
    expect(repeated).toMatchObject({ status: 'ingested', phase: 'done', attemptCount: 1 });
    expect(fixture.sideEffects).toEqual({ command: 0, rescan: 1 });
    expect(fixture.recycleCalls).toHaveLength(2);
    expect((fixture.database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_local_works').get() as { count: number }).count).toBe(1);
  });

  it('preserves the review job and all files when removed-file evidence does not match', async () => {
    fixture = await createManualFixture();
    const mismatched = { ...fixture.input, removedUnknownFiles: ['different.jfif'] };

    await expect(fixture.service.adoptManualPlacement(mismatched)).rejects.toThrow('does not exactly match');

    expect(fixture.service.getJob(1)).toMatchObject({
      status: 'awaiting_review',
      phase: 'validating',
      validationStatus: 'failed',
      cleanupStatus: 'not_ready',
      attemptCount: 1,
      errorCode: 'UNKNOWN_FILE_TYPE',
      errorDetail: 'Unknown files require review: discarded.jfif'
    });
    expect(fixture.sideEffects).toEqual({ command: 0, rescan: 0 });
    expect(fixture.recycleCalls).toHaveLength(0);
    await expect(fs.access(fixture.sourcePath)).resolves.toBeUndefined();
    await expect(fs.access(path.join(fixture.processingRoot, '1'))).resolves.toBeUndefined();
    await expect(fs.access(fixture.targetPath)).resolves.toBeUndefined();
  });

  it('reuses an exact local relationship created by an earlier scoped scan', async () => {
    fixture = await createManualFixture({ existingLocalRelation: true });

    const result = await fixture.service.adoptManualPlacement(fixture.input);

    expect(result).toMatchObject({ status: 'ingested', phase: 'done', attemptCount: 1 });
    expect(result.summary).toMatchObject({ localWorkId: 1, sourceReconciled: true });
    expect((fixture.database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_local_works').get() as { count: number }).count).toBe(1);
    expect(fixture.sideEffects).toEqual({ command: 0, rescan: 1 });
  });

  it('fails closed when a file recorded as removed still remains in the formal target', async () => {
    fixture = await createManualFixture({ retainedJfif: true });

    await expect(fixture.service.adoptManualPlacement(fixture.input)).rejects.toThrow('still contains non-media files');

    expect(fixture.service.getJob(1)).toMatchObject({
      status: 'awaiting_review',
      phase: 'validating',
      validationStatus: 'failed',
      attemptCount: 1,
      errorCode: 'UNKNOWN_FILE_TYPE'
    });
    expect(fixture.sideEffects).toEqual({ command: 0, rescan: 0 });
    expect(fixture.recycleCalls).toHaveLength(0);
  });

  it('rejects a target outside the mapped creator directory without scanning or cleanup', async () => {
    fixture = await createManualFixture();
    const wrongTarget = path.join(fixture.libraryRoot, 'Creator Alpha', 'wrong-title');
    await fs.mkdir(wrongTarget, { recursive: true });

    await expect(fixture.service.adoptManualPlacement({
      ...fixture.input,
      expectedTargetPath: wrongTarget
    })).rejects.toThrow('does not exactly match');

    expect(fixture.service.getJob(1)).toMatchObject({ status: 'awaiting_review', errorCode: 'UNKNOWN_FILE_TYPE' });
    expect(fixture.sideEffects).toEqual({ command: 0, rescan: 0 });
    expect(fixture.recycleCalls).toHaveLength(0);
  });
});
