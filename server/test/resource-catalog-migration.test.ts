import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { resourceCatalogSchemaSql } from '../src/db/resource-catalog-schema.js';

describe('persistent resource catalog migration and transactional dirty markers', () => {
  let db: DatabaseSync;
  let directory: string;
  let file: string;
  const generation = (id = 1) => Number((db.prepare('SELECT generation FROM resource_catalog_state WHERE creator_id=?').get(id) as { generation: number }).generation);
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-migration-'));
    file = path.join(directory, 'test.sqlite');
    db = new DatabaseSync(file);
    db.exec(schemaSql);
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'One','one','test','1'),(2,'Two','two','test','2'),(3,'Three','three','test','3');
      INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'one','One','One'),(2,'two','Two','Two');
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,1,'root','One','root/One','One','matched','now'),(2,2,2,'root','Two','root/Two','Two','matched','now');
      INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Work'),(2,2,'Work');
      INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(1,1,'One/Work',1);
      INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,1,1,'Work','root/One/Work','Work','matched','now');
      INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
      VALUES(1,1,'one.jpg','.jpg','One/Work/one.jpg','root/One/Work/one.jpg',100,10,10,'image/jpeg','hash',1,'now',1,'thumb','preview');
      INSERT INTO post_items(post_id,image_id,position) VALUES(1,1,1);
      UPDATE resource_catalog_state SET built_generation=generation,rule_version=1,revision='saved',last_error=NULL;`);
  });
  afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('fresh schema and upgrade SQL are identical and repeat is a no-op', () => {
    const sql = fs.readFileSync(new URL('../db/migrations/000022_resource_catalog_read_model.sql', import.meta.url), 'utf8').split('-- migrate:down')[0].replace('-- migrate:up', '').trim();
    // TypeScript normalizes template-literal newlines; a Windows checkout may
    // keep CRLF in the SQL file. Compare the actual SQL apart from line endings.
    expect(sql.replaceAll('\r\n', '\n')).toBe(resourceCatalogSchemaSql.trim().replaceAll('\r\n', '\n'));
    const before = db.prepare('SELECT * FROM resource_catalog_state ORDER BY creator_id').all();
    db.exec(sql); db.exec(sql);
    expect(db.prepare('SELECT * FROM resource_catalog_state ORDER BY creator_id').all()).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' });
  });
  it('upgrades an existing schema without modifying original records', () => {
    const original = db.prepare('SELECT * FROM archive_catalog_works').all();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'rc_dirty_%'").all() as { name: string }[];
    for (const { name } of names) db.exec(`DROP TRIGGER ${name}`);
    db.exec('DROP TABLE resource_catalog_rows; DROP TABLE resource_catalog_state; DROP TABLE resource_catalog_meta;');
    db.exec(resourceCatalogSchemaSql);
    expect(db.prepare('SELECT * FROM archive_catalog_works').all()).toEqual(original);
    expect(db.prepare('SELECT creator_id,built_generation FROM resource_catalog_state ORDER BY creator_id').all()).toEqual([1,2,3].map(creator_id => ({creator_id,built_generation:0})));
  });
  it('marks only related creator on independent-connection writes and persists over reopen', () => {
    const before = [generation(1),generation(2)];
    const other = new DatabaseSync(file);
    other.exec("UPDATE images SET file_size=101 WHERE id=1"); other.close();
    expect(generation(1)).toBeGreaterThan(before[0]); expect(generation(2)).toBe(before[1]);
    const current = generation(); db.close(); db = new DatabaseSync(file);
    expect(generation()).toBe(current);
  });
  it('does not mark derivative cache, timestamps or unchanged facts', () => {
    const before = generation();
    db.exec("UPDATE images SET thumbnail_path='cache2',preview_path='cache3',updated_at='later' WHERE id=1; UPDATE posts SET updated_at='later'; UPDATE archive_catalog_works SET display_title=display_title,updated_at='later';");
    expect(generation()).toBe(before);
  });
  it('dirty marking rolls back together with facts and leaves saved publication intact', () => {
    const before = generation();
    db.exec("BEGIN; UPDATE images SET file_size=102 WHERE id=1; ROLLBACK;");
    expect(generation()).toBe(before);
    db.exec("UPDATE resource_catalog_state SET last_error='failed',failed_generation=generation,retry_after='later' WHERE creator_id=1; UPDATE posts SET caption='new' WHERE id=1;");
    expect(db.prepare('SELECT revision,last_error,failed_generation,retry_after FROM resource_catalog_state WHERE creator_id=1').get()).toEqual({revision:'saved',last_error:null,failed_generation:null,retry_after:null});
  });
  it('marks both previous and next Work owner, but not unrelated creators', () => {
    const before = [generation(1),generation(2),generation(3)];
    db.exec('UPDATE archive_catalog_works SET creator_id=2 WHERE id=1');
    expect(generation(1)).toBeGreaterThan(before[0]); expect(generation(2)).toBeGreaterThan(before[1]); expect(generation(3)).toBe(before[2]);
  });
  it('shared-folder owner additions and removals dirty all affected owners', () => {
    // Legacy ambiguity must remain observable even though fresh databases prohibit it.
    db.exec('DROP INDEX idx_catalog_folder_gallery_active');
    const before = generation();
    db.exec("INSERT INTO archive_catalog_local_creator_folders(id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(3,2,1,'root','alias','root/alias','alias','matched','now');");
    expect(generation()).toBeGreaterThan(before);
    const next = generation(); db.exec('DELETE FROM archive_catalog_local_creator_folders WHERE id=3'); expect(generation()).toBeGreaterThan(next);
  });
  it('legacy post links without explicit post_id respond to members and deletion', () => {
    db.exec('UPDATE archive_catalog_local_works SET post_id=NULL WHERE id=1');
    const before = generation(); db.exec('UPDATE post_items SET position=2 WHERE post_id=1'); expect(generation()).toBeGreaterThan(before);
    const next = generation(); db.exec('DELETE FROM images WHERE id=1'); expect(generation()).toBeGreaterThan(next);
  });
  it('does not erase published rows when a Work is removed before regeneration', () => {
    db.exec("INSERT INTO resource_catalog_rows VALUES(1,1,1,1,1,'available',0,'work','{}','[]'); DELETE FROM archive_catalog_works WHERE id=1;");
    expect(db.prepare('SELECT COUNT(*) n FROM resource_catalog_rows').get()).toMatchObject({n:1});
    expect(db.prepare('SELECT generation>built_generation dirty FROM resource_catalog_state WHERE creator_id=1').get()).toMatchObject({dirty:1});
  });
  it('source, alias and retained-original decisions invalidate only their owner', () => {
    for (const sql of [
      "INSERT INTO archive_catalog_creator_aliases VALUES(1,'alias','alias','manual','now','now')",
      "INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,reason,payload_json) VALUES('retained','admission_file_removal',1,1,'explicit','{\"retainOriginal\":true}')",
      "INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at) VALUES(1,1,'test','1','collection','now'); INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at) VALUES(1,1,'test','1','source','now','now')",
      "UPDATE archive_catalog_collections SET source_url='https://example.invalid/item' WHERE id=1",
    ]) { const before=generation(); const unrelated=generation(2); db.exec(sql); expect(generation()).toBeGreaterThan(before); expect(generation(2)).toBe(unrelated); }
  });
  it('ingest heartbeat and unrelated summary fields do not invalidate retained counts', () => {
    db.exec(`INSERT INTO local_ingest_jobs(creator_id,source_archive_path,source_archive_name,source_archive_size,source_archive_mtime,source_archive_sha256,status,target_path,summary_json)
      VALUES(1,'test/archive','archive',1,1,'hash','queued','root/One/Work','{"retainedOriginalCount":1}')`);
    const queued = generation();
    db.exec("UPDATE local_ingest_jobs SET claim_heartbeat_at='now',updated_at='now',summary_json='{\"retainedOriginalCount\":1,\"progress\":2}'");
    expect(generation()).toBe(queued);
    db.exec("UPDATE local_ingest_jobs SET status='ingested'");
    expect(generation()).toBeGreaterThan(queued);
    const complete = generation();
    db.exec("UPDATE local_ingest_jobs SET summary_json='{\"retainedOriginalCount\":1,\"progress\":3}'");
    expect(generation()).toBe(complete);
    db.exec("UPDATE local_ingest_jobs SET summary_json='{\"retainedOriginalCount\":2}'");
    expect(generation()).toBeGreaterThan(complete);
  });
});
