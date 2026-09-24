import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: string;
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-config-'));
  vi.stubEnv('DATA_ROOT', path.join(root, 'data'));
  vi.stubEnv('DB_DIR', path.join(root, 'db'));
  vi.stubEnv('GALLERY_ROOT', path.join(root, 'gallery'));
  vi.stubEnv('THUMBNAILS_DIR', path.join(root, 'thumbnails'));
  vi.stubEnv('PREVIEWS_DIR', path.join(root, 'previews'));
  vi.stubEnv('BACKUP_ROOT', path.join(root, 'backups'));
  vi.stubEnv('APP_ENV_FILE', path.join(root, 'isolated.env'));
  vi.stubEnv('APP_RUN_CONFIG_FILE', path.join(root, 'isolated.run.xml'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root, { recursive: true, force: true }); });

it('resolves the default backup path from repositoryRoot and leaves automatic backup off', async () => {
  vi.stubEnv('BACKUP_ROOT', undefined);
  const { appConfig, repositoryRoot } = await import('../src/config/env.js');
  expect(appConfig.backupRoot).toBe(path.join(repositoryRoot, 'data_backup'));
  expect(appConfig.backupAutomatic).toEqual({ enabled: false, intervalHours: 24, retainDaily: 7, retainWeekly: 4 });
});

it('uses the selected environment file and records only the actual run configuration without password values', async () => {
  fs.writeFileSync(path.join(root, 'isolated.env'), 'LOG_VERBOSE=true\n');
  const password = 'synthetic-config-password';
  fs.writeFileSync(path.join(root, 'isolated.run.xml'), `<component><configuration><envs><env name="LOCAL_INGEST_ARCHIVE_PASSWORD" value="${password}" /></envs></configuration></component>`);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('LOG_VERBOSE', undefined);
  vi.stubEnv('LOCAL_INGEST_ARCHIVE_PASSWORD', password);
  const { appConfig, environmentFile } = await import('../src/config/env.js');
  expect(appConfig.logVerbose).toBe(true);
  expect(environmentFile).toBe(path.join(root, 'isolated.env'));
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  const service = createApplicationRecoveryService();
  expect(service.config.configFiles.map(file => file.path)).toEqual([path.join(root, 'isolated.env'), path.join(root, 'isolated.run.xml')]);
  expect(service.config.configurationGaps?.some(gap => gap.includes('LOCAL_INGEST_ARCHIVE_PASSWORD'))).toBe(false);
  expect(JSON.stringify(service.getStatus())).not.toContain(password);
  expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
});

it('protects unpacked and archive waiting roots and requires the local decryption key when ciphertext exists', async () => {
  fs.mkdirSync(path.join(root, 'db'));
  const db = new DatabaseSync(path.join(root, 'db', 'gallery.sqlite'));
  db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.prepare('INSERT INTO app_settings VALUES(?,?)').run('local_ingest.settings', JSON.stringify({ inboxRoot: path.join(root, 'archives'), processingRoot: path.join(root, 'processing'), libraryRoot: path.join(root, 'gallery') }));
  db.prepare('INSERT INTO app_settings VALUES(?,?)').run('local-admission.waiting-root.v1', path.join(root, 'unpacked'));
  db.prepare('INSERT INTO app_settings VALUES(?,?)').run('local_ingest.archive_password', JSON.stringify({ version: 1, data: 'synthetic-ciphertext' }));
  db.close();
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  const service = createApplicationRecoveryService();
  expect(service.config.forbiddenRoots).toEqual(expect.arrayContaining([path.join(root, 'unpacked'), path.join(root, 'archives'), path.join(root, 'processing')]));
  expect(service.config.requiredPrivateFiles).toEqual(['local-ingest-archive-password.key']);
  expect(service.config.instanceId).toMatch(/^cosgallery-\d+-[a-f0-9]{12}$/);
  expect(service.config.instanceId).not.toContain(root);
});

it('reports every supported process-only launch setting as a recovery gap without its value', async () => {
  vi.stubEnv('SERVER_HOST', '127.0.0.7');
  vi.stubEnv('SERVER_PORT', '4329');
  vi.stubEnv('COS_GALLERY_MODE', 'true');
  vi.stubEnv('LOCAL_INGEST_STARTUP_SCAN', 'false');
  vi.stubEnv('DERIVATIVE_MODE', 'lazy');
  vi.stubEnv('BACKUP_AUTO_ENABLED', 'true');
  const { supportedEnvironmentKeys } = await import('../src/config/env.js');
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  const gaps = createApplicationRecoveryService().config.configurationGaps ?? [];
  for (const key of supportedEnvironmentKeys.filter(key => process.env[key] !== undefined)) {
    expect(gaps.some(gap => gap.includes(`Process-injected ${key} `))).toBe(true);
  }
  expect(JSON.stringify(gaps)).not.toContain('127.0.0.7');
  expect(JSON.stringify(gaps)).not.toContain('4329');
});

it('rejects unignored repository-local backup roots while accepting ignored subdirectories and external roots', async () => {
  const { repositoryRoot } = await import('../src/config/env.js');
  vi.stubEnv('BACKUP_ROOT', path.join(repositoryRoot, 'unignored-backups'));
  vi.resetModules();
  let adapter = await import('../src/services/application-recovery-service.js');
  expect(() => adapter.createApplicationRecoveryService()).toThrow('repository-local BACKUP_ROOT');
  expect(fs.existsSync(path.join(repositoryRoot, 'unignored-backups'))).toBe(false);
  vi.stubEnv('BACKUP_ROOT', path.join(repositoryRoot, 'data_backup', 'isolated-test'));
  vi.resetModules();
  adapter = await import('../src/services/application-recovery-service.js');
  expect(adapter.createApplicationRecoveryService().config.backupRoot).toBe(path.join(repositoryRoot, 'data_backup', 'isolated-test'));
  expect(fs.existsSync(path.join(repositoryRoot, 'data_backup', 'isolated-test'))).toBe(false);
  vi.stubEnv('BACKUP_ROOT', path.join(root, 'backups'));
  vi.resetModules();
  adapter = await import('../src/services/application-recovery-service.js');
  expect(adapter.createApplicationRecoveryService().config.backupRoot).toBe(path.join(root, 'backups'));
});
