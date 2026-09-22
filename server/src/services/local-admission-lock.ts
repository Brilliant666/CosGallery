import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const LOCAL_ADMISSION_LOCK_KEY = 'local-folder-admission.execution-lock.v1';
type Owner = { pid: number; token: string; kind: string };
const context = new AsyncLocalStorage<Owner>();

function readOwner(value: string): Owner {
  let owner: Owner;
  try { owner = JSON.parse(value) as Owner; } catch { throw new Error('Admission lock metadata is invalid; manual review required'); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.token || typeof owner.kind !== 'string') {
    throw new Error('Admission lock owner cannot be verified');
  }
  return owner;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('Admission lock process liveness is unknown; do not take over');
  }
}

/** Atomic across SQLite connections/processes. Age alone never grants ownership. */
async function runLocked<T>(database: DatabaseSync, kind: string, allowNested: boolean, action: () => Promise<T>): Promise<T> {
  const current = database.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY) as {value:string}|undefined;
  const inherited = context.getStore();
  if (allowNested && current && inherited && readOwner(current.value).token === inherited.token && inherited.pid === process.pid) {
    return action();
  }
  const owner: Owner = { pid: process.pid, token: randomUUID(), kind };
  const value = JSON.stringify(owner);
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY) as {value:string}|undefined;
    if (row && alive(readOwner(row.value).pid)) throw new Error('Local admission or indexing operation is active in another execution; retry after completion');
    database.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(LOCAL_ADMISSION_LOCK_KEY,value);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  try { return await context.run(owner, action); }
  finally {
    // Never clear ownership acquired by a different execution.
    database.prepare('DELETE FROM app_settings WHERE key=? AND value=?').run(LOCAL_ADMISSION_LOCK_KEY,value);
  }
}

export function runAdmissionExclusive<T>(database: DatabaseSync, action: () => Promise<T>): Promise<T> {
  return runLocked(database, 'admission', context.getStore()?.kind === 'admission-collection', action);
}

/** One serial collection owns the same cross-process lock, including gaps between children. */
export function runAdmissionCollectionExclusive<T>(database: DatabaseSync, action: () => Promise<T>): Promise<T> {
  return runLocked(database, 'admission-collection', false, action);
}

/** Allows the admission's own scoped scanner, but excludes unrelated workers. */
export function runWithAdmissionBarrier<T>(database: DatabaseSync, action: () => Promise<T>): Promise<T> {
  return runLocked(database, 'index-or-ingest', true, action);
}
