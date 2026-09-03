import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import { ArchiveCatalogPipelineService } from '../src/services/archive-catalog-pipeline-service.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';
import { ArchiveDownloadTaskService } from '../src/services/archive-download-task-service.js';
import { areCostuanTitlesCompatible } from '../src/services/costuan-numbering-service.js';

type CreatorIds = { a: number; b: number; c: number };

function creatorId(database: DatabaseSync, name: string): number {
  const row = database.prepare(
    'SELECT id FROM archive_catalog_creators WHERE canonical_name = ?'
  ).get(name) as { id: number } | undefined;
  if (!row) throw new Error(`Missing synthetic creator ${name}`);
  return row.id;
}

function sourceWork(database: DatabaseSync, creatorIdValue: number, order: number): { id: number; work_id: number; collection_id: number } {
  const row = database.prepare(
    `SELECT source_works.id, source_works.work_id, source_works.collection_id
     FROM archive_catalog_source_works source_works
     JOIN archive_catalog_works works ON works.id = source_works.work_id
     WHERE works.creator_id = ? AND source_works.source_order = ?`
  ).get(creatorIdValue, order) as { id: number; work_id: number; collection_id: number } | undefined;
  if (!row) throw new Error(`Missing synthetic source work ${creatorIdValue}/${order}`);
  return row;
}

function insertTask(
  database: DatabaseSync,
  sourceWorkId: number,
  creatorName: string,
  filename: string,
  status: 'pending' | 'cancelled'
): number {
  const result = database.prepare(
    `INSERT INTO archive_catalog_download_tasks (
       source_work_id, provider, target_root, target_relative_directory,
       target_filename, status, created_at, updated_at
     ) VALUES (?, 'baidu', 'G:\\cos待入库', ?, ?, ?,
       '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z')`
  ).run(sourceWorkId, creatorName, filename, status);
  return Number(result.lastInsertRowid);
}

function rowsForCreator(database: DatabaseSync, table: string, creatorIdValue: number): unknown[] {
  switch (table) {
    case 'archive_catalog_local_creator_folders':
      return database.prepare(
        `SELECT * FROM archive_catalog_local_creator_folders
         WHERE creator_id = ? ORDER BY id`
      ).all(creatorIdValue);
    case 'archive_catalog_local_works':
      return database.prepare(
        `SELECT local_works.*
         FROM archive_catalog_local_works local_works
         JOIN archive_catalog_local_creator_folders local_folders
           ON local_folders.id = local_works.local_creator_folder_id
         WHERE local_folders.creator_id = ? ORDER BY local_works.id`
      ).all(creatorIdValue);
    case 'archive_catalog_works':
      return database.prepare(
        'SELECT * FROM archive_catalog_works WHERE creator_id = ? ORDER BY id'
      ).all(creatorIdValue);
    case 'archive_catalog_source_works':
      return database.prepare(
        `SELECT source_works.*
         FROM archive_catalog_source_works source_works
         JOIN archive_catalog_works works ON works.id = source_works.work_id
         WHERE works.creator_id = ? ORDER BY source_works.id`
      ).all(creatorIdValue);
    case 'archive_catalog_download_tasks':
      return database.prepare(
        `SELECT tasks.*
         FROM archive_catalog_download_tasks tasks
         JOIN archive_catalog_source_works source_works ON source_works.id = tasks.source_work_id
         JOIN archive_catalog_works works ON works.id = source_works.work_id
         WHERE works.creator_id = ? ORDER BY tasks.id`
      ).all(creatorIdValue);
    case 'archive_catalog_metadata_tasks':
      return database.prepare(
        'SELECT * FROM archive_catalog_metadata_tasks WHERE creator_id = ? ORDER BY id'
      ).all(creatorIdValue);
    default:
      throw new Error(`Unsupported snapshot table ${table}`);
  }
}

const CREATOR_TABLES = [
  'archive_catalog_local_creator_folders',
  'archive_catalog_local_works',
  'archive_catalog_works',
  'archive_catalog_source_works',
  'archive_catalog_download_tasks',
  'archive_catalog_metadata_tasks'
] as const;

function snapshotCreators(database: DatabaseSync, creatorIds: number[]): string {
  return JSON.stringify(creatorIds.map((id) => ({
    id,
    tables: Object.fromEntries(CREATOR_TABLES.map((table) => [table, rowsForCreator(database, table, id)]))
  })));
}

async function writeWork(galleryRoot: string, creatorName: string, folderName: string): Promise<void> {
  const workPath = path.join(galleryRoot, creatorName, folderName);
  await fs.mkdir(workPath, { recursive: true });
  await fs.writeFile(path.join(workPath, '01.jpg'), 'synthetic-image');
}

async function seedThreeCreators(
  tempRoot: string,
  database: DatabaseSync,
  galleryRoot: string
): Promise<CreatorIds> {
  const hcfPath = path.join(tempRoot, 'hcf.json');
  const costuanPath = path.join(tempRoot, 'costuan.json');
  await fs.writeFile(hcfPath, JSON.stringify({
    format: 'hcf-tag-preferences',
    version: 1,
    state: { liked: ['Creator A', 'Creator B', 'Creator C'], kept: [] },
    contentRatings: {
      entries: [
        { name: 'Creator A', rating: 'r15' },
        { name: 'Creator B', rating: 'r15' },
        { name: 'Creator C', rating: 'r18' }
      ]
    }
  }));
  await fs.writeFile(costuanPath, JSON.stringify({
    format: 'costuan-archive-metadata',
    version: 1,
    records: {
      'costuan:a': {
        creatorName: 'Creator A',
        aliases: [],
        costuan: {
          postId: 'a',
          title: 'Creator A COSPLAY写真合集[4套][持续更新]',
          works: [
            { order: 1, sourceOrder: 'NO.001', label: '已有作品' },
            { order: 2, sourceOrder: 'NO.002', label: '新增作品' },
            { order: 3, sourceOrder: 'NO.003', label: '仍缺作品' },
            { order: 4, sourceOrder: 'NO.004', label: '失效作品' }
          ]
        },
        baidu: { sourceFolderName: 'a', destinationPath: '我的网盘/cos图集', status: 'saved' }
      },
      'costuan:b': {
        creatorName: 'Creator B',
        aliases: [],
        costuan: {
          postId: 'b',
          title: 'Creator B COSPLAY写真合集[1套][持续更新]',
          works: [{ order: 1, sourceOrder: 'NO.001', label: '稳定作品' }]
        },
        baidu: { sourceFolderName: 'b', destinationPath: '我的网盘/cos图集', status: 'saved' }
      },
      'costuan:c': {
        creatorName: 'Creator C',
        aliases: [],
        costuan: {
          postId: 'c',
          title: 'Creator C COSPLAY写真合集[1套][持续更新]',
          works: [{ order: 1, sourceOrder: 'NO.001', label: '原始名称' }]
        },
        baidu: { sourceFolderName: 'c', destinationPath: '我的网盘/cos图集', status: 'saved' }
      }
    }
  }));
  const catalog = new ArchiveCatalogService(database);
  await catalog.importHentaiclubSeed(hcfPath);
  await catalog.importCostuanArchive(costuanPath);
  const ids = {
    a: creatorId(database, 'Creator A'),
    b: creatorId(database, 'Creator B'),
    c: creatorId(database, 'Creator C')
  };
  await Promise.all([
    writeWork(galleryRoot, 'Creator A', 'Creator A NO.001 已有作品'),
    writeWork(galleryRoot, 'Creator B', 'Creator B NO.001 稳定作品'),
    writeWork(galleryRoot, 'Creator C', 'Creator C NO.001 原始名称')
  ]);
  await catalog.reconcileLocalRoot(galleryRoot);
  return ids;
}

describe('creator-scoped archive ledger isolation', () => {
  let tempRoot: string;
  let galleryRoot: string;
  let database: DatabaseSync;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-scoped-ledger-'));
    galleryRoot = path.join(tempRoot, 'gallery');
    database = new DatabaseSync(':memory:');
    database.exec(schemaSql);
  });

  afterEach(async () => {
    database.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('reconciles, removes, and creates tasks only for the target creator while preserving other rows byte-for-byte', async () => {
    const ids = await seedThreeCreators(tempRoot, database, galleryRoot);
    const a2 = sourceWork(database, ids.a, 2);
    const a4 = sourceWork(database, ids.a, 4);
    const b1 = sourceWork(database, ids.b, 1);
    const c1 = sourceWork(database, ids.c, 1);
    const a2TaskId = insertTask(database, a2.id, 'Creator A', '002.7z', 'pending');
    const a4TaskId = insertTask(database, a4.id, 'Creator A', '004.7z', 'pending');
    insertTask(database, b1.id, 'Creator B', '001.7z', 'pending');
    insertTask(database, c1.id, 'Creator C', '001.7z', 'cancelled');
    database.prepare('UPDATE archive_catalog_source_works SET is_active = 0 WHERE id = ?').run(a4.id);
    database.prepare(
      `UPDATE archive_catalog_deliveries SET status = 'expired' WHERE collection_id = ?`
    ).run(c1.collection_id);
    database.prepare(
      `UPDATE archive_catalog_source_works
       SET source_title = '完全不同的远端标题'
       WHERE id = ?`
    ).run(c1.id);
    database.prepare(
      `INSERT INTO archive_catalog_metadata_tasks (creator_id, source, status)
       VALUES (?, 'costuan', 'pending'), (?, 'costuan', 'failed')`
    ).run(ids.b, ids.c);

    expect(areCostuanTitlesCompatible(
      'Creator C NO.001 原始名称',
      '完全不同的远端标题',
      ['Creator C']
    )).toBe(false);
    const nonTargetBefore = snapshotCreators(database, [ids.b, ids.c]);
    const a1Before = database.prepare(
      `SELECT local_works.work_id, local_works.match_status, local_works.match_method
       FROM archive_catalog_local_works local_works
       JOIN archive_catalog_local_creator_folders local_folders
         ON local_folders.id = local_works.local_creator_folder_id
       WHERE local_folders.creator_id = ? AND local_works.parsed_source_order = 1`
    ).get(ids.a);

    await writeWork(galleryRoot, 'Creator A', 'Creator A NO.002 新增作品');
    const pipeline = new ArchiveCatalogPipelineService(database);
    const first = await pipeline.refreshAfterCreatorGalleryScan({
      galleryRoot,
      creatorId: ids.a,
      creatorFolderName: 'Creator A',
      defaultInboxRoot: 'G:\\cos待入库'
    });

    expect(first.local).toMatchObject({
      creatorFolders: 1,
      matchedCreatorFolders: 1,
      localWorks: 2,
      matchedWorks: 2,
      ambiguousWorks: 0
    });
    expect(first.plan).toMatchObject({
      reconciledLocal: 1,
      removedOutOfScope: 1,
      created: 1,
      existing: 0
    });
    expect(database.prepare(
      'SELECT status FROM archive_catalog_download_tasks WHERE id = ?'
    ).get(a2TaskId)).toEqual({ status: 'ingested' });
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM archive_catalog_download_tasks WHERE id = ?'
    ).get(a4TaskId)).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT tasks.status, source_works.source_order
       FROM archive_catalog_download_tasks tasks
       JOIN archive_catalog_source_works source_works ON source_works.id = tasks.source_work_id
       JOIN archive_catalog_works works ON works.id = source_works.work_id
       WHERE works.creator_id = ? AND source_works.source_order = 3`
    ).get(ids.a)).toEqual({ status: 'pending', source_order: 3 });
    expect(database.prepare(
      `SELECT local_works.work_id, local_works.match_status, local_works.match_method
       FROM archive_catalog_local_works local_works
       JOIN archive_catalog_local_creator_folders local_folders
         ON local_folders.id = local_works.local_creator_folder_id
       WHERE local_folders.creator_id = ? AND local_works.parsed_source_order = 1`
    ).get(ids.a)).toEqual(a1Before);
    expect(snapshotCreators(database, [ids.b, ids.c])).toBe(nonTargetBefore);

    const cLink = database.prepare(
      `SELECT local_works.work_id, local_works.match_status, local_works.match_method
       FROM archive_catalog_local_works local_works
       JOIN archive_catalog_local_creator_folders local_folders
         ON local_folders.id = local_works.local_creator_folder_id
       WHERE local_folders.creator_id = ?`
    ).get(ids.c);
    expect(cLink).toMatchObject({ work_id: c1.work_id, match_status: 'matched' });

    const allRowsAfterFirst = snapshotCreators(database, [ids.a, ids.b, ids.c]);
    const second = await pipeline.refreshAfterCreatorGalleryScan({
      galleryRoot,
      creatorId: ids.a,
      creatorFolderName: 'Creator A',
      defaultInboxRoot: 'D:\\ignored'
    });
    expect(second.plan).toMatchObject({
      reconciledLocal: 0,
      removedOutOfScope: 0,
      created: 0,
      existing: 1,
      targetRoot: 'G:\\cos待入库'
    });
    expect(snapshotCreators(database, [ids.a, ids.b, ids.c])).toBe(allRowsAfterFirst);
  });

  it('fails closed for empty, invalid, mismatched, or non-direct creator scopes', async () => {
    const ids = await seedThreeCreators(tempRoot, database, galleryRoot);
    const catalog = new ArchiveCatalogService(database);
    const pipeline = new ArchiveCatalogPipelineService(database);
    const download = new ArchiveDownloadTaskService(database);
    const before = snapshotCreators(database, [ids.a, ids.b, ids.c]);

    await expect(catalog.reconcileLocalCreators({ rootPath: galleryRoot, creators: [] }))
      .rejects.toThrow(/at least one|\u81f3\u5c11/u);
    await expect(pipeline.refreshAfterCreatorGalleryScan({
      galleryRoot,
      creatorId: ids.a,
      creatorFolderName: ''
    })).rejects.toThrow(/creatorFolderName/u);
    await expect(catalog.reconcileLocalCreators({
      rootPath: galleryRoot,
      creators: [{ creatorId: 999_999, folderName: 'Creator A' }]
    })).rejects.toThrow(/does not exist|\u4e0d\u5b58\u5728/u);
    await expect(catalog.reconcileLocalCreators({
      rootPath: galleryRoot,
      creators: [{ creatorId: ids.b, folderName: 'Creator A' }]
    })).rejects.toThrow(/cannot uniquely match|\u65e0\u6cd5\u552f\u4e00\u5bf9\u5e94/u);
    await expect(catalog.reconcileLocalCreators({
      rootPath: galleryRoot,
      creators: [{ creatorId: ids.a, folderName: path.join('Creator A', 'nested') }]
    })).rejects.toThrow(/direct child|\u76f4\u63a5\u5b50\u76ee\u5f55/u);
    expect(() => download.planMissing({
      targetRoot: 'G:\\cos待入库',
      creatorIds: []
    })).toThrow(/empty creatorIds|\u7a7a creatorIds/u);
    expect(() => download.planMissing({
      targetRoot: 'G:\\cos待入库',
      creatorIds: [999_999]
    })).toThrow(/does not exist|\u4e0d\u5b58\u5728/u);
    expect(snapshotCreators(database, [ids.a, ids.b, ids.c])).toBe(before);
  });

  it('keeps a valid persistent relationship stable across repeated explicit full reconciliation', async () => {
    const ids = await seedThreeCreators(tempRoot, database, galleryRoot);
    const c1 = sourceWork(database, ids.c, 1);
    database.prepare(
      `UPDATE archive_catalog_source_works
       SET source_title = '改名后与本地完全不兼容'
       WHERE id = ?`
    ).run(c1.id);
    expect(areCostuanTitlesCompatible(
      'Creator C NO.001 原始名称',
      '改名后与本地完全不兼容',
      ['Creator C']
    )).toBe(false);

    const catalog = new ArchiveCatalogService(database);
    const before = snapshotCreators(database, [ids.a, ids.b, ids.c]);
    const first = await catalog.reconcileLocalRoot(galleryRoot);
    const afterFirst = snapshotCreators(database, [ids.a, ids.b, ids.c]);
    const second = await catalog.reconcileLocalRoot(galleryRoot);
    expect(first).toMatchObject({ matchedWorks: 3, ambiguousWorks: 0 });
    expect(second).toMatchObject({ matchedWorks: 3, ambiguousWorks: 0 });
    expect(afterFirst).toBe(before);
    expect(snapshotCreators(database, [ids.a, ids.b, ids.c])).toBe(afterFirst);

    const cLink = database.prepare(
      `SELECT work_id, match_status, match_method
       FROM archive_catalog_local_works
       WHERE work_id = ?`
    ).get(c1.work_id);
    expect(cLink).toMatchObject({ work_id: c1.work_id, match_status: 'matched' });
    const download = new ArchiveDownloadTaskService(database);
    const firstPlan = download.planMissing({ targetRoot: 'G:\\cos待入库' });
    const taskRows = JSON.stringify(database.prepare(
      'SELECT * FROM archive_catalog_download_tasks ORDER BY id'
    ).all());
    const secondPlan = download.planMissing({ targetRoot: 'G:\\cos待入库' });
    expect(firstPlan.created).toBe(3);
    expect(secondPlan).toMatchObject({ created: 0, existing: 3, reconciledLocal: 0, removedOutOfScope: 0 });
    expect(JSON.stringify(database.prepare(
      'SELECT * FROM archive_catalog_download_tasks ORDER BY id'
    ).all())).toBe(taskRows);
  });
});
