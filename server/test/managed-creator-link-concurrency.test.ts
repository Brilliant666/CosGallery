import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';

const signal = (state:Int32Array,slot:number,value:number) => { Atomics.store(state,slot,value);Atomics.notify(state,slot); };
function wait(state:Int32Array,slot:number,value:number) {
  const deadline=performance.now()+10_000;
  while(Atomics.load(state,slot)!==value){
    if(Atomics.load(state,4))throw new Error('Synthetic catalog publisher failed');
    if(performance.now()>deadline)throw new Error(`Synthetic catalog barrier ${slot} timed out`);
    Atomics.wait(state,slot,Atomics.load(state,slot),50);
  }
}

// Real product publication in an independent connection. Only its scheduling is
// controlled: all SELECT/UPDATE/INSERT and SQLite lock errors are genuine.
const writerScript=String.raw`
const {DatabaseSync}=require('node:sqlite');
const {parentPort,workerData}=require('node:worker_threads');
const state=new Int32Array(workerData.shared),db=new DatabaseSync(workerData.file);
const signal=(slot,value)=>{Atomics.store(state,slot,value);Atomics.notify(state,slot);};
const wait=(slot,value)=>{const end=Date.now()+10000;while(Atomics.load(state,slot)!==value){
  if(Date.now()>end)throw Error('Synthetic writer barrier timed out');Atomics.wait(state,slot,Atomics.load(state,slot),50);}};
db.exec('PRAGMA busy_timeout=5000');
let publishing=false;
const proxy=new Proxy(db,{get(target,key){
  if(key==='exec')return sql=>{
    if(publishing&&sql.trim()==='COMMIT'){
      signal(2,1);wait(3,1);
      if(workerData.releaseDelayMs)Atomics.wait(state,5,0,workerData.releaseDelayMs);
    }
    return target.exec(sql);
  };
  const value=target[key];return typeof value==='function'?value.bind(target):value;
}});
(async()=>{try{
  const {register}=await import(workerData.tsx);register();
  const {ResourceCatalogReadModel}=await import(workerData.model);
  const model=new ResourceCatalogReadModel(proxy),prepared=model.prepare(1);
  signal(0,1);wait(1,1);publishing=true;
  const published=model.publish(prepared);
  parentPort.postMessage({published,publication:db.prepare('SELECT publication FROM resource_catalog_meta').get().publication});
}catch(e){signal(4,1);parentPort.postMessage({error:e.message,code:e.code,errcode:e.errcode});}
finally{db.close();parentPort.close();}})();
`;

describe('managed creator folder-link writer reservation',()=>{
  let directory:string,file:string,gallery:string,db:DatabaseSync;
  const workers:Worker[]=[];
  beforeEach(()=>{
    directory=fs.mkdtempSync(path.join(os.tmpdir(),'managed-link-concurrency-'));
    file=path.join(directory,'synthetic.sqlite');gallery=path.join(directory,'gallery');
    db=new DatabaseSync(file);db.exec(schemaSql);db.exec('PRAGMA busy_timeout=5000');
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'SyntheticOne','syntheticone','test','1'),(2,'SyntheticTwo','synthetictwo','test','2');
      INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'one','SyntheticOne','SyntheticOne');
      INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'SyntheticWork');
      INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(1,1,'SyntheticOne/SyntheticWork',1);
      INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
      VALUES(1,1,'synthetic.jpg','.jpg','SyntheticOne/SyntheticWork/synthetic.jpg','synthetic-not-read',100,10,10,'image/jpeg','hash',1,'now',1,'thumb','preview');
      INSERT INTO post_items(post_id,image_id,position) VALUES(1,1,1);`);
    db.prepare(`INSERT INTO archive_catalog_local_creator_folders(id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,match_method,scanned_at)
      VALUES(1,1,1,?,'SyntheticOne',?,'SyntheticOne','matched','original','now')`).run(gallery,path.join(gallery,'SyntheticOne'));
    db.prepare(`INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,1,1,'SyntheticWork',?,'SyntheticWork','matched','now')`).run(path.join(gallery,'SyntheticOne','SyntheticWork'));
    db.prepare('UPDATE archive_catalog_works SET primary_local_work_id=1 WHERE id=1').run();
  });
  afterEach(async()=>{for(const worker of workers.splice(0))await worker.terminate();db.close();fs.rmSync(directory,{recursive:true,force:true});});
  function publisher(releaseDelayMs=0){
    const shared=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*6),state=new Int32Array(shared);
    const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    const worker=new Worker(writerScript,{eval:true,workerData:{file,shared,releaseDelayMs,
      tsx:pathToFileURL(path.join(server,'node_modules/tsx/dist/esm/api/index.mjs')).href,
      model:pathToFileURL(path.join(server,'src/services/resource-catalog-read-model.ts')).href}});
    workers.push(worker);
    const result=new Promise<{published?:boolean;publication?:number;error?:string}>(resolve=>{
      worker.once('message',resolve);worker.once('error',e=>resolve({error:e.message}));
    });
    return {state,result};
  }
  const identityRows=()=>['archive_catalog_works','archive_catalog_local_works','posts','post_items','images']
    .map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

  it('demonstrates the real deferred read-to-write failure against a catalog publication, not a mocked error',async()=>{
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({journal_mode:'delete'});
    const writer=publisher();wait(writer.state,0,1);
    // A caller-owned deferred transaction models the original top-level
    // SAVEPOINT behavior. Nested calls deliberately retain that caller's policy.
    db.exec('SAVEPOINT synthetic_original_deferred');
    db.prepare('SELECT id FROM archive_catalog_creators').all();
    signal(writer.state,1,1);wait(writer.state,2,1);
    let error:unknown;
    try{new ManagedCreatorService(db,gallery).linkFolder(1,{creatorId:1});}
    catch(e){error=e;}
    finally{db.exec('ROLLBACK TO synthetic_original_deferred; RELEASE synthetic_original_deferred');signal(writer.state,3,1);}
    expect(error).toMatchObject({code:'ERR_SQLITE_ERROR',errcode:5,message:'database is locked'});
    expect(await writer.result).toMatchObject({published:true});
    expect(new ManagedCreatorService(db,gallery).linkFolder(1,{creatorId:1}).id).toBe(1);
  });

  it('waits for an already active catalog writer before any folder-link read, then succeeds without retrying',async()=>{
    const original=identityRows(),writer=publisher(200);wait(writer.state,0,1);
    signal(writer.state,1,1);wait(writer.state,2,1);
    let reserved=false;const trace:string[]=[];
    const proxy=new Proxy(db,{get(target,key){
      if(key==='exec')return(sql:string)=>{trace.push(sql);if(sql==='BEGIN IMMEDIATE')signal(writer.state,3,1);
        const result=target.exec(sql);if(sql==='BEGIN IMMEDIATE')reserved=true;return result;};
      if(key==='prepare')return(sql:string)=>{expect(reserved).toBe(true);return target.prepare(sql);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    try{
      expect(new ManagedCreatorService(proxy,gallery).linkFolder(1,{creatorId:1}).id).toBe(1);
      expect(trace[0]).toBe('BEGIN IMMEDIATE');expect(trace.at(-1)).toBe('COMMIT');
      expect(db.isTransaction).toBe(false);expect(identityRows()).toEqual(original);
    }finally{signal(writer.state,3,1);}
    expect(await writer.result).toMatchObject({published:true,publication:1});
    expect(db.prepare('SELECT creator_id,gallery_folder_id,match_method FROM archive_catalog_local_creator_folders WHERE id=1').get())
      .toEqual({creator_id:1,gallery_folder_id:1,match_method:'manual'});
  });

  it('leaves caller-owned transactions open and permits the caller to roll back a successful link',()=>{
    const before=db.prepare('SELECT * FROM archive_catalog_local_creator_folders').all();
    db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO app_settings(key,value) VALUES('caller','kept-until-rollback')").run();
    expect(new ManagedCreatorService(db,gallery).linkFolder(1,{creatorId:1}).id).toBe(1);
    expect(db.isTransaction).toBe(true);db.exec('ROLLBACK');
    expect(db.prepare('SELECT * FROM archive_catalog_local_creator_folders').all()).toEqual(before);
    expect(db.prepare("SELECT * FROM app_settings WHERE key='caller'").get()).toBeUndefined();
  });

  it('rolls back only its savepoint on nested failure and releases its own transaction on top-level failure',()=>{
    const service=new ManagedCreatorService(db,gallery),before=db.prepare('SELECT * FROM archive_catalog_local_creator_folders').all();
    db.exec("CREATE TRIGGER synthetic_link_rejection BEFORE UPDATE ON archive_catalog_local_creator_folders BEGIN SELECT RAISE(ABORT,'synthetic ownership failure'); END;");
    expect(()=>service.linkFolder(1,{creatorId:1})).toThrow('synthetic ownership failure');expect(db.isTransaction).toBe(false);
    db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO app_settings(key,value) VALUES('caller','keep')").run();
    expect(()=>service.linkFolder(1,{creatorId:1})).toThrow('synthetic ownership failure');expect(db.isTransaction).toBe(true);
    expect(db.prepare("SELECT value FROM app_settings WHERE key='caller'").get()).toEqual({value:'keep'});
    db.exec('COMMIT');expect(db.prepare('SELECT * FROM archive_catalog_local_creator_folders').all()).toEqual(before);
    db.exec('DROP TRIGGER synthetic_link_rejection');
    expect(()=>service.linkFolder(1,{creatorId:2})).toThrow('目录已关联其他博主');expect(db.isTransaction).toBe(false);
    expect(service.linkFolder(1,{creatorId:1}).id).toBe(1);
  });
});
