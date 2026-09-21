import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { WorkIdentityService, type LocalIdentityInput } from '../src/services/work-identity-service.js';

const signal = (state: Int32Array, slot: number) => { Atomics.store(state, slot, 1); Atomics.notify(state, slot); };
function wait(state: Int32Array, slot: number) {
  const deadline = performance.now() + 10_000;
  while (!Atomics.load(state, slot)) {
    if (Atomics.load(state, 4)) throw new Error('Synthetic catalog publisher failed');
    if (performance.now() > deadline) throw new Error(`Synthetic catalog barrier ${slot} timed out`);
    Atomics.wait(state, slot, 0, 50);
  }
}

// An actual ResourceCatalogReadModel publication owns a separate SQLite writer.
// Barriers control only scheduling; no SQL operation or lock failure is mocked.
const publisherScript = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
const state = new Int32Array(workerData.shared), db = new DatabaseSync(workerData.file);
const signal = slot => { Atomics.store(state, slot, 1); Atomics.notify(state, slot); };
const wait = slot => { const end = Date.now() + 10000; while (!Atomics.load(state, slot)) {
  if (Date.now() > end) throw Error('Synthetic publisher barrier timed out'); Atomics.wait(state, slot, 0, 50);
} };
db.exec('PRAGMA busy_timeout=5000');
let publishing = false;
const scheduled = new Proxy(db, { get(target, key) {
  if (key === 'exec') return sql => {
    if (publishing && sql === 'COMMIT') {
      signal(2); wait(3);
      if (workerData.releaseDelayMs) Atomics.wait(state, 5, 0, workerData.releaseDelayMs);
    }
    return target.exec(sql);
  };
  const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
} });
(async () => { try {
  const { register } = await import(workerData.tsx); register();
  const { ResourceCatalogReadModel } = await import(workerData.model);
  const model = new ResourceCatalogReadModel(scheduled), prepared = model.prepare(1);
  signal(0); wait(1); publishing = true;
  const published = model.publish(prepared);
  parentPort.postMessage({ published, publication: db.prepare('SELECT publication FROM resource_catalog_meta').get().publication });
} catch (error) {
  signal(4); parentPort.postMessage({ error: error.message });
} finally { db.close(); parentPort.close(); } })();
`;

describe('local work identity writer reservation', () => {
  let directory: string, file: string, db: DatabaseSync, input: LocalIdentityInput;
  const workers: Worker[] = [];
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-identity-concurrency-'));
    file = path.join(directory, 'synthetic.sqlite');
    const gallery = path.join(directory, 'gallery');
    db = new DatabaseSync(file); db.exec(schemaSql); db.exec('PRAGMA busy_timeout=5000');
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'Synthetic','synthetic','test','1')`);
    input = { creatorId: 1, rootPath: gallery, creatorFolderName: 'Synthetic',
      absolutePath: path.join(gallery, 'Synthetic', 'NO.027 Example'), relativePath: 'Synthetic/NO.027 Example',
      title: 'Example', reason: 'Confirmed synthetic identity', key: 'synthetic-plan:item' };
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map(worker => worker.terminate()));
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  function publisher(releaseDelayMs = 0) {
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 6), state = new Int32Array(shared);
    const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const worker = new Worker(publisherScript, { eval: true, workerData: { file, shared, releaseDelayMs,
      tsx: pathToFileURL(path.join(server, 'node_modules/tsx/dist/esm/api/index.mjs')).href,
      model: pathToFileURL(path.join(server, 'src/services/resource-catalog-read-model.ts')).href } });
    workers.push(worker);
    const result = new Promise<{ published?: boolean; publication?: number; error?: string }>(resolve => {
      worker.once('message', resolve); worker.once('error', error => resolve({ error: error.message }));
    });
    return { state, result };
  }
  const identityRows = () => ['archive_catalog_works', 'archive_catalog_local_creator_folders',
    'archive_catalog_local_works', 'archive_catalog_work_decisions']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());

  it('reproduces the original deferred read-to-write upgrade failure against a real catalog publisher', async () => {
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    const writer = publisher(); wait(writer.state, 0);
    // A caller-owned deferred transaction recreates the original top-level
    // SAVEPOINT. Nested registration must continue respecting its caller.
    db.exec('SAVEPOINT synthetic_original_deferred');
    db.prepare('SELECT id FROM archive_catalog_creators').all();
    signal(writer.state, 1); wait(writer.state, 2);
    let error: unknown;
    const started = performance.now();
    try { new WorkIdentityService(db).registerLocal(input); }
    catch (caught) { error = caught; }
    finally {
      db.exec('ROLLBACK TO synthetic_original_deferred; RELEASE synthetic_original_deferred');
      signal(writer.state, 3);
    }
    expect(error).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5, message: 'database is locked' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await writer.result).toMatchObject({ published: true, publication: 1 });
    expect(identityRows()).toEqual([[], [], [], []]);
  });

  it('waits for an active publisher before reading identity and registers exactly once', async () => {
    const writer = publisher(200); wait(writer.state, 0);
    signal(writer.state, 1); wait(writer.state, 2);
    let reserved = false;
    const readsReserved: boolean[] = [], trace: string[] = [];
    const scheduled = new Proxy(db, { get(target, key) {
      if (key === 'exec') return (sql: string) => {
        trace.push(sql);
        if (sql === 'BEGIN IMMEDIATE') signal(writer.state, 3);
        const result = target.exec(sql);
        if (sql === 'BEGIN IMMEDIATE') reserved = true;
        return result;
      };
      if (key === 'prepare') return (sql: string) => {
        if (sql.startsWith('SELECT')) readsReserved.push(reserved);
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const started = performance.now();
    let mapped: ReturnType<WorkIdentityService['registerLocal']>;
    try { mapped = new WorkIdentityService(scheduled).registerLocal(input); }
    finally { signal(writer.state, 3); }
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(await writer.result).toMatchObject({ published: true, publication: 1 });
    expect(trace[0]).toBe('BEGIN IMMEDIATE'); expect(trace.at(-1)).toBe('COMMIT');
    expect(readsReserved.length).toBeGreaterThan(0); expect(readsReserved.every(Boolean)).toBe(true);
    expect(db.isTransaction).toBe(false);
    const saved = identityRows(), service = new WorkIdentityService(db);
    expect(service.registerLocal(input)).toEqual(mapped);
    expect(() => service.registerLocal({ ...input, title: 'Changed confirmation' })).toThrow('new confirmation');
    expect(db.isTransaction).toBe(false); expect(identityRows()).toEqual(saved);
    expect(saved.map(rows => rows.length)).toEqual([1, 1, 1, 1]);
  });

  it('propagates bounded writer timeout without partial identity or an open transaction', async () => {
    db.exec('PRAGMA busy_timeout=50');
    const writer = publisher(); wait(writer.state, 0);
    signal(writer.state, 1); wait(writer.state, 2);
    try { expect(() => new WorkIdentityService(db).registerLocal(input)).toThrow('database is locked'); }
    finally { signal(writer.state, 3); }
    expect(db.isTransaction).toBe(false);
    expect(await writer.result).toMatchObject({ published: true });
    expect(identityRows()).toEqual([[], [], [], []]);
    expect(new WorkIdentityService(db).registerLocal(input).localWorkId).toBeGreaterThan(0);
  });

  it('keeps a successful nested registration inside the caller transaction', () => {
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO app_settings(key,value) VALUES('caller','keep-until-rollback')").run();
    const service = new WorkIdentityService(db), mapped = service.registerLocal(input);
    expect(service.registerLocal(input)).toEqual(mapped);
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(identityRows()).toEqual([[], [], [], []]);
    expect(db.prepare("SELECT value FROM app_settings WHERE key='caller'").get()).toBeUndefined();
  });

  it('rolls back the full registration on failure while preserving caller writes', () => {
    db.exec(`CREATE TRIGGER synthetic_identity_rejection BEFORE INSERT ON archive_catalog_work_decisions
      BEGIN SELECT RAISE(ABORT,'synthetic identity rejection'); END`);
    const service = new WorkIdentityService(db);
    expect(() => service.registerLocal(input)).toThrow('synthetic identity rejection');
    expect(db.isTransaction).toBe(false); expect(identityRows()).toEqual([[], [], [], []]);
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO app_settings(key,value) VALUES('caller','preserved')").run();
    expect(() => service.registerLocal(input)).toThrow('synthetic identity rejection');
    expect(db.isTransaction).toBe(true); expect(identityRows()).toEqual([[], [], [], []]);
    db.exec('COMMIT');
    expect(db.prepare("SELECT value FROM app_settings WHERE key='caller'").get()).toEqual({ value: 'preserved' });
  });
});
