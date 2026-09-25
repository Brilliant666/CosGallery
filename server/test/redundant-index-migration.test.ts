import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { validateRedundantIndexReplacements } from '../src/db/migration.js';

const migration = fs.readFileSync(new URL('../db/migrations/000027_remove_redundant_indexes.sql', import.meta.url), 'utf8');
const [up, down] = migration.replace('-- migrate:up', '').split('-- migrate:down');
const names = [...up.matchAll(/DROP INDEX IF EXISTS (\w+)/g)].map(match => match[1]);

describe('000027 exact redundant indexes', () => {
  it('preserves facts and constraint plans across 000026 upgrade, repeat and reopen; fresh schema matches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-migration-'));
    const file = path.join(root, 'isolated.sqlite');
    let db = new DatabaseSync(file);
    const definitions = () => db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all();
    try {
      db.exec(schemaSql); const fresh = definitions();
      db.exec(down);
      db.exec("INSERT INTO folders(slug,name,folder_path) VALUES('unique','Folder','/fixture'); INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'Creator','creator','test','1'); INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Work')");
      const facts = db.prepare('SELECT * FROM archive_catalog_works').all();
      expect(names).toHaveLength(8);
      for (const name of names) expect(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name)).toBeTruthy();
      db.exec(up); expect(definitions()).toEqual(fresh);
      validateRedundantIndexReplacements(db);
      expect(db.prepare('SELECT * FROM archive_catalog_works').all()).toEqual(facts);
      expect(() => db.exec("INSERT INTO folders(slug,name,folder_path) VALUES('unique','duplicate','/different')")).toThrow('UNIQUE');
      expect(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM folders WHERE slug=?').all('unique').some(row => String(row.detail).includes('sqlite_autoindex_folders'))).toBe(true);
      expect(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM post_items WHERE post_id=? ORDER BY position').all(1).some(row => String(row.detail).includes('sqlite_autoindex_post_items'))).toBe(true);
      db.exec(up); db.close(); db = new DatabaseSync(file); db.exec(up);
      validateRedundantIndexReplacements(db);
      expect(definitions()).toEqual(fresh); expect(db.prepare('SELECT * FROM archive_catalog_works').all()).toEqual(facts);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['nonunique', 'CREATE TABLE images(relative_path TEXT); CREATE INDEX fake ON images(relative_path)'],
    ['partial', 'CREATE TABLE images(relative_path TEXT); CREATE UNIQUE INDEX fake ON images(relative_path) WHERE relative_path IS NOT NULL'],
    ['explicit rather than constraint', 'CREATE TABLE images(relative_path TEXT); CREATE UNIQUE INDEX fake ON images(relative_path)'],
    ['wrong collation', 'CREATE TABLE images(relative_path TEXT COLLATE NOCASE UNIQUE)'],
    ['wrong direction', 'CREATE TABLE images(relative_path TEXT, UNIQUE(relative_path DESC))'],
    ['extra key', 'CREATE TABLE images(relative_path TEXT,extra TEXT,UNIQUE(relative_path,extra))']
  ])('rejects %s replacement instead of accepting any index', (_label, ddl) => {
    const db = new DatabaseSync(':memory:');
    try { db.exec(ddl); expect(() => validateRedundantIndexReplacements(db)).toThrow('images is missing its full BINARY ascending UNIQUE/PRIMARY KEY constraint'); }
    finally { db.close(); }
  });
});
