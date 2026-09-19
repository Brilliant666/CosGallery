import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ databasePath: '' }));
vi.mock('../src/services/storage-service.js', () => ({
  storageService: {
    getDatabasePath: () => {
      if (!fixture.databasePath) throw new Error('Contention fixture is not initialized');
      return fixture.databasePath;
    }
  }
}));

type Manager = typeof import('../src/db/database.js')['databaseManager'];
type Settings = typeof import('../src/db/repositories.js')['appSettingsRepository'];

describe.sequential('application database writer contention', () => {
  let tempRoot = '';
  let manager: Manager;
  let settings: Settings;
  const workers: Worker[] = [];

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-writer-contention-'));
    fixture.databasePath = path.join(tempRoot, 'gallery.sqlite');
    vi.resetModules();
    ({ databaseManager: manager } = await import('../src/db/database.js'));
    manager.close();
    // Use the real manager and normal startup migrations, not a mocked SQLite
    // connection. The storage seam points exclusively at this temporary file.
    manager.connection;
    ({ appSettingsRepository: settings } = await import('../src/db/repositories.js'));
    settings.set('contention-test-marker', 'keep-until-delete');
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
    manager?.close();
    fixture.databasePath = '';
    vi.resetModules();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function holdWriterLock(releaseAfterMs: number): Promise<void> {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.path);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE app_settings SET value = value WHERE key = ?')
        .run('contention-test-marker');
      parentPort.postMessage('locked');
      setTimeout(() => {
        db.exec('COMMIT');
        db.close();
      }, workerData.releaseAfterMs);
    `, { eval: true, workerData: { path: fixture.databasePath, releaseAfterMs } });
    workers.push(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });
  }

  it('waits for an independent writer before deleting startup settings', async () => {
    expect(manager.connection.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    await holdWriterLock(250);
    const start = performance.now();
    settings.remove('contention-test-marker');
    expect(performance.now() - start).toBeGreaterThanOrEqual(100);
    expect(settings.get('contention-test-marker')).toBeNull();
  });

  it('propagates a bounded lock timeout without deleting the setting', async () => {
    manager.connection.exec('PRAGMA busy_timeout=50');
    await holdWriterLock(350);
    expect(() => settings.remove('contention-test-marker')).toThrow(/database is locked/);
    expect(settings.get('contention-test-marker')).toBe('keep-until-delete');
  });

  it('restores the configured wait on each new connection', () => {
    const first = manager.connection;
    first.exec('PRAGMA busy_timeout=50');
    manager.close();
    const reopened = manager.connection;
    expect(reopened === first).toBe(false);
    expect(reopened.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(settings.get('contention-test-marker')).toBe('keep-until-delete');
  });
});
