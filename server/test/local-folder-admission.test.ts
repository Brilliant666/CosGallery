import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';

describe.sequential('actual local directory admission and recovery',()=>{
 let root:string,input:string,gallery:string,creator:number;
 let manager:typeof import('../src/db/database.js')['databaseManager'];
 let service:import('../src/services/local-folder-admission-service.js').LocalFolderAdmissionService;
 beforeAll(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'local-admission-integration-'));input=path.join(root,'inbox');gallery=path.join(root,'gallery');
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');vi.stubEnv('PUBLIC_DEMO_MODE','1');
  for(const [key,dir] of Object.entries({DATA_ROOT:path.join(root,'data'),GALLERY_ROOT:gallery,DB_DIR:path.join(root,'db'),THUMBNAILS_DIR:path.join(root,'thumbs'),PREVIEWS_DIR:path.join(root,'previews')})){vi.stubEnv(key,dir);await fs.mkdir(dir,{recursive:true});}
  await fs.mkdir(input);vi.resetModules();
  ({databaseManager:manager}=await import('../src/db/database.js'));
  const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');
  creator=new ManagedCreatorService(manager.connection,gallery).create({name:'Synthetic Creator',rating:'R15',preference:'liked'}).id;
  const {LocalFolderAdmissionService}=await import('../src/services/local-folder-admission-service.js');service=new LocalFolderAdmissionService(manager.connection,gallery);
 });
 afterAll(()=>{manager.close();vi.unstubAllEnvs();});
 beforeEach(async()=>{const {LocalFolderAdmissionService}=await import('../src/services/local-folder-admission-service.js');service=new LocalFolderAdmissionService(manager.connection,gallery);});
 async function make(name:string,color='#2468aa'){
  const dir=path.join(input,name);await fs.mkdir(path.join(dir,'nested'),{recursive:true});
  await sharp({create:{width:32,height:48,channels:3,background:color}}).jpeg().toFile(path.join(dir,'nested','1.jpg'));
  await fs.writeFile(path.join(dir,'keep.txt'),'untouched attachment');await fs.writeFile(path.join(dir,'ad.url'),'[InternetShortcut]\nURL=https://invalid.example');return dir;
 }
 async function plan(name:string){await make(name);const p=await service.preview({creatorId:creator,inputRoot:input,directories:[name]});return {...p,confirmed:true,items:p.items.map(i=>({...i,reason:'Synthetic user confirmed independent set'}))};}
 const rows=(table:string)=>manager.connection.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
 it('previews without writes, preserves names, admits source-free sets through real scanner and API',async()=>{
  const p=await plan('Synthetic Creator NO.032 Blue Theme 2 (Night) [1P-2MB]');
  expect(p.items[0].localOnly).toBe(false);expect(p.items[0].acceptExistingVersion).toBe(false);
  expect(p.items[0].displayTitle).toBe('Blue Theme 2 (Night)');expect(rows('archive_catalog_works')).toHaveLength(0);
  const result=await service.apply(p);expect(result.completed).toBe(true);
  expect(rows('archive_catalog_local_works')[0].work_id).toBeTruthy();expect(rows('posts')).toHaveLength(1);
  for(const table of ['archive_catalog_source_works','archive_catalog_download_tasks','local_ingest_jobs'])expect(rows(table)).toHaveLength(0);
  const {createApp}=await import('../src/app.js');const {requestTestApp}=await import('./http-test-utils.js');
  const response=await requestTestApp(createApp(),'GET',`/api/cos-gallery/creators/${creator}/works?page=1&limit=10`);
  expect(response.status).toBe(200);expect(response.body.items).toHaveLength(1);
  expect(await fs.readFile(path.join(p.items[0].targetPath,'keep.txt'),'utf8')).toBe('untouched attachment');
  expect(await fs.stat(path.join(p.items[0].targetPath,'nested','1.jpg'))).toBeTruthy();
  const before=rows('posts');await service.apply(p);expect(rows('posts')).toEqual(before);
  // A completed legacy checkpoint without the opt-in field still replays safely.
  const saved=manager.connection.prepare('SELECT payload_json FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId) as {payload_json:string};
  const legacy=JSON.parse(saved.payload_json);delete legacy.items[0].acceptExistingVersion;
  manager.connection.prepare('UPDATE archive_local_admission_plans SET payload_json=? WHERE plan_id=?').run(JSON.stringify(legacy),p.planId);
  await service.apply(legacy);expect(rows('posts')).toEqual(before);
  await expect(service.apply({...p,items:p.items.map(i=>({...i,displayTitle:'changed'}))})).rejects.toThrow('content changed');
 });
 it.each(['files_verified','planned'])('preserves creator spelling and resumes legacy %s comparison-case plans',async(initialState)=>{
  const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');
  const creatorName='MixedCaseCreator_'+initialState,seedName='Case seed '+initialState;
  const mixedCreator=new ManagedCreatorService(manager.connection,gallery).create({name:creatorName,rating:'R15',preference:'liked'}).id;
  await make(seedName);const seed=await service.preview({creatorId:mixedCreator,inputRoot:input,directories:[seedName]});
  await service.apply({...seed,confirmed:true,items:seed.items.map(i=>({...i,reason:'Seed existing canonical creator directory'}))});
  const name='NO.081 MixedCase Set '+initialState;await make(name);
  const preview=await service.preview({creatorId:mixedCreator,inputRoot:input,directories:[name]});
  expect(preview.creatorDirectory).toBe(creatorName);
  expect(path.basename(path.dirname(preview.items[0].targetPath))).toBe(creatorName);
  // Windows old plans persisted a lowercase comparison key; Linux must retain case sensitivity.
  const directory=process.platform==='win32'?creatorName.toLowerCase():preview.creatorDirectory;
  const p={...preview,confirmed:true,creatorDirectory:directory,items:preview.items.map(i=>({...i,targetPath:path.join(gallery,directory,name),reason:'Synthetic confirmed scope'}))};
  const {admissionPlanSchema}=await import('../src/services/local-folder-admission-service.js');
  const {WorkIdentityService}=await import('../src/services/work-identity-service.js');const item=p.items[0];
  const mapped=new WorkIdentityService(manager.connection).registerLocal({creatorId:mixedCreator,rootPath:p.galleryRoot,creatorFolderName:directory,
    absolutePath:item.targetPath,relativePath:path.relative(gallery,item.targetPath),title:item.displayTitle,reason:item.reason,key:`${p.planId}:${item.key}`,localOnly:false});
  manager.connection.prepare('INSERT INTO archive_local_admission_plans(plan_id,payload_json,content_hash) VALUES(?,?,?)').run(p.planId,JSON.stringify(admissionPlanSchema.parse(p)),'historical immutable hash');
  manager.connection.prepare("INSERT INTO archive_local_admission_items(plan_id,item_key,state,manifest_json,work_id,local_work_id,last_error) VALUES(?,?,?,?,?,?,'Scoped Post was not found')").run(p.planId,item.key,initialState,JSON.stringify(item.manifest),initialState==='planned'?null:mapped.workId,initialState==='planned'?null:mapped.localWorkId);
  const {scannerService}=await import('../src/services/scanner-service.js');
  if(initialState==='files_verified'){
    await fs.rename(path.join(input,name),item.targetPath);
    await scannerService.scanCosCreators([creatorName],'synthetic-legacy-case',{workFolderName:name});
  }else{
    const scan=scannerService.scanCosCreators.bind(scannerService);
    const spy=vi.spyOn(scannerService,'scanCosCreators').mockImplementationOnce(async(...args)=>{await scan(...args);throw Error('Lost indexing response');});
    try {await expect(service.apply(p)).rejects.toThrow('Lost indexing response');}finally{spy.mockRestore();}
  }
  const checkpoint=()=>manager.connection.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=?').get(p.planId)!;
  expect(checkpoint().state).toBe('files_verified');
  const before=checkpoint();const saved=manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId);
  const post=manager.connection.prepare('SELECT id FROM posts WHERE source_path=?').get(creatorName+'/'+name)!;
  expect(post).toBeTruthy();
  const file=path.join(p.items[0].targetPath,'nested','1.jpg'),stat=await fs.stat(file,{bigint:true});
  const identityCounts=()=>['archive_catalog_works','archive_catalog_local_works','posts','images'].map(t=>rows(t).length);
  const counts=identityCounts();
  const decisions=rows('archive_catalog_work_decisions');const folderCount=rows('archive_catalog_local_creator_folders').length;
  if(process.platform==='win32'&&initialState==='files_verified'){
    const old=manager.connection.prepare('SELECT local_creator_folder_id FROM archive_catalog_local_works WHERE id=?').get(mapped.localWorkId)!;
    manager.connection.prepare('UPDATE archive_catalog_local_creator_folders SET creator_id=? WHERE id=?').run(creator,old.local_creator_folder_id);
    await expect(service.apply(p)).rejects.toThrow('ownership changed');
    expect(manager.connection.prepare('SELECT local_creator_folder_id FROM archive_catalog_local_works WHERE id=?').get(mapped.localWorkId)).toEqual(old);
    manager.connection.prepare('UPDATE archive_catalog_local_creator_folders SET creator_id=? WHERE id=?').run(mixedCreator,old.local_creator_folder_id);
    manager.connection.prepare('UPDATE archive_catalog_local_creator_folders SET is_active=0 WHERE id=?').run(old.local_creator_folder_id);
    await expect(service.apply(p)).rejects.toThrow('ownership changed');
    expect(manager.connection.prepare('SELECT is_active FROM archive_catalog_local_creator_folders WHERE id=?').get(old.local_creator_folder_id)?.is_active).toBe(0);
    manager.connection.prepare('UPDATE archive_catalog_local_creator_folders SET is_active=1 WHERE id=?').run(old.local_creator_folder_id);
  }
  expect((await service.apply(p)).completed).toBe(true);
  expect(checkpoint()).toMatchObject({state:'completed',work_id:before.work_id,local_work_id:before.local_work_id,last_error:null});
  expect(manager.connection.prepare('SELECT post_id FROM archive_catalog_local_works WHERE id=?').get(before.local_work_id)?.post_id).toBe(post.id);
  expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId)).toEqual(saved);
  expect(identityCounts()).toEqual(counts);expect((await fs.stat(file,{bigint:true})).ino).toBe(stat.ino);
  expect(rows('archive_catalog_work_decisions')).toEqual(decisions);expect(rows('archive_catalog_local_creator_folders')).toHaveLength(folderCount);
  expect(manager.connection.prepare('SELECT count(*) n FROM archive_catalog_local_creator_folders WHERE creator_id=? AND is_active=1').get(mixedCreator)?.n).toBe(1);
  expect((await service.apply(p)).completed).toBe(true);expect(identityCounts()).toEqual(counts);
 });
 it('resumes a real move before verification checkpoint without recreating identities',async()=>{
  const p=await plan('NO.099 Interrupted');
  p.items[0].acceptExistingVersion=true;
  await expect(service.apply(p,{stopAfterMove:true})).rejects.toThrow('Simulated interruption');
  const before=rows('archive_catalog_works').map(x=>x.id);
  await expect(fs.stat(path.join(input,p.items[0].sourceRelativePath))).rejects.toThrow();
  expect((await service.apply(p)).completed).toBe(true);expect(rows('archive_catalog_works').map(x=>x.id)).toEqual(before);
  const local=rows('archive_catalog_local_works').find(x=>x.absolute_path===p.items[0].targetPath)!;
  expect(local.identity_policy).toBe('manual');expect(JSON.parse(String(local.provenance_json)).acceptExistingVersion).toBe(true);
 });
 it('rejects empty scope, source changes, target conflict and unauthorized attachment exclusion',async()=>{
  await expect(service.preview({creatorId:creator,inputRoot:input,directories:[]})).rejects.toThrow('non-empty');
  const p=await plan('NO.110 Source Changed');await fs.writeFile(path.join(input,p.items[0].sourceRelativePath,'keep.txt'),'changed');
  await expect(service.apply(p)).rejects.toThrow('Source changed');
  const q=await plan('NO.111 Conflict');await fs.mkdir(q.items[0].targetPath);
  await expect(service.apply(q)).rejects.toThrow('Target exists');
  const r=await plan('NO.112 Attachment');r.items[0].approvedAds=['nested/1.jpg'];
  await expect(service.apply(r)).rejects.toThrow('explicit existing TXT/URL');
 });
 it('excludes only approved TXT/URL reversibly and replay verifies retained files',async()=>{
  const p=await plan('NO.113 Explicit Ads');p.items[0].approvedAds=['ad.url'];
  const result=await service.apply(p);const saved=result.items[0].excludedAttachments[0].preservedAt;
  expect(await fs.readFile(saved,'utf8')).toContain('invalid.example');
  await expect(fs.stat(path.join(p.items[0].targetPath,'ad.url'))).rejects.toThrow();
  expect(await fs.readFile(path.join(p.items[0].targetPath,'keep.txt'),'utf8')).toBe('untouched attachment');
  await service.apply(p);
  await fs.writeFile(path.join(p.items[0].targetPath,'keep.txt'),'external change');
  await expect(service.apply(p)).rejects.toThrow('changed');
 });
 it('CLI previews apply global exact-image ad defaults only to new unconfirmed plans',async()=>{
  const name='NO.114 Global image ads',dir=await make(name);
  await fs.copyFile(path.join(dir,'nested','1.jpg'),path.join(dir,'492.jpg'));
  await fs.copyFile(path.join(dir,'nested','1.jpg'),path.join(dir,'009-01.jpg'));
  const preview=await service.preview({creatorId:creator,inputRoot:input,directories:[name]});
  expect(preview.confirmed).toBe(false);expect(preview.items[0].approvedAds.sort()).toEqual(['009-01.jpg','492.jpg']);
  const plan={...preview,confirmed:true,items:preview.items.map(i=>({...i,reason:'Global image advertisement policy'}))};
  await service.apply(plan);await service.apply(plan);
  for(const ad of plan.items[0].approvedAds)await expect(fs.stat(path.join(input,'.local-admission-attachments',plan.planId,plan.items[0].key,ad))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(plan.items[0].targetPath,'nested','1.jpg'))).resolves.toBeTruthy();
 });
 it('records audited removal, resumes remaining items and retains original plan and IDs',async()=>{
  await make('Recovery first');await make('Recovery next');
  await fs.writeFile(path.join(input,'Recovery first','bad.jpg'),'');
  const preview=await service.preview({creatorId:creator,inputRoot:input,directories:['Recovery first','Recovery next']});
  const p={...preview,confirmed:true,items:preview.items.map(i=>({...i,reason:'Explicit batch',approvedAds:['ad.url']}))};
  const {scannerService}=await import('../src/services/scanner-service.js');
  const scan=vi.spyOn(scannerService,'scanCosCreators').mockRejectedValueOnce(new Error('Synthetic decoder failure'));
  await expect(service.apply(p)).rejects.toThrow('Synthetic decoder');scan.mockRestore();
  const original=manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId);
  const first=manager.connection.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(p.planId,p.items[0].key)!;
  const item=p.items[0];const saved=path.join(input,'.local-admission-attachments',p.planId,item.key,'ad.url');
  await fs.unlink(saved);await fs.unlink(path.join(item.targetPath,'bad.jpg'));
  await expect(service.apply(p)).rejects.toThrow('changed');
  const request={confirmed:true,planId:p.planId,key:'recovery-batch',reason:'User accepted missing broken file and recycled ad',evidence:'Synthetic removal record',removals:['bad.jpg','ad.url'].map(relativePath=>({itemKey:item.key,entry:item.manifest.find(e=>e.relativePath===relativePath)!}))};
  const recorded=await service.recover(request);expect(recorded.resumed).toBe(false);
  await expect(service.recover({...request,key:'different-key'})).rejects.toThrow('already has an active');
  expect(manager.connection.prepare('SELECT state FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(p.planId,item.key)?.state).toBe('files_verified');
  expect((await service.recover(request)).decisionIds).toEqual(recorded.decisionIds);
  const done=await service.apply(p);expect(done.completed).toBe(true);expect(done.items[0].work_id).toBe(first.work_id);expect(done.items[0].local_work_id).toBe(first.local_work_id);
  expect(done.items[0].approvedRemovals).toHaveLength(2);expect(done.items[0].excludedAttachments[0].status).toBe('removed_by_explicit_decision');
  expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId)).toEqual(original);
  expect(manager.connection.prepare('SELECT manifest_json FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(p.planId,item.key)?.manifest_json).toBe(first.manifest_json);
  expect((await service.recover(request)).decisionIds).toEqual(recorded.decisionIds);
  expect((await service.apply(p)).completed).toBe(true);
  // New/changed files are never covered by a missing-file authorization.
  await fs.writeFile(path.join(item.targetPath,'bad.jpg'),'replacement');await expect(service.apply(p)).rejects.toThrow('present again');await fs.unlink(path.join(item.targetPath,'bad.jpg'));
  await fs.writeFile(path.join(item.targetPath,'extra.txt'),'not authorized');await expect(service.apply(p)).rejects.toThrow('changed');await fs.unlink(path.join(item.targetPath,'extra.txt'));
 });
 it('allows completed advertisement recovery but rejects unapproved, wrong and revoked evidence',async()=>{
  const p=await plan('Recovery completed ads');p.items[0].approvedAds=['ad.url'];const done=await service.apply(p);const item=p.items[0];
  await fs.unlink(done.items[0].excludedAttachments[0].preservedAt);
  const request={confirmed:true,planId:p.planId,key:'completed-ad',reason:'Recycle approved ad',evidence:'Synthetic user record',removals:[{itemKey:item.key,entry:item.manifest.find(e=>e.relativePath==='ad.url')!}]};
  await expect(service.recover({...request,confirmed:false})).rejects.toThrow();
  await expect(service.recover({...request,removals:[{...request.removals[0],entry:{...request.removals[0].entry,size:999}}]})).rejects.toThrow('original manifest');
  await expect(service.recover({...request,removals:[{itemKey:item.key,entry:item.manifest.find(e=>e.relativePath==='keep.txt')!}]})).rejects.toThrow('Only original approved');
  await expect(service.recover({...request,removals:[{itemKey:item.key,entry:item.manifest.find(e=>e.kind==='directory')!}]})).rejects.toThrow('Only original approved');
  const recorded=await service.recover(request);expect((await service.apply(p)).completed).toBe(true);
  await fs.mkdir(path.dirname(done.items[0].excludedAttachments[0].preservedAt),{recursive:true});
  await fs.writeFile(done.items[0].excludedAttachments[0].preservedAt,'returned ad');
  await expect(service.apply(p)).rejects.toThrow('present again');await fs.unlink(done.items[0].excludedAttachments[0].preservedAt);
  await expect(service.recover({...request,key:'indexed-media',removals:[{itemKey:item.key,entry:item.manifest.find(e=>e.kind==='image')!}]})).rejects.toThrow('unfinished');
  const {WorkIdentityService}=await import('../src/services/work-identity-service.js');new WorkIdentityService(manager.connection).revoke(Number(recorded.decisionIds[0]),'User revoked exception');
  await expect(service.apply(p)).rejects.toThrow('changed');await expect(service.recover(request)).rejects.toThrow('revoked');
 });
 it('recovery is atomic across items and rejects unexplained missing files',async()=>{
  const p=await plan('Recovery rejects collateral');p.items[0].approvedAds=['ad.url'];const done=await service.apply(p);const item=p.items[0];await fs.unlink(done.items[0].excludedAttachments[0].preservedAt);await fs.unlink(path.join(item.targetPath,'keep.txt'));
  const before=rows('archive_catalog_work_decisions');
  await expect(service.recover({confirmed:true,planId:p.planId,key:'collateral',reason:'ad only',evidence:'test',removals:[{itemKey:item.key,entry:item.manifest.find(e=>e.relativePath==='ad.url')!}]})).rejects.toThrow('changed');
  expect(rows('archive_catalog_work_decisions')).toEqual(before);
 });
 it('does not grant removals for an unstarted plan or planned directory',async()=>{
  const p=await plan('Recovery not moved');const item=p.items[0];
  await expect(service.recover({confirmed:true,planId:p.planId,key:'unstarted',reason:'test',evidence:'test',removals:[{itemKey:item.key,entry:item.manifest.find(e=>e.kind==='image')!}]})).rejects.toThrow('Existing admission plan');
 });
 it('recovers provisional scanner Post/media without replacing surviving IDs',async()=>{
  const name='Recovery provisional Post';const dir=await make(name);
  await sharp({create:{width:32,height:48,channels:3,background:'#abc123'}}).jpeg().toFile(path.join(dir,'second.jpg'));
  const preview=await service.preview({creatorId:creator,inputRoot:input,directories:[name]});const p={...preview,confirmed:true,items:preview.items.map(i=>({...i,reason:'User approved individual broken-media removal'}))};
  const {scannerService}=await import('../src/services/scanner-service.js');const original= scannerService.scanCosCreators.bind(scannerService);
  const spy=vi.spyOn(scannerService,'scanCosCreators').mockImplementationOnce(async(...args)=>{await original(...args);throw Error('Lost scan response');});
  await expect(service.apply(p)).rejects.toThrow('Lost scan response');spy.mockRestore();
  const item=p.items[0],relative=path.relative(gallery,item.targetPath).split(path.sep).join('/');
  const post=manager.connection.prepare('SELECT * FROM posts WHERE source_path=?').get(relative)!;
  const active=()=>manager.connection.prepare('SELECT i.id FROM images i JOIN post_items p ON p.image_id=i.id WHERE p.post_id=? AND i.is_deleted=0 AND i.is_trashed=0 ORDER BY i.id').all(post.id);
  const before=active();expect(before).toHaveLength(2);
  await fs.unlink(path.join(item.targetPath,'second.jpg'));
  await service.recover({confirmed:true,planId:p.planId,key:'provisional',reason:'User accepts remaining original',evidence:'synthetic recycle',removals:[{itemKey:item.key,entry:item.manifest.find(e=>e.relativePath==='second.jpg')!}]});
  const done=await service.apply(p);expect(done.completed).toBe(true);
  const after=manager.connection.prepare(`SELECT posts.*,(SELECT count(*) FROM post_items WHERE post_id=posts.id) item_count,
    (SELECT image_id FROM post_items WHERE post_id=posts.id ORDER BY position LIMIT 1) cover_image_id FROM posts WHERE source_path=?`).get(relative)!;expect(after.id).toBe(post.id);expect(after.item_count).toBe(1);
  expect(active()).toHaveLength(1);expect(before.map(i=>i.id)).toContain(active()[0].id);expect(after.cover_image_id).toBe(active()[0].id);
 });
 it('retains explicit oversized originals through interrupted rename and actual scoped indexing',async()=>{
  const name='Retain original';const dir=await make(name);
  await fs.writeFile(path.join(dir,'bad.jpeg'),'synthetic undecodable original');
  const preview=await service.preview({creatorId:creator,inputRoot:input,directories:[name]});
  const p={...preview,confirmed:true,items:preview.items.map(i=>({...i,reason:'Keep explicit original'}))};
  const {scannerService}=await import('../src/services/scanner-service.js');
  const spy=vi.spyOn(scannerService,'scanCosCreators').mockRejectedValueOnce(new Error('Synthetic pixel limit'));
  await expect(service.apply(p)).rejects.toThrow('pixel limit');spy.mockRestore();
  const original=manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId);
  const item=p.items[0],entry=item.manifest.find(e=>e.relativePath==='bad.jpeg')!;
  const request={confirmed:true,planId:p.planId,key:'retained-original',reason:'User keeps oversized original',evidence:'synthetic failure',removals:[{itemKey:item.key,entry,retainOriginal:true}]};
  const recorded=await service.recover(request);
  expect(await fs.readFile(path.join(item.targetPath,'bad.jpeg'),'utf8')).toBe('synthetic undecodable original');
  // Decision committed but rename failed; replay resumes the very same operation.
  const rename=vi.spyOn(fs,'rename').mockRejectedValueOnce(new Error('Synthetic rename interruption'));
  await expect(service.apply(p)).rejects.toThrow('rename interruption');rename.mockRestore();
  const done=await service.apply(p);expect(done.completed).toBe(true);
  expect(done.items[0].approvedRemovals).toHaveLength(0);expect(done.items[0].retainedOriginals).toHaveLength(1);
  const retained=done.items[0].retainedOriginals[0].preservedAt;
  expect(await fs.readFile(retained,'utf8')).toBe('synthetic undecodable original');
  await expect(fs.stat(path.join(item.targetPath,'bad.jpeg'))).rejects.toThrow();
  const local=manager.connection.prepare('SELECT post_id FROM archive_catalog_local_works WHERE id=?').get(done.items[0].local_work_id)!;
  expect(manager.connection.prepare('SELECT count(*) n FROM post_items WHERE post_id=?').get(local.post_id)?.n).toBe(1);
  expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId)).toEqual(original);
  expect((await service.recover(request)).decisionIds).toEqual(recorded.decisionIds);
  expect((await service.apply(p)).completed).toBe(true);
  await fs.writeFile(path.join(item.targetPath,'bad.jpeg'),'duplicate');await expect(service.apply(p)).rejects.toThrow('both locations');await fs.unlink(path.join(item.targetPath,'bad.jpeg'));
  await fs.writeFile(path.join(path.dirname(retained),'extra.txt'),'unapproved');await expect(service.apply(p)).rejects.toThrow('changed');await fs.unlink(path.join(path.dirname(retained),'extra.txt'));
  await fs.writeFile(retained,'changed original');await expect(service.apply(p)).rejects.toThrow('changed');
 });
 it('does not authorize removal of the last supported medium',async()=>{
  const p=await plan('Recovery no media');const {scannerService}=await import('../src/services/scanner-service.js');const spy=vi.spyOn(scannerService,'scanCosCreators').mockRejectedValueOnce(new Error('Synthetic fail'));
  await expect(service.apply(p)).rejects.toThrow('Synthetic fail');spy.mockRestore();const item=p.items[0],entry=item.manifest.find(e=>e.kind==='image')!;await fs.unlink(path.join(item.targetPath,entry.relativePath));
  await expect(service.recover({confirmed:true,planId:p.planId,key:'empty-media',reason:'test',evidence:'test',removals:[{itemKey:item.key,entry}]})).rejects.toThrow('No supported media');
 });
 it('reopens the real database in a separate Node process without rebuilding IDs',()=>{
  const before=rows('archive_catalog_local_works').map(x=>({id:x.id,work_id:x.work_id}));
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT id,work_id FROM archive_catalog_local_works ORDER BY id').all()));d.close();`,path.join(root,'db','gallery.sqlite')],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual(before);
 });
 it('keeps source-first explicit foreign numbering through actual scan, source refresh and a new-process scan',async()=>{
  const {ArchiveCatalogService}=await import('../src/services/archive-catalog-service.js');
  const catalog=new ArchiveCatalogService(manager.connection);
  const record=(label:string)=>({creatorName:'Synthetic Creator',costuan:{postId:'synthetic-source',title:'Synthetic collection',works:[{order:30,sourceOrder:'NO.030',label}]}});
  catalog.importCostuanRecord(record('Nurse'));
  const source=manager.connection.prepare('SELECT id,work_id FROM archive_catalog_source_works').get() as {id:number;work_id:number};
  const p=await plan('NO.032 Nurse');p.items[0].identity={kind:'existing',sourceWorkId:source.id} as any;p.items[0].displayTitle='Nurse';
  const admitted=await service.apply(p);expect(admitted.items[0].work_id).toBe(source.work_id);
  catalog.importCostuanRecord(record('External retitled Nurse'));
  expect(manager.connection.prepare('SELECT display_title FROM archive_catalog_works WHERE id=?').get(source.work_id)?.display_title).toBe('Nurse');
  const before=manager.connection.prepare('SELECT id,work_id,post_id FROM archive_catalog_local_works ORDER BY id').all();manager.close();
  const result=spawnSync(process.execPath,['--import','./node_modules/tsx/dist/loader.mjs','test/fixtures/local-admission-restart.ts',String(creator),'Synthetic Creator',p.items[0].sourceRelativePath],{encoding:'utf8',env:process.env,cwd:fileURLToPath(new URL('../',import.meta.url))});
  expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual(before);
 });
 it('admits two confirmed same-work copies without a silent title or primary switch',async()=>{
  await make('NO.201 Shared Theme','#123456');await make('NO.202 Shared Theme','#987654');
  const p=await service.preview({creatorId:creator,inputRoot:input,directories:['NO.201 Shared Theme','NO.202 Shared Theme']});
  p.items.forEach(i=>i.reason='Explicit synthetic same-work confirmation');p.items[1].identity={kind:'same-as',itemKey:p.items[0].key} as any;
  const confirmed={...p,confirmed:true};
  await expect(service.apply({...confirmed,items:confirmed.items.map((i,n)=>n?{...i,displayTitle:'Incorrect different title'}:i)})).rejects.toThrow('canonical displayTitle');
  const result=await service.apply(confirmed);expect(result.items[0].work_id).toBe(result.items[1].work_id);
  expect(manager.connection.prepare('SELECT primary_local_work_id FROM archive_catalog_works WHERE id=?').get(result.items[0].work_id)?.primary_local_work_id).toBe(result.items[0].local_work_id);
  const ids=()=>rows('posts').map(p=>({id:p.id,source_path:p.source_path,folder_id:p.folder_id,cover_image_id:p.cover_image_id,item_count:p.item_count}));
  const before=ids();
  // Simulate an index commit whose admission checkpoint response was lost.
  manager.connection.prepare("UPDATE archive_local_admission_items SET state='files_verified' WHERE plan_id=? AND item_key=?").run(p.planId,p.items[1].key);
  await service.apply(confirmed);expect(ids()).toEqual(before);
 });
 it('refuses active acquisition at registration and again at resume without clearing claim history',async()=>{
  const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');
  const other=new ManagedCreatorService(manager.connection,gallery).create({name:'Recovery Claim Owner',rating:'R15',preference:'liked'});
  const {ArchiveCatalogService}=await import('../src/services/archive-catalog-service.js');
  new ArchiveCatalogService(manager.connection).importCostuanRecord({creatorName:'Recovery Claim Owner',costuan:{postId:'recovery-claim-source',title:'Synthetic collection',works:[{order:1,sourceOrder:'NO.001',label:'Claim Theme'}]}});
  const source=manager.connection.prepare('SELECT s.id FROM archive_catalog_source_works s JOIN archive_catalog_collections c ON c.id=s.collection_id WHERE c.creator_id=?').get(other.id)!;
  const name='Claim Theme';const dir=await make(name);await fs.writeFile(path.join(dir,'bad.jpg'),'');
  const preview=await service.preview({creatorId:other.id,inputRoot:input,directories:[name]});const p={...preview,confirmed:true,items:preview.items.map(i=>({...i,reason:'Explicit source mapping',displayTitle:'Claim Theme',identity:{kind:'existing',sourceWorkId:Number(source.id)}}))};
  const {scannerService}=await import('../src/services/scanner-service.js');const spy=vi.spyOn(scannerService,'scanCosCreators').mockRejectedValueOnce(new Error('Synthetic decoder fail'));
  await expect(service.apply(p)).rejects.toThrow('Synthetic decoder');spy.mockRestore();const item=p.items[0];await fs.unlink(path.join(item.targetPath,'bad.jpg'));
  const taskId=manager.connection.prepare(`INSERT INTO archive_catalog_download_tasks(source_work_id,provider,target_root,target_relative_directory,target_filename,status,claimed_by,attempt_count)
    VALUES(?,'baidu',?,'Synthetic','001.7z','claimed','synthetic-worker',3)`).run(source.id,input).lastInsertRowid;
  const task=()=>manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(taskId);
  const request={confirmed:true,planId:p.planId,key:'claim-test',reason:'User recycles broken file',evidence:'synthetic log',removals:[{itemKey:item.key,entry:item.manifest.find(e=>e.relativePath==='bad.jpg')!}]};
  const before=task();await expect(service.recover(request)).rejects.toThrow('acquisition is active');expect(task()).toEqual(before);
  manager.connection.prepare("UPDATE archive_catalog_download_tasks SET status='staged' WHERE id=?").run(taskId);
  // A worker can acquire the task while the asynchronous target inventory runs.
  const verification=service as unknown as {verifyTarget(...args:unknown[]):Promise<void>};
  const verify=verification.verifyTarget.bind(service);
  const decisionsBefore=rows('archive_catalog_work_decisions');
  const duringVerification=vi.spyOn(verification,'verifyTarget').mockImplementationOnce(async(...args)=>{
    await verify(...args);
    manager.connection.prepare("UPDATE archive_catalog_download_tasks SET status='claimed' WHERE id=?").run(taskId);
  });
  try{await expect(service.recover(request)).rejects.toThrow('acquisition is active');}finally{duringVerification.mockRestore();}
  expect(task()).toEqual(before);expect(rows('archive_catalog_work_decisions')).toEqual(decisionsBefore);
  manager.connection.prepare("UPDATE archive_catalog_download_tasks SET status='staged' WHERE id=?").run(taskId);await service.recover(request);
  manager.connection.prepare("UPDATE archive_catalog_download_tasks SET status='claimed' WHERE id=?").run(taskId);const claimed=task();await expect(service.apply(p)).rejects.toThrow('acquisition changed');expect(task()).toEqual(claimed);
 });
});
