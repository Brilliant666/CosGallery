import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readSourceReuse } from '../src/routes/source-reuse-read.js';
describe('source reuse read model', () => {
  it('returns all pages of review and satisfied reuse only, with safe public fields', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE archive_catalog_creators(id INTEGER, canonical_name TEXT); CREATE TABLE archive_catalog_collections(id INTEGER, creator_id INTEGER, metadata_json TEXT); INSERT INTO archive_catalog_creators VALUES(1,\'sample\')');
      const entry = { sourceOrder: '001', rawTitle: 'Title', normalizedTitle: 'title', status: 'review', reason: 'ambiguous', satisfied: false, ruleVersion: '1' };
      db.prepare('INSERT INTO archive_catalog_collections VALUES(1,1,?)').run(JSON.stringify({ localSourceReuse: [
        ...Array.from({ length: 101 }, () => entry),
        { ...entry, status: 'reuse', satisfied: true, privatePath: 'G:\\secret' },
        { ...entry, status: 'reuse', satisfied: false }, { ...entry, status: 'missing' },
        { ...entry, reason: 'G:\\secret' }, { ...entry, status: 'existing', satisfied: true }
      ] }));
      const first = readSourceReuse(db, 1, 100), second = readSourceReuse(db, 2, 100);
      expect(first.total).toBe(104); expect(first.hasMore).toBe(true);
      expect(second.items).toHaveLength(4); expect(second.hasMore).toBe(false);
      expect(JSON.stringify(second)).not.toContain('secret');
      expect(second.items[1].status).toBe('reuse');
    } finally { db.close(); }
  });
});
