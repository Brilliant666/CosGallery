import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';

describe.sequential('Host, origin, CLI identity and scoped bridge boundaries', () => {
  let app: express.Application, root: string, cookie: string, bridgeToken: string;
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  const intent = { 'x-foldergram-intent': '1', host: 'localhost:4141' };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'h1-request-boundary-'));
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SERVER_PORT', '4141');
    vi.stubEnv('SERVER_HOST', '127.0.0.1'); vi.stubEnv('SERVER_ALLOWED_HOSTS', '');
    vi.stubEnv('CSRF_TRUSTED_ORIGINS', ''); vi.stubEnv('APP_ENV_FILE', path.join(root, 'missing.env'));
    for (const [name, suffix] of Object.entries({ DATA_ROOT: '', DB_DIR: 'db', GALLERY_ROOT: 'gallery', THUMBNAILS_DIR: 'thumbs', PREVIEWS_DIR: 'previews', BACKUP_ROOT: 'backups' })) vi.stubEnv(name, path.join(root, suffix));
    await fs.mkdir(path.join(root, 'gallery'));
    vi.resetModules();
    manager = (await import('../src/db/database.js')).databaseManager;
    const { authService } = await import('../src/services/auth-service.js');
    authService.setAdminPassword('synthetic-h1-boundary-password');
    bridgeToken = new (await import('../src/services/archive-bridge-service.js')).ArchiveBridgeService().rotateToken();
    app = (await import('../src/app.js')).createApp();
    const login = await requestTestApp(app, 'POST', '/api/auth/login', intent, { password: 'synthetic-h1-boundary-password' });
    expect(login.status).toBe(200);
    cookie = login.headers.get('set-cookie')!.split(';')[0];
  });
  afterAll(async () => {
    manager?.close(); vi.unstubAllEnvs(); vi.resetModules();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('checks Host before health, media, share and even token-authenticated bridge routes', async () => {
    for (const endpoint of ['/api/health', '/thumbnails/missing.jpg', '/api/share/folders/test/access', '/api/archive-bridge/ping']) {
      const result = await requestTestApp(app, 'GET', endpoint, {
        host: 'rebind.attacker.invalid', 'x-forwarded-host': 'localhost:4141', 'x-cosgallery-bridge-token': bridgeToken
      });
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('UNTRUSTED_HOST');
    }
  });

  it('preserves extension bridge token scope, not an admin API bypass', async () => {
    const headers = { host: 'localhost:4141', origin: 'chrome-extension://synthetic', 'x-cosgallery-bridge-token': bridgeToken };
    expect((await requestTestApp(app, 'GET', '/api/archive-bridge/ping', headers)).status).toBe(200);
    expect((await requestTestApp(app, 'GET', '/api/archive-bridge/ping', { host: 'localhost:4141' })).status).toBe(401);
    expect((await requestTestApp(app, 'GET', '/api/admin/local-ingest/operation', headers)).status).toBe(401);
  });

  it('CLI intent alone is not identity; an authenticated CLI session remains usable', async () => {
    const endpoint = '/api/admin/settings/home-feed-default', body = { defaultMode: 'recent' };
    for (const headers of [intent, { ...intent, 'sec-fetch-mode': 'cors' }]) {
      expect((await requestTestApp(app, 'PUT', endpoint, headers, body)).status).toBe(401);
      expect((await requestTestApp(app, 'PUT', endpoint, { ...headers, cookie }, body)).status).toBe(200);
    }
  });

  it('does not allow HTTP settings or validation to select a different executable', async () => {
    const headers = { ...intent, cookie };
    const settings = await requestTestApp(app, 'GET', '/api/admin/local-ingest/settings', headers);
    expect(settings.status).toBe(200);
    const changed = { ...settings.body, sevenZipPath: 'C:\\synthetic-h1-unapproved\\7z.exe' };
    for (const [method, endpoint] of [['PUT', '/api/admin/local-ingest/settings'], ['POST', '/api/admin/local-ingest/settings/validate']]) {
      const result = await requestTestApp(app, method, endpoint, headers, changed);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('SEVEN_ZIP_STARTUP_OWNED');
    }
    expect((await requestTestApp(app, 'GET', '/api/admin/local-ingest/settings', headers)).body).toEqual(settings.body);
  });

  it('accepts matching webpage origin, rejects spoofed forwarding and contradictory metadata', async () => {
    const endpoint = '/api/admin/settings/home-feed-default', body = { defaultMode: 'recent' };
    expect((await requestTestApp(app, 'PUT', endpoint, {
      ...intent, cookie, origin: 'http://localhost:4141', referer: 'http://localhost:4141/settings', 'sec-fetch-site': 'same-origin'
    }, body)).status).toBe(200);
    for (const provenance of [
      { origin: 'https://attacker.invalid', 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'https' },
      { origin: 'http://localhost:4141', referer: 'http://attacker.invalid/page' },
      { origin: 'null' }, { referer: 'broken' }, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }
    ]) expect((await requestTestApp(app, 'PUT', endpoint, { ...intent, cookie, ...provenance } as Record<string, string>, body)).status).toBe(403);
  });
});
