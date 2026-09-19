import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ResourceCatalogBuilder } from '../src/services/resource-catalog-builder.js';
import { ResourceCatalogReadModel, RESOURCE_CATALOG_RULE_VERSION } from '../src/services/resource-catalog-read-model.js';

describe('resource catalog durable publication lifecycle', () => {
  let db: DatabaseSync;
  let directory: string;
  let file: string;
  let model: ResourceCatalogReadModel;
  const state = (creator = 1) => db.prepare('SELECT * FROM resource_catalog_state WHERE creator_id=?').get(creator)!;
  const rows = () => db.prepare('SELECT * FROM resource_catalog_rows ORDER BY work_id').all();
  const publication = () => Number(db.prepare('SELECT publication FROM resource_catalog_meta').get()!.publication);
  const generateAll = () => { for (const id of model.pending(100)) expect(model.rebuildCreator(id)).toBe(true); };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-model-'));
    file = path.join(directory, 'test.sqlite'); db = new DatabaseSync(file); db.exec(schemaSql);
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'One','one','test','1'),(2,'Two','two','test','2');
      INSERT INTO archive_catalog_creator_aliases VALUES(1,'Alias','alias','manual','now','now');
      INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'one','One','One'),(2,'two','Two','Two');
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,1,'root','One','root/One','One','matched','now'),(2,2,2,'root','Two','root/Two','Two','matched','now');
      INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Work'),(2,2,'Work');
      INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(1,1,'One/Work',1),(2,2,'Two/Work',2);
      INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,1,1,'Work','root/One/Work','Work','matched','now'),(2,2,2,2,'Work','root/Two/Work','Work','matched','now');
      INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
      VALUES(1,1,'one.jpg','.jpg','One/Work/one.jpg','root/One/Work/one.jpg',100,10,10,'image/jpeg','hash',1,'now',1,'thumb','preview');
      INSERT INTO post_items(post_id,image_id,position) VALUES(1,1,1);`);
    model = new ResourceCatalogReadModel(db);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(directory,{recursive:true,force:true}); });

  it('initializes once, preserves numbered independent same-title Works and aliases, and reopens cleanly', () => {
    expect(model.pending(100)).toEqual([1,2]); generateAll();
    const saved = rows(); expect(saved).toHaveLength(2);
    expect(saved.map(r => r.no_number)).toEqual([1,1]);
    expect(state().aliases_text).toBe('one\nalias');
    expect(model.pending(100)).toEqual([]);
    db.close(); db = new DatabaseSync(file); model = new ResourceCatalogReadModel(db);
    const spy = vi.spyOn(ResourceCatalogBuilder.prototype,'generate');
    expect(model.pending(100)).toEqual([]); expect(rows()).toEqual(saved); expect(spy).not.toHaveBeenCalled();
  });
  it('coalesces independent committed changes and ignores rolled-back facts', () => {
    generateAll(); const other = new DatabaseSync(file);
    try {
      other.exec("BEGIN; UPDATE archive_catalog_works SET display_title='Rejected' WHERE id=1; ROLLBACK;");
      expect(model.pending(100)).toEqual([]);
      other.exec("BEGIN; UPDATE archive_catalog_works SET display_title='Accepted' WHERE id=1; UPDATE images SET file_size=200 WHERE id=1; COMMIT;");
    } finally { other.close(); }
    expect(model.pending(100)).toEqual([1]); const before=publication(); expect(model.rebuildCreator(1)).toBe(true);
    expect(publication()).toBe(before+1); expect(model.pending(100)).toEqual([]);
    expect(JSON.parse(String(rows()[0]!.row_json))).toMatchObject({ title:'Accepted',mediaBytes:200,imageCount:1 });
  });
  it('rejects stale prepared generation and never clears newer changes', () => {
    generateAll(); db.exec("UPDATE archive_catalog_works SET display_title='A' WHERE id=1");
    const prepared=model.prepare(1); const before=rows();
    const other=new DatabaseSync(file); other.exec("UPDATE archive_catalog_works SET display_title='B' WHERE id=1"); other.close();
    expect(model.publish(prepared)).toBe(false); expect(rows()).toEqual(before); expect(model.pending()).toEqual([1]);
    expect(model.rebuildCreator(1)).toBe(true); expect(JSON.parse(String(rows()[0]!.row_json)).title).toBe('B');
  });
  it('publishes a prepared generation at most once across competing builders', () => {
    const first=model.prepare(1); const duplicate=model.prepare(1);
    expect(model.publish(first)).toBe(true); const version=publication();
    expect(model.publish(duplicate)).toBe(false); expect(publication()).toBe(version);
    expect(model.rebuildCreator(1)).toBe(false); expect(publication()).toBe(version);
  });
  it('keeps completed rows on generation failure, persists pending/retry, and recovers after restart', () => {
    generateAll(); const saved=rows(); db.exec("UPDATE archive_catalog_works SET display_title='Later' WHERE id=1");
    const spy=vi.spyOn(ResourceCatalogBuilder.prototype,'generate').mockImplementationOnce(()=>{throw new Error('synthetic failure');});
    expect(()=>model.rebuildCreator(1)).toThrow('synthetic failure'); spy.mockRestore();
    expect(rows()).toEqual(saved); expect(state().last_error).toBeTruthy(); expect(state().failed_generation).toBe(state().generation);
    db.close(); db=new DatabaseSync(file); model=new ResourceCatalogReadModel(db);
    expect(model.pending(100)).toEqual([]); expect(state().generation).not.toBe(state().built_generation);
    db.exec("UPDATE resource_catalog_state SET retry_after='2000-01-01' WHERE creator_id=1");
    expect(model.pending()).toEqual([1]); expect(model.rebuildCreator(1)).toBe(true); expect(state().last_error).toBeNull();
  });
  it('rolls back all derived deletes/inserts if publishing fails part-way', () => {
    generateAll(); const saved=rows(); const before=publication(); db.exec("UPDATE archive_catalog_works SET display_title='Later' WHERE id=1");
    db.exec("CREATE TRIGGER fail_catalog BEFORE INSERT ON resource_catalog_rows WHEN NEW.creator_id=1 BEGIN SELECT RAISE(ABORT,'synthetic publish failure'); END;");
    expect(()=>model.rebuildCreator(1)).toThrow('synthetic publish failure');
    expect(rows()).toEqual(saved); expect(publication()).toBe(before); expect(state().generation).not.toBe(state().built_generation);
    db.exec('DROP TRIGGER fail_catalog'); expect(model.rebuildCreator(1)).toBe(true);
  });
  it('prioritizes old owner but can atomically publish an out-of-order ownership move', () => {
    generateAll(); db.exec('UPDATE archive_catalog_works SET creator_id=1 WHERE id=2');
    expect(model.pending(100)).toEqual([2,1]);
    expect(model.rebuildCreator(1)).toBe(true); expect(model.rebuildCreator(2)).toBe(false);
    expect(rows().map(r=>[r.work_id,r.creator_id])).toEqual([[1,1],[2,1]]);
    expect(model.pending(100)).toEqual([]);
  });
  it('ownership swaps publish both complete creators without PK collisions or dependency starvation', () => {
    generateAll(); db.exec('UPDATE archive_catalog_works SET creator_id=CASE id WHEN 1 THEN 2 ELSE 1 END');
    const prepared=model.prepare(1); expect(prepared.related?.map(item=>item.creatorId)).toEqual([2]);
    expect(model.publish(prepared)).toBe(true); expect(model.pending(100)).toEqual([]);
    expect(rows().map(r=>[r.work_id,r.creator_id])).toEqual([[1,2],[2,1]]);
  });
  it('a newer generation in any ownership-closure member prevents partial publication', () => {
    generateAll(); db.exec('UPDATE archive_catalog_works SET creator_id=1 WHERE id=2');
    const prepared=model.prepare(1); const saved=rows();
    db.exec("UPDATE archive_catalog_creators SET canonical_name='New two' WHERE id=2");
    expect(model.publish(prepared)).toBe(false); expect(rows()).toEqual(saved);
    expect(model.rebuildCreator(1)).toBe(true); expect(model.pending(100)).toEqual([]);
  });
  it('publishes deleted creator tombstones before reassigned rows and preserves business IDs', () => {
    generateAll(); db.exec('UPDATE archive_catalog_works SET creator_id=1 WHERE id=2; DELETE FROM archive_catalog_creators WHERE id=2;');
    expect(model.pending(100)).toEqual([2,1]); expect(model.rebuildCreator(2)).toBe(true);
    expect(db.prepare('SELECT * FROM resource_catalog_state WHERE creator_id=2').get()).toBeUndefined();
    expect(model.rebuildCreator(1)).toBe(true); expect(db.prepare('SELECT id FROM archive_catalog_works ORDER BY id').all()).toEqual([{id:1},{id:2}]);
    expect(rows().map(r=>r.work_id)).toEqual([1,2]);
  });
  it('rule-version mismatch rebuilds once without altering business generations', () => {
    generateAll(); const generation=state().generation;
    db.exec('UPDATE resource_catalog_state SET rule_version=0 WHERE creator_id=1');
    expect(model.pending(100)).toEqual([1]); expect(model.rebuildCreator(1)).toBe(true);
    expect(state().rule_version).toBe(RESOURCE_CATALOG_RULE_VERSION); expect(state().generation).toBe(generation); expect(model.pending(100)).toEqual([]);
  });
  it('an older updater cannot downgrade a newer completed rule version or mark it failed', () => {
    generateAll(); db.exec("UPDATE archive_catalog_works SET display_title='New fact' WHERE id=1");
    const oldPrepared=model.prepare(1);
    // Simulate an independently deployed v2 publication of the same generation.
    db.exec('UPDATE resource_catalog_state SET rule_version=2,built_generation=generation,last_error=NULL WHERE creator_id=1');
    const saved=rows(); const version=publication();
    expect(model.pending(100)).toEqual([]);
    expect(()=>model.prepare(1)).toThrow('newer than this updater');
    expect(model.publish(oldPrepared)).toBe(false);
    expect(()=>model.rebuildCreator(1)).toThrow('newer than this updater');
    expect(state().rule_version).toBe(2); expect(state().last_error).toBeNull(); expect(state().retry_after).toBeNull();
    expect(rows()).toEqual(saved); expect(publication()).toBe(version);
    db.exec("UPDATE archive_catalog_works SET display_title='Newer fact' WHERE id=1");
    expect(model.pending(100)).toEqual([]); // Only a compatible newer process may service this dirty creator.
  });
  it('unavailable selected primary remains selected, while explicit deletion excludes it', () => {
    generateAll(); db.exec('UPDATE archive_catalog_works SET primary_local_work_id=1 WHERE id=1; UPDATE archive_catalog_local_works SET is_active=0 WHERE id=1');
    model.rebuildCreator(1);
    expect(JSON.parse(String(rows()[0]!.row_json))).toMatchObject({localState:'unavailable',primaryLocalWorkId:1,imageCount:1});
    db.exec('UPDATE posts SET is_deleted=1 WHERE id=1'); model.rebuildCreator(1);
    expect(rows().map(r=>r.work_id)).toEqual([2]);
  });
});
