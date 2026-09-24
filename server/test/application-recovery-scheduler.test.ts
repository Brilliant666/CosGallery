import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: string;
let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-scheduler-'));
  for (const [name, suffix] of Object.entries({ DATA_ROOT: 'data', DB_DIR: 'db', GALLERY_ROOT: 'gallery', THUMBNAILS_DIR: 'thumbnails', PREVIEWS_DIR: 'previews', BACKUP_ROOT: 'backups', APP_ENV_FILE: 'fixture.env', APP_RUN_CONFIG_FILE: 'fixture.run.xml' })) {
    vi.stubEnv(name, path.join(root, suffix));
  }
  vi.stubEnv('BACKUP_AUTO_ENABLED', 'true');
  fs.mkdirSync(path.join(root, 'db'));
  const db = new DatabaseSync(path.join(root, 'db', 'gallery.sqlite'));
  db.exec("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES('000003'); CREATE TABLE fixture(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO fixture VALUES(1,'preserved');");
  db.close();
});
afterEach(async () => {
  await stop?.(); stop = undefined;
  vi.unstubAllEnvs(); vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});
async function adapter() {
  const result = await import('../src/services/application-recovery-service.js');
  stop = result.stopAutomaticRecoveryPoints;
  return result;
}

it('disabled scheduling and status reads create no backup directory', async () => {
  vi.stubEnv('BACKUP_AUTO_ENABLED', 'false');
  const api = await adapter();
  api.startAutomaticRecoveryPoints();
  await api.checkAutomaticRecoveryPoint();
  expect(api.createApplicationRecoveryService().getStatus().points).toEqual([]);
  expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
});

it('enabled startup creates one real daily point and coalesces concurrent and not-due checks', async () => {
  const api = await adapter();
  api.startAutomaticRecoveryPoints();
  await Promise.all([api.checkAutomaticRecoveryPoint(), api.checkAutomaticRecoveryPoint()]);
  await api.stopAutomaticRecoveryPoints();
  const service = api.createApplicationRecoveryService();
  const initial = service.getStatus().points;
  expect(initial).toHaveLength(1);
  expect(initial[0]).toMatchObject({ reason: 'daily', instanceId: service.config.instanceId, validation: { integrity: 'ok', foreignKeys: 0 } });
  await api.checkAutomaticRecoveryPoint();
  expect(service.getStatus().points.map(point => point.id)).toEqual(initial.map(point => point.id));
});

it('an expired same-instance daily point produces a new consistent point', async () => {
  const api = await adapter();
  await api.checkAutomaticRecoveryPoint();
  const service = api.createApplicationRecoveryService();
  const first = service.getStatus().points[0]!;
  // Age only this isolated fixture metadata; both adapter and real child use their real clocks.
  const metadata = path.join(root, 'backups', first.id, 'metadata.json');
  fs.writeFileSync(metadata, JSON.stringify({ ...first, completedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }));
  await api.checkAutomaticRecoveryPoint();
  const points = service.getStatus().points;
  expect(points).toHaveLength(2);
  expect(points[0]!.id).not.toBe(first.id);
  const restored = new DatabaseSync(path.join(root, 'backups', points[0]!.id, 'gallery.sqlite'), { readOnly: true });
  try { expect(restored.prepare('SELECT value FROM fixture WHERE id=1').get()?.value).toBe('preserved'); }
  finally { restored.close(); }
});

it('a fresh daily point belonging to another instance does not suppress this instance', async () => {
  const api = await adapter();
  const service = api.createApplicationRecoveryService();
  const { ApplicationRecoveryService } = await import('../src/services/application-recovery-core.js');
  const other = new ApplicationRecoveryService({ ...service.config, instanceId: 'isolated-other-instance' });
  await other.create('daily');
  await api.checkAutomaticRecoveryPoint();
  expect(service.getStatus().points.map(point => point.instanceId).sort()).toEqual([service.config.instanceId, 'isolated-other-instance'].sort());
});
