import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { CreatorSyncQueryService } from '../src/services/creator-sync-query-service.js';
import { ArchiveDownloadTaskService, type ArchiveDownloadTaskStatus } from '../src/services/archive-download-task-service.js';
import { normalizeCreatorIdentity } from '../src/utils/creator-identity.js';
import { DOWNLOAD_STAGED_AT_PREFIX } from '../src/services/archive-download-activity.js';

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
    (source_work_id,provider,target_root,target_relative_directory,target_filename,status,created_at,updated_at) VALUES(?,'baidu','/synthetic/inbox','Creator',?,?,?,?)`)
    .run(sourceId, `${sourceId}.7z`, status, timestamp, timestamp).lastInsertRowid);
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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

  it('evaluates the full roster once per request and never retains coverage across reads', () => {
    const id=creator('Request snapshot'), col=collection(id), s=source(id,col,1);
    task(s.id,'staged');
    const prepare=vi.spyOn(db,'prepare');
    for(const read of [()=>service.roster(),()=>service.stats(),()=>service.metadataCreators(),()=>service.downloadCreators(),()=>service.downloadTaskPage({creatorId:id})]) {
      prepare.mockClear();read();
      expect(prepare.mock.calls.filter(([sql])=>sql.includes('local_rows AS MATERIALIZED'))).toHaveLength(1);
    }
    expect(service.stats().works.missing).toBe(1);
    local(folder(id,'New local'),s.workId);
    expect(service.stats().works.missing).toBe(0);
    expect(service.metadataCreators().items[0].missingWorks).toBe(0);
    expect(service.roster({page:2,limit:1})).toMatchObject({total:1,items:[]});
  });

  it('materializes status-filtered task aggregates instead of decoding the roster for every task', () => {
    const id=creator('Filtered staged'), col=collection(id);
    for(let n=1;n<=3;n++)task(source(id,col,n).id,n===3?'claimed':'staged');
    const prepare=vi.spyOn(db,'prepare');
    const result=service.downloadCreators({status:'staged',sort:'recent'});
    expect(result).toMatchObject({total:1,taskTotal:2,summary:{staged:2,claimed:0}});
    const activity=prepare.mock.calls.map(([sql])=>sql).find(sql=>sql.includes('FROM ordered_creators'))!;
    expect(activity).toContain('roster AS MATERIALIZED');
    expect(activity).toContain('cohort AS MATERIALIZED');
    // Keep task_scope flattenable: count/order-only reads must not eagerly
    // compute acceptance snapshots they do not use.
    expect(activity).toContain('task_scope AS (');
    expect(activity).toContain('activity_tasks AS MATERIALIZED');
  });

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

  it('keeps pending supplemental evidence separate from numbered work and task totals', () => {
    const a = creator('A'), col = collection(a), retired = collection(a), other = creator('B');
    source(a, col, 1);
    const pending = { sourceOrderKey: 'SPECIAL:微博图', label: '微博图', rawTitle: 'A 微博图[354P-1.8GB]', status: 'awaiting_review' };
    db.prepare('UPDATE archive_catalog_collections SET metadata_json=? WHERE id=?').run(JSON.stringify({ supplementalContents: [pending, pending,
      { label: '已处理内容', status: 'completed' }, 'invalid entry', 1, null] }), col);
    db.prepare('UPDATE archive_catalog_collections SET metadata_json=?,is_active=0 WHERE id=?').run(JSON.stringify({ supplementalContents: [{ ...pending, label: '旧附加内容' }] }), retired);
    db.prepare('UPDATE archive_catalog_collections SET metadata_json=? WHERE id=?').run('not json', collection(other));
    const before = snapshot();
    expect(service.roster({ q: 'A' }).items[0]).toMatchObject({ pendingSupplementalTitles: ['微博图'], sourceWorks: 1, missingWorks: 1 });
    expect(service.metadataCreators().items[0].pendingSupplementalTitles).toEqual(['微博图']);
    expect(service.roster({ q: 'B' }).items[0].pendingSupplementalTitles).toEqual([]);
    expect(service.stats()).toMatchObject({ works: { source: 1, missing: 1 }, execution: { download: { total: 0 } } });
    expect(snapshot()).toBe(before);
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

  it('projects the Stage1 source/task union with independent real evidence and task timestamps', () => {
    const historical = creator('Same'), failed = creator('Same'), absent = creator('Not found');
    const empty = creator('Empty collection'), retired = creator('Inactive source'), other = creator('Other source task');
    collection(empty);
    const historicalCollection = collection(historical);
    source(historical, historicalCollection, 1); source(historical, collection(historical), 2); delivery(historicalCollection, true);
    source(failed, collection(failed), 1);
    const inactiveSource = source(retired, collection(retired), 1);
    db.prepare('UPDATE archive_catalog_source_works SET is_active=0 WHERE id=?').run(inactiveSource.id);
    const updatedAt = '2026-09-09T03:00:00Z';
    for (const [id, status] of [[failed, 'failed'], [absent, 'not_found']] as const) {
      db.prepare(`INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status,attempt_count,last_error,updated_at)
        VALUES(?,'costuan',?,2,'Real attempt error',?)`).run(id, status, updatedAt);
    }
    db.prepare("INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status) VALUES(?,'other','pending')").run(other);
    const before = snapshot(); db.exec('PRAGMA query_only=ON');
    const result = service.metadataCreators();
    expect(result).toMatchObject({ total: 3, summary: { sourceCreators: 2, sourceCollections: 3,
      taskTotal: 2, tasks: { total: 2, failed: 1, not_found: 1, completed: 0 } } });
    expect(result.items.find(row => row.creatorId === historical)).toMatchObject({ metadataTask: null,
      sourceCollections: 2, latestSourceAt: timestamp, sourceState: { metadataAccepted: true, deliveryEvidence: 'verified' } });
    expect(result.items.find(row => row.creatorId === failed)).toMatchObject({ latestSourceAt: timestamp,
      sourceState: { metadataAccepted: true }, metadataTask: { status: 'failed', attemptCount: 2, updatedAt, lastError: 'Real attempt error' } });
    expect(result.items.find(row => row.creatorId === absent)).toMatchObject({ latestSourceAt: null,
      sourceState: { metadataAccepted: false }, metadataTask: { status: 'not_found', updatedAt } });
    expect(service.metadataCreators({ q: 'Same' }).total).toBe(2);
    expect(service.metadataCreators({ source: 'absent' }).items.map(row => row.creatorId)).toEqual([absent]);
    expect(service.metadataCreators({ status: 'no_task' })).toMatchObject({ total: 1, summary: { taskTotal: 0 } });
    expect(service.metadataCreators({ status: 'failed' })).toMatchObject({ total: 1, summary: { sourceCreators: 1, taskTotal: 1 } });
    expect(snapshot()).toBe(before);
  });

  it('paginates the complete Stage1 union beyond 100 creators with full filtered summaries', () => {
    const ids: number[] = [];
    for (let n = 0; n < 107; n++) {
      const id = creator(`Creator ${String(n).padStart(3, '0')}`); ids.push(id);
      if (n % 2 === 0) source(id, collection(id), 1);
      else db.prepare("INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status) VALUES(?,'costuan','pending')").run(id);
    }
    const first = service.metadataCreators({ limit: 100 });
    const second = service.metadataCreators({ limit: 100, page: 2 });
    expect(first).toMatchObject({ total: 107, hasMore: true, summary: { sourceCreators: 54, sourceCollections: 54, taskTotal: 53 } });
    expect(second).toMatchObject({ total: 107, hasMore: false, summary: first.summary });
    expect(second.items).toHaveLength(7);
    expect([...first.items, ...second.items].map(row => row.creatorId)).toEqual(ids);
    expect(service.metadataCreators({ page: 999 })).toMatchObject({ total: 107, items: [], summary: first.summary });
    expect(service.metadataCreators({ q: 'Creator 106' }).items.map(row => row.creatorId)).toEqual([ids[106]]);
    expect(service.metadataCreators({ q: 'missing' })).toMatchObject({ total: 0, summary: { sourceCreators: 0, sourceCollections: 0, taskTotal: 0 } });
    expect(() => service.metadataCreators({ status: 'bad' as 'failed' })).toThrow();
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

  it('orders Stage2 recent events before preference across pages and preserves explicit name ordering', () => {
    const old = creator('A liked', 'liked'), middle = creator('B kept', 'kept'), newest = creator('Z recent', null);
    for (const [id, time] of [[old, '2026-09-09T00:00:00Z'], [middle, '2026-09-10T00:00:00Z'], [newest, '2026-09-11T00:00:00Z']] as const) {
      const t = task(source(id, collection(id), 1).id, 'staged');
      db.prepare('UPDATE archive_catalog_download_tasks SET updated_at=? WHERE id=?').run(time, t);
    }
    const before = snapshot(); db.exec('PRAGMA query_only=ON');
    const pages = [1, 2, 3].map(page => service.downloadCreators({ page, limit: 1 }));
    expect(pages.flatMap(page => page.items.map(row => row.creatorId))).toEqual([newest, middle, old]);
    for (const page of pages) expect(page).toMatchObject({ total: 3, taskTotal: 3, summary: { staged: 3 } });
    expect(pages.map(page => page.hasMore)).toEqual([true, true, false]);
    expect(service.downloadCreators({ sort: 'recent' }).items.map(row => row.creatorId)).toEqual([newest, middle, old]);
    expect(service.downloadCreators({ sort: 'name' }).items.map(row => row.creatorId)).toEqual([old, middle, newest]);
    expect(() => service.downloadCreators({ sort: 'invalid' as 'recent' })).toThrow();
    expect(snapshot()).toBe(before);
  });

  it('keeps the actual staging order after local reconciliation clears claims and overwrites task timestamps', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = creator('A latest staged'), b = creator('B older staged');
    const sa = source(a, collection(a), 1), sb = source(b, collection(b), 1);
    const ta = task(sa.id, 'claimed'), tb = task(sb.id, 'claimed');
    const downloads = new ArchiveDownloadTaskService(db);
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    downloads.update(tb, { status: 'staged' });
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    downloads.update(ta, { status: 'staged' });
    const expected = [a, b];
    expect(service.downloadCreators().items.map(row => row.creatorId)).toEqual(expected);
    local(folder(a, 'A'), sa.workId);
    vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
    expect(downloads.planMissing({ targetRoot: '/synthetic/inbox', creatorIds: [a] }).reconciledLocal).toBe(1);
    expect(downloads.get(ta)).toMatchObject({ status: 'ingested', claimedAt: null, updatedAt: '2026-09-12T00:00:00.000Z' });
    // A new query service/process reads durable evidence, not a transient sort cache.
    db.exec('PRAGMA query_only=ON');
    expect([1, 2].flatMap(page => new CreatorSyncQueryService(db).downloadCreators({ page, limit: 1 }).items.map(row => row.creatorId)))
      .toEqual(expected);
    expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(`${DOWNLOAD_STAGED_AT_PREFIX}${ta}`))
      .toEqual({ value: '2026-09-11T00:00:00.000Z' });
  });

  it('preserves legacy staging evidence without promoting receipt replays, and records a genuine restaging', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = creator('A old staging'), b = creator('B recent staging');
    const ta = task(source(a, collection(a), 1).id, 'staged');
    const tb = task(source(b, collection(b), 1).id, 'staged');
    db.prepare('UPDATE archive_catalog_download_tasks SET updated_at=? WHERE id=?').run('2026-09-09T00:00:00Z', ta);
    db.prepare('UPDATE archive_catalog_download_tasks SET updated_at=? WHERE id=?').run('2026-09-10T00:00:00Z', tb);
    const downloads = new ArchiveDownloadTaskService(db);
    vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
    downloads.update(ta, { status: 'staged' });
    expect(service.downloadCreators().items.map(row => row.creatorId)).toEqual([b, a]);
    downloads.update(ta, { status: 'pending' });
    downloads.update(ta, { status: 'claimed' });
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    downloads.update(ta, { status: 'staged' });
    expect(service.downloadCreators().items.map(row => row.creatorId)).toEqual([a, b]);
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    downloads.update(ta, { status: 'downloaded' });
    downloads.update(ta, { status: 'ingested' });
    expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(`${DOWNLOAD_STAGED_AT_PREFIX}${ta}`))
      .toEqual({ value: '2026-09-13T00:00:00.000Z' });
    expect(service.downloadCreators().items.map(row => row.creatorId)).toEqual([a, b]);
    expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(`${DOWNLOAD_STAGED_AT_PREFIX}${tb}`)).toBeUndefined();
  });

  it('preserves existing staged timestamps in the selected local reconciliation scope but never invents ingested history', () => {
    const a = creator('A'), b = creator('B');
    const sa = source(a, collection(a), 1), sb = source(b, collection(b), 1);
    const ta = task(sa.id, 'staged'), tb = task(sb.id, 'staged');
    const old = task(source(a, collection(a), 2).id, 'ingested');
    local(folder(a, 'A'), sa.workId);
    new ArchiveDownloadTaskService(db).planMissing({ targetRoot: '/synthetic/inbox', creatorIds: [a] });
    expect(db.prepare('SELECT key,value FROM app_settings WHERE key LIKE ?').all(`${DOWNLOAD_STAGED_AT_PREFIX}%`))
      .toEqual([{ key: `${DOWNLOAD_STAGED_AT_PREFIX}${ta}`, value: timestamp }]);
    expect(new ArchiveDownloadTaskService(db).get(tb)?.status).toBe('staged');
    expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(`${DOWNLOAD_STAGED_AT_PREFIX}${old}`)).toBeUndefined();
  });

  it('rolls back the status write if durable staging evidence cannot be saved', () => {
    const a = creator('A'), ta = task(source(a, collection(a), 1).id, 'claimed');
    db.exec(`CREATE TRIGGER reject_staging_evidence BEFORE INSERT ON app_settings
      WHEN NEW.key LIKE '${DOWNLOAD_STAGED_AT_PREFIX}%' BEGIN SELECT RAISE(ABORT,'fixture evidence failure'); END;`);
    const before = snapshot();
    expect(() => new ArchiveDownloadTaskService(db).update(ta, { status: 'staged' })).toThrow('fixture evidence failure');
    expect(snapshot()).toBe(before);
  });

  it('pins metadata and download activity using all creator tasks even when status filters hide the active task', () => {
    const recent = creator('A recent'), metadata = creator('B metadata'), claimed = creator('C claimed'), downloading = creator('D downloading');
    for (const id of [recent, metadata, claimed, downloading]) {
      const col = collection(id), staged = task(source(id, col, 1).id, 'staged');
      db.prepare('UPDATE archive_catalog_download_tasks SET updated_at=? WHERE id=?')
        .run(id === recent ? '2026-09-11T00:00:00Z' : timestamp, staged);
      if (id === claimed || id === downloading) {
        const active = task(source(id, col, 2).id, id === claimed ? 'claimed' : 'downloading');
        db.prepare('UPDATE archive_catalog_download_tasks SET claimed_at=?,claimed_by=? WHERE id=?').run(timestamp, 'fixture-worker', active);
      }
    }
    db.prepare(`INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status,claimed_at,claimed_by,attempt_count)
      VALUES(?,'costuan','claimed',?,'fixture-worker',1)`).run(metadata, timestamp);
    const all = service.downloadCreators();
    expect(new Set(all.items.slice(0, 3).map(row => row.creatorId))).toEqual(new Set([metadata, claimed, downloading]));
    expect(all.items[3].creatorId).toBe(recent);
    const filtered = service.downloadCreators({ status: 'staged' });
    expect(filtered.items.map(row => row.creatorId)).toEqual(all.items.map(row => row.creatorId));
    expect(filtered).toMatchObject({ total: 4, taskTotal: 4, summary: { staged: 4, claimed: 0, downloading: 0 } });
  });

  it('compares actual instants across timezone formats and leaves invalid fallback dates last with stable identity ties', () => {
    const earlier = creator('A offset'), later = creator('Z UTC'), tie1 = creator('Same'), tie2 = creator('Same'), invalid = creator('A invalid');
    for (const [id, time] of [[earlier, '2026-09-11T10:00:00+08:00'], [later, '2026-09-11T03:00:00Z'],
      [tie1, '2026-09-10T00:00:00Z'], [tie2, '2026-09-10T00:00:00Z'], [invalid, 'not-a-date']] as const) {
      const col = collection(id), s = source(id, col, 1); task(s.id);
      db.prepare('UPDATE archive_catalog_collections SET observed_at=? WHERE id=?').run(time, col);
      db.prepare('UPDATE archive_catalog_source_works SET last_seen_at=? WHERE id=?').run(time, s.id);
    }
    expect(service.downloadCreators().items.map(row => row.creatorId)).toEqual([later, earlier, tie1, tie2, invalid]);
  });

  it('ignores Stage3 completion and unrelated updates while keeping trusted prior checks after a pending reopen', () => {
    const old = creator('A ingested'), history = creator('B reopened'), current = creator('C checked'), failed = creator('D failed');
    for (const id of [old, history, current, failed]) task(source(id, collection(id), 1).id, 'ingested');
    db.prepare("UPDATE archive_catalog_download_tasks SET updated_at='2099-01-01T00:00:00Z',completed_at='2099-01-01T00:00:00Z'").run();
    const insert = db.prepare(`INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status,attempt_count,completed_at,updated_at)
      VALUES(?,'costuan',?,?,?,?)`);
    insert.run(old, 'completed', 0, '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z');
    const h = Number(insert.run(history, 'pending', 2, null, '2099-01-01T00:00:00Z').lastInsertRowid);
    const c = Number(insert.run(current, 'completed', 1, '2026-09-09T00:00:00Z', '2099-01-01T00:00:00Z').lastInsertRowid);
    insert.run(failed, 'failed', 1, null, '2026-09-09T12:00:00Z');
    const context = db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)');
    context.run(`archive.metadata-task.context.${h}`, JSON.stringify({ checkRoundId: 'new-round', history: [
      'malformed history entry', null, 42,
      { status: 'completed', attemptCount: 1, completedAt: '2026-09-10T00:00:00Z', receipt: { receiptId: 'prior-receipt' } },
      { status: 'completed', attemptCount: 0, completedAt: '2099-01-01T00:00:00Z' },
      { status: 'pending', attemptCount: 2, completedAt: '2099-01-01T00:00:00Z' }
    ] }));
    context.run(`archive.metadata-task.context.${c}`, JSON.stringify({ receipt: { receiptId: 'current-receipt' } }));
    const before = snapshot(); db.exec('PRAGMA query_only=ON');
    expect(service.downloadCreators().items.map(row => row.creatorId)).toEqual([history, failed, current, old]);
    expect(snapshot()).toBe(before);
  });

  it('does not promote unclaimed pending work or receiptless synthetic completion over real result evidence', () => {
    const pending = creator('A pending'), synthetic = creator('B synthetic'), notFound = creator('C not found'), claimed = creator('D staged claim');
    for (const id of [pending, synthetic, notFound, claimed]) {
      const t = task(source(id, collection(id), 1).id);
      if (id === claimed) db.prepare("UPDATE archive_catalog_download_tasks SET status='failed',claimed_at='2026-09-10T00:00:00Z' WHERE id=?").run(t);
    }
    const insert = db.prepare(`INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status,attempt_count,completed_at,updated_at)
      VALUES(?,'costuan',?,?,?,?)`);
    insert.run(pending, 'pending', 4, null, '2099-01-01T00:00:00Z');
    insert.run(synthetic, 'completed', 1, '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z');
    insert.run(notFound, 'not_found', 1, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z');
    expect(service.downloadCreators().items.map(row => row.creatorId)).toEqual([claimed, notFound, pending, synthetic]);
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
    // One expensive roster read plus bounded lightweight aggregate queries.
    service.roster({ limit: 100 }); expect(prepare).toHaveBeenCalledTimes(3); prepare.mockClear();
    service.metadataCreators({ limit: 100 }); expect(prepare).toHaveBeenCalledTimes(4); prepare.mockClear();
    service.stats(); expect(prepare).toHaveBeenCalledTimes(6); prepare.mockClear();
    service.downloadCreators(); expect(prepare).toHaveBeenCalledTimes(4); prepare.mockClear();
    service.downloadTaskPage({ creatorId: a }); expect(prepare).toHaveBeenCalledTimes(4); prepare.mockRestore();
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
