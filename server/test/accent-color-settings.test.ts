import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';
import { ACCENT_COLORS } from '../src/types/accent-color.js';

describe.sequential('shared accent color settings', () => {
  let root: string, app: express.Application;
  let database: typeof import('../src/db/database.js')['databaseManager'];
  let settings: typeof import('../src/db/repositories.js')['appSettingsRepository'];
  let admin: Record<string, string>, viewer: Record<string, string>;
  const route = '/api/admin/settings/accent-color';
  const key = 'app.accent_color';
  const snapshot = () => database.connection.prepare('SELECT key,value FROM app_settings ORDER BY key').all();
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'accent-color-settings-'));
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('PUBLIC_DEMO_MODE', '0');
    for (const name of ['DATA_ROOT', 'GALLERY_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      const dir = path.join(root, name); await fs.mkdir(dir); vi.stubEnv(name, dir);
    }
    vi.resetModules();
    database = (await import('../src/db/database.js')).databaseManager;
    settings = (await import('../src/db/repositories.js')).appSettingsRepository;
    app = (await import('../src/app.js')).createApp();
    const auth = (await import('../src/services/auth-service.js')).authService;
    auth.setAdminPassword('isolated-accent-admin-password'); auth.setViewerAccess('public');
    const session = (role: 'admin' | 'viewer') => {
      let cookie = '';
      auth.setAuthenticatedSession({ cookie(name: string, value: string) { cookie = `${name}=${value}`; } } as express.Response,
        { secure: false, get() { return undefined; } } as unknown as express.Request, role);
      return { cookie, 'x-foldergram-intent': '1' };
    };
    admin = session('admin'); viewer = session('viewer');
  });
  beforeEach(() => { database.connection.prepare('DELETE FROM app_settings WHERE key=?').run(key); });
  afterAll(async () => {
    database?.close(); vi.unstubAllEnvs(); vi.resetModules();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('defaults missing and unknown stored values to blue without writing or repairing settings', async () => {
    for (const value of [null, 'obsolete-theme', '#ff0000', '']) {
      if (value !== null) settings.set(key, value);
      const before = snapshot();
      const publicResponse = await requestTestApp(app, 'GET', '/api/status');
      const adminResponse = await requestTestApp(app, 'GET', '/api/admin/stats', admin);
      expect(publicResponse.status).toBe(200); expect(adminResponse.status).toBe(200);
      expect(publicResponse.body.preferences.accentColor).toBe('blue');
      expect(adminResponse.body.preferences.accentColor).toBe('blue');
      expect(snapshot()).toEqual(before);
    }
  });

  it.each(ACCENT_COLORS)('persists %s across connection reopen and shares it with anonymous and administrator readers', async accentColor => {
    settings.set('app.default_locale', 'zh'); settings.set('feed.default_home_mode', 'rediscover');
    const untouched = snapshot();
    const saved = await requestTestApp(app, 'PUT', route, admin, { accentColor });
    expect(saved.status).toBe(200); expect(saved.body).toEqual({ accentColor });
    expect(snapshot().filter(row => row.key !== key)).toEqual(untouched);
    database.close();
    expect(settings.get(key)).toBe(accentColor);
    for (const [url, headers] of [['/api/status', {}], ['/api/admin/stats', admin]] as const) {
      const read = await requestTestApp(app, 'GET', url, headers);
      expect(read.status).toBe(200); expect(read.body.preferences.accentColor).toBe(accentColor);
      expect(read.body.preferences.defaultLocale).toBe('zh');
      expect(read.body.preferences.defaultHomeFeedMode).toBe('rediscover');
    }
  });

  it('rejects arbitrary colors, malformed bodies and extra settings without changing any setting', async () => {
    settings.set(key, 'teal');
    const before = snapshot();
    for (const body of [{}, { accentColor: null }, { accentColor: 'BLUE' }, { accentColor: '#ff0000' },
      { accentColor: 'url(https://invalid.test)' }, { accentColor: ['blue'] },
      { accentColor: 'rose', defaultLocale: 'en' }]) {
      expect((await requestTestApp(app, 'PUT', route, admin, body)).status).toBe(400);
      expect(snapshot()).toEqual(before);
    }
  });

  it('protects writes from anonymous, viewer, missing-intent and cross-origin requests', async () => {
    settings.set(key, 'purple'); const before = snapshot();
    for (const [headers, status] of [
      [{ 'x-foldergram-intent': '1' }, 401], [viewer, 403], [{ cookie: admin.cookie }, 403],
      [{ ...admin, origin: 'https://untrusted.invalid' }, 403]
    ] as Array<[Record<string, string>, number]>) {
      expect((await requestTestApp(app, 'PUT', route, headers, { accentColor: 'rose' })).status).toBe(status);
      expect(snapshot()).toEqual(before);
    }
  });
});
