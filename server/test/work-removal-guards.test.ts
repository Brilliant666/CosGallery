import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import {
  WorkIdentityService,
  type LocalIdentityInput,
} from '../src/services/work-identity-service.js';
import { ArchiveDownloadTaskService } from '../src/services/archive-download-task-service.js';
import { LocalFolderAdmissionService } from '../src/services/local-folder-admission-service.js';
import { LocalIngestService } from '../src/services/local-ingest-service.js';
import {
  assertPathNotRemoved,
  assertWorkNotRemoved,
  isRemovedPath,
} from '../src/services/work-removal-guards.js';
import { sourceNeedsAcquisitionSql } from '../src/services/archive-local-fulfillment-service.js';

describe('removed Work acquisition barriers', () => {
  let db: DatabaseSync,
    identity: WorkIdentityService,
    input: LocalIdentityInput,
    workId: number;
  const root = path.resolve('synthetic-removal-guards');
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
   VALUES(1,'Synthetic','synthetic','fixture','one');
   INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at)
   VALUES(1,1,'costuan','fixture','Fixture','now');`);
    identity = new WorkIdentityService(db);
    input = {
      creatorId: 1,
      rootPath: root,
      creatorFolderName: 'Synthetic',
      absolutePath: path.join(root, 'Synthetic', 'Album'),
      relativePath: 'Album',
      title: 'Album',
      key: 'original',
      reason: 'Synthetic fixture',
    };
    const registered = identity.registerLocal(input);
    workId = registered.workId;
    db.prepare(
      `INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order,source_title,first_seen_at,last_seen_at)
   VALUES(1,?,1,'costuan','NO.001',1,'Album','now','now')`,
    ).run(workId);
    db.exec(`INSERT INTO archive_catalog_download_tasks(id,source_work_id,provider,target_root,target_relative_directory,target_filename,status)
   VALUES(1,1,'baidu','/inbox','Synthetic','001.7z','failed');`);
    db.prepare(
      `INSERT INTO removal_operations(operation_id,kind,target_id,mode,state,payload_json,created_at,updated_at)
   VALUES('remove','work',?,'trash','completed','{}','now','now')`,
    ).run(workId);
    db.prepare(
      `INSERT INTO work_removal_paths(work_id,local_work_id,absolute_path,relative_path) VALUES(?,?,?,'Synthetic/Album')`,
    ).run(workId, registered.localWorkId, input.absolutePath);
    db.prepare(
      `INSERT INTO work_removals(work_id,state,operation_id,snapshot_json,created_at) VALUES(?,'trashed','remove','{}','now')`,
    ).run(workId);
    db.prepare(
      'UPDATE archive_catalog_local_works SET is_active=0 WHERE id=?',
    ).run(registered.localWorkId);
  });
  afterEach(() => db.close());
  it('blocks path descendants and exact identities without blocking a similarly named sibling; restore removes the barrier', () => {
    expect(() => assertWorkNotRemoved(db, workId)).toThrow(/回收站/);
    expect(() =>
      assertPathNotRemoved(
        db,
        path.join(input.absolutePath, 'nested', 'a.jpg'),
      ),
    ).toThrow(/目标目录/);
    expect(isRemovedPath(db, `${input.absolutePath}-other`)).toBe(false);
    if (process.platform === 'win32')
      expect(isRemovedPath(db, input.absolutePath.toUpperCase())).toBe(true);
    db.prepare('DELETE FROM work_removals WHERE work_id=?').run(workId);
    expect(() => assertWorkNotRemoved(db, workId)).not.toThrow();
    expect(isRemovedPath(db, input.absolutePath)).toBe(false);
    expect(identity.registerLocal(input).workId).toBe(workId);
  });
  it('blocks both the old registration replay and a new copy attached to the same Work', () => {
    expect(() => identity.registerLocal(input)).toThrow(/已移除/);
    expect(() =>
      identity.registerLocal({
        ...input,
        key: 'copy',
        relativePath: 'Copy',
        absolutePath: path.join(root, 'Synthetic', 'Copy'),
        workId,
      }),
    ).toThrow(/回收站/);
    expect(() =>
      identity.registerLocal({
        ...input,
        key: 'source',
        relativePath: 'Copy',
        absolutePath: path.join(root, 'Synthetic', 'Copy'),
        sourceWorkId: 1,
      }),
    ).toThrow(/回收站/);
    expect(
      db.prepare('SELECT COUNT(*) n FROM archive_catalog_local_works').get(),
    ).toEqual({ n: 1 });
  });
  it('holds existing download retries, seed claims and planning without rewriting the task history', () => {
    const tasks = new ArchiveDownloadTaskService(db),
      history = db
        .prepare('SELECT * FROM archive_catalog_download_tasks')
        .all();
    expect(tasks.get(1)?.acquisitionState).toBe('review_required');
    expect(
      tasks.planMissing({ targetRoot: '/inbox', creatorIds: [1] }).created,
    ).toBe(0);
    expect(() => tasks.claim({ workerId: 'test', seedTaskId: 1 })).toThrow();
    expect(() => tasks.update(1, { status: 'pending' })).toThrow();
    expect(
      db
        .prepare(
          `SELECT ${sourceNeedsAcquisitionSql('s')} AS missing FROM archive_catalog_source_works s WHERE id=1`,
        )
        .get(),
    ).toEqual({ missing: 0 });
    expect(
      db.prepare('SELECT * FROM archive_catalog_download_tasks').all(),
    ).toEqual(history);
  });
  it('rejects a stale folder-admission plan before any filesystem check or scan starts', async () => {
    const admission = new LocalFolderAdmissionService(db, root);
    const plan = {
      version: 1,
      planId: 'synthetic',
      confirmed: true,
      creatorId: 1,
      inputRoot: path.resolve('synthetic-inbox'),
      galleryRoot: root,
      creatorDirectory: 'Synthetic',
      items: [
        {
          key: 'album',
          sourceRelativePath: 'Album',
          targetPath: input.absolutePath,
          displayTitle: 'Album',
          identity: { kind: 'new' },
          reason: 'Synthetic',
          localOnly: true,
          excludeSourceIds: [],
          primary: false,
          approvedAds: [],
          manifest: [
            {
              relativePath: 'a.jpg',
              kind: 'image',
              size: 1,
              dev: '1',
              ino: '1',
              mtimeNs: '1',
            },
          ],
        },
      ],
    };
    await expect(admission.verifyUnstarted(plan)).rejects.toThrow(/目标目录/);
  });
  it.each(['source', 'path'])(
    'rejects archived-ingest replay by %s before claiming or modifying the job',
    async (mode) => {
      db.prepare(
        `INSERT INTO local_ingest_jobs(id,creator_id,source_work_id,archive_download_task_id,
   source_archive_path,source_archive_name,source_archive_size,source_archive_mtime,source_archive_sha256,status,target_path)
   VALUES(1,1,?,?,'/synthetic/inbox/a.7z','a.7z',1,1,'synthetic','failed',?)`,
      ).run(
        mode === 'source' ? 1 : null,
        mode === 'source' ? 1 : null,
        mode === 'path' ? input.absolutePath : null,
      );
      const before = db.prepare('SELECT * FROM local_ingest_jobs').all();
      await expect(new LocalIngestService(db).runJob(1)).rejects.toThrow(
        /回收站/,
      );
      expect(db.prepare('SELECT * FROM local_ingest_jobs').all()).toEqual(
        before,
      );
    },
  );
});
