import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';

const migrationSql = fs.readFileSync(
  new URL('../db/migrations/000020_add_image_derivative_path_indexes.sql', import.meta.url),
  'utf8'
);
const [upSql, downSql] = migrationSql.split('-- migrate:down');
const paths = [
  ['thumbnail_path', 'idx_images_thumbnail_path'],
  ['preview_path', 'idx_images_preview_path']
] as const;

function seedImages(database: DatabaseSync): void {
  database.prepare('INSERT INTO folders(id, slug, name, folder_path) VALUES (1, ?, ?, ?)')
    .run('creator', 'Creator', 'creator');
  const insert = database.prepare(`
    INSERT INTO images (
      id, folder_id, filename, extension, relative_path, absolute_path,
      file_size, width, height, mime_type, checksum_or_fingerprint, mtime_ms,
      first_seen_at, sort_timestamp, thumbnail_path, preview_path, is_deleted, is_trashed
    ) VALUES (?, 1, ?, '.jpg', ?, ?, 100, 640, 960, 'image/jpeg', ?, ?,
      '2026-01-01T00:00:00.000Z', ?, ?, ?, ?, ?)
  `);
  for (const [id, name, deleted, trashed] of [
    [1, 'old', 0, 0],
    [2, 'duplicate', 0, 0],
    [3, 'duplicate', 1, 0],
    [4, 'trashed', 0, 1],
    [5, '', 0, 0],
    [10000, 'new', 0, 0]
  ] as const) {
    insert.run(id, `${id}.jpg`, `creator/${id}.jpg`, `/fixture/creator/${id}.jpg`,
      `fingerprint-${id}`, id, id,
      name ? `thumb/${name}.webp` : '', name ? `preview/${name}.webp` : '', deleted, trashed);
  }
}

function expectPathIndexes(database: DatabaseSync): void {
  const indexes = database.prepare('PRAGMA index_list(images)').all();
  for (const [column, index] of paths) {
    expect(indexes).toContainEqual(expect.objectContaining({ name: index, unique: 0, partial: 0 }));
    expect(database.prepare(`PRAGMA index_info(${index})`).all())
      .toEqual([expect.objectContaining({ name: column })]);
  }
}

describe('image derivative path indexes', () => {
  it('keeps the fresh/test schema identical to the ordinary non-unique migration indexes', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(schemaSql);
      expectPathIndexes(database);
      const definitions = database.prepare(
        "SELECT name, sql FROM sqlite_master WHERE name IN ('idx_images_thumbnail_path', 'idx_images_preview_path') ORDER BY name"
      ).all();
      database.exec(downSql);
      database.exec(upSql);
      database.exec(upSql);
      expectPathIndexes(database);
      expect(database.prepare(
        "SELECT name, sql FROM sqlite_master WHERE name IN ('idx_images_thumbnail_path', 'idx_images_preview_path') ORDER BY name"
      ).all()).toEqual(definitions);
    } finally {
      database.close();
    }
  });

  it.each(paths)('uses an index for existing repository predicate %s without changing lookup results', (column, index) => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(schemaSql);
      database.exec(downSql);
      seedImages(database);
      // Preserve imageRepository's exact unfiltered predicate. Route visibility
      // and authorization behavior is unchanged and covered by existing route tests.
      const sql = `SELECT * FROM images WHERE ${column} = ?`;
      const prefix = column === 'thumbnail_path' ? 'thumb' : 'preview';
      const samples = ['old', 'new', 'missing', 'duplicate', 'trashed'].map((name) => `${prefix}/${name}.webp`);
      const values = [...samples, '', null];
      const before = values.map((value) => database.prepare(sql).get(value));
      const rowsBefore = database.prepare('SELECT * FROM images ORDER BY id').all();
      expect(database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(samples[0]))
        .toContainEqual(expect.objectContaining({ detail: 'SCAN images' }));

      database.exec(upSql);
      expectPathIndexes(database);
      for (const [position, value] of values.entries()) {
        expect(database.prepare(sql).get(value)).toEqual(before[position]);
        expect(database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(value))
          .toContainEqual(expect.objectContaining({ detail: `SEARCH images USING INDEX ${index} (${column}=?)` }));
      }
      expect(database.prepare('SELECT * FROM images ORDER BY id').all()).toEqual(rowsBefore);
      expect(database.prepare(`SELECT id FROM images WHERE ${column} = ? ORDER BY id`).all(`${prefix}/duplicate.webp`))
        .toEqual([{ id: 2 }, { id: 3 }]);
      expect(database.prepare(sql).get(null)).toBeUndefined();
      // Paths have always been NOT NULL; the migration neither relaxes this
      // constraint nor turns a legal empty string / repeated path into an error.
      expect(() => database.prepare(`UPDATE images SET ${column} = NULL WHERE id = 5`).run())
        .toThrow(/NOT NULL constraint failed/);
      database.prepare(`UPDATE images SET ${column} = ? WHERE id = 10000`).run(`${prefix}/duplicate.webp`);
      expect(database.prepare(`SELECT id FROM images WHERE ${column} = ? ORDER BY id`).all(`${prefix}/duplicate.webp`))
        .toEqual([{ id: 2 }, { id: 3 }, { id: 10000 }]);
      database.prepare('DELETE FROM images WHERE id = 10000').run();
      expect(database.prepare(sql).get(`${prefix}/new.webp`)).toBeUndefined();
      expect(database.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
