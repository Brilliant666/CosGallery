import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';

describe.sequential('Companion real HTTP boundary on synthetic database', () => {
  let root: string, app: express.Application, cookie: string, viewerCookie: string, token: string, grantId: string;
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const host = { host: 'localhost:4141' };
  const admin = () => ({ ...host, cookie, 'x-foldergram-intent': '1', origin: 'http://localhost:4141' });
  const plugin = () => ({ ...host, origin, authorization: `Bearer ${token}` });
  const item = { requestKey: 'fixture-1', site: 'costuan.com', pageType: 'resource', pageIdentifier: '/123.html', candidateNames: ['Fixture'] };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-http-'));
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SERVER_PORT', '4141'); vi.stubEnv('SERVER_HOST', '127.0.0.1');
    vi.stubEnv('SERVER_ALLOWED_HOSTS', ''); vi.stubEnv('CSRF_TRUSTED_ORIGINS', '');
    vi.stubEnv('APP_ENV_FILE', path.join(root, 'missing.env')); vi.stubEnv('APP_RUN_CONFIG_FILE', path.join(root, 'missing.xml'));
    for (const [key, suffix] of Object.entries({ DATA_ROOT: 'data', DB_DIR: 'db', GALLERY_ROOT: 'gallery', THUMBNAILS_DIR: 'thumbs', PREVIEWS_DIR: 'previews', BACKUP_ROOT: 'backups' })) {
      await fs.mkdir(path.join(root, suffix), { recursive: true }); vi.stubEnv(key, path.join(root, suffix));
    }
    vi.resetModules();
    manager = (await import('../src/db/database.js')).databaseManager;
    const { authService } = await import('../src/services/auth-service.js');
    authService.setAdminPassword('synthetic-companion-admin'); authService.setViewerAccess('password', 'synthetic-companion-viewer');
    app = (await import('../src/app.js')).createApp();
    const login = async (password: string) => {
      const result = await requestTestApp(app, 'POST', '/api/auth/login', { ...host, 'x-foldergram-intent': '1' }, { password });
      expect(result.status).toBe(200); return result.headers.get('set-cookie')!.split(';')[0]!;
    };
    cookie = await login('synthetic-companion-admin'); viewerCookie = await login('synthetic-companion-viewer');
    manager.connection.exec("INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id,preference) VALUES(1,'Fixture','fixture','synthetic','1','liked')");
    const created = await requestTestApp(app, 'POST', '/api/admin/companion/grants', admin(), {
      label: 'Synthetic extension', extensionOrigin: origin, expiresInDays: 30,
      scopes: ['identity:read', 'summary:read', 'library:link', 'catalog:link']
    });
    expect(created.status).toBe(201); token = created.body.token; grantId = created.body.grant.id;
  });
  afterAll(async () => {
    manager?.close(); vi.unstubAllEnvs(); vi.resetModules();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('creates only through ordinary admin capability and CSRF, never returns saved tokens', async () => {
    const endpoint = '/api/admin/companion/grants';
    expect((await requestTestApp(app, 'GET', endpoint, host)).status).toBe(401);
    expect((await requestTestApp(app, 'GET', endpoint, { ...host, cookie: viewerCookie })).status).toBe(403);
    expect((await requestTestApp(app, 'POST', endpoint, { ...host, cookie }, {})).status).toBe(403);
    expect((await requestTestApp(app, 'POST', endpoint, { ...admin(), origin }, {})).status).toBe(403);
    const list = await requestTestApp(app, 'GET', endpoint, admin());
    expect(list.status).toBe(200); expect(list.body.grants[0].id).toBe(grantId);
    expect(JSON.stringify(list.body)).not.toContain(token); expect(JSON.stringify(list.body)).not.toContain('tokenHash');
  });

  it('requires dedicated authorization even with admin cookie and never bypasses gallery login', async () => {
    const endpoint = '/api/companion/v1/connection';
    for (const extra of [{}, { cookie }, { 'x-cosgallery-bridge-token': 'synthetic-legacy' }]) {
      const result = await requestTestApp(app, 'GET', endpoint, { ...host, ...extra });
      expect(result.status).toBe(401); expect(result.body.collectedWorkCount).toBeNull();
    }
    const result = await requestTestApp(app, 'GET', endpoint, plugin());
    expect(result.status).toBe(200); expect(result.body.apiVersion).toBe('companion-v1');
    expect(result.body.capabilities.mutations).toBe(false); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.body.capabilities).toMatchObject({ rosterSync: true, aliasSync: true, maxRosterPageSize: 50, maxAliasPageSize: 200, maxPageBytes: 262144 });
    expect((await requestTestApp(app, 'GET', '/api/admin/local-ingest/operation', plugin())).status).toBe(401);
    expect((await requestTestApp(app, 'GET', '/api/library', plugin())).status).toBe(401);
  });

  it('keeps Host and narrow origin/preflight checks; does not trust forwarding or resource-site origin', async () => {
    const endpoint = '/api/companion/v1/connection';
    expect((await requestTestApp(app, 'GET', endpoint, { ...plugin(), host: 'attacker.invalid', 'x-forwarded-host': 'localhost:4141' })).status).toBe(403);
    for (const originValue of ['https://costuan.com', 'null', `chrome-extension://${'b'.repeat(32)}`]) {
      const result = await requestTestApp(app, 'GET', endpoint, { ...plugin(), origin: originValue });
      expect(result.status).toBe(403); expect(result.body.collectedWorkCount).toBeNull();
      expect(result.headers.get('access-control-allow-origin')).toBeNull();
    }
    const headers = { ...host, origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' };
    const preflight = await requestTestApp(app, 'OPTIONS', '/api/companion/v1/resolve', headers);
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    expect((await requestTestApp(app, 'OPTIONS', '/api/admin/companion/grants', headers)).headers.get('access-control-allow-origin')).toBeNull();
    expect((await requestTestApp(app, 'OPTIONS', endpoint, { ...headers, 'access-control-request-method': 'DELETE' })).status).toBe(403);
    expect((await requestTestApp(app, 'OPTIONS', endpoint, { ...headers, 'access-control-request-headers': 'x-cosgallery-bridge-token' })).status).toBe(403);
    expect((await requestTestApp(app, 'GET', endpoint, { ...host, authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await requestTestApp(app, 'GET', endpoint, { ...host, authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('reads limited summaries and partial batches without domain writes or initialization/rebuild', async () => {
    const before = manager.connection.prepare('SELECT total_changes() n').get();
    const summary = await requestTestApp(app, 'GET', '/api/companion/v1/creators/1', plugin());
    expect(summary.status).toBe(200); expect(summary.body).toMatchObject({ creatorId: 1, canonicalName: 'Fixture', collectedWorkCount: null, matchStatus: 'manual', readModel: { status: 'uninitialized' } });
    expect(summary.body.links).toEqual({ library: '/library/1', catalog: '/archive-catalog?workspace=resources&creatorId=1' });
    const search = await requestTestApp(app, 'GET', '/api/companion/v1/creators?q=Fix', plugin());
    expect(search.status).toBe(200); expect(search.body.items).toHaveLength(1);
    for (const name of ['preference', 'absolute_path', 'source_url', 'metadata_json', 'tokenHash', 'images', 'password']) expect(JSON.stringify(summary.body)).not.toContain(name);
    const result = await requestTestApp(app, 'POST', '/api/companion/v1/resolve', plugin(), { items: [null, item] });
    expect(result.status).toBe(200); expect(result.body.batchStatus).toBe('partial_failure');
    expect(result.body.items[0]).toMatchObject({ index: 0, requestKey: null, collectedWorkCount: null, error: { status: 400 } });
    expect(result.body.items[1]).toMatchObject({ requestKey: 'fixture-1', matchStatus: 'matched', creator: { creatorId: 1 } });
    expect(manager.connection.prepare('SELECT total_changes() n').get()).toEqual(before);
  });

  it('bounds query/body/batch and returns null on failures instead of zero', async () => {
    for (const body of [{ items: [] }, { items: Array.from({ length: 51 }, (_, i) => ({ ...item, requestKey: `r${i}` })) }, { items: [item, item] }]) {
      const result = await requestTestApp(app, 'POST', '/api/companion/v1/resolve', plugin(), body);
      expect(result.status).toBe(400); expect(result.body.collectedWorkCount).toBeNull();
    }
    for (const body of ['invalid-json-object', { items: [item], padding: 'x'.repeat(34_000) }]) {
      const result = await requestTestApp(app, 'POST', '/api/companion/v1/resolve', plugin(), body);
      expect([400, 413]).toContain(result.status); expect(result.body.collectedWorkCount).toBeNull();
    }
    expect((await requestTestApp(app, 'GET', `/api/companion/v1/creators?q=${'x'.repeat(121)}`, plugin())).status).toBe(400);
    expect((await requestTestApp(app, 'GET', '/api/companion/v1/creators/999', plugin())).body.collectedWorkCount).toBeNull();
    expect((await requestTestApp(app, 'POST', '/api/companion/v1/claim', plugin(), {})).status).toBe(404);
  });

  it('enforces identity-only scope and omits ungranted links', async () => {
    const created = await requestTestApp(app, 'POST', '/api/admin/companion/grants', admin(), { label: 'Names only', extensionOrigin: origin, scopes: ['identity:read'] });
    const headers = { ...plugin(), authorization: `Bearer ${created.body.token}` };
    const connection = await requestTestApp(app, 'GET', '/api/companion/v1/connection', headers);
    expect(connection.body.capabilities.creatorSummary).toBe(false);
    const summary = await requestTestApp(app, 'GET', '/api/companion/v1/creators/1', headers);
    expect(summary.status).toBe(403); expect(summary.body.collectedWorkCount).toBeNull();
    const resolved = await requestTestApp(app, 'POST', '/api/companion/v1/resolve', headers, { items: [item] });
    expect(resolved.body.items[0]).toMatchObject({ collectedWorkCount: null, readModel: { status: 'permission_denied' }, creator: { links: {} } });
    const roster = await requestTestApp(app, 'GET', '/api/companion/v1/roster', headers);
    expect(roster.status).toBe(200);
    expect(roster.body.items[0]).toMatchObject({ creatorId: 1, preference: 'liked', collectedWorkCount: null, readModel: { status: 'permission_denied' }, links: {} });
    const aliases = await requestTestApp(app, 'GET', `/api/companion/v1/aliases?identityVersion=${roster.body.identityVersion}`, headers);
    expect(aliases.status).toBe(200); expect(aliases.body.identityVersion).toBe(roster.body.identityVersion);
  });

  it('pages authorized roster/aliases with shared identity consistency and unchanged DB', async () => {
    const db = manager.connection;
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(2,'Second','second','synthetic','2');
      INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(1,'Shared','shared','one'),(1,'Shared','shared','two'),(2,'Shared','shared','one')`);
    const before = db.prepare('SELECT total_changes() n').get();
    for (const path of ['/roster', '/aliases']) expect((await requestTestApp(app, 'GET', '/api/companion/v1' + path, host)).status).toBe(401);
    const first = await requestTestApp(app, 'GET', '/api/companion/v1/roster?limit=1', plugin());
    expect(first.status).toBe(200); expect(first.body.total).toBe(2); expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({ creatorId: 1, canonicalName: 'Fixture', preference: 'liked', collectedWorkCount: null, readModel: { status: 'uninitialized' }, links: { library: '/library/1' } });
    const version = first.body.identityVersion;
    expect(version).toMatch(/^[a-f0-9]{64}$/);
    const next = await requestTestApp(app, 'GET', `/api/companion/v1/roster?limit=1&identityVersion=${version}&cursor=${encodeURIComponent(first.body.nextCursor)}`, plugin());
    expect(next.status).toBe(200); expect(next.body.items[0].creatorId).toBe(2); expect(next.body.nextCursor).toBeNull();
    expect(next.body.items[0].preference).toBeNull();
    expect(next.body).toMatchObject({ identityVersion: version, instanceId: first.body.instanceId, grantId: first.body.grantId, permissionFingerprint: first.body.permissionFingerprint });
    const aliases = await requestTestApp(app, 'GET', `/api/companion/v1/aliases?identityVersion=${version}`, plugin());
    expect(aliases.status).toBe(200); expect(aliases.body.total).toBe(2);
    expect(aliases.body.items).toEqual([{ creatorId: 1, alias: 'Shared' }, { creatorId: 2, alias: 'Shared' }]);
    for (const path of ['/aliases', '/roster?limit=51', '/aliases?limit=201', '/roster?identityVersion=bad', `/roster?cursor=${first.body.nextCursor}`]) {
      const invalid = await requestTestApp(app, 'GET', '/api/companion/v1' + path, plugin());
      expect(invalid.status).toBe(400); expect(invalid.body.collectedWorkCount).toBeNull();
    }
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    db.exec("UPDATE archive_catalog_creators SET canonical_name='Renamed' WHERE id=2");
    for (const path of ['/roster', '/aliases']) {
      const changed = await requestTestApp(app, 'GET', `/api/companion/v1${path}?identityVersion=${version}`, plugin());
      expect(changed.status).toBe(409); expect(changed.body).toMatchObject({ code: 'COMPANION_IDENTITY_CHANGED', collectedWorkCount: null });
    }
  });

  it('invalidates both streams on preference edits without exposing a preference mutation route', async () => {
    const db = manager.connection;
    const first = await requestTestApp(app, 'GET', '/api/companion/v1/roster?limit=1', plugin());
    try {
      db.exec("UPDATE archive_catalog_creators SET preference='kept' WHERE id=2");
      const before = db.prepare('SELECT total_changes() n').get();
      for (const route of ['/roster', '/aliases']) {
        const stale = await requestTestApp(app, 'GET', `/api/companion/v1${route}?identityVersion=${first.body.identityVersion}`, plugin());
        expect(stale.status).toBe(409); expect(stale.body.code).toBe('COMPANION_IDENTITY_CHANGED');
        expect(stale.body.items).toBeUndefined();
      }
      const fresh = await requestTestApp(app, 'GET', '/api/companion/v1/roster', plugin());
      expect(fresh.status).toBe(200); expect(fresh.body.identityVersion).not.toBe(first.body.identityVersion);
      expect(fresh.body.items.find((entry: { creatorId: number }) => entry.creatorId === 2).preference).toBe('kept');
      const write = await requestTestApp(app, 'POST', '/api/companion/v1/roster', plugin(), { creatorId: 2, preference: 'liked' });
      expect(write.status).toBe(404);
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    } finally { db.exec('UPDATE archive_catalog_creators SET preference=NULL WHERE id=2'); }
  });

  it('rejects an oversized directory response rather than silently truncating it', async () => {
    const db = manager.connection;
    const old = db.prepare('SELECT canonical_name FROM archive_catalog_creators WHERE id=2').get()!.canonical_name;
    try {
      db.prepare('UPDATE archive_catalog_creators SET canonical_name=? WHERE id=2').run('大'.repeat(100000));
      const result = await requestTestApp(app, 'GET', '/api/companion/v1/roster', plugin());
      expect(result.status).toBe(413); expect(result.body).toMatchObject({ code: 'COMPANION_PAGE_TOO_LARGE', collectedWorkCount: null });
      expect(result.body.items).toBeUndefined();
    } finally { db.prepare('UPDATE archive_catalog_creators SET canonical_name=? WHERE id=2').run(old); }
  });

  it('revocation immediately invalidates connection and cached-result revalidation', async () => {
    const endpoint = '/api/admin/companion/grants/' + grantId;
    expect((await requestTestApp(app, 'DELETE', endpoint, plugin())).status).toBe(403);
    expect((await requestTestApp(app, 'DELETE', endpoint, admin())).status).toBe(200);
    for (const route of ['/connection', '/creators/1', '/creators?q=Fix', '/roster', '/aliases']) {
      const result = await requestTestApp(app, 'GET', '/api/companion/v1' + route, plugin());
      expect(result.status).toBe(401); expect(result.body.collectedWorkCount).toBeNull();
    }
  });
});
