import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {schemaSql} from '../src/db/schema.js';

const migration=fs.readFileSync(new URL('../db/migrations/000025_local_admission_web.sql',import.meta.url),'utf8');
const up=migration.split('-- migrate:down')[0].replace('-- migrate:up','');
const tables=['local_admission_web_batches','local_admission_web_items','local_admission_web_requests','local_review_web_sessions','local_review_web_file_actions'];
function definitions(db:DatabaseSync){return tables.map(table=>({table,columns:db.prepare(`PRAGMA table_info(${table})`).all(),foreignKeys:db.prepare(`PRAGMA foreign_key_list(${table})`).all(),indexes:db.prepare(`PRAGMA index_list(${table})`).all()}));}

describe('000025 web orchestration migration',()=>{
  it('upgrade matches fresh schema, preserves business facts and original payloads, repeats and reopens',()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'admission-web-upgrade-'));
    const filename=path.join(directory,'test.sqlite');let db=new DatabaseSync(filename);
    try{
      db.exec(schemaSql);const expected=definitions(db);
      db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'中文博主','中文博主','test','1');
        INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'原作品');
        INSERT INTO archive_local_admission_plans(plan_id,payload_json,content_hash) VALUES('original','{"historical":true}','original-hash');`);
      const originals={creator:db.prepare('SELECT * FROM archive_catalog_creators').all(),work:db.prepare('SELECT * FROM archive_catalog_works').all(),plan:db.prepare('SELECT * FROM archive_local_admission_plans').all()};
      for(const table of [...tables].reverse())db.exec(`DROP TABLE ${table}`);
      db.exec(up);expect(definitions(db)).toEqual(expected);
      db.exec(`INSERT INTO local_admission_web_batches(id,creator_id,input_root,state,created_at,updated_at,context_json,confirmed_json) VALUES('batch',1,'synthetic','needs_review','now','now','{}','{"immutable":true}');
        INSERT INTO local_review_web_sessions(id,creator_id,target_key,target_json,request_key,status,created_at,updated_at) VALUES('session',1,'target','{}','request','interrupted','now','now');
        INSERT INTO local_review_web_file_actions(session_id,relative_path,source_path,quarantine_path,fingerprint_json,state) VALUES('session','广告.txt','synthetic/source','synthetic/preserved','{}','intent');`);
      const receipt=db.prepare('SELECT * FROM local_admission_web_batches').all(),sessions=db.prepare('SELECT * FROM local_review_web_sessions').all(),actions=db.prepare('SELECT * FROM local_review_web_file_actions').all();
      db.exec(up);db.exec(up);db.close();db=new DatabaseSync(filename);db.exec(up);
      expect(db.prepare('SELECT * FROM local_admission_web_batches').all()).toEqual(receipt);
      expect(db.prepare('SELECT * FROM local_review_web_sessions').all()).toEqual(sessions);
      expect(db.prepare('SELECT * FROM local_review_web_file_actions').all()).toEqual(actions);
      expect(db.prepare('SELECT * FROM archive_catalog_creators').all()).toEqual(originals.creator);
      expect(db.prepare('SELECT * FROM archive_catalog_works').all()).toEqual(originals.work);
      expect(db.prepare('SELECT * FROM archive_local_admission_plans').all()).toEqual(originals.plan);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA quick_check').get()).toMatchObject({quick_check:'ok'});
      expect(()=>db.exec(migration.split('-- migrate:down')[1])).toThrow('local_admission_web_downgrade_requires_explicit_data_preservation');
      expect(db.prepare('SELECT COUNT(*) n FROM local_review_web_sessions').get()!.n).toBe(1);
    }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
  });
});
