import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanionGrantService, COMPANION_GRANTS_KEY } from '../src/services/companion-grant-service.js';

const origin = `chrome-extension://${'a'.repeat(32)}`;
const body = { label: 'Synthetic browser', extensionOrigin: origin, scopes: ['identity:read', 'summary:read'], expiresInDays: 30 };
const dbs: DatabaseSync[] = [];
function fixture(now = () => Date.now()) {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  return { db, service: new CompanionGrantService(db, now) };
}
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe('Companion dedicated grants', () => {
  it('does not initialize or write on reads; uses a stable non-sensitive instance identity', () => {
    const { db, service } = fixture();
    expect(service.list()).toEqual({ instanceId: null, label: 'CosGallery', grants: [] });
    expect(() => service.authenticate(undefined, origin)).toThrow(/无效/);
    expect(db.prepare('SELECT count(*) n FROM app_settings').get()).toEqual({ n: 0 });
    const created = service.create(body);
    const before = db.prepare('SELECT total_changes() n').get();
    const auth = service.authenticate(`Bearer ${created.token}`, origin);
    expect(auth.instanceId).toBe(created.instanceId);
    expect(auth.grant.id).toBe(created.grant.id);
    expect(new CompanionGrantService(db).list().instanceId).toBe(created.instanceId);
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    expect(JSON.stringify(service.list())).not.toContain(created.token);
    expect(JSON.stringify(service.list())).not.toContain('tokenHash');
    expect((db.prepare('SELECT value FROM app_settings WHERE key=?').get(COMPANION_GRANTS_KEY) as { value: string }).value).not.toContain(created.token);
  });

  it('separates instances, grants and permission fingerprints', () => {
    const first = fixture(), second = fixture();
    const a = first.service.create(body), b = second.service.create(body);
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(() => second.service.authenticate(`Bearer ${a.token}`, origin)).toThrow(/无效/);
    const c = first.service.create({ ...body, scopes: ['identity:read'] });
    expect(first.service.authenticate(`Bearer ${a.token}`, origin).permissionFingerprint)
      .not.toBe(first.service.authenticate(`Bearer ${c.token}`, origin).permissionFingerprint);
  });

  it('rejects legacy credentials, a wrong origin, expiry and revoked grants on every call', () => {
    let now = Date.now(); const { service } = fixture(() => now);
    const a = service.create({ ...body, expiresInDays: 1 });
    for (const token of ['admin-session', 'archive-bridge-token', `${a.token.slice(0, -1)}!`]) {
      expect(() => service.authenticate(`Bearer ${token}`, origin)).toThrow(/无效/);
    }
    expect(() => service.authenticate(`Bearer ${a.token}`, 'https://costuan.com')).toThrow(/来源/);
    expect(() => service.authenticate(`Bearer ${a.token}`, `chrome-extension://${'b'.repeat(32)}`)).toThrow(/来源/);
    service.revoke(a.grant.id);
    expect(() => service.authenticate(`Bearer ${a.token}`, origin)).toThrow(/撤销/);
    const b = service.create({ ...body, expiresInDays: 1 }); now += 86_400_001;
    expect(() => service.authenticate(`Bearer ${b.token}`, origin)).toThrow(/到期/);
    expect(service.allowsOrigin(origin)).toBe(false);
  });

  it('validates scope/origin/expiry; bounds active grants', () => {
    const { service } = fixture();
    for (const patch of [{ extensionOrigin: '*' }, { extensionOrigin: 'null' }, { scopes: ['admin'] },
      { scopes: ['summary:read'] }, { scopes: ['identity:read', 'identity:read'] }, { expiresInDays: 91 }]) {
      expect(() => service.create({ ...body, ...patch })).toThrow();
    }
    for (let i = 0; i < 16; i++) service.create(body);
    expect(() => service.create(body)).toThrow(/16/);
    service.revoke(service.list().grants[0]!.id);
    expect(() => service.create(body)).not.toThrow();
  });

  it('fails closed on corrupt server authorization state, not as a caller input error', () => {
    const { db, service } = fixture(); const created = service.create(body);
    const state = JSON.parse(String(db.prepare('SELECT value FROM app_settings WHERE key=?').get(COMPANION_GRANTS_KEY)!.value));
    state.grants[0].expiresAt = 'invalid';
    db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(JSON.stringify(state), COMPANION_GRANTS_KEY);
    expect(() => service.authenticate(`Bearer ${created.token}`, origin)).toThrow('authorization state is invalid');
  });
});
