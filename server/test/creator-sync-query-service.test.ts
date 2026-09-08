import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { CreatorSyncQueryService } from '../src/services/creator-sync-query-service.js';
import { ArchiveDownloadTaskService, type ArchiveDownloadTaskStatus } from '../src/services/archive-download-task-service.js';
import { normalizeCreatorIdentity } from '../src/utils/creator-identity.js';

describe('shared creator sync read model', () => {
  let db: DatabaseSync, service: CreatorSyncQueryService, sequence: number;
  const timestamp = '2026-09-08T00:00:00Z';
  const creator = (name: string, preference: 'liked' | 'kept' | null = 'liked', rating: 'R15' | 'R18' | null = 'R18') => {
    const id = Number(db.prepare(`INSERT INTO archive_catalog_creators(canonical_name,normalized_name,preference,effective_rating,seed_source,seed_source_creator_id)
      VALUES(?,?,?,?,'fixture',?)`).run(name, normalizeCreatorIdentity(name), preference, rating, `fixture:${++sequence}`).lastInsertRowid);
    db.prepare("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(?,?,?,'fixture')").run(id, name, normalizeCreatorIdentity(name));
    return id;
  };
  const collection = (creatorId: number) => Number(db.prepare(`INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at)
    VALUES(?,'costuan',?,'Fixture collection',?)`).run(creatorId, `collection-${++sequence}`, timestamp).lastInsertRowid);
  const source = (creatorId: number, collectionId: number, order: number, scheme = 'NO', linkedWork?: number) => {
    const workId = linkedWork ?? Number(db.prepare("INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'Fixture work')").run(creatorId).lastInsertRowid);
    const id = Number(db.prepare(`INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_order,source_order_label,source_title,first_seen_at,last_seen_at)
      VALUES(?,?,'costuan',?,?,?,'Fixture title',?,?)`).run(workId, collectionId, `${scheme}.${order}`, order, `${scheme}.${order}`, timestamp, timestamp).lastInsertRowid);
    return { id, workId };
  };
  const folder = (creatorId: number | null, name: string) => Number(db.prepare(`INSERT INTO archive_catalog_local_creator_folders
    (creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(?,'/synthetic',?,?,?, ?,?)`)
    .run(creatorId, name, `/synthetic/${name}`, name, creatorId === null ? 'unmatched' : 'matched', timestamp).lastInsertRowid);
  const local = (folderId: number, workId: number | null) => Number(db.prepare(`INSERT INTO archive_catalog_local_works
    (local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,image_count,match_status,scanned_at) VALUES(?,?,?,?,'Work',1,?,?)`)
    .run(folderId, workId, `work-${++sequence}`, `/synthetic/work-${sequence}`, workId === null ? 'unmatched' : 'matched', timestamp).lastInsertRowid);
  const task = (sourceId: number, status: ArchiveDownloadTaskStatus = 'pending') => Number(db.prepare(`INSERT INTO archive_catalog_download_tasks
    (source_work_id,provider,target_root,target_relative_directory,target_filename,status) VALUES(?,'baidu','/synthetic/inbox','Creator',?,?)`)
    .run(sourceId, `${sourceId}.7z`, status).lastInsertRowid);
  const job = (creatorId: number, sourceId: number, taskId: number) => db.prepare(`INSERT INTO local_ingest_jobs
    (creator_id,source_work_id,archive_download_task_id,source_archive_path,source_archive_name,source_archive_size,source_archive_mtime,source_archive_sha256,status,phase,validation_status,cleanup_status,summary_json)
    VALUES(?,?,?,?,'fixture.7z',1,1,?,'ingested','done','passed','recycled','{"warning":"historical manual choice"}')`)
    .run(creatorId, sourceId, taskId, `/synthetic/inbox/${++sequence}.7z`, String(sequence).padStart(64, '0'));
  const delivery = (collectionId: number, verified: boolean, key = 'primary') => db.prepare(`INSERT INTO archive_catalog_deliveries
    (collection_id,provider,delivery_key,delivery_type,status,source_folder_name,destination_path,first_seen_at,last_seen_at,metadata_json)
    VALUES(?,'baidu',?,'share-folder','saved','100','我的网盘/cos图集',?,?,?)`)
    .run(collectionId, key, timestamp, timestamp, verified ? JSON.stringify({ verification: { checkedAt: timestamp, method: 'saved', sourceDirectory: '我的网盘/cos图集/100' } }) : null);
  const snapshot = () => JSON.stringify(['archive_catalog_creators', 'archive_catalog_creator_aliases', 'archive_catalog_collections',
    'archive_catalog_source_works', 'archive_catalog_local_works', 'archive_catalog_local_creator_folders', 'archive_catalog_download_tasks',
    'archive_catalog_metadata_tasks', 'local_ingest_jobs', 'app_settings'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec(schemaSql); sequence = 0; service = new CreatorSyncQueryService(db); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it('reads the entire canonical roster, not just metadata tasks, with aliases and multi-folder identity', () => {
    const a = creator('Canonical'), b = creator('HistoricalSource', 'kept', 'R15'), c = creator('NeverChecked', null, null);
    db.prepare("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(?,'Old Alias','oldalias','manual')").run(a);
    const col = collection(a), first = source(a, col, 1), second = source(a, col, 2);
    local(folder(a, 'Canonical'), first.workId); local(folder(a, 'Old Alias'), second.workId);
    source(b, collection(b), 1); delivery(col, true); delivery(col, true, 'duplicate-delivery');
    db.prepare("INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status,attempt_count,last_error) VALUES(?,'costuan','not_found',1,'Latest attempt failed')").run(c);
    const payload = service.roster();
    expect(payload.total).toBe(3);
    expect(payload.items.find(item => item.creatorId === a)).toMatchObject({ localWorks: 2, matchedLocalWorks: 2,
      sourceWorks: 2, missingWorks: 0, metadataTask: null, sourceState: { deliveryEvidence: 'verified' } });
    expect(payload.items.find(item => item.creatorId === b)).toMatchObject({ sourceWorks: 1, localWorks: 0, metadataTask: null });
    expect(payload.items.find(item => item.creatorId === c)).toMatchObject({ sourceWorks: 0, metadataTask: { status: 'not_found', attemptCount: 1 } });
    expect(service.roster({ q: 'Old Alias' }).items.map(item => item.creatorId)).toEqual([a]);
    expect(service.roster({ q: 'oldalias' }).items.map(item => item.creatorId)).toEqual([a]);
    expect(service.stats()).toMatchObject({ creators: { total: 3, withLocal: 1, withSource: 2 }, works: { local: 2, source: 3, missing: 1 }, execution: { metadata: { total: 1, not_found: 1 } } });
  });

  it('keeps source, local works, download tasks and ingest jobs distinct rather than subtracting job totals', () => {
    const a = creator('A'), col = collection(a), f = folder(a, 'A');
    const sources = [1, 2, 3, 4].map(n => source(a, col, n));
    for (const s of sources.slice(0, 3)) local(f, s.workId);
    const firstTask = task(sources[0].id, 'ingested'); task(sources[1].id, 'ingested'); task(sources[3].id, 'cancelled');
    job(a, sources[0].id, firstTask);
    expect(service.stats()).toMatchObject({ works: { source: 4, local: 3, matchedLocal: 3, unresolvedLocal: 0, missing: 1 },
      execution: { download: { total: 3, ingested: 2, cancelled: 1 }, ingest: { total: 1, ingested: 1 } } });
    // Three tasks minus one job is not the one actual source/local gap.
    expect(service.roster().items[0].missingWorks).toBe(1);
  });

  it('uses complete stable identity for gaps: NO and VOL same number remain different, equal counts can still have gaps', () => {
    const a = creator('A'), col = collection(a), f = folder(a, 'A');
    const no = source(a, col, 1), vol = source(a, col, 1, 'VOL');
    local(f, no.workId);
    const orphan = Number(db.prepare("INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'Other local identity')").run(a).lastInsertRowid);
    local(f, orphan);
    const duplicateCollection = collection(a); source(a, duplicateCollection, 1, 'NO', no.workId);
    expect(service.roster().items[0]).toMatchObject({ sourceWorks: 3, sourceCollections: 2, localWorks: 2, missingWorks: 1 });
    db.prepare('UPDATE archive_catalog_source_works SET is_active=0 WHERE id=?').run(vol.id);
    expect(service.roster().items[0].missingWorks).toBe(0);
  });

  it('applies the same roster filters to totals, source coverage and all Stage2 pages without widening empty results', () => {
    const liked = creator('Same', 'liked', 'R18'), kept = creator('Same', 'kept', 'R15'), off = creator('Off');
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=?').run(off);
    const a = source(liked, collection(liked), 1), b = source(kept, collection(kept), 1), c = source(off, collection(off), 1);
    local(folder(liked, 'LikedLocal'), a.workId);
    task(a.id, 'ingested'); task(b.id, 'staged'); task(c.id, 'failed');
    const filters = { preference: 'liked' as const, rating: 'R18' as const, local: 'present' as const, source: 'present' as const };
    expect(service.roster(filters).items.map(item => item.creatorId)).toEqual([liked]);
    expect(service.stats(filters).execution.download).toMatchObject({ total: 1, ingested: 1 });
    expect(service.downloadCreators(filters)).toMatchObject({ total: 1, taskTotal: 1, items: [{ creatorId: liked, total: 1 }] });
    expect(service.downloadTaskPage({ ...filters, creatorId: liked }).total).toBe(1);
    expect(service.downloadTaskPage({ ...filters, creatorId: kept }).total).toBe(0);
    expect(service.roster({ enabled: 'all' }).total).toBe(3);
    expect(service.roster({ enabled: 'disabled' }).items.map(item => item.creatorId)).toEqual([off]);
    expect(service.roster({ q: 'Same' }).items.map(item => item.creatorId)).toEqual([liked, kept]);
    expect(service.stats({ q: 'does-not-exist' })).toMatchObject({ creators: { total: 0 }, execution: { download: { total: 0 } } });
  });

  it('finds later creators after the first 100 tasks and pages full detail summaries consistently', () => {
    const early = creator('A'), late = creator('Z'), a = collection(early), z = collection(late);
    for (let n = 1; n <= 107; n++) task(source(early, a, n).id, n % 2 ? 'ingested' : 'staged');
    for (let n = 1; n <= 3; n++) task(source(late, z, n).id, 'ingested');
    expect(service.downloadCreators({ limit: 1, page: 1 })).toMatchObject({ total: 2, taskTotal: 110, hasMore: true, items: [{ creatorId: early, total: 107 }] });
    expect(service.downloadCreators({ limit: 1, page: 2 })).toMatchObject({ total: 2, taskTotal: 110, hasMore: false, items: [{ creatorId: late, total: 3 }] });
    const detail = service.downloadTaskPage({ creatorId: early, limit: 50, page: 3 });
    expect(detail).toMatchObject({ total: 107, hasMore: false, summary: { total: 107, ingested: 54, staged: 53 } });
    expect(detail.items).toHaveLength(7);
    const ids = [1, 2, 3].flatMap(page => service.downloadTaskPage({ creatorId: early, limit: 50, page }).items.map(item => item.id));
    expect(new Set(ids).size).toBe(107);
    expect(service.downloadTaskPage({ creatorId: early, page: 999 })).toMatchObject({ items: [], total: 107, summary: { total: 107 } });
    expect(service.downloadCreators({ status: 'ingested', limit: 1, page: 2 })).toMatchObject({ total: 2, taskTotal: 57, items: [{ creatorId: late, total: 3 }] });
    expect(service.downloadTaskPage({ creatorId: early, status: 'staged' }).summary.total).toBe(53);
  });

  it('returns the existing task detail shape without delivery JOIN multiplication', () => {
    const a = creator('A'), col = collection(a), s = source(a, col, 1), t = task(s.id);
    delivery(col, false); delivery(col, true, 'second');
    const expected = new ArchiveDownloadTaskService(db).get(t);
    expect(service.downloadTaskPage({ creatorId: a }).items).toEqual([expected]);
    expect(service.downloadCreators().summary.total).toBe(1);
  });

  it('lists unlinked directories separately and treats invalid cross-creator matched rows as unresolved', () => {
    const a = creator('A'), b = creator('B'), first = source(a, collection(a), 1);
    local(folder(b, 'WrongOwner'), first.workId);
    local(folder(null, 'UnknownOne'), null); local(folder(null, 'UnknownTwo'), null);
    expect(service.stats()).toMatchObject({ creators: { total: 2, withLocal: 1 }, works: { local: 1, matchedLocal: 0, unresolvedLocal: 1, missing: 1 },
      unlinkedLocalFolders: { total: 2, localWorks: 2, scope: 'all-unlinked' } });
    expect(service.stats({ q: 'no-match' }).unlinkedLocalFolders).toMatchObject({ total: 2, scope: 'all-unlinked' });
  });

  it('performs a bounded number of set queries, reads under query_only and never turns failures into zero', () => {
    const a = creator('A'), col = collection(a), s = source(a, col, 1); task(s.id);
    for (let n = 0; n < 110; n++) creator(`Roster-${n}`);
    const before = snapshot(); db.exec('PRAGMA query_only=ON');
    const prepare = vi.spyOn(db, 'prepare');
    service.roster({ limit: 100 }); expect(prepare).toHaveBeenCalledTimes(2); prepare.mockClear();
    service.stats(); expect(prepare).toHaveBeenCalledTimes(5); prepare.mockClear();
    service.downloadCreators(); expect(prepare).toHaveBeenCalledTimes(2); prepare.mockClear();
    service.downloadTaskPage({ creatorId: a }); expect(prepare).toHaveBeenCalledTimes(3); prepare.mockRestore();
    expect(snapshot()).toBe(before);
    expect(() => service.roster({ page: 0 })).toThrow();
    expect(() => service.roster({ enabled: 'invalid' as 'all' })).toThrow();
    expect(() => service.downloadTaskPage({ creatorId: 0 })).toThrow();
    expect(() => service.downloadTaskPage({ creatorId: 99999 })).toThrow(/不存在/);
    expect(() => service.downloadCreators({ status: 'bad' as ArchiveDownloadTaskStatus })).toThrow();
    db.exec('PRAGMA query_only=OFF; DROP TABLE archive_catalog_download_tasks');
    expect(() => service.stats()).toThrow();
    expect(() => service.downloadCreators()).toThrow();
  });
});
