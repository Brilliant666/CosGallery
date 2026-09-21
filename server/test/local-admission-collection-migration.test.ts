import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {schemaSql} from '../src/db/schema.js';

const migration=fs.readFileSync(new URL('../db/migrations/000026_local_admission_collections.sql',import.meta.url),'utf8');
const up=migration.split('-- migrate:down')[0].replace('-- migrate:up','');
const tables=['local_admission_web_collections','local_admission_web_collection_batches','local_admission_web_collection_requests'];
function definitions(db:DatabaseSync){return tables.map(table=>({table,columns:db.prepare(`PRAGMA table_info(${table})`).all(),foreignKeys:db.prepare(`PRAGMA foreign_key_list(${table})`).all(),indexes:db.prepare(`PRAGMA index_list(${table})`).all()}));}

describe('000026 multi-creator orchestration migration',()=>{
  it('matches fresh schema, preserves original single-creator plans and queued confirmations across repeat and reopen',()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'admission-collection-upgrade-')),filename=path.join(directory,'test.sqlite');let db=new DatabaseSync(filename);
    try{
      db.exec(schemaSql);const expected=definitions(db);
      db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'中文博主','中文博主','test','1');
        INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'原作品');
        INSERT INTO archive_local_admission_plans(plan_id,payload_json,content_hash) VALUES('original','{"historical":true}','original-hash');
        INSERT INTO local_admission_web_batches(id,creator_id,input_root,state,created_at,updated_at,context_json,confirmed_json) VALUES('batch',1,'synthetic','needs_review','now','now','{}','{"immutable":true}');`);
      const originalTables=['archive_catalog_creators','archive_catalog_works','archive_local_admission_plans','local_admission_web_batches'];
      const originals=originalTables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
      for(const table of [...tables].reverse())db.exec(`DROP TABLE ${table}`);
      db.exec(up);expect(definitions(db)).toEqual(expected);expect(originalTables.map(table=>db.prepare(`SELECT * FROM ${table}`).all())).toEqual(originals);
      db.exec(`INSERT INTO local_admission_web_collections(id,state,created_at,updated_at,confirmed_json,owner_pid,owner_token) VALUES('collection','queued','now','now','{"allChildrenConfirmed":true}',123,'original-owner');
        INSERT INTO local_admission_web_collection_batches VALUES('collection','batch',0);
        INSERT INTO local_admission_web_collection_requests VALUES('request','collection','execute','exact-payload-hash','now');`);
      const queued=tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
      db.exec(up);db.close();db=new DatabaseSync(filename);db.exec(up);
      expect(definitions(db)).toEqual(expected);expect(tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all())).toEqual(queued);
      expect(originalTables.map(table=>db.prepare(`SELECT * FROM ${table}`).all())).toEqual(originals);
      expect(()=>db.exec("INSERT INTO local_admission_web_collection_batches VALUES('collection','batch',1)")).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.prepare('PRAGMA quick_check').get()).toMatchObject({quick_check:'ok'});
      expect(()=>db.exec(migration.split('-- migrate:down')[1])).toThrow('local_admission_collection_downgrade_requires_explicit_data_preservation');
      expect(tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all())).toEqual(queued);
    }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
  });
});
