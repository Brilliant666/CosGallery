import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {schemaSql} from '../src/db/schema.js';
import {ArchiveLocalFulfillmentService} from '../src/services/archive-local-fulfillment-service.js';
import {ArchiveDownloadTaskService} from '../src/services/archive-download-task-service.js';
import {CreatorSyncQueryService} from '../src/services/creator-sync-query-service.js';
import {sourceNeedsAcquisitionSql} from '../src/services/archive-local-fulfillment-service.js';

function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'local-accept-'));const db=new DatabaseSync(':memory:');db.exec(schemaSql);
 db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'Synthetic','synthetic','fixture','one');
 INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Local title');
 INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at) VALUES(1,1,'costuan','fixture','Fixture','now');
 INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order,source_title,media_summary,first_seen_at,last_seen_at) VALUES(1,1,1,'costuan','NO.030',30,'Source title','31P','now','now');
 INSERT INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(1,1,'/fixture','Synthetic','/fixture/Synthetic','Synthetic','matched','now');
 INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'synthetic','Synthetic','/fixture');
 INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(1,1,'/fixture/32',1);
 INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path) VALUES(1,1,'a.jpg','jpg','a.jpg','/fixture/a.jpg',1,1,1,'image/jpeg','fixture',1,'now',1,'thumb','preview');
 INSERT INTO post_items(post_id,image_id,position) VALUES(1,1,1);
 INSERT INTO archive_catalog_download_tasks(id,source_work_id,provider,target_root,target_relative_directory,target_filename,status,claimed_by,attempt_count,created_at,updated_at) VALUES(1,1,'baidu','/inbox','Synthetic','030.7z','staged','historical-worker',3,'before','before');`);
 db.prepare(`INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,identity_policy,relative_path,absolute_path,folder_name,image_count,total_bytes,match_status,scanned_at) VALUES(1,1,1,1,'manual','NO.032',?,'NO.032',1,1,'matched','now')`).run(dir);
 db.exec(`INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,source_work_id,reason,payload_json) VALUES('identity','same_work',1,1,1,'User confirmed','{}')`);
 const service=new ArchiveLocalFulfillmentService(db),tasks=new ArchiveDownloadTaskService(db);
 const accept=()=>service.accept({decisionKey:'accept-one',sourceWorkId:1,localWorkId:1,taskIds:[1],reason:'Accept existing version, not byte identical'});
 return {db,tasks,accept,clean(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
describe('explicit local acquisition satisfaction',()=>{
 it('retains staged worker/history; exact read/plan/claim/replay agree and late receipt remains accepted',()=>{
  const f=fixture();try{
   const before=f.db.prepare('SELECT * FROM archive_catalog_download_tasks').all();
   expect(f.accept().replayed).toBe(false);expect(f.accept().replayed).toBe(true);
   expect(f.db.prepare('SELECT * FROM archive_catalog_download_tasks').all()).toEqual(before);
   expect(f.tasks.get(1)?.acquisitionState).toBe('local_satisfied');
   expect(new CreatorSyncQueryService(f.db).downloadCreators().items[0].localSatisfied).toBe(1);
   expect(new CreatorSyncQueryService(f.db).downloadTaskPage({creatorId:1}).items[0].acquisitionState).toBe('local_satisfied');
   expect(f.tasks.planMissing({targetRoot:'/inbox',creatorIds:[1]})).toMatchObject({created:0,reconciledLocal:0});
   expect(()=>f.tasks.claim({workerId:'other',seedTaskId:1})).toThrow(/接受决定/);
   expect(f.tasks.update(1,{status:'staged',workerId:'historical-worker'})?.status).toBe('staged');
   expect(f.tasks.get(1)?.attemptCount).toBe(3);
  }finally{f.clean();}
 });
 it('rejects active claims without changing execution ownership or adding decisions',()=>{
  const f=fixture();try{f.db.exec("UPDATE archive_catalog_download_tasks SET status='claimed'");expect(f.accept).toThrow(/活动/);expect(f.db.prepare('SELECT COUNT(*) n FROM archive_catalog_local_fulfillments').get()).toEqual({n:0});expect(f.tasks.get(1)?.claimedBy).toBe('historical-worker');}finally{f.clean();}
 });
 it('changed source or revoked acceptance becomes review hold, not automatic reacquisition',()=>{
  const f=fixture();try{f.accept();f.db.exec("UPDATE archive_catalog_source_works SET media_summary='32P'");expect(f.tasks.get(1)?.acquisitionState).toBe('review_required');expect(f.tasks.planMissing({targetRoot:'/inbox',creatorIds:[1]}).created).toBe(0);expect(()=>f.tasks.update(1,{status:'pending'})).toThrow(/复核/);f.db.exec("UPDATE archive_catalog_work_decisions SET state='revoked' WHERE kind='accept_version'");expect(f.tasks.get(1)?.acquisitionState).toBe('review_required');}finally{f.clean();}
 });
 it('requires indexed nonempty local copy and exact task scope',()=>{
  const f=fixture();try{f.db.exec('DELETE FROM post_items');expect(f.accept).toThrow(/媒体索引/);}finally{f.clean();}
 });
 it('review-held source stays missing coverage rather than being counted as satisfied',()=>{
  const f=fixture();try{
   f.accept();f.db.exec("UPDATE archive_catalog_source_works SET media_summary='different declaration'");
   expect(f.db.prepare(`SELECT ${sourceNeedsAcquisitionSql('s')} AS missing FROM archive_catalog_source_works s WHERE id=1`).get()).toEqual({missing:1});
   const query=new CreatorSyncQueryService(f.db);expect(query.stats().works.missing).toBe(1);
   expect(query.downloadCreators().items[0]).toMatchObject({localSatisfied:0,acquisitionReviewRequired:1});
   expect(f.tasks.planMissing({targetRoot:'/inbox',creatorIds:[1]}).created).toBe(0);
  }finally{f.clean();}
 });
});
