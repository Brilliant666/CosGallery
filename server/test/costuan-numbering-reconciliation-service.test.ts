import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import { CostuanNumberingReconciliationService } from '../src/services/costuan-numbering-reconciliation-service.js';

type SeedOptions = {
  creatorName: string;
  rawDirectoryText: string;
  metadataWorks?: Array<Record<string, unknown>>;
};

function seedCollection(database: DatabaseSync, options: SeedOptions): { creatorId: number; collectionId: number } {
  const creatorId = Number(database.prepare(
    `INSERT INTO archive_catalog_creators (
       canonical_name, normalized_name, preference, effective_rating,
       seed_source, seed_source_creator_id
     ) VALUES (?, ?, 'liked', 'R15', 'test', ?)`
  ).run(options.creatorName, options.creatorName.toLocaleLowerCase(), options.creatorName).lastInsertRowid);
  const collectionId = Number(database.prepare(
    `INSERT INTO archive_catalog_collections (
       creator_id, source, source_collection_id, title, declared_work_count,
       raw_directory_text, metadata_json, observed_at
     ) VALUES (?, 'costuan', ?, ?, NULL, ?, ?, ?)`
  ).run(
    creatorId,
    `collection-${creatorId}`,
    `${options.creatorName} collection`,
    options.rawDirectoryText,
    JSON.stringify({ works: options.metadataWorks ?? [] }),
    '2026-09-02T00:00:00.000Z'
  ).lastInsertRowid);
  return { creatorId, collectionId };
}

function seedSourceWork(
  database: DatabaseSync,
  creatorId: number,
  collectionId: number,
  sourceWorkId: string,
  title: string,
  order: number
): { workId: number; sourceWorkDatabaseId: number } {
  const workId = Number(database.prepare(
    'INSERT INTO archive_catalog_works (creator_id, display_title) VALUES (?, ?)'
  ).run(creatorId, title).lastInsertRowid);
  const sourceWorkDatabaseId = Number(database.prepare(
    `INSERT INTO archive_catalog_source_works (
       work_id, collection_id, source, source_work_id, source_order,
       source_order_label, source_title, metadata_json, first_seen_at, last_seen_at
     ) VALUES (?, ?, 'costuan', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workId,
    collectionId,
    sourceWorkId,
    order,
    sourceWorkId,
    title,
    JSON.stringify({ order, sourceOrder: sourceWorkId, label: title }),
    '2026-09-02T00:00:00.000Z',
    '2026-09-02T00:00:00.000Z'
  ).lastInsertRowid);
  return { workId, sourceWorkDatabaseId };
}

function seedLocalFolder(database: DatabaseSync, creatorId: number, creatorName: string): number {
  return Number(database.prepare(
    `INSERT INTO archive_catalog_local_creator_folders (
       creator_id, root_path, relative_path, absolute_path, folder_name,
       match_status, match_method, scanned_at
     ) VALUES (?, 'G:\\cos图集', ?, ?, ?, 'matched', 'creator-exact', ?)`
  ).run(
    creatorId,
    creatorName,
    `G:\\cos图集\\${creatorName}`,
    creatorName,
    '2026-09-02T00:00:00.000Z'
  ).lastInsertRowid);
}

function seedLocalWork(
  database: DatabaseSync,
  localFolderId: number,
  folderName: string,
  workId: number | null
): number {
  return Number(database.prepare(
    `INSERT INTO archive_catalog_local_works (
       local_creator_folder_id, work_id, relative_path, absolute_path, folder_name,
       parsed_source_order, image_count, video_count, advertisement_file_count,
       other_file_count, total_bytes, match_status, match_method, scanned_at
     ) VALUES (?, ?, ?, ?, ?, NULL, 1, 0, 0, 0, 1, ?, ?, ?)`
  ).run(
    localFolderId,
    workId,
    folderName,
    `G:\\cos图集\\${folderName}`,
    folderName,
    workId === null ? 'unmatched' : 'matched',
    workId === null ? null : 'costuan-numbering-key',
    '2026-09-02T00:00:00.000Z'
  ).lastInsertRowid);
}

describe('Costuan numbering reconciliation', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(schemaSql);
    database.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => database.close());

  it('adds a VOL work without colliding with the existing NO number and is idempotent', () => {
    const creatorName = '混合编号博主';
    const { creatorId, collectionId } = seedCollection(database, {
      creatorName,
      rawDirectoryText: [
        `${creatorName} NO.013 黑护士 [10P-20MB]`,
        `${creatorName} Vol.13 白蕾丝姐姐 [20P-30MB]`
      ].join('\n'),
      metadataWorks: [{ order: 13, sourceOrder: 'NO.013', label: '黑护士' }]
    });
    const no = seedSourceWork(database, creatorId, collectionId, 'NO.013', '黑护士', 13);
    for (let index = 1; index <= 5; index += 1) {
      database.prepare(
        `INSERT INTO local_ingest_jobs (
           source_work_id, creator_id, source_archive_path, source_archive_name,
           source_archive_size, source_archive_mtime, source_archive_sha256,
           status, phase, validation_status, cleanup_status, attempt_count
         ) VALUES (?, ?, ?, ?, 100, 1, ?, 'ingested', 'done', 'passed', 'recycled', 1)`
      ).run(
        no.sourceWorkDatabaseId,
        creatorId,
        `G:\\cos待入库\\${creatorName}\\${index}.7z`,
        `${index}.7z`,
        String(index).padStart(64, '0')
      );
    }
    const localIngestJobsBefore = database.prepare(
      `SELECT id, status, phase, validation_status, cleanup_status, attempt_count
       FROM local_ingest_jobs ORDER BY id`
    ).all();
    const localFolderId = seedLocalFolder(database, creatorId, creatorName);
    const localNoId = seedLocalWork(database, localFolderId, `${creatorName} NO.013 黑护士`, no.workId);
    const localVolId = seedLocalWork(database, localFolderId, `${creatorName} Vol.13 白蕾丝姐姐`, null);
    const service = new CostuanNumberingReconciliationService(database);

    const dryRun = service.plan({ creatorNames: [creatorName] });
    expect(dryRun.summary).toMatchObject({
      parsedSourceWorks: 2,
      sourceWorksToAdd: 1,
      localLinksToCreate: 1,
      preservedLocalLinks: 1,
      blockingIssues: 0,
      missingWorksAfter: 0
    });
    expect(dryRun.localLinksToCreate[0]).toMatchObject({
      localWorkId: localVolId,
      sourceWorkId: 'VOL.013',
      numberingKey: 'VOL:013'
    });

    const applied = service.apply({ creatorNames: [creatorName] });
    expect(applied.applied).toMatchObject({ sourceWorksAdded: 1, localLinksCreated: 1 });
    expect(applied.after.summary).toMatchObject({
      sourceWorksToAdd: 0,
      sourceWorksToUpdate: 0,
      localLinksToCreate: 0,
      missingWorksAfter: 0,
      blockingIssues: 0
    });

    const sourceRows = database.prepare(
      `SELECT source_work_id, source_order_label, metadata_json
       FROM archive_catalog_source_works ORDER BY source_work_id`
    ).all() as Array<{ source_work_id: string; source_order_label: string; metadata_json: string }>;
    expect(sourceRows.map((row) => row.source_work_id)).toEqual(['NO.013', 'VOL.013']);
    expect(JSON.parse(sourceRows[1].metadata_json)).toMatchObject({
      sourceOrderRaw: 'Vol.13',
      sourceOrderScheme: 'VOL',
      sourceOrderKey: 'VOL:013'
    });
    const links = database.prepare(
      'SELECT id, work_id FROM archive_catalog_local_works WHERE id IN (?, ?) ORDER BY id'
    ).all(localNoId, localVolId) as Array<{ id: number; work_id: number }>;
    expect(links[0].work_id).toBe(no.workId);
    expect(links[1].work_id).not.toBe(no.workId);
    expect(database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_works').get()).toEqual({ count: 2 });
    expect(database.prepare(
      `SELECT id, status, phase, validation_status, cleanup_status, attempt_count
       FROM local_ingest_jobs ORDER BY id`
    ).all()).toEqual(localIngestJobsBefore);

    const repeated = service.plan({ creatorNames: [creatorName] });
    expect(repeated.summary).toMatchObject({
      sourceWorksToAdd: 0,
      sourceWorksToUpdate: 0,
      localLinksToCreate: 0,
      blockingIssues: 0
    });
  });

  it('links an unnumbered local folder only through a unique exact title in the same creator', () => {
    const creatorName = '五更百鬼';
    const { creatorId } = seedCollection(database, {
      creatorName,
      rawDirectoryText: `${creatorName} VOL.001 兔玩映画 ${creatorName} 白咝JK [10P-26MB]`
    });
    const localFolderId = seedLocalFolder(database, creatorId, creatorName);
    const localId = seedLocalWork(
      database,
      localFolderId,
      `兔玩映画 ${creatorName} 白丝JK [10P-26MB]`,
      null
    );
    const service = new CostuanNumberingReconciliationService(database);
    const plan = service.plan({ creatorNames: [creatorName] });

    expect(plan.summary).toMatchObject({ localLinksToCreate: 1, blockingIssues: 0 });
    expect(plan.localLinksToCreate[0]).toMatchObject({
      localWorkId: localId,
      sourceWorkId: 'VOL.001',
      numberingKey: 'VOL:001'
    });
  });

  it('blocks a numbered match when its normalized title is severely inconsistent', () => {
    const creatorName = '需审查博主';
    const { creatorId } = seedCollection(database, {
      creatorName,
      rawDirectoryText: `${creatorName} VOL.001 正确标题 [10P-20MB]`
    });
    const localFolderId = seedLocalFolder(database, creatorId, creatorName);
    seedLocalWork(database, localFolderId, `${creatorName} VOL.001 完全不同`, null);
    const service = new CostuanNumberingReconciliationService(database);
    const plan = service.plan({ creatorNames: [creatorName] });

    expect(plan.summary).toMatchObject({ titleConflicts: 1, blockingIssues: 1, localLinksToCreate: 0 });
    expect(() => service.apply({ creatorNames: [creatorName] })).toThrow(/blocking issue/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_source_works').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_works').get()).toEqual({ count: 0 });
  });

  it('canonicalizes a legacy VOL source id instead of creating a duplicate work', () => {
    const creatorName = '历史编号博主';
    const { creatorId, collectionId } = seedCollection(database, {
      creatorName,
      rawDirectoryText: `${creatorName} VOL.013 白蕾丝姐姐 [20P-30MB]`,
      metadataWorks: [{ order: 13, sourceOrder: 'Vol.13', label: '白蕾丝姐姐' }]
    });
    const legacy = seedSourceWork(database, creatorId, collectionId, 'Vol.13', '白蕾丝姐姐', 13);
    const localFolderId = seedLocalFolder(database, creatorId, creatorName);
    seedLocalWork(database, localFolderId, `${creatorName} VOL.013 白蕾丝姐姐`, legacy.workId);
    const service = new CostuanNumberingReconciliationService(database);

    expect(service.plan({ creatorNames: [creatorName] }).summary).toMatchObject({
      sourceWorksToAdd: 0,
      sourceWorksToUpdate: 1,
      blockingIssues: 0
    });
    service.apply({ creatorNames: [creatorName] });

    expect(database.prepare(
      'SELECT source_work_id, source_order_label FROM archive_catalog_source_works'
    ).get()).toEqual({ source_work_id: 'VOL.013', source_order_label: 'VOL.013' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_source_works').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_works').get()).toEqual({ count: 1 });
    expect(service.plan({ creatorNames: [creatorName] }).summary).toMatchObject({
      sourceWorksToAdd: 0,
      sourceWorksToUpdate: 0,
      blockingIssues: 0
    });
  });
});
