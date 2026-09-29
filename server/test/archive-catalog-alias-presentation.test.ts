import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ArchiveCatalogQueryService } from '../src/services/archive-catalog-query-service.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';
import { normalizeCreatorIdentity } from '../src/utils/creator-identity.js';

describe('creator alias presentation', () => {
  let db: DatabaseSync;
  let query: ArchiveCatalogQueryService;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    query = new ArchiveCatalogQueryService(db);
  });
  afterEach(() => db.close());

  const alias = (id: number, value: string, source: string) => db.prepare(`
    INSERT OR IGNORE INTO archive_catalog_creator_aliases
      (creator_id,alias,normalized_alias,source) VALUES(?,?,?,?)
  `).run(id, value, normalizeCreatorIdentity(value), source);

  it('omits legacy manual self aliases from both detail and count while preserving source evidence', () => {
    const id = new ManagedCreatorService(db).create({ name: 'Alpha' }).id;
    alias(id, 'Alpha', 'manual');
    alias(id, 'Alpha', 'costuan');
    alias(id, 'Alpha', 'manual-history');
    alias(id, 'Other name', 'manual');
    const before = db.prepare('SELECT * FROM archive_catalog_creator_aliases ORDER BY rowid').all();

    const detail = query.getCreatorDetail(id)!;
    expect(detail.aliasCount).toBe(1);
    expect(detail.aliases).toHaveLength(3);
    expect(detail.aliases.filter(row => row.editable).map(row => row.alias)).toEqual(['Other name']);
    expect(detail.aliases.filter(row => row.alias === 'Alpha').map(row => row.source).sort())
      .toEqual(['costuan', 'manual-history']);
    expect(query.listCreators({ page: 1, limit: 10, query: 'Alpha' }).items[0])
      .toMatchObject({ id, aliasCount: 1 });
    expect(db.prepare('SELECT * FROM archive_catalog_creator_aliases ORDER BY rowid').all()).toEqual(before);
  });

  it('keeps distinct spelling variants even when their identity normalization equals the canonical name', () => {
    const id = new ManagedCreatorService(db).create({ name: 'Alice-X' }).id;
    alias(id, 'alice_x', 'manual');
    alias(id, 'Ａlice-X', 'costuan');
    const detail = query.getCreatorDetail(id)!;
    expect(detail.aliasCount).toBe(2);
    expect(detail.aliases.map(row => row.alias).sort()).toEqual(['alice_x', 'Ａlice-X'].sort());
  });
});
