import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';

const migration = readFileSync(new URL('../db/migrations/000018_add_image_move_signature_index.sql', import.meta.url), 'utf8');
const up = migration.split('-- migrate:up')[1].split('-- migrate:down')[0];
const down = migration.split('-- migrate:down')[1];
// Exercise the unchanged repository SQL without initializing the app database.
const repository = readFileSync(new URL('../src/db/repositories.ts', import.meta.url), 'utf8');
const sql = repository.slice(repository.indexOf('  listMoveCandidates(')).match(/`([\s\S]*?)`/)![1];

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  db.exec("INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'test','test','test')");
  const insert = db.prepare(`INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path,is_deleted,is_trashed)
    VALUES(?,1,'image',?,?,?, ?,1,1,'image/jpeg','test',?,'2026-01-01',0,'t','p',?,?)`);
  for (const [id, size, time, ext, deleted, trashed] of [
    [8,100,10.49,'.JPG',0,0], [2,100,10.1,'.jpg',0,0],
    [3,100,10.5,'.jpg',0,0], [4,101,10,'.jpg',0,0],
    [5,100,10,'.png',0,0], [6,100,10,'.jpg',1,0], [7,100,10,'.jpg',0,1]
  ] as const) insert.run(id,ext,`file-${id}`,`/file-${id}`,size,time,deleted,trashed);
  return db;
}

describe('image move signature index', () => {
  it('preserves rows, case folding, rounded timestamps, visibility and stable ID order', () => {
    const db=fixture();
    try {
      const snapshot=db.prepare('SELECT * FROM images ORDER BY id').all();
      db.exec(down);
      const cases: [number,number,string][]=[[100,10,'.jpg'],[100,11,'.JPG'],[101,10,'.jpg'],[100,10,'.png'],[999,10,'.jpg']];
      const before=cases.map(args=>db.prepare(sql).all(...args));
      db.exec(up);
      expect(cases.map(args=>db.prepare(sql).all(...args))).toEqual(before);
      expect(db.prepare(sql).all(100,10,'.JpG').map(row=>row.id)).toEqual([2,8]);
      expect(db.prepare('SELECT * FROM images ORDER BY id').all()).toEqual(snapshot);
      const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(100,10,'.jpg').map(row=>row.detail).join(' ');
      expect(plan).toContain('idx_images_move_signature');
      expect(plan).not.toContain('TEMP B-TREE');
    } finally {db.close();}
  });
  it('maintains the partial index as visibility and file metadata change', () => {
    const db=fixture();
    try {
      db.exec('UPDATE images SET is_deleted=0 WHERE id=6; UPDATE images SET is_trashed=1 WHERE id=2; UPDATE images SET file_size=200 WHERE id=8');
      expect(db.prepare(sql).all(100,10,'.jpg').map(row=>row.id)).toEqual([6]);
      expect(db.prepare(sql).all(200,10,'.jpg').map(row=>row.id)).toEqual([8]);
    } finally {db.close();}
  });
  it('supports idempotent installation and rollback without changing media rows', () => {
    const db=fixture();
    try {
      const before=db.prepare('SELECT * FROM images ORDER BY id').all();
      db.exec(up); db.exec(up); db.exec(down);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_images_move_signature'").get()).toBeUndefined();
      expect(db.prepare('SELECT * FROM images ORDER BY id').all()).toEqual(before);
    } finally {db.close();}
  });
});
