import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { isolatedTestEnvironment } from '../../scripts/test-environment.mjs';
import { appConfig as initialConfig, environmentFile as initialEnvironmentFile } from '../src/config/env.js';

let fixtureRoot: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (fixtureRoot) {
    const absolute = await fs.realpath(fixtureRoot);
    const temporary = await fs.realpath(os.tmpdir());
    if (path.dirname(absolute) !== temporary || !path.basename(absolute).startsWith('cosgallery-test-environment-')) {
      throw new Error('Refusing to remove a path outside the owned test fixture.');
    }
    await fs.rm(absolute, { recursive: true, force: true });
    fixtureRoot = undefined;
  }
});

it('installs isolated defaults before application setup reads configuration', () => {
  const root = initialConfig.dataRoot;
  expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root)).toMatch(/^foldergram-vitest-\d+$/);
  expect(initialConfig).toMatchObject({
    nodeEnv: 'test',
    dbDir: path.join(root, 'db'),
    galleryRoot: path.join(root, 'gallery'),
    thumbnailsDir: path.join(root, 'thumbnails'),
    previewsDir: path.join(root, 'previews'),
    backupRoot: path.join(root, 'recovery-points'),
    runConfigurationFile: path.join(root, 'test.run.xml'),
    backupAutomatic: { enabled: false },
    localIngestStartupScan: false
  });
  expect(initialEnvironmentFile).toBe(path.join(root, 'test.env'));
});

it.each(['test', 'production'] as const)('keeps actual %s configuration inside the fixture despite inherited paths', async nodeEnv => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-test-environment-'));
  const root = path.join(fixtureRoot, 'isolated');
  const outside = path.join(fixtureRoot, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const sentinel = 'SERVER_ALLOWED_HOSTS=outside.invalid\nBACKUP_AUTO_ENABLED=true\n';
  await fs.writeFile(path.join(outside, 'caller.env'), sentinel);
  await fs.writeFile(path.join(outside, 'caller.run.xml'), '<fixture>preserve caller configuration</fixture>');

  // These are synthetic caller paths, never paths from the actual machine.
  for (const key of ['DATA_ROOT', 'DATA_DIR', 'DB_DIR', 'GALLERY_ROOT', 'THUMBNAILS_DIR', 'PREVIEWS_DIR', 'BACKUP_ROOT']) {
    vi.stubEnv(key, outside);
  }
  vi.stubEnv('APP_ENV_FILE', path.join(outside, 'caller.env'));
  vi.stubEnv('APP_RUN_CONFIG_FILE', path.join(outside, 'caller.run.xml'));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('BACKUP_AUTO_ENABLED', 'true');
  vi.stubEnv('LOCAL_INGEST_STARTUP_SCAN', 'true');
  vi.stubEnv('LOCAL_INGEST_ARCHIVE_PASSWORD', 'synthetic-caller-password');
  vi.stubEnv('SERVER_ALLOWED_HOSTS', undefined);

  const isolated = isolatedTestEnvironment(root, { nodeEnv });
  for (const [key, value] of Object.entries(isolated)) vi.stubEnv(key, value);
  await fs.writeFile(isolated.APP_ENV_FILE, 'SERVER_ALLOWED_HOSTS=isolated.invalid\nBACKUP_AUTO_ENABLED=true\n');
  vi.resetModules();
  const { appConfig, environmentFile } = await import('../src/config/env.js');

  expect(appConfig).toMatchObject({
    nodeEnv,
    dataRoot: root,
    dbDir: path.join(root, 'db'),
    databasePath: path.join(root, 'db', 'gallery.sqlite'),
    galleryRoot: path.join(root, 'gallery'),
    thumbnailsDir: path.join(root, 'thumbnails'),
    previewsDir: path.join(root, 'previews'),
    backupRoot: path.join(root, 'recovery-points'),
    runConfigurationFile: path.join(root, 'test.run.xml'),
    backupAutomatic: { enabled: false },
    localIngestStartupScan: false,
    allowedHosts: nodeEnv === 'production' ? ['isolated.invalid'] : []
  });
  expect(environmentFile).toBe(path.join(root, 'test.env'));
  expect(process.env.DATA_DIR).toBe(root);
  expect(process.env.LOCAL_INGEST_ARCHIVE_PASSWORD).toBe('');
  // Importing configuration neither reads the external sentinel into the app
  // nor modifies caller files or creates a database, backup or media directory.
  expect(await fs.readFile(path.join(outside, 'caller.env'), 'utf8')).toBe(sentinel);
  expect(await fs.readFile(path.join(outside, 'caller.run.xml'), 'utf8')).toBe('<fixture>preserve caller configuration</fixture>');
  expect((await fs.readdir(outside)).sort()).toEqual(['caller.env', 'caller.run.xml']);
  expect(await fs.readdir(root)).toEqual(['test.env']);
});

it('rejects a relative root before it can resolve against an application checkout', () => {
  expect(() => isolatedTestEnvironment('data')).toThrow('absolute fixture root');
});
