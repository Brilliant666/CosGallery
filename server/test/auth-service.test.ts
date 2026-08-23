import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type AuthServiceModule = typeof import('../src/services/auth-service.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type AppSettingKeysModule = typeof import('../src/constants/app-setting-keys.js');

function createRequest(method: string, routePath: string): express.Request {
  return {
    method,
    path: routePath,
    secure: false,
    get() {
      return undefined;
    }
  } as unknown as express.Request;
}

describe.sequential('auth service roles', () => {
  let tempRoot = '';
  let authService: AuthServiceModule['authService'];
  let appSettingsRepository: RepositoriesModule['appSettingsRepository'];
  let APP_DEFAULT_LOCALE_SETTING_KEY: AppSettingKeysModule['APP_DEFAULT_LOCALE_SETTING_KEY'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-auth-service-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  });

  beforeEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });

    vi.resetModules();
    ({ authService } = await import('../src/services/auth-service.js'));
    ({ appSettingsRepository } = await import('../src/db/repositories.js'));
    ({ APP_DEFAULT_LOCALE_SETTING_KEY } = await import('../src/constants/app-setting-keys.js'));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('authenticates admin and viewer passwords as different roles', () => {
    authService.setAdminPassword('admin-pass-123');
    authService.setViewerAccess('password', 'viewer-pass-123');

    expect(authService.authenticatePassword('admin-pass-123')).toBe('admin');
    expect(authService.authenticatePassword('viewer-pass-123')).toBe('viewer');
    expect(authService.authenticatePassword('wrong-pass-123')).toBeNull();
  });

  it('rejects viewer passwords that match the admin password', () => {
    authService.setAdminPassword('same-pass-123');

    expect(() => authService.setViewerAccess('password', 'same-pass-123')).toThrowError(
      /Viewer password must be different from the admin password\./
    );
  });

  it('rejects admin password changes that match the current viewer password', () => {
    authService.setAdminPassword('admin-pass-123');
    authService.setViewerAccess('password', 'viewer-pass-123');

    expect(() => authService.setAdminPassword('viewer-pass-123')).toThrowError(
      /Viewer password must be different from the admin password\./
    );
  });

  it('reports anonymous public viewer status with local favorites when public mode is enabled', () => {
    authService.setAdminPassword('admin-pass-123');
    authService.setViewerAccess('public');

    expect(authService.getStatus(createRequest('GET', '/feed'))).toMatchObject({
      enabled: true,
      authenticated: false,
      role: 'anonymous',
      accessMode: 'public',
      likesMode: 'local',
      capabilities: {
        canManageLibrary: false,
        canDeleteMedia: false,
        canAccessSettings: false,
        canUseSharedLikes: false,
        canUseLocalFavorites: true
      }
    });
  });

  it('includes the saved app default locale in public auth status', () => {
    appSettingsRepository.set(APP_DEFAULT_LOCALE_SETTING_KEY, 'zh');
    authService.setAdminPassword('admin-pass-123');

    expect(authService.getStatus(createRequest('GET', '/auth/status'))).toMatchObject({
      enabled: true,
      authenticated: false,
      role: 'anonymous',
      accessMode: 'off',
      defaultLocale: 'zh'
    });
  });
});
