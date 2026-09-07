import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';

describe('000017 preferred local creator folder migration', () => {
  it('is reversible, defaults to null, enforces the bridge foreign key and repeats cleanly', () => {
    const database = new DatabaseSync(':memory:');
    const sql = fs.readFileSync(
      new URL('../db/migrations/000017_add_preferred_local_creator_folder.sql', import.meta.url),
      'utf8'
    );
    const [up, down] = sql.split('-- migrate:down');
    try {
      database.exec(schemaSql);
      database.exec(down);
      database.exec(
        `INSERT INTO archive_catalog_creators
         (id, canonical_name, normalized_name, seed_source, seed_source_creator_id)
         VALUES (1, 'Creator', 'creator', 'test', 'creator-1')`
      );
      database.exec(up);
      expect(database.prepare('SELECT preferred_local_creator_folder_id FROM archive_catalog_creators').get())
        .toEqual({ preferred_local_creator_folder_id: null });
      expect(() => database.prepare(
        'UPDATE archive_catalog_creators SET preferred_local_creator_folder_id = 999 WHERE id = 1'
      ).run()).toThrow();
      database.exec(
        `INSERT INTO archive_catalog_local_creator_folders (
           id, creator_id, root_path, relative_path, absolute_path, folder_name,
           match_status, match_method, is_active, scanned_at
         ) VALUES (7, 1, 'C:/gallery', 'Creator', 'C:/gallery/Creator', 'Creator',
           'matched', 'test', 1, CURRENT_TIMESTAMP)`
      );
      database.prepare('UPDATE archive_catalog_creators SET preferred_local_creator_folder_id=7 WHERE id=1').run();
      expect(database.prepare('SELECT preferred_local_creator_folder_id FROM archive_catalog_creators').get())
        .toEqual({ preferred_local_creator_folder_id: 7 });
      database.exec(down);
      expect(database.prepare('PRAGMA table_info(archive_catalog_creators)').all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'preferred_local_creator_folder_id' })]));
      database.exec(up);
      expect(database.prepare('SELECT preferred_local_creator_folder_id FROM archive_catalog_creators').get())
        .toEqual({ preferred_local_creator_folder_id: null });
      expect(database.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
