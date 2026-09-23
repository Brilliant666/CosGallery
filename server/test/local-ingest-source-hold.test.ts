import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { LocalIngestService } from '../src/services/local-ingest-service.js';
import type { LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';

const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db); db.exec(schemaSql);
  db.exec(`
    INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'Synthetic','synthetic','fixture','one');
    INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at)
      VALUES(1,1,'costuan','fixture','Fixture','now');
    INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'One'),(2,1,'Two');
    INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order,source_title,first_seen_at,last_seen_at)
      VALUES(1,1,1,'costuan','NO.001',1,'One','now','now'),(2,2,1,'costuan','NO.002',2,'Two','now','now');
    INSERT INTO archive_catalog_download_tasks(id,source_work_id,provider,target_root,target_relative_directory,target_filename,status,attempt_count,created_at,updated_at)
      VALUES(1,1,'baidu','/fixture/inbox','Synthetic','001.7z','downloaded',2,'before','before'),
            (2,2,'baidu','/fixture/inbox','Synthetic','002.7z','downloaded',2,'before','before');
    INSERT INTO local_ingest_jobs(id,archive_download_task_id,source_work_id,creator_id,source_archive_path,source_archive_name,source_archive_size,source_archive_mtime,source_archive_sha256)
      VALUES(1,1,1,1,'/fixture/inbox/Synthetic/001.7z','001.7z',1,1,'fixture-one'),
            (2,2,2,1,'/fixture/inbox/Synthetic/002.7z','002.7z',1,1,'fixture-two');
  `);
  const settings = { get: vi.fn(() => ({ allowlist: ['Synthetic'] })), getArchivePassword: vi.fn(() => '') };
  const hashFile = vi.fn(), runCommand = vi.fn();
  const service = new LocalIngestService(db, settings as unknown as LocalIngestSettingsService,
    undefined, undefined, { hashFile, runCommand });
  // The real claim and admission barrier execute; successful-path archive I/O is
  // outside this focused test and must only be reached for non-held jobs.
  const execute = vi.spyOn(service as any, 'runClaimedJob').mockImplementation(async (id: unknown) => service.getJob(Number(id)));
  const checkedSettings = vi.spyOn(service as any, 'checkedSettings');
  const hold = () => db.prepare(`UPDATE archive_catalog_collections SET metadata_json=? WHERE id=1`)
    .run(JSON.stringify({ localSourceReuse: [{ sourceOrder: 'NO.001', status: 'review' }] }));
  const row = (id = 1) => db.prepare('SELECT * FROM local_ingest_jobs WHERE id=?').get(id)!;
  const tasks = () => db.prepare('SELECT * FROM archive_catalog_download_tasks ORDER BY id').all();
  return { db, service, execute, checkedSettings, hashFile, runCommand, hold, row, tasks };
}

describe('Stage3 durable source holds for unstarted jobs', () => {
  it.each(['queued', 'failed'])('rechecks a new source review before processing an old %s job', async status => {
    const f = fixture(); f.db.prepare('UPDATE local_ingest_jobs SET status=? WHERE id=1').run(status);
    const tasks = f.tasks(); f.hold();
    const result = await f.service.runJob(1);
    expect(result.status).toBe('awaiting_review');
    expect(f.row()).toMatchObject({ phase: 'mapping', error_code: 'SOURCE_ACQUISITION_REVIEW_REQUIRED',
      attempt_count: 0, processing_path: null, summary_json: null, claim_token: null, completed_at: null });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.checkedSettings).not.toHaveBeenCalled();
    expect(f.hashFile).not.toHaveBeenCalled(); expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.tasks()).toEqual(tasks);
  });

  it('honors a persisted local fulfillment without changing its decision or download history', async () => {
    const f = fixture();
    f.db.exec(`
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES(1,1,'/fixture/library','Synthetic','/fixture/library/Synthetic','Synthetic','matched','now');
      INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES(1,1,1,'One','/fixture/library/Synthetic/One','One','matched','now');
      INSERT INTO archive_catalog_work_decisions(id,decision_key,kind,work_id,local_work_id,source_work_id,reason,payload_json)
        VALUES(1,'fixture-accept','accept_version',1,1,1,'Synthetic acceptance','{}');
      INSERT INTO archive_catalog_local_fulfillments(decision_id,source_work_id,local_work_id,work_id,task_id,source_snapshot_json,local_snapshot_json,reason)
        VALUES(1,1,1,1,1,'{}','{}','Synthetic prior acceptance');
    `);
    const prior = f.db.prepare('SELECT * FROM archive_catalog_local_fulfillments').all(); const tasks = f.tasks();
    expect((await f.service.runJob(1)).status).toBe('awaiting_review');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.row().attempt_count).toBe(0);
    expect(f.db.prepare('SELECT * FROM archive_catalog_local_fulfillments').all()).toEqual(prior);
    expect(f.tasks()).toEqual(tasks);
  });

  it('does not change a job owned by another live claim', async () => {
    const f = fixture(); f.hold();
    f.db.prepare("UPDATE local_ingest_jobs SET claim_token='other-worker',claim_heartbeat_at=? WHERE id=1").run(new Date().toISOString());
    const before = f.row(); await f.service.runJob(1);
    expect(f.row()).toEqual(before); expect(f.execute).not.toHaveBeenCalled();
  });

  it('holds only the related batch item and excludes it from the next runnable batch', async () => {
    const f = fixture(); f.hold(); const tasks = f.tasks();
    const batch = await f.service.runBatch({ jobIds: [1, 2] });
    expect(batch.awaitingReview).toBe(1); expect(batch.failed).toBe(0);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledWith(2);
    expect(f.row(2).status).toBe('queued'); expect(f.tasks()).toEqual(tasks);
    expect((await f.service.runBatch({ jobIds: [1] })).total).toBe(0);
  });

  it.each([
    "UPDATE local_ingest_jobs SET attempt_count=1 WHERE id=1",
    "UPDATE local_ingest_jobs SET processing_path='/fixture/checkpoint' WHERE id=1",
    "UPDATE local_ingest_jobs SET summary_json='{}' WHERE id=1",
    "UPDATE local_ingest_jobs SET status='reconciling' WHERE id=1"
  ])('leaves existing checkpoint/reconciliation handling unchanged: %s', async sql => {
    const f = fixture(); f.hold(); f.db.exec(sql); await f.service.runJob(1);
    expect(f.execute).toHaveBeenCalledWith(1);
    expect(f.row().error_code).not.toBe('SOURCE_ACQUISITION_REVIEW_REQUIRED');
  });

  it('keeps the ordinary execution path for an unheld source', async () => {
    const f = fixture(); await f.service.runJob(1);
    expect(f.execute).toHaveBeenCalledWith(1); expect(f.row().status).toBe('queued');
    expect(f.row().error_code).toBeNull();
  });
});
