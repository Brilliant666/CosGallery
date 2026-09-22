import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';

describe.sequential('scoped catalog reconciliation writer contention', () => {
  let tempRoot: string, databasePath: string, galleryRoot: string, db: DatabaseSync;
  let service: ArchiveCatalogService, creatorId: number;
  const workers: Worker[] = [];

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-scoped-writer-'));
    databasePath = path.join(tempRoot, 'gallery.sqlite');
    galleryRoot = path.join(tempRoot, 'gallery');
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000');
    db.exec(schemaSql);
    creatorId = new ManagedCreatorService(db, galleryRoot).create({ name: 'ScopedWriter' }).id;
    db.prepare("INSERT INTO app_settings(key,value) VALUES('writer-marker','before')").run();
    await fs.mkdir(path.join(galleryRoot, 'ScopedWriter', 'One'), { recursive: true });
    await fs.writeFile(path.join(galleryRoot, 'ScopedWriter', 'One', 'image.jpg'), 'synthetic');
    service = new ArchiveCatalogService(db);
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(worker => worker.terminate()));
    if (db?.isTransaction) db.exec('ROLLBACK');
    db?.close();
    // This exact task-owned path was created by mkdtemp above.
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const reconcile = () => service.reconcileLocalCreators({
    rootPath: galleryRoot, creators: [{ creatorId, folderName: 'ScopedWriter' }], workFolderName: 'One'
  });
  const localCounts = () => ['archive_catalog_local_creator_folders', 'archive_catalog_local_works']
    .map(table => Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n));

  async function holdWriter(releaseAfterMs: number) {
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.path);
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE app_settings SET value='writer' WHERE key='writer-marker'").run();
      parentPort.postMessage('locked');
      setTimeout(()=>{db.exec('COMMIT');db.close();},workerData.releaseAfterMs);
    `, { eval: true, workerData: { path: databasePath, releaseAfterMs } });
    workers.push(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });
  }

  it('waits for a real independent writer before reading and updating catalog identity', async () => {
    await holdWriter(350);
    const started = performance.now();
    const result = await reconcile();
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(result.localWorks).toBe(1);
    expect(localCounts()).toEqual([1, 1]);
    expect(db.prepare('SELECT image_count FROM archive_catalog_local_works').get()!.image_count).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it('leaves no catalog writes or open transaction after a bounded writer timeout', async () => {
    db.exec('PRAGMA busy_timeout=30');
    await holdWriter(350);
    await expect(reconcile()).rejects.toThrow(/database is locked/);
    expect(localCounts()).toEqual([0, 0]);
    expect(db.isTransaction).toBe(false);
  });

  it('does not commit a caller-owned transaction after successful reconciliation', async () => {
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE app_settings SET value='caller' WHERE key='writer-marker'").run();
    await reconcile();
    expect(db.isTransaction).toBe(true);
    expect(localCounts()).toEqual([1, 1]);
    db.exec('ROLLBACK');
    expect(localCounts()).toEqual([0, 0]);
    expect(db.prepare("SELECT value FROM app_settings WHERE key='writer-marker'").get()!.value).toBe('before');
  });

  it.each([false, true])('rolls back its writes on failure, preserving caller ownership=%s', async nested => {
    db.exec("CREATE TRIGGER reject_scoped_work BEFORE INSERT ON archive_catalog_local_works BEGIN SELECT RAISE(ABORT,'scoped rollback probe'); END");
    if (nested) {
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE app_settings SET value='caller' WHERE key='writer-marker'").run();
    }
    await expect(reconcile()).rejects.toThrow('scoped rollback probe');
    expect(localCounts()).toEqual([0, 0]);
    expect(db.isTransaction).toBe(nested);
    expect(db.prepare("SELECT value FROM app_settings WHERE key='writer-marker'").get()!.value).toBe(nested ? 'caller' : 'before');
    if (nested) {
      db.exec('COMMIT');
      expect(db.prepare("SELECT value FROM app_settings WHERE key='writer-marker'").get()!.value).toBe('caller');
    }
  });
});
