import {DatabaseSync} from 'node:sqlite';
import {describe, it, expect} from 'vitest';
import {schemaSql} from '../src/db/schema.js';
import {ArchiveCatalogService} from '../src/services/archive-catalog-service.js';
import {ArchiveMetadataTaskService} from '../src/services/archive-metadata-task-service.js';
import {CostuanRangeReviewStore} from '../src/services/costuan-range-review-store.js';
import {applyCostuanRangeReview, type CostuanRangeReview} from '../src/services/costuan-range-review.js';
import {parseCostuanDirectoryText} from '../src/services/costuan-numbering-service.js';

const creatorId = 901, postId = '8801', date = '2026-09-26T00:00:00Z';
const title = 'SyntheticCOSPLAY写真作品合集[4套][持续更新]';
const text = 'NO.001-NO.003\nSynthetic NO.004 独立作品 [2P-1MB]';
const review: CostuanRangeReview = {version: 1, creatorId, postId, collectionTitle: title,
  rawDirectoryText: text, approvedAt: date, reason: '合成逐项审核', entries: [
    ...[1, 2, 3].map(order => ({sourceOrder: `NO.00${order}`, rawTitle: `Synthetic NO.00${order} NO.00${order}（来源未提供标题）`, filename: `00${order}.7z`})),
    {sourceOrder: 'NO.004', rawTitle: 'Synthetic NO.004 独立作品 [2P-1MB]', filename: '004.7z'}
  ]};
const context = {creatorId, postId, collectionTitle: title, rawDirectoryText: text, works: parseCostuanDirectoryText(text)};
const record = {creatorName: 'Synthetic', costuan: {postId, title, collectionCount: 4,
  resourceDirectoryText: text, works: context.works, directoryVerification: {complete: false, parsedWorkCount: 2, checkedAt: date}}};
const share = (files: string[]) => ({transport: 'direct-share', status: 'share-verified',
  shareUrl: 'https://pan.baidu.com/s/1synthetic', sourceFolderName: 'synthetic-source',
  verification: {method: 'share-read', complete: true, checkRoundId: 'round', checkedAt: date, files}});

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  db.prepare("INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,is_active,seed_source,seed_source_creator_id) VALUES (?,'Synthetic','synthetic',1,'test','901')").run(creatorId);
  return db;
}

function seedHistory(db: DatabaseSync) {
  const works = applyCostuanRangeReview(review, context).works;
  const collection = Number(db.prepare(`INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,declared_work_count,raw_directory_text,metadata_json,observed_at)
    VALUES (?,'costuan',?,?,4,?,?,?)`).run(creatorId, postId, title, text, JSON.stringify({works}), date).lastInsertRowid);
  for (const work of works) {
    const id = Number(db.prepare('INSERT INTO archive_catalog_works(creator_id,display_title) VALUES (?,?)').run(creatorId, work.label).lastInsertRowid);
    db.prepare(`INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_order,source_order_label,source_title,raw_title,media_summary,metadata_json,first_seen_at,last_seen_at)
      VALUES (?,?,'costuan',?,?,?,?,?,?,?,?,?)`).run(id, collection, work.sourceOrder, work.order!, work.sourceOrder, work.label, work.rawTitle, work.mediaSummary, JSON.stringify(work), date, date);
  }
  // Singles may already be locally satisfied: historic compatibility needs
  // direct-share proof for range members, not every subsequent single entry.
  db.prepare(`INSERT INTO archive_catalog_deliveries(collection_id,provider,delivery_key,delivery_type,status,source_folder_name,metadata_json,first_seen_at,last_seen_at)
    VALUES (?,'baidu','synthetic','share','share-verified','synthetic-source',?,?,?)`)
    .run(collection, JSON.stringify(share(['001.7z', '002.7z', '003.7z'])), date, date);
  return collection;
}

describe('explicit range review storage and catalog integration', () => {
  it('does not expand an unreviewed range or accept a client approval flag', () => {
    const db = database();
    try {
      const service = new ArchiveCatalogService(db);
      const before = db.prepare('SELECT total_changes() n').get();
      expect(() => service.validateCompleteCostuanDirectory(record, creatorId)).toThrow(/范围/);
      expect(() => service.validateCompleteCostuanDirectory({...record, rangeReview: {policy: 'explicit-range-v1', reviewId: 'client'}}, creatorId)).toThrow();
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    } finally { db.close(); }
  });

  it('registers a scoped approval idempotently without creating Work rows or overwriting a decision', () => {
    const db = database();
    try {
      const service = new ArchiveCatalogService(db);
      expect(service.saveCostuanRangeReview(creatorId, review)).toEqual({replayed: false});
      const before = db.prepare('SELECT total_changes() n').get();
      expect(service.saveCostuanRangeReview(creatorId, {...review, entries: [...review.entries].reverse()})).toEqual({replayed: true});
      expect(() => service.saveCostuanRangeReview(creatorId, {...review, reason: 'different approval'})).toThrow(/不允许隐式覆盖/);
      expect(() => service.saveCostuanRangeReview(creatorId + 1, review)).toThrow();
      expect(db.prepare('SELECT COUNT(*) n FROM archive_catalog_works').get()).toEqual({n: 0});
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    } finally { db.close(); }
  });

  it('preflight stays read-only and fresh direct-share proof is required for completion', () => {
    const db = database();
    try {
      const service = new ArchiveCatalogService(db);
      service.saveCostuanRangeReview(creatorId, review);
      const before = db.prepare('SELECT total_changes() n').get();
      const proof = service.validateCompleteCostuanDirectory(record, creatorId);
      expect(proof.canonicalWorks).toHaveLength(4);
      expect(proof.rangeReview).toMatchObject({policy: 'explicit-range-v1', requiredFilenames: ['001.7z', '002.7z', '003.7z']});
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
      const metadata = new ArchiveMetadataTaskService(db);
      const plan = metadata.planSelected({creatorIds: [creatorId], requestId: 'generic-range-fixture'});
      const planned = plan.items[0].task!;
      const task = metadata.claim({workerId: 'fixture', taskIds: plan.taskIds, rounds: [{taskId: planned.id, checkRoundId: planned.checkRoundId!}]})[0];
      const beforeMetadata = db.prepare('SELECT total_changes() n').get();
      expect(metadata.validateDirectory({id: task.id, workerId: 'fixture', expectedAttempt: task.attemptCount, canonicalCreatorId: creatorId, record}).rangeReview?.policy).toBe('explicit-range-v1');
      const full = {...proof.record, baidu: share(['001.7z', '002.7z', '003.7z', '004.7z'])};
      expect(() => service.validateCompleteCostuanCheck(full, creatorId, 'round')).not.toThrow();
      expect(() => service.validateCompleteCostuanCheck({...full, baidu: share(['002.7z', '003.7z', '004.7z'])}, creatorId, 'round')).toThrow(/唯一核验/);
      expect(() => service.validateCompleteCostuanCheck({...full, baidu: share(['001.7z', '001.7z', '002.7z', '003.7z', '004.7z'])}, creatorId, 'round')).toThrow(/唯一核验/);
      expect(() => service.validateCompleteCostuanCheck({...full, baidu: {...full.baidu, transport: 'owned-folder'}}, creatorId, 'round')).toThrow();
      expect(() => service.validateCompleteCostuanCheck(full, creatorId, 'other-round')).toThrow();
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(beforeMetadata);
    } finally { db.close(); }
  });

  it('accepts the plugin compact range wire shape and validates the canonical result returned on completion', () => {
    const db = database();
    try {
      const service = new ArchiveCatalogService(db);
      service.saveCostuanRangeReview(creatorId, review);
      // Literal output shape of CAMCore.parseResourceDirectory: unlike server
      // parsing, range has no scheme/key/offsets and singles omit media counts.
      const pluginWorks = [
        {sourceOrder: 'NO.001-NO.003', rawTitle: 'NO.001-NO.003', label: '来源未提供标题', mediaSummary: '',
          rangeDeclaration: true, range: {first: 1, last: 3, count: 3}},
        {order: 4, sourceOrder: 'NO.004', rawTitle: 'Synthetic NO.004 独立作品 [2P-1MB]', label: '独立作品', mediaSummary: '[2P-1MB]'}
      ];
      const pluginRecord = {...record, costuan: {...record.costuan, works: pluginWorks}};
      const proof = service.validateCompleteCostuanDirectory(pluginRecord, creatorId);
      expect(proof.canonicalWorks).toHaveLength(4);
      expect(proof.rangeReview?.requiredFilenames).toEqual(['001.7z', '002.7z', '003.7z']);
      const returned = {...pluginRecord, costuan: {...pluginRecord.costuan, works: proof.canonicalWorks,
        directoryVerification: proof.canonicalDirectoryVerification}, baidu: share(['001.7z', '002.7z', '003.7z', '004.7z'])};
      expect(() => service.validateCompleteCostuanCheck(returned, creatorId, 'round')).not.toThrow();
      for (const range of [{first: 2, last: 3, count: 2}, {first: 1, last: 4, count: 3}, {first: 1, last: 3, count: 2},
        {first: 1, last: 3, count: 3, scheme: 'VOL'}, {first: 1, last: 3, count: 3, key: 'wrong'},
        {first: 1, last: 3, count: 3, rawLabel: 'NO.001-NO.004'}, {first: 1, last: 3, count: 3, start: 9}]) {
        expect(() => service.validateCompleteCostuanDirectory({...pluginRecord, costuan: {...pluginRecord.costuan,
          works: [{...pluginWorks[0], range}, pluginWorks[1]]}}, creatorId)).toThrow(/范围/);
      }
    } finally { db.close(); }
  });

  it('rejects malformed saved approval without a 500 or implicit historical fallback', () => {
    const db = database();
    try {
      seedHistory(db);
      const store = new CostuanRangeReviewStore(db);
      store.save(review);
      db.prepare("UPDATE app_settings SET value='{' WHERE key LIKE 'archive.costuan-range-review.v1.%'").run();
      expect(store.resolve(context)).toBeNull();
      expect(() => new ArchiveCatalogService(db).validateCompleteCostuanDirectory(record, creatorId)).toThrow(/范围/);
      expect(() => store.save(review)).toThrow(/不允许隐式覆盖/);
    } finally { db.close(); }
  });

  it('reuses only persisted individual history and range-file proof without writing a new approval or identity', () => {
    const db = database();
    try {
      seedHistory(db);
      const before = db.prepare('SELECT total_changes() n').get();
      const result = new CostuanRangeReviewStore(db).resolve(context);
      expect(result?.works).toHaveLength(4);
      expect(result?.rangeReview.requiredFilenames).toEqual(['001.7z', '002.7z', '003.7z']);
      expect(new ArchiveCatalogService(db).validateCompleteCostuanDirectory(record, creatorId).rangeReview?.policy).toBe('explicit-range-v1');
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) n FROM app_settings WHERE key LIKE 'archive.costuan-range-review.v1.%'").get()).toEqual({n: 0});
    } finally { db.close(); }
  });

  it.each(['missing-proof', 'duplicate-file', 'missing-file', 'wrong-folder', 'inactive-row', 'missing-row', 'bad-collection-json', 'bad-row-json', 'changed-label', 'changed-raw', 'changed-row-media', 'changed-snapshot', 'different-creator', 'different-page'])('keeps historical compatibility closed for %s', mode => {
    const db = database();
    try {
      seedHistory(db);
      let current = context;
      if (mode === 'missing-proof') db.exec('DELETE FROM archive_catalog_deliveries');
      if (mode === 'duplicate-file') db.prepare('UPDATE archive_catalog_deliveries SET metadata_json=?').run(JSON.stringify(share(['001.7z', '001.7z', '002.7z', '003.7z'])));
      if (mode === 'missing-file') db.prepare('UPDATE archive_catalog_deliveries SET metadata_json=?').run(JSON.stringify(share(['001.7z', '003.7z'])));
      if (mode === 'wrong-folder') db.exec("UPDATE archive_catalog_deliveries SET source_folder_name='other'");
      if (mode === 'inactive-row') db.exec('UPDATE archive_catalog_source_works SET is_active=0 WHERE source_order=2');
      if (mode === 'missing-row') db.exec('DELETE FROM archive_catalog_source_works WHERE source_order=2');
      if (mode === 'bad-collection-json') db.exec("UPDATE archive_catalog_collections SET metadata_json='{' ");
      if (mode === 'bad-row-json') db.exec("UPDATE archive_catalog_source_works SET metadata_json='{' WHERE source_order=2");
      if (mode === 'changed-label') db.exec("UPDATE archive_catalog_source_works SET source_title='changed' WHERE source_order=2");
      if (mode === 'changed-raw') db.exec("UPDATE archive_catalog_source_works SET raw_title='NO.002 changed' WHERE source_order=2");
      if (mode === 'changed-row-media') db.exec("UPDATE archive_catalog_source_works SET media_summary='[90P]' WHERE source_order=2");
      if (mode === 'changed-snapshot') current = {...context, rawDirectoryText: `${text}\n2026.01.01更新：`};
      if (mode === 'different-creator') current = {...context, creatorId: 999};
      if (mode === 'different-page') current = {...context, postId: '9900'};
      const before = db.prepare('SELECT total_changes() n').get();
      expect(new CostuanRangeReviewStore(db).resolve(current)).toBeNull();
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    } finally { db.close(); }
  });
});
