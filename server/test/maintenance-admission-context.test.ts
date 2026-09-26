import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { MaintenanceOperationLock } from '../src/services/maintenance-operation-lock.js';
import { LOCAL_ADMISSION_LOCK_KEY, runAdmissionCollectionExclusive, runAdmissionExclusive, runWithAdmissionBarrier } from '../src/services/local-admission-lock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

it.each(['generation', 'exclusive'] as const)('preserves a queued %s caller context after another caller fails', async kind => {
  const context = new AsyncLocalStorage<string>();
  const lock = new MaintenanceOperationLock();
  const hold = deferred();
  const first = context.run('previous', () => lock.runExclusive(async () => {
    await hold.promise;
    throw new Error('previous failed');
  }));
  const failed = expect(first).rejects.toThrow('previous failed');
  const queued = context.run('queued', () => {
    const operation = async () => {
      await Promise.resolve();
      return context.getStore();
    };
    return kind === 'generation' ? lock.runGeneration(operation) : lock.runExclusive(operation);
  });
  const unrelated = lock.runExclusive(async () => context.getStore());
  hold.resolve();
  await failed;
  expect(await queued).toBe('queued');
  expect(await unrelated).toBeUndefined();
});

it('keeps a collection admission owner when its scoped index waits for cold generation', async () => {
  const db = database();
  const lock = new MaintenanceOperationLock();
  const hold = deferred();
  const generation = lock.runGeneration(() => hold.promise);
  const admission = runAdmissionCollectionExclusive(db, () => runAdmissionExclusive(db, async () => {
    const owner = db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY);
    await lock.runExclusive(() => runWithAdmissionBarrier(db, async () => {
      expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY)).toEqual(owner);
    }));
    // Subsequent work in the same collection must retain the original lock too.
    await lock.runExclusive(() => runWithAdmissionBarrier(db, async () => undefined));
    return 'indexed';
  }));
  const result = expect(admission).resolves.toBe('indexed');
  hold.resolve();
  try {
    await Promise.all([generation, result]);
    expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY)).toBeUndefined();
  } finally { await admission.catch(() => undefined); db.close(); }
});

it('does not lend an admission owner to an unrelated queued index', async () => {
  const db = database();
  const lock = new MaintenanceOperationLock();
  const holdGeneration = deferred();
  const entered = deferred();
  const finishAdmission = deferred();
  const admission = runAdmissionCollectionExclusive(db, async () => {
    const generation = lock.runGeneration(async () => {
      entered.resolve();
      await holdGeneration.promise;
    });
    await finishAdmission.promise;
    await generation;
  });
  await entered.promise;
  let unrelatedRan = false;
  const unrelated = lock.runExclusive(() => runWithAdmissionBarrier(db, async () => { unrelatedRan = true; }));
  const rejected = expect(unrelated).rejects.toThrow('active in another execution');
  holdGeneration.resolve();
  try {
    await rejected;
    expect(unrelatedRan).toBe(false);
  } finally {
    finishAdmission.resolve();
    await admission;
    db.close();
  }
});
