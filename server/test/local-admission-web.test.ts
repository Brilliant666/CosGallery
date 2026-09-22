import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {beforeAll,beforeEach,afterEach,afterAll,describe,it,expect,vi} from 'vitest';
import {requestTestApp} from './http-test-utils.js';

describe.sequential('web directory admission delegates to original plans',()=>{
  let root:string,waiting:string,gallery:string,creator:number,parent='中文 博主 & 样本';
  let manager:typeof import('../src/db/database.js')['databaseManager'];
  let service:import('../src/services/local-admission-web-service.js').LocalAdmissionWebService;
  let App:typeof import('../src/app.js')['createApp'];
  beforeAll(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'web-admission-'));waiting=path.join(root,'cos等待入库');gallery=path.join(root,'gallery');
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');vi.stubEnv('PUBLIC_DEMO_MODE','0');vi.stubEnv('DERIVATIVE_MODE','lazy');
    for(const [key,value] of Object.entries({DATA_ROOT:path.join(root,'data'),DB_DIR:path.join(root,'db'),GALLERY_ROOT:gallery,THUMBNAILS_DIR:path.join(root,'thumbs'),PREVIEWS_DIR:path.join(root,'previews')})){
      vi.stubEnv(key,value);await fs.mkdir(value,{recursive:true});}
    await fs.mkdir(path.join(waiting,parent),{recursive:true});vi.resetModules();
    ({databaseManager:manager}=await import('../src/db/database.js'));
    const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');creator=new ManagedCreatorService(manager.connection,gallery).create({name:parent,rating:'R15',preference:'liked'}).id;
    const {LocalAdmissionWebService}=await import('../src/services/local-admission-web-service.js');service=new LocalAdmissionWebService(manager.connection,gallery);
    ({createApp:App}=await import('../src/app.js'));
  },30000);
  beforeEach(async()=>{const {LocalAdmissionWebService}=await import('../src/services/local-admission-web-service.js');service=new LocalAdmissionWebService(manager.connection,gallery);});
  afterEach(async()=>{await service.waitForIdle();});
  afterAll(async()=>{await service?.waitForIdle();manager?.close();vi.unstubAllEnvs();});
  async function make(name:string){const dir=path.join(waiting,parent,name);await fs.mkdir(dir);await sharp({create:{width:12,height:18,channels:3,background:'#ab1234'}}).jpeg().toFile(path.join(dir,'图片 1.jpg'));
    await fs.writeFile(path.join(dir,'明确广告.txt'),'synthetic ad');await fs.writeFile(path.join(dir,'笔记.txt'),'keep attachment');return dir;}
  async function preview(names:string[]){for(const name of names)await make(name);return service.preview({creatorId:creator,parent,directories:names});}
  function request(batch:Awaited<ReturnType<typeof service.preview>>,override:Record<string,unknown>={}){return {requestKey:randomUUID(),confirmed:true,acceptExistingVersion:true,
    actions:batch.items.map(i=>({key:i.key,action:'new',displayTitle:i.displayTitle})),...override};}
  it('lists one layer, enforces configured root and never accepts arbitrary paths',async()=>{
    const list=await service.directories(creator);expect(list.items.find(i=>i.name===parent)?.matchesSelectedCreator).toBe(true);
    await expect(service.directories(creator,'..')).rejects.toThrow();await expect(service.directories(creator,path.resolve(root))).rejects.toThrow();
    await expect(service.saveSettings(gallery)).rejects.toThrow('独立');expect(service.settings().waitingRoot).toBe(waiting);
    const linked=path.join(waiting,'linked');await fs.symlink(path.join(waiting,parent),linked,process.platform==='win32'?'junction':'dir');
    expect((await service.directories(creator)).items.find(i=>i.name==='linked')?.selectable).toBe(false);
    await expect(service.directories(creator,'linked')).rejects.toThrow('链接');
    for(const reserved of ['.local-admission-attachments','.local-review-attachments','.LOCAL-REVIEW-attachments']){
      await fs.mkdir(path.join(waiting,parent,reserved),{recursive:true});
      await expect(service.preview({creatorId:creator,parent,directories:[reserved]})).rejects.toThrow('系统附件');
      await expect(service.directories(creator,reserved)).rejects.toThrow('系统附件');
    }
    expect((await service.directories(creator,parent)).items.some(item=>/^\.local-/i.test(item.name))).toBe(false);
  });
  it('HTTP requires write intent; preview persists draft only and all polling stays lightweight',async()=>{
    await make('NO.001 HTTP选择');
    const body={creatorId:creator,parent,directories:['NO.001 HTTP选择']};
    const denied=await requestTestApp(App(),'POST','/api/admin/local-admission/previews',{},body);expect(denied.status).toBe(403);
    const response=await requestTestApp(App(),'POST','/api/admin/local-admission/previews',{'x-foldergram-intent':'1'},body);
    expect(response.status).toBe(201);expect(response.body.state).toBe('draft');expect(response.body.items[0]).not.toHaveProperty('manifest');
    expect(manager.connection.prepare('SELECT COUNT(*) n FROM archive_catalog_works').get()!.n).toBe(0);
    const stat=vi.spyOn(fs,'readdir');const read=await requestTestApp(App(),'GET',`/api/admin/local-admission/batches/${response.body.id}`);expect(read.status).toBe(200);expect(stat).not.toHaveBeenCalled();stat.mockRestore();
  });
  it('submits asynchronously, deduplicates lost responses, preserves original names and ignored attachments',async()=>{
    const batch=await preview(['NO.002 中文 空格 & 标题']);const input=request(batch,{adsConfirmed:true,actions:[{key:batch.items[0].key,action:'new',approvedAds:['明确广告.txt']}]});
    const [first,retry]=await Promise.all([service.execute(batch.id,input),service.execute(batch.id,input)]);expect(first.id).toBe(retry.id);expect(['queued','running']).toContain(first.state);
    await service.waitForIdle();expect(service.get(batch.id).state).toBe('completed');
    const item=service.items(batch.id).items[0];expect(item.state).toBe('completed');expect(item.workId).toBeTruthy();expect(item.postId).toBeTruthy();
    expect(item).toMatchObject({executionState:'completed',nextAction:'none'});
    await expect(fs.stat(path.join(gallery,parent,'NO.002 中文 空格 & 标题','图片 1.jpg'))).resolves.toBeTruthy();
    expect(await fs.readFile(path.join(gallery,parent,'NO.002 中文 空格 & 标题','笔记.txt'),'utf8')).toBe('keep attachment');
    expect(await fs.readFile(path.join(waiting,parent,'.local-admission-attachments',batch.id,item.key,'明确广告.txt'),'utf8')).toBe('synthetic ad');
    expect(manager.connection.prepare('SELECT COUNT(*) n FROM local_ingest_jobs').get()!.n).toBe(0);
    expect((await service.execute(batch.id,input)).state).toBe('completed');await expect(service.execute(batch.id,{...input,acceptExistingVersion:false})).rejects.toThrow('请求键');
  });
  it('same-title independent Work and same-work copies remain distinct decisions; primary can be the later copy',async()=>{
    const batch=await preview(['NO.003 同名','NO.004 同名','NO.005 主副本甲','NO.006 主副本乙']);
    const actions=batch.items.map(i=>({key:i.key,action:'new',displayTitle:i.displayTitle} as Record<string,unknown>));actions[3]={key:batch.items[3].key,action:'same-as',sameAsKey:batch.items[2].key,primary:true};
    await service.execute(batch.id,request(batch,{actions}));await service.waitForIdle();expect(service.get(batch.id).state).toBe('completed');
    const items=service.items(batch.id).items;expect(items[0].workId).not.toBe(items[1].workId);expect(items[2].workId).toBe(items[3].workId);
    expect(manager.connection.prepare('SELECT primary_local_work_id FROM archive_catalog_works WHERE id=?').get(Number(items[3].workId))!.primary_local_work_id).toBe(items[3].localWorkId);
  });
  it('skipped/deferred source folders remain, deferred work can get a new preview without replaying completed items',async()=>{
    const batch=await preview(['NO.007 明确','NO.008 跳过','NO.009 暂缓']);const actions=batch.items.map((i,n)=>({key:i.key,action:['new','skip','defer'][n]}));
    await service.execute(batch.id,request(batch,{actions}));await service.waitForIdle();expect(service.get(batch.id).totals).toEqual({total:3,selected:1,completed:1,skipped:1,deferred:1});
    expect(service.items(batch.id).items.slice(1)).toMatchObject([
      {state:'skip',executionState:null,nextAction:'none'}, {state:'defer',executionState:null,nextAction:'prepare_preview'}]);
    for(const name of ['NO.008 跳过','NO.009 暂缓'])await expect(fs.stat(path.join(waiting,parent,name))).resolves.toBeTruthy();
    const renewed=await service.repreview(batch.id);expect(renewed.id).not.toBe(batch.id);expect(renewed.items[0].sourceRelativePath).toBe('NO.009 暂缓');
    await expect(service.repreview(batch.id,[batch.items[0].key])).rejects.toThrow('原计划');
  });
  it('existing Work chooser supplies identity; retains canonical title and existing primary',async()=>{
    const batch=await preview(['NO.010 额外副本']);const existing=service.works(creator,'同名').items[0]!;expect(existing.workId).toBeTruthy();
    await service.execute(batch.id,request(batch,{actions:[{key:batch.items[0].key,action:'existing',workId:existing.workId}]}));await service.waitForIdle();
    const item=service.items(batch.id).items[0];expect(item.workId).toBe(existing.workId);
    expect(manager.connection.prepare('SELECT primary_local_work_id FROM archive_catalog_works WHERE id=?').get(existing.workId)!.primary_local_work_id).toBe(existing.primaryLocalWorkId);
  });
  it('pre-confirmation source changes and occupied targets fail without file moves',async()=>{
    const batch=await preview(['NO.011 变化']);await fs.writeFile(path.join(waiting,parent,'NO.011 变化','图片 1.jpg'),'changed');
    await service.execute(batch.id,request(batch));await service.waitForIdle();expect(service.get(batch.id).state).toBe('needs_review');expect(service.get(batch.id).error).toContain('Source changed');
    expect(service.items(batch.id).items[0]).toMatchObject({state:'not_started',executionState:null,nextAction:'prepare_preview'});
    await expect(fs.stat(path.join(waiting,parent,'NO.011 变化'))).resolves.toBeTruthy();
    const next=await preview(['NO.012 占用']);await fs.mkdir(next.items[0].targetPath);
    await service.execute(next.id,request(next));await service.waitForIdle();expect(service.get(next.id).error).toContain('Target exists');
  });
  it('new service instance sees persisted batches; dead-owner interruption is explicit and never auto-replayed',async()=>{
    const batch=await preview(['NO.013 重启']);
    manager.connection.prepare("UPDATE local_admission_web_batches SET state='running',owner_pid=2147483646,confirmed_json='{}' WHERE id=?").run(batch.id);
    const {LocalAdmissionWebService}=await import('../src/services/local-admission-web-service.js');const reopened=new LocalAdmissionWebService(manager.connection,gallery);
    expect(reopened.get(batch.id).state).toBe('interrupted');expect(reopened.list(creator).items.some(i=>i.id===batch.id)).toBe(true);
    await expect(fs.stat(path.join(waiting,parent,'NO.013 重启'))).resolves.toBeTruthy();
  });
  it('explicit ads confirmation cannot be implied by ordinary execution and another creator Work is refused',async()=>{
    const batch=await preview(['NO.014 精确范围']);await expect(service.execute(batch.id,request(batch,{actions:[{key:batch.items[0].key,action:'new',approvedAds:['明确广告.txt']}]}))).rejects.toThrow('单独确认');
    await expect(service.execute(batch.id,request(batch,{actions:[{key:batch.items[0].key,action:'existing',workId:2147483647}]}))).rejects.toThrow('身份');
    expect(service.get(batch.id).state).toBe('draft');
  });
  it('known active ownership and unverifiable ownership block submission without clearing the lock',async()=>{
    const batch=await preview(['NO.015 互斥']);const key='local-folder-admission.execution-lock.v1';
    for(const value of [JSON.stringify({pid:process.pid,token:'other',kind:'index-or-ingest'}),'{}']){
      manager.connection.prepare('INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)').run(key,value);
      await expect(service.execute(batch.id,request(batch))).rejects.toThrow();
      expect(manager.connection.prepare('SELECT value FROM app_settings WHERE key=?').get(key)!.value).toBe(value);
      expect(service.get(batch.id).state).toBe('draft');
    }
    manager.connection.prepare('DELETE FROM app_settings WHERE key=?').run(key);
  });
  it('a changed selected identity requires a fresh preview, leaving the immutable draft and source untouched',async()=>{
    const existing=service.works(creator,'同名').items[0]!;
    const batch=await preview(['NO.016 身份变化']);
    manager.connection.prepare('UPDATE archive_catalog_works SET display_title=? WHERE id=?').run('更新后的规范标题',existing.workId);
    await expect(service.execute(batch.id,request(batch,{actions:[{key:batch.items[0].key,action:'existing',workId:existing.workId}]}))).rejects.toThrow('身份已变化');
    expect(service.get(batch.id).state).toBe('draft');await expect(fs.stat(path.join(waiting,parent,'NO.016 身份变化'))).resolves.toBeTruthy();
  });
  it('web resume keeps the original plan and indexed identities after a provenance writer failure',async()=>{
    const {SourceEvidenceService}=await import('../src/services/source-evidence-service.js');const evidence=new SourceEvidenceService(manager.connection);
    const observation=evidence.save({creatorId:creator,requestId:'web-evidence',record:{platform:'other',pageUrl:'https://example.test/synthetic',pageTitle:'合成资料',method:'manual',rawDirectoryText:''}});
    evidence.confirmIdentity(observation.id,{creatorId:creator,requestId:'confirm-web-evidence',reason:'合成归属确认',expectedRevision:observation.identityRevision});
    await make('NO.017 关联失败恢复');const batch=await service.preview({creatorId:creator,parent,directories:['NO.017 关联失败恢复'],sourceEvidenceId:observation.id});
    const failure=vi.spyOn(SourceEvidenceService.prototype,'linkAdmission').mockImplementation(()=>{throw Error('Synthetic post-index provenance failure');});
    try{await service.execute(batch.id,request(batch));await service.waitForIdle();}finally{failure.mockRestore();}
    const item=service.items(batch.id).items[0];expect(item.state).toBe('indexed');expect(service.get(batch.id).state).toBe('failed');
    const original=manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id);
    const media=manager.connection.prepare('SELECT id FROM images WHERE id IN (SELECT image_id FROM post_items WHERE post_id=?) ORDER BY id').all(Number(item.postId));
    const resume={requestKey:randomUUID(),confirmed:true};service.resume(batch.id,resume);service.resume(batch.id,resume);await service.waitForIdle();
    expect(service.get(batch.id).state).toBe('completed');
    expect(service.items(batch.id).items[0]).toMatchObject({workId:item.workId,localWorkId:item.localWorkId,postId:item.postId,state:'completed'});
    expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id)).toEqual(original);
    expect(manager.connection.prepare('SELECT id FROM images WHERE id IN (SELECT image_id FROM post_items WHERE post_id=?) ORDER BY id').all(Number(item.postId))).toEqual(media);
    expect(evidence.get(observation.id).links).toHaveLength(1);
  });
  it('exact existing-source acceptance preserves staged history and refuses active claims',async()=>{
    const db=manager.connection;
    const workId=Number(db.prepare('INSERT INTO archive_catalog_works(creator_id,display_title,title_policy) VALUES(?,?,?)').run(creator,'精确来源规范名','manual').lastInsertRowid);
    const collectionId=Number(db.prepare("INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at) VALUES(?,'test','web-exact','合成来源','now')").run(creator).lastInsertRowid);
    const sourceId=Number(db.prepare("INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_order,source_title,media_summary,first_seen_at,last_seen_at) VALUES(?,?,'test','one',1,'来源原名','1P','now','now')").run(workId,collectionId).lastInsertRowid);
    const taskId=Number(db.prepare("INSERT INTO archive_catalog_download_tasks(source_work_id,provider,target_root,target_relative_directory,target_filename,status,claimed_by,attempt_count) VALUES(?,'baidu','synthetic','synthetic','真实记录名称.7z','claimed','active-test',2)").run(sourceId).lastInsertRowid);
    const initial=await preview(['NO.018 来源编号不同']);
    await expect(service.execute(initial.id,request(initial,{actions:[{key:initial.items[0].key,action:'existing',workId,acceptSourceIds:[sourceId]}]}))).rejects.toThrow('活动');
    expect(db.prepare('SELECT status,claimed_by FROM archive_catalog_download_tasks WHERE id=?').get(taskId)).toEqual({status:'claimed',claimed_by:'active-test'});
    db.prepare("UPDATE archive_catalog_download_tasks SET status='staged' WHERE id=?").run(taskId);
    const batch=await service.repreview(initial.id,[initial.items[0].key]);
    const history=db.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(taskId);
    expect(service.works(creator,'精确来源').items[0].sources[0]).toMatchObject({sourceWorkId:sourceId,taskIds:[taskId]});
    await service.execute(batch.id,request(batch,{actions:[{key:batch.items[0].key,action:'existing',workId,acceptSourceIds:[sourceId]}]}));await service.waitForIdle();
    expect(service.get(batch.id).state).toBe('completed');expect(service.items(batch.id).items[0].displayTitle).toBe('精确来源规范名');
    expect(db.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(taskId)).toEqual(history);
    const {ArchiveDownloadTaskService}=await import('../src/services/archive-download-task-service.js');
    expect(new ArchiveDownloadTaskService(db).get(taskId)?.acquisitionState).toBe('local_satisfied');
  });
  it('repreview retains unchanged choices only as unconfirmed suggestions and remaps same-as keys',async()=>{
    const batch=await preview(['NO.019 已变化','NO.020 未变化主','NO.021 未变化次','NO.022 原选择复用']);
    const existing=service.works(creator,'精确来源').items[0];
    const actions=[{key:batch.items[0].key,action:'new'},{key:batch.items[1].key,action:'new',displayTitle:'保留上次展示名'},
      {key:batch.items[2].key,action:'same-as',sameAsKey:batch.items[1].key,primary:true},
      {key:batch.items[3].key,action:'existing',workId:existing.workId}];
    await fs.writeFile(path.join(waiting,parent,'NO.019 已变化','图片 1.jpg'),'replaced');
    await service.execute(batch.id,request(batch,{actions}));await service.waitForIdle();
    expect(service.get(batch.id).error).toContain('NO.019 已变化');
    const payload=manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(batch.id);
    const next=await service.repreview(batch.id,batch.items.map(i=>i.key));expect(next.state).toBe('draft');
    expect(next.items[0].suggestedAction).toBeUndefined();
    expect(next.items[1].suggestedAction).toMatchObject({action:'new',displayTitle:'保留上次展示名'});
    expect(next.items[2].suggestedAction).toMatchObject({action:'same-as',sameAsKey:next.items[1].key,primary:true});
    expect(next.items[3].suggestedAction).toMatchObject({action:'existing',workId:existing.workId});
    expect(next.items[3].candidates.some(c=>c.workId===existing.workId)).toBe(true);
    expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(next.id)).toBeUndefined();
    expect(manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(batch.id)).toEqual(payload);
    for(const item of batch.items)await expect(fs.stat(path.join(waiting,parent,item.sourceRelativePath))).resolves.toBeTruthy();
  });
  it('adds exact global image ads to legacy drafts without rescanning or rewriting preview evidence',async()=>{
    const name='NO.023 全局广告草稿',dir=await make(name);
    for(const file of ['492.jpg','009-01.jpg','0492.jpg','492.jpeg'])await fs.copyFile(path.join(dir,'图片 1.jpg'),path.join(dir,file));
    const batch=await service.preview({creatorId:creator,parent,directories:[name]});
    expect(batch.items[0].ads.filter(a=>a.automatic).map(a=>a.relativePath).sort()).toEqual(['009-01.jpg','492.jpg']);
    const db=manager.connection,row=db.prepare('SELECT summary_json,preview_json FROM local_admission_web_items WHERE batch_id=?').get(batch.id)!;
    const legacy=JSON.parse(String(row.summary_json));delete legacy.advertisementRulesVersion;legacy.ads=legacy.ads.filter((a:{automatic?:boolean})=>!a.automatic);
    db.prepare('UPDATE local_admission_web_items SET summary_json=? WHERE batch_id=?').run(JSON.stringify(legacy),batch.id);
    const saved=db.prepare('SELECT * FROM local_admission_web_items WHERE batch_id=?').get(batch.id);
    const reads=vi.spyOn(fs,'readdir');
    try{expect(service.items(batch.id).items[0].ads.filter(a=>a.automatic).map(a=>a.relativePath).sort()).toEqual(['009-01.jpg','492.jpg']);expect(reads).not.toHaveBeenCalled();}finally{reads.mockRestore();}
    expect(db.prepare('SELECT * FROM local_admission_web_items WHERE batch_id=?').get(batch.id)).toEqual(saved);
    expect(db.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id)).toBeUndefined();
    // Historical confirmed summaries/choices do not gain retroactive approvals.
    db.prepare("UPDATE local_admission_web_batches SET state='completed',confirmed_json='{}' WHERE id=?").run(batch.id);
    expect(service.items(batch.id).items[0].ads).toEqual(legacy.ads);
  });
  it('moves only the confirmed global JPG advertisements outside the gallery and safely replays exact evidence',async()=>{
    const name='NO.024 图片广告执行',dir=await make(name);await fs.mkdir(path.join(dir,'nested'));
    for(const file of ['492.jpg','009-01.jpg','nested/492.jpg','0492.jpg','492.jpeg'])await fs.copyFile(path.join(dir,'图片 1.jpg'),path.join(dir,file));
    const batch=await service.preview({creatorId:creator,parent,directories:[name]});
    const approvedAds=['492.jpg','nested/492.jpg','明确广告.txt'];
    const input=request(batch,{adsConfirmed:true,actions:[{key:batch.items[0].key,action:'new',approvedAds}]});
    await expect(service.execute(batch.id,{...input,adsConfirmed:undefined})).rejects.toThrow('单独确认');
    await expect(service.execute(batch.id,{...input,actions:[{key:batch.items[0].key,action:'new',approvedAds:['图片 1.jpg']}]})).rejects.toThrow('具体候选');
    await service.execute(batch.id,input);await service.waitForIdle();expect(service.get(batch.id).state).toBe('completed');
    const item=service.items(batch.id).items[0],destination=path.join(gallery,parent,name);
    for(const ad of approvedAds){await expect(fs.stat(path.join(destination,ad))).rejects.toThrow();await expect(fs.stat(path.join(waiting,parent,'.local-admission-attachments',batch.id,item.key,ad))).resolves.toBeTruthy();}
    for(const file of ['图片 1.jpg','009-01.jpg','0492.jpg','492.jpeg','笔记.txt'])await expect(fs.stat(path.join(destination,file))).resolves.toBeTruthy();
    const db=manager.connection,images=db.prepare('SELECT image_id FROM post_items WHERE post_id=? ORDER BY position').all(Number(item.postId));expect(images).toHaveLength(4);
    const saved=db.prepare('SELECT payload_json FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id)!;
    const {LocalFolderAdmissionService}=await import('../src/services/local-folder-admission-service.js');
    await new LocalFolderAdmissionService(db,gallery).apply(JSON.parse(String(saved.payload_json)));
    expect(db.prepare('SELECT image_id FROM post_items WHERE post_id=? ORDER BY position').all(Number(item.postId))).toEqual(images);
    const adPath=path.join(waiting,parent,'.local-admission-attachments',batch.id,item.key,'492.jpg');
    await fs.appendFile(adPath,'changed');
    await expect(new LocalFolderAdmissionService(db,gallery).apply(JSON.parse(String(saved.payload_json)))).rejects.toThrow('changed');
  });
  it('refuses to admit an advertisement-only directory before any move or immutable plan',async()=>{
    const name='NO.025 仅广告',dir=path.join(waiting,parent,name);await fs.mkdir(dir);
    await sharp({create:{width:12,height:18,channels:3,background:'#123456'}}).jpeg().toFile(path.join(dir,'492.jpg'));
    const batch=await service.preview({creatorId:creator,parent,directories:[name]});
    await expect(service.execute(batch.id,request(batch,{adsConfirmed:true,actions:[{key:batch.items[0].key,action:'new',approvedAds:['492.jpg']}]}))).rejects.toThrow('没有可展示媒体');
    expect(service.get(batch.id).state).toBe('draft');expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id)).toBeUndefined();
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });
  it('derives recovery actions from immutable checkpoints and suppresses them while an owner is active',async()=>{
    const batch=await preview(['NO.026 恢复动作']),db=manager.connection;
    const {scannerService}=await import('../src/services/scanner-service.js');
    const scan=vi.spyOn(scannerService,'scanCosCreators').mockRejectedValueOnce(new Error('Synthetic media issue'));
    await service.execute(batch.id,request(batch));await service.waitForIdle();scan.mockRestore();
    const get=()=>service.items(batch.id).items[0];
    expect(get()).toMatchObject({state:'files_verified',executionState:'files_verified',nextAction:'review_files',postId:null});
    const saved=db.prepare('SELECT payload_json,content_hash FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id);
    const reads=[vi.spyOn(fs,'readdir'),vi.spyOn(fs,'lstat'),vi.spyOn(fs,'readFile')];
    try{
      // Identical error text must not turn a move intent or indexed item into media review.
      for(const state of ['planned','move_intent','indexed']){
        db.prepare('UPDATE archive_local_admission_items SET state=? WHERE plan_id=?').run(state,batch.id);
        expect(get()).toMatchObject({state,executionState:state,nextAction:'resume_plan',lastError:'Synthetic media issue'});
      }
      db.prepare("UPDATE archive_local_admission_items SET state='files_verified' WHERE plan_id=?").run(batch.id);
      const localId=Number(get().localWorkId),postId=Number(db.prepare('SELECT id FROM posts LIMIT 1').get()!.id);
      db.exec('SAVEPOINT review_attached_post');
      try{
        db.prepare('UPDATE archive_catalog_local_works SET post_id=NULL WHERE post_id=?').run(postId);
        db.prepare('UPDATE archive_catalog_local_works SET post_id=? WHERE id=?').run(postId,localId);
        expect(get().nextAction).toBe('resume_plan');
      }finally{db.exec('ROLLBACK TO review_attached_post; RELEASE review_attached_post');}
      db.exec('SAVEPOINT review_fulfillment');
      try{
        db.prepare("UPDATE archive_catalog_local_fulfillments SET local_work_id=? WHERE id=(SELECT id FROM archive_catalog_local_fulfillments WHERE state='active' LIMIT 1)").run(localId);
        expect(get().nextAction).toBe('resume_plan');
      }finally{db.exec('ROLLBACK TO review_fulfillment; RELEASE review_fulfillment');}
      db.exec('SAVEPOINT review_acquisition');
      try{
        db.prepare("UPDATE archive_catalog_download_tasks SET status='claimed' WHERE id=(SELECT id FROM archive_catalog_download_tasks LIMIT 1)").run();
        expect(get().nextAction).toBe('none');
      }finally{db.exec('ROLLBACK TO review_acquisition; RELEASE review_acquisition');}
      db.prepare("UPDATE local_admission_web_batches SET state='running',owner_pid=?,owner_token='test-owner' WHERE id=?").run(process.pid,batch.id);
      expect(get().nextAction).toBe('none');
      db.prepare("UPDATE local_admission_web_batches SET state='needs_review',owner_pid=NULL,owner_token=NULL WHERE id=?").run(batch.id);
      const reviewId=randomUUID();
      db.prepare(`INSERT INTO local_review_web_sessions(id,creator_id,target_key,target_json,request_key,status,owner_pid,created_at,updated_at)
        VALUES(?,?,?,?,?,'preparing',?,'now','now')`).run(reviewId,creator,`admission:${batch.id}:${batch.items[0].key}`,'{}',randomUUID(),process.pid);
      expect(get().nextAction).toBe('none');
      db.prepare("UPDATE local_review_web_sessions SET status='failed',owner_pid=NULL WHERE id=?").run(reviewId);
      expect(get().nextAction).toBe('review_files');
      db.exec('SAVEPOINT review_missing_confirmation');
      try{
        db.prepare('UPDATE local_admission_web_batches SET confirmed_json=NULL WHERE id=?').run(batch.id);
        expect(get().nextAction).toBe('none');
      }finally{db.exec('ROLLBACK TO review_missing_confirmation; RELEASE review_missing_confirmation');}
      for(const read of reads)expect(read).not.toHaveBeenCalled();
      expect(db.prepare('SELECT payload_json,content_hash FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id)).toEqual(saved);
    }finally{for(const read of reads)read.mockRestore();}
  });
  it('viewer and unauthenticated requests cannot browse disk, inspect batches or submit operations',async()=>{
    const {authService}=await import('../src/services/auth-service.js');authService.setAdminPassword('synthetic-admin-pass');authService.setViewerAccess('password','synthetic-viewer-pass');
    const app=App(),login=await requestTestApp(app,'POST','/api/auth/login',{'x-foldergram-intent':'1'},{password:'synthetic-viewer-pass'});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    for(const url of ['/settings',`/directories?creatorId=${creator}`,`/works?creatorId=${creator}`,'/batches']){
      expect((await requestTestApp(app,'GET','/api/admin/local-admission'+url)).status).toBe(401);
      expect((await requestTestApp(app,'GET','/api/admin/local-admission'+url,{cookie})).status).toBe(403);
    }
    expect((await requestTestApp(app,'POST','/api/admin/local-admission/previews',{'x-foldergram-intent':'1',cookie},{creatorId:creator,parent,directories:['NO.016 身份变化']})).status).toBe(403);
  });
});
