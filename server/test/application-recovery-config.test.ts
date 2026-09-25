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
afterEach(() => { vi.doUnmock('../src/config/env.js'); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root, { recursive: true, force: true }); });

async function useIsolatedSources() {
  vi.stubEnv('BACKUP_ROOT', path.join(root, 'data_backup'));
  vi.doMock('../src/config/env.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/config/env.js')>(), repositoryRoot: root }));
  const env = await import('../src/config/env.js');
  fs.writeFileSync(path.join(root, 'isolated.env'), env.supportedEnvironmentKeys.filter(key => !key.startsWith('APP_') && process.env[key] !== undefined)
    .map(key => `${key}='${process.env[key]}'`).join('\n'));
  return env;
}

it('treats unused IDE configuration as not applicable when files and code defaults cover the instance', async () => {
  vi.stubEnv('APP_RUN_CONFIG_FILE', undefined);
  vi.stubEnv('SERVER_HOST', '127.0.0.1');
  const env = await useIsolatedSources();
  const filename = path.join(root, 'isolated.env'); fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(/^SERVER_HOST=.*\n?/m, ''));
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  const service = createApplicationRecoveryService();
  expect(service.config.configurationGaps).toEqual([]);
  expect(service.config.configFiles.map(file => file.path)).toEqual([env.environmentFile]);
});

it.each([
  ['missing', null],
  ['invalid', '<component><configuration><env name="SERVER_HOST" value="127.0.0.9"></component>'],
  ['mismatch', '<component><configuration><envs><env name="SERVER_HOST" value="127.0.0.8" /></envs></configuration></component>']
])('keeps an accurate gap for explicitly selected %s run configuration', async (classification, xml) => {
  vi.stubEnv('SERVER_HOST', '127.0.0.9');
  await useIsolatedSources();
  if (xml) fs.writeFileSync(path.join(root, 'isolated.run.xml'), xml);
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  const config = createApplicationRecoveryService().config;
  expect(config.configurationGaps?.some(gap => gap.includes(`APP_RUN_CONFIG_FILE: ${classification}`))).toBe(true);
  expect(config.configFiles.some(file => file.path.endsWith('.run.xml'))).toBe(false);
  expect(JSON.stringify(config.configurationGaps)).not.toContain('127.0.0.8');
});

it('does not treat a sole unused run file as evidence that it launched this instance', async () => {
  vi.stubEnv('APP_RUN_CONFIG_FILE', undefined); await useIsolatedSources();
  fs.mkdirSync(path.join(root, '.run'));
  fs.writeFileSync(path.join(root, '.run', 'unused.run.xml'), '<component><configuration><envs><env name="NODE_ENV" value="test" /></envs></configuration></component>');
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  const config = createApplicationRecoveryService().config;
  expect(config.configFiles.some(file => file.path.endsWith('.run.xml'))).toBe(false);
  expect(config.configurationGaps).toEqual([]);
  fs.copyFileSync(path.join(root, '.run', 'unused.run.xml'), path.join(root, '.run', 'also-unused.run.xml'));
  expect(createApplicationRecoveryService().config.configurationGaps).toEqual([]);
});

it('collects a unique reliable run and leaves ambiguous runs unselected with only genuine uncovered settings', async () => {
  vi.stubEnv('APP_RUN_CONFIG_FILE', undefined); vi.stubEnv('LOCAL_INGEST_ARCHIVE_PASSWORD', 'synthetic-only-process');
  await useIsolatedSources();
  const filename = path.join(root, 'isolated.env'); fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(/^LOCAL_INGEST_ARCHIVE_PASSWORD=.*\n?/m, ''));
  fs.mkdirSync(path.join(root, '.run'));
  const xml = '<component><configuration><envs><env value="synthetic-only-process" name="LOCAL_INGEST_ARCHIVE_PASSWORD" /></envs></configuration></component>';
  fs.writeFileSync(path.join(root, '.run', 'one.run.xml'), xml);
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  expect(createApplicationRecoveryService().config.configFiles.some(file => file.path.endsWith('one.run.xml'))).toBe(true);
  expect(createApplicationRecoveryService().config.configurationGaps).toEqual([]);
  fs.writeFileSync(path.join(root, '.run', 'two.run.xml'), xml);
  const ambiguous = createApplicationRecoveryService().config;
  expect(ambiguous.configFiles.some(file => file.path.endsWith('.run.xml'))).toBe(false);
  expect(ambiguous.configurationGaps).toEqual([
    'Process-injected LOCAL_INGEST_ARCHIVE_PASSWORD must be restored separately; its value is not exported.',
    'Run configuration source unconfirmed: multiple candidates; uncovered process settings require separate restoration.'
  ]);
  expect(JSON.stringify(ambiguous.configurationGaps)).not.toContain('synthetic-only-process');
});

it('uses the same schema defaults and dependent paths without losing genuinely required production overrides', async () => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SERVER_PORT', '4499');
  const { isEnvironmentValueRestorable } = await import('../src/config/env.js');
  expect(isEnvironmentValueRestorable('SERVER_PORT', '4499', {})).toBe(false);
  expect(isEnvironmentValueRestorable('SERVER_PORT', '4141', {})).toBe(true);
  expect(isEnvironmentValueRestorable('FFMPEG_PATH', 'ffmpeg', {})).toBe(true);
  expect(isEnvironmentValueRestorable('BACKUP_AUTO_ENABLED', '0', {})).toBe(true);
  expect(isEnvironmentValueRestorable('GALLERY_ROOT', path.join(root, 'data', 'gallery'), { DATA_ROOT: path.join(root, 'data') })).toBe(true);
  expect(isEnvironmentValueRestorable('GALLERY_ROOT', path.join(root, 'other-gallery'), {})).toBe(false);
});

it('does not let two unbacked dependent process paths prove each other recoverable', async () => {
  vi.stubEnv('DATA_DIR', path.join(root, 'data'));
  const { isEnvironmentValueRestorable } = await import('../src/config/env.js');
  expect(isEnvironmentValueRestorable('DATA_ROOT', path.join(root, 'data'), {})).toBe(false);
  expect(isEnvironmentValueRestorable('DATA_DIR', path.join(root, 'data'), {})).toBe(false);
  expect(isEnvironmentValueRestorable('GALLERY_ROOT', path.join(root, 'data', 'gallery'), {})).toBe(false);
  expect(isEnvironmentValueRestorable('GALLERY_ROOT', path.join(root, 'data', 'gallery'), { DATA_ROOT: path.join(root, 'data') })).toBe(true);
});

it('creates a complete new point without IDE files while preserving a prior incomplete historical point byte for byte', async () => {
  vi.stubEnv('APP_RUN_CONFIG_FILE', undefined); await useIsolatedSources();
  fs.mkdirSync(path.join(root, 'db'));
  const db = new DatabaseSync(path.join(root, 'db', 'gallery.sqlite')); db.exec('CREATE TABLE facts(id INTEGER PRIMARY KEY)'); db.close();
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  const { ApplicationRecoveryService } = await import('../src/services/application-recovery-core.js');
  const service = createApplicationRecoveryService();
  const historical = await new ApplicationRecoveryService({ ...service.config, configurationGaps: ['No matching active .run configuration was identified; process-only launch settings need separate restoration.'] }).create('manual');
  const metadata = path.join(service.config.backupRoot, historical.id, 'metadata.json');
  const original = fs.readFileSync(metadata);
  const current = await service.create('manual');
  expect(current.configuration).toEqual({ complete: true, gaps: [] });
  expect(fs.readFileSync(metadata)).toEqual(original);
  expect(service.getStatus().points.find(point => point.id === historical.id)?.configuration.complete).toBe(false);
  expect(service.getStatus().latestSuccess?.configuration.complete).toBe(true);
});

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

it('reports necessary non-default process-only settings and missing explicit materials without their values', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SERVER_HOST', '127.0.0.7');
  vi.stubEnv('SERVER_PORT', '4329');
  vi.stubEnv('COS_GALLERY_MODE', 'true');
  vi.stubEnv('LOCAL_INGEST_STARTUP_SCAN', 'false');
  vi.stubEnv('DERIVATIVE_MODE', 'lazy');
  vi.stubEnv('BACKUP_AUTO_ENABLED', 'true');
  const { createApplicationRecoveryService } = await import('../src/services/application-recovery-service.js');
  const gaps = createApplicationRecoveryService().config.configurationGaps ?? [];
  for (const key of ['NODE_ENV', 'SERVER_HOST', 'SERVER_PORT', 'COS_GALLERY_MODE', 'LOCAL_INGEST_STARTUP_SCAN', 'DERIVATIVE_MODE', 'BACKUP_AUTO_ENABLED', 'DATA_ROOT', 'BACKUP_ROOT']) {
    expect(gaps.some(gap => gap.includes(`Process-injected ${key} `))).toBe(true);
  }
  expect(gaps.some(gap => gap.includes('APP_ENV_FILE: missing'))).toBe(true);
  expect(gaps.some(gap => gap.includes('APP_RUN_CONFIG_FILE: missing'))).toBe(true);
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
