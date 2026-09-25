import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationRecoveryService } from '../src/services/application-recovery-core.js';
import { denyRecoveryFileRequests } from '../src/middleware/protected-recovery-files.js';

let root: string;
let service: ApplicationRecoveryService;
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'application-recovery-integration-'));
  service = new ApplicationRecoveryService({ sourceDbPath: path.join(root, 'gallery.sqlite'), backupRoot: path.join(root, 'backups'),
    instanceId: 'isolated-test', codeVersion: 'test', configFiles: [], forbiddenRoots: [], automatic: { enabled: false } });
  vi.doMock('../src/services/application-recovery-service.js', () => ({ createApplicationRecoveryService: () => service,
    createPreRebuildRecoveryPoint: () => service.create('pre-rebuild') }));
});

it('a failed rebuild recovery point never enters the maintenance queue or modifies the input database', async () => {
  const db = new DatabaseSync(service.config.sourceDbPath);
  db.exec("CREATE TABLE facts(id INTEGER PRIMARY KEY, note TEXT); INSERT INTO facts VALUES(1,'keep original input')"); db.close();
  fs.writeFileSync(service.config.backupRoot, 'invalid target');
  const { scannerService } = await import('../src/services/scanner-service.js');
  const enqueue = vi.spyOn(scannerService as unknown as { enqueue: (...args: unknown[]) => Promise<unknown> }, 'enqueue');
  await expect(scannerService.rebuildLibraryIndex()).rejects.toThrow();
  expect(enqueue).not.toHaveBeenCalled();
  const after = new DatabaseSync(service.config.sourceDbPath, { readOnly: true });
  try { expect(after.prepare('SELECT * FROM facts').all()).toEqual([{ id: 1, note: 'keep original input' }]); }
  finally { after.close(); enqueue.mockRestore(); }
});
afterEach(() => {
  vi.doUnmock('../src/services/application-recovery-service.js');
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

it('the real API keeps authentication and trusted-mutation checks ahead of backup creation', async () => {
  vi.stubEnv('DB_DIR', root);
  vi.stubEnv('DATA_ROOT', path.join(root, 'data'));
  vi.stubEnv('GALLERY_ROOT', path.join(root, 'gallery'));
  vi.stubEnv('THUMBNAILS_DIR', path.join(root, 'thumbnails'));
  vi.stubEnv('PREVIEWS_DIR', path.join(root, 'previews'));
  vi.stubEnv('BACKUP_ROOT', service.config.backupRoot);
  const { createApp } = await import('../src/app.js');
  const { authService } = await import('../src/services/auth-service.js');
  const { databaseManager } = await import('../src/db/database.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    expect((await fetch(`${base}/api/admin/recovery-points`)).status).toBe(200);
    expect((await fetch(`${base}/api/admin/recovery-points`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'x-foldergram-intent': '1', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    authService.setAdminPassword('isolated-recovery-password');
    expect((await fetch(`${base}/api/admin/recovery-points`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/recovery-points`, { method: 'POST', headers: { origin: 'http://localhost:4141', 'x-foldergram-intent': '1', 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect(fs.existsSync(service.config.backupRoot)).toBe(false);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    databaseManager.close();
  }
});

describe('recovery integration before the first migration write', () => {
  it('publishes a pre-baseline snapshot before creating migration markers', async () => {
    const baseline = fs.readFileSync(path.resolve('db/migrations/000001_baseline.sql'), 'utf8').split('-- migrate:up')[1]!.split('-- migrate:down')[0]!;
    const original = new DatabaseSync(service.config.sourceDbPath); original.exec(baseline); original.close();
    const { baselineExistingDatabaseIfNeeded } = await import('../src/db/migration.js');
    expect(baselineExistingDatabaseIfNeeded(service.config.sourceDbPath).baselineInserted).toBe(true);
    const point = service.getStatus().points[0]!;
    expect(point.schemaVersions).toEqual([]);
    const before = new DatabaseSync(path.join(service.config.backupRoot, point.id, 'gallery.sqlite'), { readOnly: true });
    try { expect(before.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()).toBeUndefined(); }
    finally { before.close(); }
  });
  it('does not back up a fresh database or a no-op startup, then protects an actual upgrade', async () => {
    const { runStartupMigrations } = await import('../src/db/migration.js');
    const source = service.config.sourceDbPath;
    runStartupMigrations({ databasePath: source });
    expect(service.getStatus().points).toHaveLength(0);
    runStartupMigrations({ databasePath: source });
    expect(service.getStatus().points).toHaveLength(0);
    const migrations = path.join(root, 'migrations');
    fs.mkdirSync(migrations);
    fs.writeFileSync(path.join(migrations, '900001_test.sql'), '-- migrate:up\nCREATE TABLE extra_fixture(id INTEGER PRIMARY KEY);\n-- migrate:down\nDROP TABLE extra_fixture;');
    runStartupMigrations({ databasePath: source, migrationsDirectory: migrations });
    const points = service.getStatus().points;
    expect(points).toHaveLength(1);
    expect(points[0]!.reason).toBe('pre-migration');
    const snapshot = new DatabaseSync(path.join(service.config.backupRoot, points[0]!.id, 'gallery.sqlite'), { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='extra_fixture'").get()).toBeUndefined();
      expect(snapshot.prepare("SELECT version FROM schema_migrations WHERE version='900001'").get()).toBeUndefined();
      expect(snapshot.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { snapshot.close(); }
  });

  it('blocks baseline marker creation when recovery cannot be published', async () => {
    const database = new DatabaseSync(service.config.sourceDbPath);
    database.exec('CREATE TABLE folders(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO folders VALUES(1,\'preserved\')');
    database.close();
    fs.writeFileSync(service.config.backupRoot, 'not a directory');
    const { baselineExistingDatabaseIfNeeded } = await import('../src/db/migration.js');
    expect(() => baselineExistingDatabaseIfNeeded(service.config.sourceDbPath)).toThrow();
    const unchanged = new DatabaseSync(service.config.sourceDbPath, { readOnly: true });
    try {
      expect(unchanged.prepare('SELECT * FROM folders').all()).toEqual([{ id: 1, name: 'preserved' }]);
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()).toBeUndefined();
      expect(unchanged.prepare('PRAGMA table_info(folders)').all()).toHaveLength(2);
    } finally { unchanged.close(); }
  });

  it('backs up an incorrect 000004 marker before repair removes it', async () => {
    const { runStartupMigrations } = await import('../src/db/migration.js');
    const migrationRoot = path.resolve('db/migrations');
    const staged = path.join(root, 'initial-migrations'); fs.mkdirSync(staged);
    for (const name of fs.readdirSync(migrationRoot).filter(name => /^(000001|000002)_/.test(name))) fs.copyFileSync(path.join(migrationRoot, name), path.join(staged, name));
    runStartupMigrations({ databasePath: service.config.sourceDbPath, migrationsDirectory: staged });
    const broken = new DatabaseSync(service.config.sourceDbPath);
    broken.exec("INSERT INTO schema_migrations(version) VALUES('000004')"); broken.close();
    runStartupMigrations({ databasePath: service.config.sourceDbPath });
    const point = service.getStatus().points[0]!;
    expect(service.getStatus().points).toHaveLength(1);
    const before = new DatabaseSync(path.join(service.config.backupRoot, point.id, 'gallery.sqlite'), { readOnly: true });
    try {
      expect(before.prepare("SELECT version FROM schema_migrations WHERE version='000004'").get()).toEqual({ version: '000004' });
      expect(before.prepare("SELECT name FROM sqlite_master WHERE name='folder_share_links'").get()).toBeUndefined();
    } finally { before.close(); }
  });
});

it('GET is metadata-only, rejects arbitrary destinations and blocks secret static paths', async () => {
  const db = new DatabaseSync(service.config.sourceDbPath); db.exec('CREATE TABLE facts(id INTEGER PRIMARY KEY)'); db.close();
  const { createApplicationRecoveryRouter } = await import('../src/routes/application-recovery-routes.js');
  const app = express(); app.use(express.json()); app.use(denyRecoveryFileRequests(service.config.backupRoot));
  app.use('/api/admin/recovery-points', createApplicationRecoveryRouter());
  app.use((_req, res) => res.send('fallback must not reveal protected files'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    expect((await fetch(`${base}/api/admin/recovery-points`)).status).toBe(200);
    expect(fs.existsSync(service.config.backupRoot)).toBe(false);
    expect((await fetch(`${base}/api/admin/recovery-points`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ path: '/arbitrary' }) })).status).toBe(400);
    expect(fs.existsSync(service.config.backupRoot)).toBe(false);
    for (const suffix of ['/.env', '/.env.production', '/data_backup/point-x/gallery.sqlite', '/backups/file', '/private/password.key', '/.run/task.run.xml', '/%2Eenv']) {
      expect((await fetch(`${base}${suffix}`)).status, suffix).toBe(404);
    }
    const created = await fetch(`${base}/api/admin/recovery-points`, { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
    expect(created.status).toBe(202);
    expect((await created.json()).active).not.toBeNull();
    const deadline = Date.now() + 4000;
    while (service.getStatus().active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(service.getStatus().active).toBeNull();
    expect(service.getStatus().points).toHaveLength(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
