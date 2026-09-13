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
  await expect(service.apply({...p,items:p.items.map(i=>({...i,displayTitle:'changed'}))})).rejects.toThrow('content changed');
 });
 it('resumes a real move before verification checkpoint without recreating identities',async()=>{
  const p=await plan('NO.099 Interrupted');
  await expect(service.apply(p,{stopAfterMove:true})).rejects.toThrow('Simulated interruption');
  const before=rows('archive_catalog_works').map(x=>x.id);
  await expect(fs.stat(path.join(input,p.items[0].sourceRelativePath))).rejects.toThrow();
  expect((await service.apply(p)).completed).toBe(true);expect(rows('archive_catalog_works').map(x=>x.id)).toEqual(before);
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
});
