import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { WorkIdentityService } from '../src/services/work-identity-service.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';
import { runStartupMigrations } from '../src/db/migration.js';

describe('persistent local work identity in real catalog reconciliation',()=>{
 let root:string,db:DatabaseSync,identity:WorkIdentityService,catalog:ArchiveCatalogService,creatorId:number;
 beforeEach(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'work-identity-'));
  db=new DatabaseSync(path.join(root,'test.sqlite'));db.exec(schemaSql);
  identity=new WorkIdentityService(db);catalog=new ArchiveCatalogService(db);
  creatorId=new ManagedCreatorService(db,root).create({name:'Synthetic'}).id;
 });
 afterEach(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});
 async function register(name:string, extra:Record<string,unknown>={}){
  const absolutePath=path.join(root,'Synthetic',name);
  await fs.mkdir(absolutePath,{recursive:true});await fs.writeFile(path.join(absolutePath,'a.jpg'),'synthetic');
  return identity.registerLocal({creatorId,rootPath:root,creatorFolderName:'Synthetic',absolutePath,relativePath:name,title:'Same display title',reason:'confirmed synthetic',key:name,...extra});
 }
 const record=(works:Array<{order:number;sourceOrder:string;label:string}>)=>({creatorName:'Synthetic',costuan:{postId:'synthetic',title:'Synthetic collection',works}});
 it('persists opt-in separately from explicit local-only, with manual identity for source-free admission',async()=>{
  const ordinary=await register('Ordinary'),accepted=await register('Accepted',{acceptExistingVersion:true}),blocked=await register('Blocked',{localOnly:true,acceptExistingVersion:true});
  const policy=(id:number)=>db.prepare('SELECT identity_policy,provenance_json FROM archive_catalog_local_works WHERE id=?').get(id) as {identity_policy:string;provenance_json:string};
  expect(policy(ordinary.localWorkId).identity_policy).toBe('manual');
  expect(JSON.parse(policy(ordinary.localWorkId).provenance_json).acceptExistingVersion).toBe(false);
  expect(JSON.parse(policy(accepted.localWorkId).provenance_json).acceptExistingVersion).toBe(true);
  expect(policy(blocked.localWorkId).identity_policy).toBe('local_only');
  await catalog.reconcileLocalCreators({rootPath:root,creators:[{creatorId,folderName:'Synthetic'}]});
  expect(JSON.parse(policy(accepted.localWorkId).provenance_json).acceptExistingVersion).toBe(true);
 });
 it('keeps same-title independent Work IDs, local-only identity and exact IDs after database reopen and real rescan',async()=>{
  const first=await register('Unknown NO.032 Theme',{localOnly:true}),second=await register('Another NO.032 Theme');
  expect(first.workId).not.toBe(second.workId);
  await catalog.reconcileLocalCreators({rootPath:root,creators:[{creatorId,folderName:'Synthetic'}]});
  db.close();db=new DatabaseSync(path.join(root,'test.sqlite'));catalog=new ArchiveCatalogService(db);
  await catalog.reconcileLocalCreators({rootPath:root,creators:[{creatorId,folderName:'Synthetic'}]});
  expect(db.prepare('SELECT id,work_id FROM archive_catalog_local_works ORDER BY id').all()).toEqual([
   {id:first.localWorkId,work_id:first.workId},{id:second.localWorkId,work_id:second.workId}
  ]);
  expect(db.prepare('SELECT COUNT(*) n FROM archive_catalog_source_works').get()).toEqual({n:0});
 });
 it('preserves explicit foreign number and two copies after source refresh and withdrawal',async()=>{
  catalog.importCostuanRecord(record([{order:30,sourceOrder:'NO.030',label:'Nurse'}]));
  const source=db.prepare('SELECT id,work_id FROM archive_catalog_source_works').get() as {id:number;work_id:number};
  const first=await register('NO.032 Nurse',{sourceWorkId:source.id});
  const second=await register('NO.099 Nurse',{sameAsLocalId:first.localWorkId});
  catalog.importCostuanRecord(record([{order:30,sourceOrder:'NO.030',label:'New external title'}]));
  expect(db.prepare('SELECT display_title FROM archive_catalog_works WHERE id=?').get(source.work_id)).toEqual({display_title:'Nurse'});
  db.prepare('UPDATE archive_catalog_source_works SET is_active=0').run();
  await catalog.reconcileLocalCreators({rootPath:root,creators:[{creatorId,folderName:'Synthetic'}]});
  expect(db.prepare('SELECT work_id FROM archive_catalog_local_works ORDER BY id').all()).toEqual([{work_id:source.work_id},{work_id:source.work_id}]);
  expect(first.workId).toBe(second.workId);
 });
 it('binds a not-yet-imported source to a local Work and refuses existing Work merges',async()=>{
  const local=await register('Local only');
  catalog.importCostuanRecord(record([]));
  const collection=(db.prepare('SELECT id FROM archive_catalog_collections').get() as {id:number}).id;
  identity.bindSource({workId:local.workId,collectionId:collection,sourceWorkId:'NO.030',reason:'confirmed',key:'binding'});
  catalog.importCostuanRecord(record([{order:30,sourceOrder:'NO.030',label:'External title'}]));
  expect(db.prepare('SELECT work_id FROM archive_catalog_source_works').get()).toEqual({work_id:local.workId});
  expect(db.prepare('SELECT display_title FROM archive_catalog_works WHERE id=?').get(local.workId)).toEqual({display_title:'Same display title'});
  const other=await register('Other');
  expect(()=>identity.bindSource({workId:other.workId,collectionId:collection,sourceWorkId:'NO.030',reason:'no merge',key:'conflict'})).toThrow('merge');
 });
 it('revokes unique-name fulfillment only for its source/copy without disabling other relations',async()=>{
  catalog.importCostuanRecord(record([{order:1,sourceOrder:'NO.001',label:'Theme'},{order:2,sourceOrder:'NO.002',label:'Other'}]));
  const sources=db.prepare('SELECT id FROM archive_catalog_source_works ORDER BY id').all() as {id:number}[];
  const local=await register('Revocation copy');
  const unique=Number(db.prepare("INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,source_work_id,reason,payload_json) VALUES('unique','unique_name',?,?,?,'test','{}')").run(local.workId,local.localWorkId,sources[0].id).lastInsertRowid);
  for(const source of sources)db.prepare("INSERT INTO archive_catalog_local_fulfillments(decision_id,source_work_id,local_work_id,work_id,source_snapshot_json,local_snapshot_json,reason) VALUES(?,?,?,?,'{}','{}','test')").run(local.decisionId,source.id,local.localWorkId,local.workId);
  identity.revoke(unique,'User corrected source identity');
  expect(db.prepare('SELECT state FROM archive_catalog_local_fulfillments ORDER BY id').all()).toEqual([{state:'revoked'},{state:'active'}]);
  expect(db.prepare('SELECT work_id,identity_policy FROM archive_catalog_local_works WHERE id=?').get(local.localWorkId)).toEqual({work_id:local.workId,identity_policy:'manual'});
 });
 it('keeps explicit exclusion and local-only after revoke without deleting assets',async()=>{
  catalog.importCostuanRecord(record([{order:1,sourceOrder:'NO.001',label:'Theme'}]));
  const source=(db.prepare('SELECT id FROM archive_catalog_source_works').get() as {id:number}).id;
  const local=await register('NO.001 Theme',{localOnly:true});
  const rejected=identity.excludeSource(local.localWorkId,source,'Different contents','negative');
  await catalog.reconcileLocalCreators({rootPath:root,creators:[{creatorId,folderName:'Synthetic'}]});
  expect(db.prepare('SELECT state FROM archive_catalog_work_decisions WHERE id=?').get(rejected)).toEqual({state:'active'});
  identity.revoke(local.decisionId,'Undo accepted relation; keep local asset');
  await catalog.reconcileLocalCreators({rootPath:root,creators:[{creatorId,folderName:'Synthetic'}]});
  expect(db.prepare('SELECT work_id,identity_policy FROM archive_catalog_local_works WHERE id=?').get(local.localWorkId)).toEqual({work_id:local.workId,identity_policy:'local_only'});
 });
});

it('migrates fresh, upgrade and repeated startup without changing legacy identity',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'identity-migration-'));
 let db:DatabaseSync|undefined;
 try {
  const migrations=path.resolve('db/migrations'),old=path.join(root,'old');
  await fs.mkdir(old);
  for(const name of await fs.readdir(migrations)) if(name<'000019') await fs.copyFile(path.join(migrations,name),path.join(old,name));
  const file=path.join(root,'upgrade.sqlite');
  runStartupMigrations({databasePath:file,migrationsDirectory:old});
  db=new DatabaseSync(file);
  db.prepare("INSERT INTO archive_catalog_creators(canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES('Migration','migration','manual','migration')").run();
  db.prepare("INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(1,'Legacy')").run();db.close();
  runStartupMigrations({databasePath:file});runStartupMigrations({databasePath:file});
  db=new DatabaseSync(file);
  expect(db.prepare('SELECT id,display_title,title_policy,primary_local_work_id FROM archive_catalog_works').get())
    .toEqual({id:1,display_title:'Legacy',title_policy:'auto',primary_local_work_id:null});db.close();
  const fresh=path.join(root,'fresh.sqlite');runStartupMigrations({databasePath:fresh});
  db=new DatabaseSync(fresh);
  expect(db.prepare("SELECT version FROM schema_migrations WHERE version='000019'").get()).toBeTruthy();db.close();
 } finally {try{db?.close();}catch{} await fs.rm(root,{recursive:true,force:true});}
});
