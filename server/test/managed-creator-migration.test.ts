import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { completeManagedCreatorMigration } from '../src/db/managed-creator-migration.js';

describe('000016 reversible managed-creator migration',()=>{
  it('preserves historical seed snapshots, IDs and dates across up/repeat/down/up',()=>{
    const db=new DatabaseSync(':memory:');
    const sql=fs.readFileSync(new URL('../db/migrations/000016_managed_creator_roster_and_folder_bridge.sql',import.meta.url),'utf8');
    const [up,down]=sql.split('-- migrate:down');
    try {
      db.exec(schemaSql);db.exec(down);
      db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,preference,effective_rating,seed_source,seed_source_creator_id,created_at,updated_at)
        VALUES(42,'Historical','historical','liked','R18','hentaiclub','old-name','old-created','old-updated');
        INSERT INTO archive_catalog_creator_sources(creator_id,source,source_creator_id,source_display_name,metadata_json,first_seen_at,last_seen_at)
        VALUES(42,'hentaiclub','old-name','Historical','{"original":true,"initialPreference":"kept"}','first','last');
        INSERT INTO folders(id,slug,name,folder_path) VALUES(7,'old-folder','Local name','Folder');
        INSERT INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES(8,42,'G:/gallery','Folder','g:/GALLERY/Folder/','Local name','matched','old-scan');`);
      const before=db.prepare('SELECT * FROM archive_catalog_creators').get();
      db.exec(up);completeManagedCreatorMigration(db,'G:/gallery');
      expect(db.prepare('SELECT * FROM archive_catalog_creators').get()).toMatchObject({...before,is_active:1,deactivated_at:null});
      const source=db.prepare('SELECT * FROM archive_catalog_creator_sources').get()!;
      expect(JSON.parse(String(source.metadata_json))).toMatchObject({original:true,initialPreference:'kept',initialRating:'R18',authorityStatus:'historical-seed'});
      expect(source).toMatchObject({first_seen_at:'first',last_seen_at:'last'});
      expect(db.prepare('SELECT gallery_folder_id FROM archive_catalog_local_creator_folders').get()).toEqual({gallery_folder_id:7});
      completeManagedCreatorMigration(db,'G:/gallery');
      expect(db.prepare('SELECT * FROM archive_catalog_creator_sources').get()).toEqual(source);
      db.exec(down);expect(db.prepare('SELECT * FROM archive_catalog_creators').get()).toEqual(before);
      db.exec(up);completeManagedCreatorMigration(db,'G:/gallery');
      expect(db.prepare('SELECT * FROM archive_catalog_creator_sources').get()).toEqual(source);
      expect(db.prepare('PRAGMA quick_check').get()).toEqual({quick_check:'ok'});
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
});
