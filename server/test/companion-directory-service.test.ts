import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { CompanionDirectoryService } from '../src/services/companion-directory-service.js';
import { CompanionReadService } from '../src/services/companion-read-service.js';

describe('Companion complete read-only directory (synthetic database)', () => {
  let db: DatabaseSync;
  let reader: CompanionReadService;
  let directory: CompanionDirectoryService;
  const creator = (id: number, name = `Creator ${id}`) => db.prepare(`INSERT INTO archive_catalog_creators
    (id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(?,?,?,'fixture',?)`).run(id, name, name.toLowerCase(), String(id));
  const alias = (id: number, name: string, source = 'manual') => db.prepare(`INSERT INTO archive_catalog_creator_aliases
    (creator_id,alias,normalized_alias,source) VALUES(?,?,?,?)`).run(id, name, name.toLowerCase(), source);
  const identityOnly = { includeSummary: false };
  const readOnly = () => db.exec('PRAGMA query_only=ON');
  const cursor = (kind: string, offset: number, identityVersion: string, extra = {}) => Buffer.from(JSON.stringify({ kind, offset, identityVersion, ...extra })).toString('base64url');
  const invalid = { status: 400, code: 'INVALID_COMPANION_REQUEST' };
  beforeEach(() => {
    db = new DatabaseSync(':memory:'); db.exec(schemaSql);
    reader = new CompanionReadService(db); directory = new CompanionDirectoryService(db, reader);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it('enumerates 601 active identities and all deduplicated aliases without omissions or repeated entries', () => {
    for (let id = 1; id <= 602; id++) {
      creator(id); alias(id, `Alias ${id}`); alias(id, `Alias ${id}`, 'other-source'); alias(id, 'Shared');
    }
    db.exec('UPDATE archive_catalog_creators SET is_active=0 WHERE id=602');
    readOnly();
    const changes = db.prepare('SELECT total_changes() AS n').get()!.n;
    const identities: number[] = [];
    const aliases: string[] = [];
    let page = directory.roster({}, identityOnly);
    const identityVersion = page.identityVersion;
    expect(page.items).toHaveLength(50);
    expect(page.total).toBe(601);
    for (;;) {
      expect(page.identityVersion).toBe(identityVersion);
      identities.push(...page.items.map(item => item.creatorId));
      if (!page.nextCursor) break;
      page = directory.roster({ cursor: page.nextCursor, identityVersion }, identityOnly);
    }
    let aliasPage = directory.aliases({ identityVersion });
    expect(aliasPage.items).toHaveLength(200);
    expect(aliasPage.total).toBe(1202);
    for (;;) {
      expect(aliasPage.identityVersion).toBe(identityVersion);
      aliases.push(...aliasPage.items.map(item => `${item.creatorId}:${item.alias}`));
      if (!aliasPage.nextCursor) break;
      aliasPage = directory.aliases({ cursor: aliasPage.nextCursor, identityVersion });
    }
    expect(identities).toEqual(Array.from({ length: 601 }, (_, index) => index + 1));
    expect(new Set(aliases).size).toBe(1202);
    expect(aliases.filter(value => value.endsWith(':Shared'))).toHaveLength(601);
    expect(db.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes);
  });

  it('keeps binary-distinct aliases and sorts them by creator then binary raw alias', () => {
    creator(1); creator(2); alias(1, 'z'); alias(1, 'Z', 'second'); alias(1, 'á'); alias(2, 'Z');
    readOnly();
    const identityVersion = directory.roster({}, identityOnly).identityVersion;
    expect(directory.aliases({ identityVersion }).items).toEqual([
      { creatorId: 1, alias: 'Z' }, { creatorId: 1, alias: 'z' }, { creatorId: 1, alias: 'á' }, { creatorId: 2, alias: 'Z' },
    ]);
  });

  it('does not query statistics or call the summary reader for identity-only grants', () => {
    creator(1); readOnly();
    const summary = vi.spyOn(reader, 'summary');
    const prepare = vi.spyOn(db, 'prepare');
    const page = directory.roster({}, identityOnly);
    expect(page.items[0]).toMatchObject({ creatorId: 1, collectedWorkCount: null,
      readModel: { status: 'permission_denied', complete: false }, dataUpdatedAt: null });
    expect(summary).not.toHaveBeenCalled();
    expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/resource_catalog_state|archive_catalog_works|posts|images/u);
  });

  it('reuses the existing summary exactly and only for identities on the requested page', () => {
    creator(1); creator(2); creator(3); readOnly();
    const expected = reader.summary(1);
    const summary = vi.spyOn(reader, 'summary');
    const first = directory.roster({ limit: 1 });
    expect(first.items[0]).toEqual({ ...expected, preference: null, queriedAt: first.items[0]!.queriedAt });
    expect(summary).toHaveBeenCalledTimes(1);
    expect(summary).toHaveBeenLastCalledWith(1);
    const second = directory.roster({ limit: 1, cursor: first.nextCursor!, identityVersion: first.identityVersion });
    expect(second.items[0]?.creatorId).toBe(2);
    expect(summary).toHaveBeenCalledTimes(2);
    expect(summary).toHaveBeenLastCalledWith(2);
  });

  it.each(['add', 'rename', 'alias', 'deactivate', 'like', 'keep', 'clear'] as const)('rejects both endpoint continuations when identity or preference changes: %s', action => {
    creator(1); creator(2); alias(1, 'Alias'); alias(2, 'Second');
    if (action === 'clear') db.exec("UPDATE archive_catalog_creators SET preference='liked' WHERE id=2");
    const first = directory.roster({ limit: 1 }, identityOnly);
    const firstAliases = directory.aliases({ identityVersion: first.identityVersion, limit: 1 });
    if (action === 'add') creator(3);
    if (action === 'rename') db.exec("UPDATE archive_catalog_creators SET canonical_name='Renamed' WHERE id=1");
    if (action === 'alias') alias(2, 'New alias');
    if (action === 'deactivate') db.exec('UPDATE archive_catalog_creators SET is_active=0 WHERE id=1');
    if (action === 'like') db.exec("UPDATE archive_catalog_creators SET preference='liked' WHERE id=2");
    if (action === 'keep') db.exec("UPDATE archive_catalog_creators SET preference='kept' WHERE id=2");
    if (action === 'clear') db.exec('UPDATE archive_catalog_creators SET preference=NULL WHERE id=2');
    readOnly();
    const changed = { status: 409, code: 'COMPANION_IDENTITY_CHANGED' };
    expect(() => directory.roster({ identityVersion: first.identityVersion, cursor: first.nextCursor! }, identityOnly)).toThrowError(expect.objectContaining(changed));
    expect(() => directory.aliases({ identityVersion: first.identityVersion, cursor: firstAliases.nextCursor! })).toThrowError(expect.objectContaining(changed));
    expect(() => directory.aliases({ identityVersion: first.identityVersion })).toThrowError(expect.objectContaining(changed));
    expect(() => directory.roster({ limit: 1, identityVersion: first.identityVersion }, identityOnly)).toThrowError(expect.objectContaining(changed));
  });

  it('returns explicit liked/kept/null on roster only, with and without summaries, without writes', () => {
    creator(1); creator(2); creator(3); alias(1, 'Alias');
    db.exec("UPDATE archive_catalog_creators SET preference='liked' WHERE id=1; UPDATE archive_catalog_creators SET preference='kept' WHERE id=2");
    readOnly();
    const changes = db.prepare('SELECT total_changes() AS n').get()!.n;
    const full = directory.roster();
    const identity = directory.roster({}, identityOnly);
    for (const page of [full, identity]) {
      expect(page.items.map(item => item.preference)).toEqual(['liked', 'kept', null]);
      expect(page.identityVersion).toBe(full.identityVersion);
    }
    expect(directory.aliases({ identityVersion: full.identityVersion }).items).toEqual([{ creatorId: 1, alias: 'Alias' }]);
    expect(reader.summary(1)).not.toHaveProperty('preference');
    expect(db.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes);
  });

  it('excludes source metadata and duplicate registrations from identityVersion; Work changes do not invalidate identity pagination', () => {
    creator(1); creator(2); alias(1, 'Alias');
    const first = directory.roster({ limit: 1 }, identityOnly);
    db.exec("INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(1,'New work')");
    alias(1, 'Alias', 'second-source');
    readOnly();
    const after = directory.roster({ limit: 1, cursor: first.nextCursor!, identityVersion: first.identityVersion }, identityOnly);
    expect(after.identityVersion).toBe(first.identityVersion);
    expect(directory.roster({}, identityOnly).items[0]?.dataVersion).toBe(first.items[0]?.dataVersion);
    expect(directory.aliases({ identityVersion: first.identityVersion }).items).toHaveLength(1);
  });

  it('handles an empty directory and releases snapshots after errors', () => {
    readOnly();
    const page = directory.roster({}, identityOnly);
    expect(page).toMatchObject({ total: 0, items: [], nextCursor: null });
    expect(directory.aliases({ identityVersion: page.identityVersion })).toEqual(page);
    expect(() => directory.aliases({ identityVersion: '0'.repeat(64) })).toThrowError(expect.objectContaining({ status: 409 }));
    expect(directory.roster({}, identityOnly)).toEqual(page);
  });

  it.each([0, -1, 51, 1.5, NaN, Infinity])('rejects invalid roster limit %s', limit => {
    readOnly();
    expect(() => directory.roster({ limit })).toThrowError(expect.objectContaining(invalid));
  });

  it('rejects invalid alias parameters, missing versions and cross-endpoint/cross-version/malformed/out-of-range cursors', () => {
    creator(1); creator(2); alias(1, 'Alias'); alias(2, 'Alias'); readOnly();
    const first = directory.roster({ limit: 1 }, identityOnly);
    const identityVersion = first.identityVersion;
    for (const limit of [0, 201, -1, 1.5, NaN, Infinity])
      expect(() => directory.aliases({ limit, identityVersion })).toThrowError(expect.objectContaining(invalid));
    expect(() => directory.aliases({})).toThrowError(expect.objectContaining(invalid));
    expect(() => directory.roster({ cursor: first.nextCursor! })).toThrowError(expect.objectContaining(invalid));
    expect(() => directory.roster({ identityVersion: 'bad' })).toThrowError(expect.objectContaining(invalid));
    expect(() => directory.aliases({ identityVersion, cursor: first.nextCursor! })).toThrowError(expect.objectContaining(invalid));
    for (const badCursor of ['', 'not-json', 'x'.repeat(513), `${first.nextCursor}=`, cursor('roster', 0, identityVersion),
      cursor('roster', -1, identityVersion), cursor('roster', 0.5, identityVersion), cursor('roster', 2, identityVersion),
      cursor('roster', Number.MAX_SAFE_INTEGER + 1, identityVersion), cursor('roster', 1, '0'.repeat(64)),
      cursor('aliases', 1, identityVersion), cursor('roster', 1, identityVersion, { extra: true })]) {
      expect(() => directory.roster({ cursor: badCursor, identityVersion }, identityOnly)).toThrowError(expect.objectContaining(invalid));
    }
  });
});
