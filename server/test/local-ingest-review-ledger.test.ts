import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ArchiveDownloadTaskService } from '../src/services/archive-download-task-service.js';
import { ArchiveCatalogPipelineService } from '../src/services/archive-catalog-pipeline-service.js';
import { ArchiveCatalogService, type LocalReconciliationResult } from '../src/services/archive-catalog-service.js';
import { DOWNLOAD_STAGED_AT_PREFIX } from '../src/services/archive-download-activity.js';

const fixtures: Array<{ root: string; db: DatabaseSync; other?: DatabaseSync }> = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage3-review-ledger-'));
  const databasePath = path.join(root, 'isolated.sqlite');
  const db = new DatabaseSync(databasePath);
  const entry = { root, db, other: undefined as DatabaseSync | undefined };
  fixtures.push(entry);
  db.exec(schemaSql);
  db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
    VALUES(1,'Review creator','reviewcreator','test','review-1'),(2,'Other creator','othercreator','test','review-2');
    INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at)
    VALUES(1,1,'costuan','review-c1','Review collection','2024-01-01'),(2,2,'costuan','review-c2','Other collection','2024-01-01');`);
  for (const [id, creatorId, local] of [[1, 1, true], [2, 1, true], [3, 2, true], [4, 1, false]] as const) {
    db.prepare('INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(?,?,?)').run(id, creatorId, `Work ${id}`);
    db.prepare(`INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order,
      source_title,first_seen_at,last_seen_at) VALUES(?,?,?,'costuan',?,?,?,'2024-01-01','2024-01-01')`)
      .run(id, id, creatorId, `source-${id}`, id, `Work ${id}`);
    if (!local) continue;
    db.prepare(`INSERT INTO archive_catalog_download_tasks(id,source_work_id,provider,target_root,target_relative_directory,
      target_filename,status,claimed_by,claimed_at,started_at,completed_at,download_id,attempt_count,last_error,created_at,updated_at)
      VALUES(?,?,'baidu','inbox','Review creator',?,'staged','historical-worker','2024-01-01','2024-01-02','2024-01-03',
      'historical-download',5,'historical-error','2024-01-01','2024-01-04')`).run(id, id, `${id}.7z`);
  }
  for (const creatorId of [1, 2]) {
    db.prepare(`INSERT INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,
      match_status,is_active,scanned_at) VALUES(?,?,? ,?,?,?,'matched',1,'2024-01-01')`)
      .run(creatorId, creatorId, root, `creator-${creatorId}`, path.join(root, `creator-${creatorId}`), `creator-${creatorId}`);
  }
  for (const [id, creatorId] of [[1, 1], [2, 1], [3, 2]]) {
    db.prepare(`INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,
      image_count,total_bytes,match_status,is_active,scanned_at) VALUES(?,?,?,?,?,?,1,100,'matched',1,'2024-01-01')`)
      .run(id, creatorId, id, `work-${id}`, path.join(root, `creator-${creatorId}`, `work-${id}`), `work-${id}`);
  }
  const task = (id = 1) => db.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(id);
  const local: LocalReconciliationResult = { rootPath: root, creatorFolders: 1, matchedCreatorFolders: 1,
    unmatchedCreatorFolders: [], ambiguousCreatorFolders: [], localWorks: 1, matchedWorks: 1, unmatchedWorks: 0,
    ambiguousWorks: 0, bridgeReview: [] };
  return { ...entry, entry, databasePath, task, local, service: new ArchiveDownloadTaskService(db) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of fixtures.splice(0)) {
    item.other?.close();
    item.db.close();
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

describe('precise reviewed Stage3 ledger settlement', () => {
  it('settles only the original task while preserving staging, worker and execution history', async () => {
    const f = await fixture();
    f.db.exec("UPDATE archive_catalog_download_tasks SET status='claimed' WHERE id=2");
    const before = f.task()!, otherTasks = [f.task(2), f.task(3)];
    expect(f.service.reconcileReviewedLocalTask(1, 1)).toBe(1);
    const after = f.task()!;
    expect(after).toEqual({ ...before, status: 'ingested', updated_at: after.updated_at });
    expect([f.task(2), f.task(3)]).toEqual(otherTasks);
    expect(f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(`${DOWNLOAD_STAGED_AT_PREFIX}1`))
      .toEqual({ value: '2024-01-04' });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_download_tasks').get()).toEqual({ n: 3 });
    expect(f.service.reconcileReviewedLocalTask(1, 1)).toBe(0);
    expect(f.task()).toEqual(after);
  });

  it.each(['claimed', 'downloading'])('rejects active %s ownership without altering any task or staging record', async status => {
    const f = await fixture();
    f.db.prepare('UPDATE archive_catalog_download_tasks SET status=?,claimed_by=?,claimed_at=? WHERE id=1')
      .run(status, 'active-worker', '2026-09-21');
    const before = f.db.prepare('SELECT * FROM archive_catalog_download_tasks ORDER BY id').all();
    expect(() => f.service.reconcileReviewedLocalTask(1, 1)).toThrow('claim');
    expect(f.db.prepare('SELECT * FROM archive_catalog_download_tasks ORDER BY id').all()).toEqual(before);
    expect(f.db.prepare('SELECT * FROM app_settings').all()).toEqual([]);
  });

  it.each(['creator', 'inactive-local', 'inactive-folder', 'foreign-folder', 'manual-decision', 'cancelled'])
    ('refuses invalid %s evidence instead of settling by filename or counts', async variant => {
      const f = await fixture();
      if (variant === 'inactive-local') f.db.exec('UPDATE archive_catalog_local_works SET is_active=0 WHERE id=1');
      if (variant === 'inactive-folder') f.db.exec('UPDATE archive_catalog_local_creator_folders SET is_active=0 WHERE id=1');
      if (variant === 'foreign-folder') f.db.exec('UPDATE archive_catalog_local_works SET local_creator_folder_id=2 WHERE id=1');
      if (variant === 'manual-decision') f.db.exec(`INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,reason,payload_json)
        VALUES('explicit-test','not_same',1,1,'preserved decision','{}')`);
      if (variant === 'cancelled') f.db.exec("UPDATE archive_catalog_download_tasks SET status='cancelled' WHERE id=1");
      const before = f.task();
      expect(() => f.service.reconcileReviewedLocalTask(1, variant === 'creator' ? 2 : 1)).toThrow();
      expect(f.task()).toEqual(before);
      expect(f.db.prepare('SELECT * FROM app_settings').all()).toEqual([]);
    });

  it('takes an SQLite writer lock before reading activity and keeps the update atomic across connections', async () => {
    const f = await fixture();
    const other = new DatabaseSync(f.databasePath);
    f.entry.other = other;
    other.exec('PRAGMA busy_timeout=0');
    const originalPrepare = f.db.prepare.bind(f.db);
    let attempted = false;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (sql.includes('SELECT tasks.source_work_id, tasks.status')) {
        attempted = true;
        expect(() => other.exec("UPDATE archive_catalog_download_tasks SET status='claimed',claimed_by='competing-worker' WHERE id=1"))
          .toThrow(/locked|busy/i);
      }
      return originalPrepare(sql);
    });
    expect(f.service.reconcileReviewedLocalTask(1, 1)).toBe(1);
    expect(attempted).toBe(true);
    expect(f.task()!.claimed_by).toBe('historical-worker');
  });

  it('uses exact review settlement after the scoped local refresh and never invokes creator-wide planning', async () => {
    const f = await fixture();
    const refresh = vi.spyOn(ArchiveCatalogService.prototype, 'reconcileLocalCreators').mockResolvedValue(f.local);
    const broadPlan = vi.spyOn(ArchiveDownloadTaskService.prototype, 'planMissing');
    const otherTasks = [f.task(2), f.task(3)];
    const result = await new ArchiveCatalogPipelineService(f.db).refreshAfterCreatorGalleryScan({
      galleryRoot: f.root, creatorId: 1, creatorFolderName: 'Review creator', workFolderName: 'work-1', reviewDownloadTaskId: 1
    });
    expect(refresh).toHaveBeenCalledWith({ rootPath: f.root, creators: [{ creatorId: 1, folderName: 'Review creator' }],
      workFolderName: 'work-1', onProgress: undefined });
    expect(broadPlan).not.toHaveBeenCalled();
    expect(result.plan).toMatchObject({ created: 0, removedOutOfScope: 0, reconciledLocal: 1 });
    expect([f.task(2), f.task(3)]).toEqual(otherTasks);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_download_tasks').get()).toEqual({ n: 3 });
  });

  it.each(['claimed', 'downloading'])('preserves a %s claim acquired during asynchronous local reconciliation', async status => {
    const f = await fixture();
    vi.spyOn(ArchiveCatalogService.prototype, 'reconcileLocalCreators').mockImplementation(async () => {
      await Promise.resolve();
      f.db.prepare('UPDATE archive_catalog_download_tasks SET status=?,claimed_by=?,claimed_at=? WHERE id=1')
        .run(status, 'new-worker-during-scan', '2026-09-21');
      return f.local;
    });
    const broadPlan = vi.spyOn(ArchiveDownloadTaskService.prototype, 'planMissing');
    const before = f.task()!, otherTasks = [f.task(2), f.task(3)];
    await expect(new ArchiveCatalogPipelineService(f.db).refreshAfterCreatorGalleryScan({ galleryRoot: f.root,
      creatorId: 1, creatorFolderName: 'Review creator', workFolderName: 'work-1', reviewDownloadTaskId: 1 }))
      .rejects.toThrow('claim');
    expect(f.task()).toEqual({ ...before, status, claimed_by: 'new-worker-during-scan', claimed_at: '2026-09-21' });
    expect([f.task(2), f.task(3)]).toEqual(otherTasks);
    expect(broadPlan).not.toHaveBeenCalled();
  });

  it('keeps the ordinary creator pipeline on its existing planning path', async () => {
    const f = await fixture();
    vi.spyOn(ArchiveCatalogService.prototype, 'reconcileLocalCreators').mockResolvedValue(f.local);
    const plan = { created: 2, existing: 3, removedOutOfScope: 0, reconciledLocal: 1,
      skippedWithoutOrder: 0, skippedWithoutDelivery: 0, targetRoot: 'inbox' };
    const broadPlan = vi.spyOn(ArchiveDownloadTaskService.prototype, 'planMissing').mockReturnValue(plan);
    const exact = vi.spyOn(ArchiveDownloadTaskService.prototype, 'reconcileReviewedLocalTask');
    const result = await new ArchiveCatalogPipelineService(f.db).refreshAfterCreatorGalleryScan({ galleryRoot: f.root,
      creatorId: 1, creatorFolderName: 'Review creator', workFolderName: 'work-1' });
    expect(broadPlan).toHaveBeenCalledWith({ targetRoot: 'inbox', provider: 'baidu', creatorIds: [1] });
    expect(exact).not.toHaveBeenCalled();
    expect(result.plan).toEqual(plan);
  });
});
