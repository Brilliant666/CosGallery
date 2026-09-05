import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import { LocalIngestService } from '../src/services/local-ingest-service.js';
import { LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';
import type { RecycleBinAdapter } from '../src/services/recycle-bin-adapter.js';

type DiscoveryFixture = {
  root: string;
  libraryRoot: string;
  inboxRoot: string;
  processingRoot: string;
  database: DatabaseSync;
  service: LocalIngestService;
  sideEffects: { hash: number; command: number; recycle: number; reconcile: number };
};

const roots: string[] = [];

function insertCreator(database: DatabaseSync, id: number, name: string): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO archive_catalog_creators (
       id, canonical_name, normalized_name, preference, effective_rating,
       seed_source, seed_source_creator_id, created_at, updated_at
     ) VALUES (?, ?, ?, 'liked', 'R15', 'test', ?, ?, ?)`
  ).run(id, name, name.toLocaleLowerCase().replace(/[\s_\-@·・.]+/gu, ''), `creator-${id}`, now, now);
}

function insertAlias(database: DatabaseSync, creatorId: number, alias: string, source: string): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO archive_catalog_creator_aliases (
       creator_id, alias, normalized_alias, source, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(creatorId, alias, alias.toLocaleLowerCase().replace(/[\s_\-@·・.]+/gu, ''), source, now, now);
}

function insertJob(
  database: DatabaseSync,
  id: number,
  creatorId: number,
  sourcePath: string,
  status: 'queued' | 'failed' | 'awaiting_review' | 'ingested'
): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO local_ingest_jobs (
       id, creator_id, source_archive_path, source_archive_name,
       source_archive_size, source_archive_mtime, source_archive_sha256,
       status, phase, validation_status, cleanup_status, attempt_count,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 10, 1000, ?, ?, ?, 'unknown', ?, 0, ?, ?)`
  ).run(
    id,
    creatorId,
    sourcePath,
    path.basename(sourcePath),
    String(id).padStart(64, '0'),
    status,
    status === 'ingested' ? 'done' : 'discovered',
    status === 'ingested' ? 'recycled' : 'not_ready',
    now,
    now
  );
}

async function createDiscoveryFixture(): Promise<DiscoveryFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-inbox-creators-'));
  roots.push(root);
  const libraryRoot = path.join(root, 'library');
  const inboxRoot = path.join(root, 'inbox');
  const processingRoot = path.join(root, 'processing');
  await Promise.all([libraryRoot, inboxRoot, processingRoot].map((directory) => fs.mkdir(directory)));
  const database = new DatabaseSync(':memory:');
  database.exec(schemaSql);
  insertCreator(database, 1, 'Creator Alpha');
  insertCreator(database, 2, 'Creator Beta');
  insertCreator(database, 3, 'Creator Gamma');
  insertAlias(database, 1, 'Alpha Alias', 'fixture-alpha');
  insertAlias(database, 1, 'History Only', 'fixture-history');
  insertAlias(database, 1, 'Linked Creator', 'fixture-link');
  insertAlias(database, 2, 'Beta Queue', 'fixture-beta');
  insertAlias(database, 1, 'Shared Alias', 'fixture-shared-alpha');
  insertAlias(database, 2, 'Shared Alias', 'fixture-shared-beta');

  const directories = [
    'Creator Alpha', 'Alpha Alias', 'Creator Beta', 'Beta Queue', 'Empty',
    'Unknown', 'Shared Alias', 'History Only', 'Nested Only'
  ];
  await Promise.all(directories.map((name) => fs.mkdir(path.join(inboxRoot, name))));
  await Promise.all([
    fs.writeFile(path.join(inboxRoot, 'Creator Alpha', '010.7z'), 'fixture'),
    fs.writeFile(path.join(inboxRoot, 'Alpha Alias', '011.ZIP'), 'fixture'),
    fs.writeFile(path.join(inboxRoot, 'Creator Beta', '012.7zz'), 'fixture'),
    fs.writeFile(path.join(inboxRoot, 'Creator Beta', 'ignored.7z.crdownload'), 'fixture'),
    fs.writeFile(path.join(inboxRoot, 'Unknown', '013.7z'), 'fixture'),
    fs.writeFile(path.join(inboxRoot, 'Shared Alias', '014.7z'), 'fixture')
  ]);
  await fs.mkdir(path.join(inboxRoot, 'Nested Only', 'work'));
  await fs.writeFile(path.join(inboxRoot, 'Nested Only', 'work', 'nested.7z'), 'fixture');
  const linkedTarget = path.join(root, 'linked-target');
  await fs.mkdir(linkedTarget);
  await fs.writeFile(path.join(linkedTarget, '015.7z'), 'fixture');
  await fs.symlink(linkedTarget, path.join(inboxRoot, 'Linked Creator'), process.platform === 'win32' ? 'junction' : 'dir');

  insertJob(database, 1, 2, path.join(inboxRoot, 'Beta Queue', '016.7z'), 'queued');
  insertJob(database, 2, 1, path.join(inboxRoot, 'Alpha Alias', '017.7z'), 'failed');
  insertJob(database, 3, 2, path.join(inboxRoot, 'Creator Beta', '018.7z'), 'awaiting_review');
  insertJob(database, 4, 1, path.join(inboxRoot, 'History Only', '019.7z'), 'ingested');

  const settings = {
    get: () => ({
      libraryRoot,
      inboxRoot,
      processingRoot,
      sevenZipPath: '7z',
      fileStableSeconds: 5,
      recycleAfterIngest: true,
      maxExtractionDepth: 2 as const,
      allowlist: ['Creator Alpha'],
      archivePasswordConfigured: true
    }),
    getArchivePassword: () => 'unused'
  } as unknown as LocalIngestSettingsService;
  const sideEffects = { hash: 0, command: 0, recycle: 0, reconcile: 0 };
  const recycle = {
    recycle: async () => { sideEffects.recycle += 1; throw new Error('must not recycle'); },
    smokeTest: async () => ({ targetPath: '', recycled: true })
  } as unknown as RecycleBinAdapter;
  const service = new LocalIngestService(
    database,
    settings,
    recycle,
    async () => { sideEffects.reconcile += 1; },
    {
      expectedGalleryRoot: libraryRoot,
      hashFile: async () => { sideEffects.hash += 1; throw new Error('must not hash'); },
      runCommand: async () => { sideEffects.command += 1; throw new Error('must not extract'); }
    }
  );
  return { root, libraryRoot, inboxRoot, processingRoot, database, service, sideEffects };
}

afterEach(async () => {
  while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe('LocalIngest pending creator discovery', () => {
  it('finds direct pending folders read-only, maps aliases exactly, and excludes unsafe or empty directories', async () => {
    const fixture = await createDiscoveryFixture();
    const jobsBefore = fixture.database.prepare('SELECT * FROM local_ingest_jobs ORDER BY id').all();
    const observationsBefore = fixture.database.prepare('SELECT * FROM local_ingest_file_observations ORDER BY source_archive_path').all();

    const result = await fixture.service.discoverInboxCreators();

    expect(result.detected.map((entry) => entry.canonicalName)).toEqual(['Creator Alpha', 'Creator Beta']);
    expect(result.detected[0]).toMatchObject({
      folderNames: ['Alpha Alias', 'Creator Alpha'],
      archiveCount: 2,
      failedJobCount: 1
    });
    expect(result.detected[1]).toMatchObject({
      folderNames: ['Beta Queue', 'Creator Beta'],
      archiveCount: 1,
      queuedJobCount: 1,
      awaitingReviewJobCount: 1
    });
    expect(result.unmapped.map((entry) => [entry.folderName, entry.mappingStatus])).toEqual([
      ['Shared Alias', 'ambiguous'],
      ['Unknown', 'unmatched']
    ]);
    expect(result.summary).toEqual({
      directoryCount: 6,
      matchedDirectoryCount: 4,
      matchedCreatorCount: 2,
      unmappedDirectoryCount: 1,
      ambiguousDirectoryCount: 1,
      archiveCount: 5,
      queuedJobCount: 1,
      failedJobCount: 1,
      awaitingReviewJobCount: 1
    });
    expect(result.detected.flatMap((entry) => entry.folderNames)).not.toContain('Linked Creator');
    expect(result.detected.flatMap((entry) => entry.folderNames)).not.toContain('History Only');
    expect(result.unmapped.map((entry) => entry.folderName)).not.toContain('Nested Only');
    expect(fixture.sideEffects).toEqual({ hash: 0, command: 0, recycle: 0, reconcile: 0 });
    expect(fixture.database.prepare('SELECT * FROM local_ingest_jobs ORDER BY id').all()).toEqual(jobsBefore);
    expect(fixture.database.prepare('SELECT * FROM local_ingest_file_observations ORDER BY source_archive_path').all()).toEqual(observationsBefore);
    fixture.database.close();
  });

  it('keeps empty scope closed and runs only queued jobs for uniquely allowlisted creators in serial order', async () => {
    const fixture = await createDiscoveryFixture();
    fixture.database.prepare('DELETE FROM local_ingest_jobs').run();
    insertJob(fixture.database, 5, 1, path.join(fixture.inboxRoot, 'Creator Alpha', '020.7z'), 'queued');
    insertJob(fixture.database, 6, 2, path.join(fixture.inboxRoot, 'Creator Beta', '021.7z'), 'queued');
    insertJob(fixture.database, 7, 3, path.join(fixture.inboxRoot, 'Creator Gamma', '022.7z'), 'queued');

    await expect(fixture.service.scanInbox([])).rejects.toThrow(/allowlist is empty/i);
    const scan = vi.spyOn(fixture.service, 'scanInbox');
    const result = await fixture.service.runBatch({ allowlist: ['Creator Alpha', 'Creator Beta'] });

    expect(scan).not.toHaveBeenCalled();
    expect(result.items.map((entry) => entry.job.id)).toEqual([5, 6]);
    expect(result.items.map((entry) => entry.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(result).toMatchObject({ total: 2, examined: 2, settled: 0, unchanged: 2 });
    expect(fixture.sideEffects).toEqual({ hash: 0, command: 0, recycle: 0, reconcile: 0 });
    fixture.database.close();
  });

  it('runs an explicit creator scope from the complete database set instead of a dashboard page', async () => {
    const fixture = await createDiscoveryFixture();
    fixture.database.prepare('DELETE FROM local_ingest_jobs').run();
    for (let id = 1; id <= 75; id += 1) {
      insertJob(
        fixture.database,
        id,
        id <= 60 ? 1 : 2,
        path.join(fixture.inboxRoot, id <= 60 ? 'Creator Alpha' : 'Creator Beta', `${id}.7z`),
        'queued'
      );
    }

    const result = await fixture.service.runBatch({
      allowlist: ['Creator Alpha', 'Creator Beta'],
      creatorIds: [1]
    });

    expect(result).toMatchObject({ total: 60, examined: 60, unchanged: 60 });
    expect(result.items).toHaveLength(60);
    expect(result.items.every((entry) => entry.job.creatorId === 1)).toBe(true);
    expect(result.items.some((entry) => entry.job.id > 50)).toBe(true);
    fixture.database.close();
  });

  it('returns an empty batch without discovering new inbox files implicitly', async () => {
    const fixture = await createDiscoveryFixture();
    fixture.database.prepare('DELETE FROM local_ingest_jobs').run();
    const scan = vi.spyOn(fixture.service, 'scanInbox');
    const results = await fixture.service.runBatch({ allowlist: ['Creator Alpha', 'Creator Beta'] });
    expect(results).toMatchObject({ total: 0, examined: 0, settled: 0, items: [] });
    expect(scan).not.toHaveBeenCalled();
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get()).toEqual({ count: 0 });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM local_ingest_file_observations').get()).toEqual({ count: 0 });
    expect(fixture.sideEffects).toEqual({ hash: 0, command: 0, recycle: 0, reconcile: 0 });
    fixture.database.close();
  });

  it('does not downgrade or rewrite an already completed job during a creator continuation', async () => {
    const fixture = await createDiscoveryFixture();
    fixture.database.prepare('DELETE FROM local_ingest_jobs').run();
    insertJob(fixture.database, 8, 1, path.join(fixture.inboxRoot, 'Creator Alpha', '023.7z'), 'ingested');
    const before = fixture.database.prepare('SELECT * FROM local_ingest_jobs WHERE id = 8').get();

    const result = await fixture.service.runBatch({ allowlist: ['Creator Alpha'], creatorIds: [1] });

    expect(result).toMatchObject({ total: 0, examined: 0, settled: 0, items: [] });
    expect(fixture.database.prepare('SELECT * FROM local_ingest_jobs WHERE id = 8').get()).toEqual(before);
    fixture.database.close();
  });

  it('scans canonical allowlist creators across their direct alias directories', async () => {
    const fixture = await createDiscoveryFixture();

    const result = await fixture.service.scanInbox(['Creator Alpha', 'Creator Beta']);

    expect(result).toMatchObject({ discoveredArchives: 3, waitingStable: 3, createdJobs: 0 });
    expect(fixture.database.prepare(
      'SELECT DISTINCT creator_id FROM local_ingest_file_observations ORDER BY creator_id'
    ).all()).toEqual([{ creator_id: 1 }, { creator_id: 2 }]);
    expect(fixture.sideEffects).toEqual({ hash: 0, command: 0, recycle: 0, reconcile: 0 });
    fixture.database.close();
  });

  it('saves and reads every trimmed, non-empty allowlist line without duplicates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-multiline-allowlist-'));
    roots.push(root);
    const libraryRoot = path.join(root, 'library');
    const inboxRoot = path.join(root, 'inbox');
    const processingRoot = path.join(root, 'processing');
    await Promise.all([libraryRoot, inboxRoot, processingRoot].map((directory) => fs.mkdir(directory)));
    const values = new Map<string, string>();
    const service = new LocalIngestSettingsService(libraryRoot, {
      get: (key) => values.get(key) ?? null,
      setMany: (entries) => { for (const entry of entries) values.set(entry.key, entry.value); }
    });

    const saved = service.save({
      libraryRoot,
      inboxRoot,
      processingRoot,
      sevenZipPath: '7z',
      fileStableSeconds: 5,
      recycleAfterIngest: true,
      maxExtractionDepth: 2,
      allowlist: [' Creator Alpha ', 'Creator Beta', 'Creator Alpha']
    });

    expect(saved.allowlist).toEqual(['Creator Alpha', 'Creator Beta']);
    expect(service.get().allowlist).toEqual(['Creator Alpha', 'Creator Beta']);
  });
});
