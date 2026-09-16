import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {describe,it,expect} from 'vitest';
import {schemaSql} from '../src/db/schema.js';
import {sourceNeedsAcquisitionSql} from '../src/services/archive-local-fulfillment-service.js';

const [up,down]=fs.readFileSync(new URL('../db/migrations/000021_add_acquisition_read_indexes.sql',import.meta.url),'utf8').split('-- migrate:down');
describe('acquisition read indexes',()=>{
 it('uses ordinary non-unique indexes in fresh and upgraded schemas without changing decisions',()=>{
  const db=new DatabaseSync(':memory:');try{
   db.exec(schemaSql);
   db.exec(`INSERT INTO archive_catalog_work_decisions(decision_key,kind,reason,payload_json,state) VALUES ('legacy','admission_file_removal','Synthetic old-format decision','{"entry":{"relativePath":"a.jpg"}}','active'),('retained','admission_file_removal','Synthetic retained decision','{"retainOriginal":true}','revoked');`);
   const before=db.prepare('SELECT * FROM archive_catalog_work_decisions ORDER BY id').all();
   const definitions=()=>db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('idx_archive_fulfillments_source_work_state','idx_archive_decisions_local_work') ORDER BY name").all().map(r=>({...r,sql:String(r.sql).replace(/\s+/g,' ')}));
   const fresh=definitions();expect(fresh).toHaveLength(2);db.exec(down);db.exec(up);db.exec(up);expect(definitions()).toEqual(fresh);
   expect(db.prepare('SELECT * FROM archive_catalog_work_decisions ORDER BY id').all()).toEqual(before);
   for(const table of ['archive_catalog_local_fulfillments','archive_catalog_work_decisions'])expect(db.prepare(`PRAGMA index_list(${table})`).all().filter(r=>String(r.name).startsWith('idx_archive_'))).toEqual([expect.objectContaining({unique:0,partial:0})]);
   const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM archive_catalog_source_works source WHERE ${sourceNeedsAcquisitionSql('source')}`).all().map(r=>String(r.detail)).join('\n');
   expect(plan).toContain('SEARCH fulfilled USING INDEX idx_archive_fulfillments_source_work_state');
   expect(plan).toContain('SEARCH manual_decision USING COVERING INDEX idx_archive_decisions_local_work');
   expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{db.close();}
 });
});
