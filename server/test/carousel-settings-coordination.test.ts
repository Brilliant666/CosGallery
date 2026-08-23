import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestTestApp } from './http-test-utils.js';

type AppConfigModule = typeof import('../src/config/env.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type ScannerServiceModule = typeof import('../src/services/scanner-service.js');
type DatabaseModule = typeof import('../src/db/database.js');
type AppModule = typeof import('../src/app.js');

async function requestApp(app: express.Application, method: string, urlPath: string, body?: unknown) {
  return requestTestApp(app, method, urlPath, { 'x-foldergram-intent': '1' }, body);
}

describe.sequential('carousel settings persistence', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let scannerService: ScannerServiceModule['scannerService'];
  let appSettingsRepository: RepositoriesModule['appSettingsRepository'];
  let databaseManager: DatabaseModule['databaseManager'];
  let createApp: AppModule['createApp'];
  let TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY: string;
  let CAROUSELS_MIGRATION_DECISION_SETTING_KEY: string;
  let CAROUSELS_APPLIED_MODE_SETTING_KEY: string;
  let LIBRARY_REBUILD_REQUIRED_SETTING_KEY: string;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-settings-test-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  });

  beforeEach(async () => {
    databaseManager?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });

    vi.resetModules();

    ({ appConfig } = await import('../src/config/env.js'));
    ({ scannerService } = await import('../src/services/scanner-service.js'));
    ({ appSettingsRepository } = await import('../src/db/repositories.js'));
    ({ databaseManager } = await import('../src/db/database.js'));
    ({ createApp } = await import('../src/app.js'));
    const { authService } = await import('../src/services/auth-service.js');
    authService.refresh();
    const {
      TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY: key1,
      CAROUSELS_MIGRATION_DECISION_SETTING_KEY: key2,
      CAROUSELS_APPLIED_MODE_SETTING_KEY: key3,
      LIBRARY_REBUILD_REQUIRED_SETTING_KEY: key4
    } = await import('../src/constants/app-setting-keys.js');
    TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY = key1;
    CAROUSELS_MIGRATION_DECISION_SETTING_KEY = key2;
    CAROUSELS_APPLIED_MODE_SETTING_KEY = key3;
    LIBRARY_REBUILD_REQUIRED_SETTING_KEY = key4;

    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);
  });

  afterAll(async () => {
    databaseManager?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rolls back atomically when setMany encounters a failure', () => {
    appSettingsRepository.set(TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY, '0');
    appSettingsRepository.set(CAROUSELS_MIGRATION_DECISION_SETTING_KEY, 'carousels');

    const database = databaseManager.connection;
    const origPrepare = database.prepare.bind(database);

    let runCount = 0;
    vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('INSERT INTO app_settings')) {
        return {
          ...stmt,
          run(...params: unknown[]) {
            runCount++;
            if (runCount === 2) {
              throw new Error('simulated second SQLite write failure');
            }
            return stmt.run(...params);
          }
        } as any;
      }
      return stmt;
    });

    expect(() => {
      appSettingsRepository.setMany([
        { key: TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY, value: '1' },
        { key: CAROUSELS_MIGRATION_DECISION_SETTING_KEY, value: 'restore' }
      ]);
    }).toThrow('simulated second SQLite write failure');

    // Both settings must be in their original state due to transaction rollback
    expect(appSettingsRepository.get(TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY)).toBe('0');
    expect(appSettingsRepository.get(CAROUSELS_MIGRATION_DECISION_SETTING_KEY)).toBe('carousels');
  });

  it('persists the selected mode without starting a library scan', async () => {
    const app = createApp();
    appSettingsRepository.set(TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY, '0');
    appSettingsRepository.set(CAROUSELS_MIGRATION_DECISION_SETTING_KEY, 'carousels');

    const scanSpy = vi.spyOn(scannerService, 'scanAll');
    appSettingsRepository.set(LIBRARY_REBUILD_REQUIRED_SETTING_KEY, '1');

    const response = await requestApp(app, 'POST', '/api/admin/settings/carousels-as-folders', {
      treatCarouselsAsFolders: true
    });

    expect(response.status).toBe(200);
    expect(response.body.preferences.treatCarouselsAsFolders).toBe(true);
    expect(response.body.libraryIndex.rebuildRequired).toBe(true);
    expect(response.body.carouselsMigration.reconciliationPending).toBe(true);
    expect(appSettingsRepository.get(TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY)).toBe('1');
    expect(appSettingsRepository.get(CAROUSELS_MIGRATION_DECISION_SETTING_KEY)).toBe('restore');
    expect(appSettingsRepository.get(CAROUSELS_APPLIED_MODE_SETTING_KEY)).toBeNull();
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('persists the migration-card decision without starting a library scan', async () => {
    const app = createApp();
    const scanSpy = vi.spyOn(scannerService, 'scanAll');

    const response = await requestApp(app, 'POST', '/api/admin/settings/carousels-migration-decision', {
      decision: 'carousels'
    });

    expect(response.status).toBe(200);
    expect(response.body.preferences.treatCarouselsAsFolders).toBe(false);
    expect(response.body.carouselsMigration.reconciliationPending).toBe(true);
    expect(appSettingsRepository.get(TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY)).toBe('0');
    expect(appSettingsRepository.get(CAROUSELS_MIGRATION_DECISION_SETTING_KEY)).toBe('carousels');
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('keeps reconciliation pending across status reloads until a full scan applies the selected mode', async () => {
    const app = createApp();

    const saveResponse = await requestApp(app, 'POST', '/api/admin/settings/carousels-as-folders', {
      treatCarouselsAsFolders: true
    });
    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.carouselsMigration.reconciliationPending).toBe(true);

    const pendingStatus = await requestApp(app, 'GET', '/api/status');
    expect(pendingStatus.status).toBe(200);
    expect(pendingStatus.body.carouselsMigration.reconciliationPending).toBe(true);

    const scanResponse = await requestApp(app, 'POST', '/api/admin/rescan');
    expect(scanResponse.status).toBe(200);
    expect(appSettingsRepository.get(CAROUSELS_APPLIED_MODE_SETTING_KEY)).toBe('1');

    const appliedStatus = await requestApp(app, 'GET', '/api/status');
    expect(appliedStatus.status).toBe(200);
    expect(appliedStatus.body.carouselsMigration.reconciliationPending).toBe(false);
  });

  it('keeps reconciliation pending when a full scan fails', async () => {
    const app = createApp();

    await requestApp(app, 'POST', '/api/admin/settings/carousels-as-folders', {
      treatCarouselsAsFolders: true
    });
    vi.spyOn(scannerService, 'scanAll').mockRejectedValueOnce(new Error('simulated scan failure'));

    const scanResponse = await requestApp(app, 'POST', '/api/admin/rescan');
    expect(scanResponse.status).toBe(500);
    expect(appSettingsRepository.get(CAROUSELS_APPLIED_MODE_SETTING_KEY)).toBeNull();

    const statusResponse = await requestApp(app, 'GET', '/api/status');
    expect(statusResponse.body.carouselsMigration.reconciliationPending).toBe(true);
  });
});
