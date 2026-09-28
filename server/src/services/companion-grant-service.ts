import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { databaseManager } from '../db/database.js';

export const companionScopes = ['identity:read', 'summary:read', 'library:link', 'catalog:link'] as const;
export const extensionOriginSchema = z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/);
export const createCompanionGrantSchema = z.object({
  label: z.string().trim().min(1).max(80),
  extensionOrigin: extensionOriginSchema,
  scopes: z.array(z.enum(companionScopes)).min(1).max(4)
    .refine(items => items.includes('identity:read') && new Set(items).size === items.length),
  expiresInDays: z.number().int().min(1).max(90).default(30)
}).strict();
const grantSchema = z.object({
  id: z.string().uuid(), label: z.string(), extensionOrigin: extensionOriginSchema,
  scopes: z.array(z.enum(companionScopes)).min(1).max(4)
    .refine(items => items.includes('identity:read') && new Set(items).size === items.length),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/)
});
const stateSchema = z.object({ instanceId: z.string().uuid(), grants: z.array(grantSchema).max(64) });
type StoredGrant = z.infer<typeof grantSchema>;
export type CompanionGrant = Omit<StoredGrant, 'tokenHash'>;
export const COMPANION_GRANTS_KEY = 'companion_readonly_grants_v1';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const publicGrant = ({ tokenHash: _secret, ...grant }: StoredGrant): CompanionGrant => grant;

export class CompanionAccessError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/** Dedicated, revocable read-only credentials. No admin session/bridge token reuse.
 * Reads never initialize settings or update last-used timestamps. Grant writes are
 * explicit administrator actions, storing only hashes in the existing settings DB.
 */
export class CompanionGrantService {
  constructor(private readonly db: DatabaseSync = databaseManager.connection, private readonly now = () => Date.now()) {}

  private read() {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(COMPANION_GRANTS_KEY) as { value: string } | undefined;
    if (!row) return null;
    try { return stateSchema.parse(JSON.parse(row.value)); }
    catch { throw new Error('Companion authorization state is invalid'); }
  }

  list() {
    const state = this.read();
    return { instanceId: state?.instanceId ?? null, label: 'CosGallery', grants: state?.grants.map(publicGrant) ?? [] };
  }

  create(input: unknown) {
    const body = createCompanionGrantSchema.parse(input);
    const state = this.read() ?? { instanceId: randomUUID(), grants: [] };
    const active = state.grants.filter(g => !g.revokedAt && Date.parse(g.expiresAt) > this.now());
    if (active.length >= 16) throw new CompanionAccessError(409, 'GRANT_LIMIT', '最多保留16份有效授权，请先撤销不再使用的授权。');
    const id = randomUUID();
    const token = `cgcomp_${id}.${randomBytes(32).toString('base64url')}`;
    const grant: StoredGrant = {
      id, label: body.label, extensionOrigin: body.extensionOrigin, scopes: [...body.scopes].sort(),
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + body.expiresInDays * 86_400_000).toISOString(),
      revokedAt: null, tokenHash: digest(token)
    };
    // Expired/revoked tokens remain invalid when their old metadata is evicted.
    const history = state.grants.filter(g => !active.includes(g)).slice(-47);
    state.grants = [...history, ...active, grant];
    this.write(state);
    return { instanceId: state.instanceId, label: 'CosGallery', token, grant: publicGrant(grant) };
  }

  revoke(id: string) {
    const state = this.read();
    const grant = state?.grants.find(g => g.id === id);
    if (!state || !grant) throw new CompanionAccessError(404, 'GRANT_NOT_FOUND', '未找到此授权。');
    if (!grant.revokedAt) { grant.revokedAt = new Date(this.now()).toISOString(); this.write(state); }
    return { ok: true };
  }

  private write(state: z.infer<typeof stateSchema>) {
    this.db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(COMPANION_GRANTS_KEY, JSON.stringify(state));
  }

  allowsOrigin(origin: string): boolean {
    return !!this.read()?.grants.some(g => g.extensionOrigin === origin && !g.revokedAt && Date.parse(g.expiresAt) > this.now());
  }

  authenticate(authorization: string | undefined, origin: string | undefined) {
    const match = /^Bearer (cgcomp_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    const state = this.read();
    const stored = match && state?.grants.find(g => g.id === match[2]);
    if (!stored || !match || stored.revokedAt || Date.parse(stored.expiresAt) <= this.now()
      || !timingSafeEqual(Buffer.from(stored.tokenHash, 'hex'), Buffer.from(digest(match[1]!), 'hex'))) {
      throw new CompanionAccessError(401, 'COMPANION_AUTH_REQUIRED', '只读授权无效、已撤销或已到期，请重新连接。');
    }
    if (origin !== undefined && origin !== stored.extensionOrigin) {
      throw new CompanionAccessError(403, 'COMPANION_ORIGIN_DENIED', '此扩展来源未获授权。');
    }
    const grant = publicGrant(stored);
    return {
      instanceId: state!.instanceId, label: 'CosGallery', grant,
      permissionFingerprint: digest(JSON.stringify([state!.instanceId, grant.id, grant.extensionOrigin, grant.scopes, grant.expiresAt]))
    };
  }
}
