import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {beforeAll,beforeEach,afterEach,afterAll,describe,it,expect,vi} from 'vitest';
import {requestTestApp} from './http-test-utils.js';

describe.sequential('durable multi-creator local admission collections',()=>{
  let root:string,waiting:string,gallery:string,creators:number[],names=['集中博主甲','集中博主乙'];
  let manager:typeof import('../src/db/database.js')['databaseManager'];
  let service:import('../src/services/local-admission-web-service.js').LocalAdmissionWebService;
  let Service:typeof import('../src/services/local-admission-web-service.js')['LocalAdmissionWebService'];
  let Admission:typeof import('../src/services/local-folder-admission-service.js')['LocalFolderAdmissionService'];
  beforeAll(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'admission-collections-'));waiting=path.join(root,'cos等待入库');gallery=path.join(root,'gallery');
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');vi.stubEnv('PUBLIC_DEMO_MODE','0');vi.stubEnv('DERIVATIVE_MODE','lazy');
    for(const [key,value] of Object.entries({DATA_ROOT:path.join(root,'data'),DB_DIR:path.join(root,'db'),GALLERY_ROOT:gallery,THUMBNAILS_DIR:path.join(root,'thumbs'),PREVIEWS_DIR:path.join(root,'previews')})){
      vi.stubEnv(key,value);await fs.mkdir(value,{recursive:true});}
    for(const name of names)await fs.mkdir(path.join(waiting,name),{recursive:true});vi.resetModules();
    ({databaseManager:manager}=await import('../src/db/database.js'));
    const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');
    creators=names.map(name=>new ManagedCreatorService(manager.connection,gallery).create({name,rating:'R15',preference:'liked'}).id);
    ({LocalAdmissionWebService:Service}=await import('../src/services/local-admission-web-service.js'));
    ({LocalFolderAdmissionService:Admission}=await import('../src/services/local-folder-admission-service.js'));
  },30000);
  beforeEach(()=>{service=new Service(manager.connection,gallery);});
  afterEach(async()=>{await service.waitForIdle();vi.restoreAllMocks();});
  afterAll(async()=>{await service?.waitForIdle();manager?.close();vi.unstubAllEnvs();});
  async function make(index:number,title:string){const dir=path.join(waiting,names[index],title);await fs.mkdir(dir,{recursive:true});
    await sharp({create:{width:14,height:20,channels:3,background:'#bbaa99'}}).jpeg().toFile(path.join(dir,'photo.jpg'));return dir;}
  async function preview(prefix:string){for(let n=0;n<2;n++)await make(n,prefix);
    return service.previewCollection({scopes:creators.map((creatorId,n)=>({creatorId,parent:names[n],directories:[prefix]}))});}
  function request(collection:ReturnType<typeof service.collection>){return {requestKey:randomUUID(),confirmed:true as const,
    batches:collection.batches.map(batch=>({batchId:batch.id,acceptExistingVersion:true,actions:service.items(batch.id).items.map(item=>({key:item.key,action:'new' as const}))}))};}
  it('discovers only one directory layer and matches active canonical identities or registered aliases without creating anyone',async()=>{
    const db=manager.connection;
    db.prepare("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(?,?,?,'manual')").run(creators[0],'甲的别名','甲的别名');
    db.prepare("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(?,?,?,'another-source')").run(creators[0],'甲的别名','甲的别名');
    await fs.mkdir(path.join(waiting,'甲的别名'));await fs.mkdir(path.join(waiting,'未知名称'));await fs.mkdir(path.join(waiting,'.local-admission-attachments'));
    const before=db.prepare('SELECT * FROM archive_catalog_creators ORDER BY id').all(),spy=vi.spyOn(fs,'readdir');
    const workspace=await service.workspace();expect(spy.mock.calls.every(call=>call[0]===waiting)).toBe(true);spy.mockRestore();
    expect(workspace.items.find(item=>item.name==='甲的别名')?.matches).toEqual([{creatorId:creators[0],creatorName:names[0],matchedName:'甲的别名',matchKind:'alias'}]);
    expect(workspace.items.find(item=>item.name==='未知名称')?.matches).toEqual([]);expect(workspace.items.some(item=>item.name.startsWith('.local-'))).toBe(false);
    expect(workspace.items.find(item=>item.name===names[0])?.matches).toEqual([{creatorId:creators[0],creatorName:names[0],matchedName:names[0],matchKind:'canonical'}]);
    expect(service.creators('甲的别名').items).toMatchObject([{id:creators[0],name:names[0],aliases:expect.arrayContaining(['甲的别名',names[0]])}]);
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=?').run(creators[1]);
    expect((await service.workspace()).items.find(item=>item.name===names[1])?.matches).toEqual([]);expect(service.creators(names[1]).items).toEqual([]);
    db.prepare('UPDATE archive_catalog_creators SET is_active=1 WHERE id=?').run(creators[1]);expect(db.prepare('SELECT * FROM archive_catalog_creators ORDER BY id').all()).toEqual(before);
  });
  it('rejects traversal and repeated parent/creator scopes, and flags containers without automatically splitting or blocking explicit boundaries',async()=>{
    await expect(service.previewCollection({scopes:[{creatorId:creators[0],parent:'..',directories:['x']}]})).rejects.toThrow();
    await expect(service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:['x']},{creatorId:creators[0],parent:'甲的别名',directories:['y']}]})).rejects.toThrow('一个父目录');
    await expect(service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:['x']},{creatorId:creators[1],parent:names[0],directories:['y']}]})).rejects.toThrow('重复分配');
    const dir=await make(0,'复杂合集');await fs.mkdir(path.join(dir,'套图','第一套'),{recursive:true});await fs.mkdir(path.join(dir,'工作文件','第二套'),{recursive:true});
    await fs.copyFile(path.join(dir,'photo.jpg'),path.join(dir,'套图','第一套','photo.jpg'));await fs.copyFile(path.join(dir,'photo.jpg'),path.join(dir,'工作文件','第二套','photo.jpg'));
    const collection=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:['复杂合集']}]});
    const item=service.items(collection.batches[0].id).items[0];expect(item.group).toBe('D');expect(item.needsBoundaryReview).toBe(true);expect(item.structureWarnings?.length).toBeGreaterThan(0);expect(item.conflicts).toEqual([]);
    expect(manager.connection.prepare('SELECT COUNT(*) n FROM archive_catalog_works').get()!.n).toBe(0);
  });
  it('validates all creator files and identities before publishing any confirmed child or moving the first creator',async()=>{
    const collection=await preview('001 原子确认');await fs.appendFile(path.join(waiting,names[1],'001 原子确认','photo.jpg'),'changed');
    await expect(service.executeCollection(collection.id,request(collection))).rejects.toThrow('Source changed');
    expect(service.collection(collection.id).state).toBe('draft');
    for(const child of collection.batches){expect(manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(child.id)!.confirmed_json).toBeNull();
      expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(child.id)).toBeUndefined();}
    await expect(fs.stat(path.join(waiting,names[0],'001 原子确认'))).resolves.toBeTruthy();
    const second=await preview('002 跨博主引用');const input=request(second);input.batches[1].actions[0]={...input.batches[1].actions[0],action:'same-as',sameAsKey:input.batches[0].actions[0].key} as any;
    await expect(service.executeCollection(second.id,input)).rejects.toThrow('本批');expect(service.collection(second.id).state).toBe('draft');
  });
  it('executes the original per-creator plans serially, deduplicates concurrent/lost receipts and rejects child bypasses',async()=>{
    const collection=await preview('003 顺序执行'),input=request(collection),calls:number[]=[];let active=0,max=0;
    const original=Admission.prototype.apply;
    const spy=vi.spyOn(Admission.prototype,'apply').mockImplementation(async function(this:InstanceType<typeof Admission>,raw:any,options){
      active++;max=Math.max(max,active);calls.push(raw.creatorId);try{return await original.call(this,raw,options);}finally{active--;}});
    await expect(service.execute(collection.batches[0].id,{...input.batches[0],requestKey:randomUUID(),confirmed:true})).rejects.toThrow('集中');
    expect(()=>service.resume(collection.batches[0].id,{requestKey:randomUUID(),confirmed:true})).toThrow('集中');
    await expect(service.repreview(collection.batches[0].id)).rejects.toThrow('集中');
    const [one,two]=await Promise.all([service.executeCollection(collection.id,input),service.executeCollection(collection.id,input)]);expect(one.id).toBe(two.id);
    await service.waitForIdle();expect(max).toBe(1);expect(calls).toEqual(creators);spy.mockRestore();
    expect(service.collection(collection.id)).toMatchObject({state:'completed',totals:{creators:2,total:2,selected:2,completed:2,failedCreators:0}});
    const identities=collection.batches.map(child=>service.items(child.id).items[0]);
    expect(identities.every(item=>item.workId&&item.localWorkId&&item.postId)).toBe(true);
    expect((await service.executeCollection(collection.id,input)).state).toBe('completed');
    expect(collection.batches.map(child=>service.items(child.id).items[0])).toEqual(identities);
    await expect(service.executeCollection(collection.id,{...input,batches:input.batches.map(child=>({...child,acceptExistingVersion:false}))})).rejects.toThrow('请求键');
    expect(manager.connection.prepare('SELECT COUNT(*) n FROM local_ingest_jobs').get()!.n).toBe(0);
  });
  it('rejects overlapping target directories across child plans before saving any confirmation',async()=>{
    const collection=await preview('009 冲突目标'),db=manager.connection;
    const first=JSON.parse(String(db.prepare('SELECT preview_json FROM local_admission_web_items WHERE batch_id=?').get(collection.batches[0].id)!.preview_json));
    const second=JSON.parse(String(db.prepare('SELECT preview_json FROM local_admission_web_items WHERE batch_id=?').get(collection.batches[1].id)!.preview_json));
    second.targetPath=first.targetPath;
    db.prepare('UPDATE local_admission_web_items SET preview_json=? WHERE batch_id=?').run(JSON.stringify(second),collection.batches[1].id);
    await expect(service.executeCollection(collection.id,request(collection))).rejects.toThrow('同一目标');
    expect(service.collection(collection.id).state).toBe('draft');
    for(const batch of collection.batches)expect(db.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(batch.id)!.confirmed_json).toBeNull();
  });
  it('rechecks competing execution and active claims after asynchronous full-manifest validation before one atomic confirmation',async()=>{
    const db=manager.connection;
    for(const condition of ['competing','claim'] as const){
      const title=`010 准备竞态 ${condition}`,collection=await preview(title),input=request(collection);
      const original=Admission.prototype.verifyUnstarted;let count=0,taskId:number|undefined;
      const busyId=randomUUID();
      vi.spyOn(Admission.prototype,'verifyUnstarted').mockImplementation(async function(this:InstanceType<typeof Admission>,raw){
        await original.call(this,raw);if(++count!==2)return;
        // Represents a separate supported writer committing during the awaited filesystem preflight.
        if(condition==='competing')db.prepare("INSERT INTO local_admission_web_collections(id,state,created_at,updated_at,owner_pid,owner_token) VALUES(?,'running','now','now',?,'other-owner')").run(busyId,process.pid);
        else {
          const work=Number(db.prepare('INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,?)').run(creators[1],'活动任务保护').lastInsertRowid);
          const sourceCollection=Number(db.prepare("INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at) VALUES(?,'synthetic',?,'synthetic','now')").run(creators[1],randomUUID()).lastInsertRowid);
          const source=Number(db.prepare("INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at) VALUES(?,?,'synthetic','one','synthetic','now','now')").run(work,sourceCollection).lastInsertRowid);
          taskId=Number(db.prepare("INSERT INTO archive_catalog_download_tasks(source_work_id,provider,target_root,target_relative_directory,target_filename,status,claimed_by,attempt_count) VALUES(?,'synthetic','synthetic','synthetic','exact.7z','claimed','other-worker',1)").run(source).lastInsertRowid);
        }
      });
      try{
        await expect(service.executeCollection(collection.id,input)).rejects.toThrow(condition==='competing'?'集中':'活动领取');
        expect(service.collection(collection.id).state).toBe('draft');
        for(const batch of collection.batches){expect(db.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(batch.id)!.confirmed_json).toBeNull();expect(db.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id)).toBeUndefined();}
        expect(db.prepare('SELECT * FROM local_admission_web_collection_requests WHERE request_key=?').get(input.requestKey)).toBeUndefined();
        for(const name of names)await expect(fs.stat(path.join(waiting,name,title))).resolves.toBeTruthy();
        if(taskId)expect(db.prepare('SELECT status,claimed_by,attempt_count FROM archive_catalog_download_tasks WHERE id=?').get(taskId)).toEqual({status:'claimed',claimed_by:'other-worker',attempt_count:1});
      }finally{
        vi.restoreAllMocks();if(condition==='competing')db.prepare('DELETE FROM local_admission_web_collections WHERE id=?').run(busyId);
        if(taskId)db.prepare("UPDATE archive_catalog_download_tasks SET status='staged' WHERE id=?").run(taskId);
      }
    }
  });
  it('keeps all-skip/defer children completed through partial execution and resumes without parsing or replaying them',async()=>{
    await make(0,'011 跳过');await make(0,'012 暂缓');await make(1,'013 后续中断');
    const collection=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:['011 跳过','012 暂缓']},{creatorId:creators[1],parent:names[1],directories:['013 后续中断']}]}),input=request(collection);
    input.batches[0].actions=input.batches[0].actions.map((action,i)=>({...action,action:i?'defer':'skip'})) as typeof input.batches[0]['actions'];
    const original=Admission.prototype.apply;
    vi.spyOn(Admission.prototype,'apply').mockImplementationOnce(function(this:InstanceType<typeof Admission>,raw){return original.call(this,raw,{stopAfterMove:true});});
    await service.executeCollection(collection.id,input);await service.waitForIdle();vi.restoreAllMocks();
    const before=manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(collection.batches[0].id);
    expect(before).toEqual({confirmed_json:'{"skippedAll":true}'});expect(service.collection(collection.id)).toMatchObject({state:'partial',totals:{selected:1,skipped:1,deferred:1}});
    expect(service.collection(collection.id).batches[0].state).toBe('completed');
    const apply=vi.spyOn(Admission.prototype,'apply');service.resumeCollection(collection.id,{requestKey:randomUUID(),confirmed:true});await service.waitForIdle();
    expect(apply).toHaveBeenCalledTimes(1);expect(service.collection(collection.id).state).toBe('completed');
    expect(manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(collection.batches[0].id)).toEqual(before);
    expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(collection.batches[0].id)).toBeUndefined();
    for(const name of ['011 跳过','012 暂缓'])await expect(fs.stat(path.join(waiting,names[0],name))).resolves.toBeTruthy();
  });
  it('keeps a real failed-move checkpoint, finishes later creators and resumes only unfinished immutable children',async()=>{
    const collection=await preview('004 中断恢复'),input=request(collection);const original=Admission.prototype.apply;let injected=false;
    const spy=vi.spyOn(Admission.prototype,'apply').mockImplementation(async function(this:InstanceType<typeof Admission>,raw:any,options){
      if(!injected){injected=true;return original.call(this,raw,{stopAfterMove:true});}return original.call(this,raw,options);});
    await service.executeCollection(collection.id,input);await service.waitForIdle();spy.mockRestore();
    const partial=service.collection(collection.id);expect(partial.state).toBe('partial');expect(partial.batches[0].state).toBe('needs_review');expect(partial.batches[1].state).toBe('completed');
    const db=manager.connection,plans=collection.batches.map(child=>db.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(child.id));
    const first=service.items(collection.batches[0].id).items[0],second=service.items(collection.batches[1].id).items[0];
    expect(first.state).toBe('move_intent');await expect(fs.stat(path.join(waiting,names[0],'004 中断恢复'))).rejects.toThrow();
    const calls=vi.spyOn(Admission.prototype,'apply'),retry={requestKey:randomUUID(),confirmed:true};service.resumeCollection(collection.id,retry);service.resumeCollection(collection.id,retry);await service.waitForIdle();
    expect(calls).toHaveBeenCalledTimes(1);expect(service.collection(collection.id).state).toBe('completed');
    expect(service.items(collection.batches[0].id).items[0].workId).toBe(first.workId);expect(service.items(collection.batches[1].id).items[0]).toEqual(second);
    expect(collection.batches.map(child=>db.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(child.id))).toEqual(plans);
  });
  it('blocks standalone, settings and competing collections while holding the existing cross-process admission barrier',async()=>{
    const collection=await preview('005 集中互斥'),other=await preview('006 竞争集合');await make(0,'007 单入口');const standalone=await service.preview({creatorId:creators[0],parent:names[0],directories:['007 单入口']});
    const original=Admission.prototype.apply;let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    vi.spyOn(Admission.prototype,'apply').mockImplementationOnce(async function(this:InstanceType<typeof Admission>,raw,options){entered();await wait;return original.call(this,raw,options);});
    await service.executeCollection(collection.id,request(collection));await started;
    try{
      await expect(service.executeCollection(other.id,request(other))).rejects.toThrow('集中');
      await expect(service.execute(standalone.id,{requestKey:randomUUID(),confirmed:true,acceptExistingVersion:false,actions:standalone.items.map(item=>({key:item.key,action:'new'}))})).rejects.toThrow('集中');
      await expect(service.saveSettings(waiting)).rejects.toThrow('集中');
      const {runAdmissionExclusive}=await import('../src/services/local-admission-lock.js');await expect(runAdmissionExclusive(manager.connection,async()=>undefined)).rejects.toThrow('active');
    }finally{release();await service.waitForIdle();}
    expect(service.collection(collection.id).state).toBe('completed');expect(service.collection(other.id).state).toBe('draft');
  });
  it('persists a queued collection through a real process exit; reads never replay it and explicit resume uses the saved plans',async()=>{
    const collection=await preview('008 真实进程退出'),input=request(collection),inputPath=path.join(root,'synthetic-confirmation.json');await fs.writeFile(inputPath,JSON.stringify(input));manager.close();
    const child=spawnSync(process.execPath,['--import','./node_modules/tsx/dist/loader.mjs','test/fixtures/local-admission-collection-interrupt.ts',collection.id,inputPath],
      {encoding:'utf8',env:process.env,cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,timeout:30000});
    expect(child.status,child.stderr).toBe(0);expect(JSON.parse(child.stdout).state).toBe('queued');
    service=new Service(manager.connection,gallery);expect(service.collection(collection.id).state).toBe('interrupted');
    const saved=manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_collections WHERE id=?').get(collection.id);
    const read=vi.spyOn(fs,'readdir');service.collection(collection.id);service.collections();expect(read).not.toHaveBeenCalled();read.mockRestore();
    for(const name of names)await expect(fs.stat(path.join(waiting,name,'008 真实进程退出'))).resolves.toBeTruthy();
    service.resumeCollection(collection.id,{requestKey:randomUUID(),confirmed:true});await service.waitForIdle();expect(service.collection(collection.id).state).toBe('completed');
    expect(manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_collections WHERE id=?').get(collection.id)).toEqual(saved);
  },40000);
  it('reads the saved scope without disk access and republishes only selected directories into a new immutable draft',async()=>{
    const db=manager.connection,selected=['014 保持选择','015 文件变化','016 后来改名'];
    for(const title of selected)await make(0,title);
    const {SourceEvidenceService}=await import('../src/services/source-evidence-service.js'),evidence=new SourceEvidenceService(db);
    const observation=evidence.save({creatorId:creators[0],requestId:randomUUID(),record:{platform:'synthetic',pageUrl:'https://example.test/repreview',pageTitle:'测试来源',method:'manual'}});
    evidence.confirmIdentity(observation.id,{creatorId:creators[0],requestId:randomUUID(),reason:'Synthetic ownership',expectedRevision:observation.identityRevision});
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:selected,sourceEvidenceId:observation.id}]}),batchId=original.batches[0].id;
    const snapshot=()=>({collection:db.prepare('SELECT * FROM local_admission_web_collections WHERE id=?').get(original.id),
      batches:db.prepare('SELECT b.* FROM local_admission_web_batches b JOIN local_admission_web_collection_batches c ON c.batch_id=b.id WHERE c.collection_id=? ORDER BY c.position').all(original.id),
      items:db.prepare('SELECT * FROM local_admission_web_items WHERE batch_id=? ORDER BY position').all(batchId)});
    const saved=snapshot(),oldItems=service.items(batchId).items;
    const reads=[vi.spyOn(fs,'readdir'),vi.spyOn(fs,'lstat'),vi.spyOn(fs,'stat'),vi.spyOn(fs,'readFile')];
    const scope=service.collectionScope(original.id);
    expect(scope).toEqual({scopes:[{creatorId:creators[0],parent:names[0],directories:selected,acceptExistingVersion:true,sourceEvidenceId:observation.id}]});
    for(const read of reads){expect(read).not.toHaveBeenCalled();read.mockRestore();}
    const unchanged=await service.repreviewCollection(original.id,{});
    expect(unchanged.id).not.toBe(original.id);expect(unchanged.state).toBe('draft');
    expect(service.items(unchanged.batches[0].id).items.map(item=>item.reviewFingerprint)).toEqual(oldItems.map(item=>item.reviewFingerprint));
    await fs.appendFile(path.join(waiting,names[0],selected[1],'photo.jpg'),'new metadata');
    await fs.rename(path.join(waiting,names[0],selected[2]),path.join(waiting,names[0],'016 明确新名'));
    await make(0,'017 未选择的新增目录');
    const execute=vi.spyOn(Admission.prototype,'apply'),move=vi.spyOn(fs,'rename');
    const inventory=vi.spyOn(Admission.prototype,'preview');
    const counts=()=>Object.fromEntries(['archive_local_admission_plans','archive_local_admission_items','local_admission_web_requests','local_admission_web_collection_requests','archive_catalog_works','archive_catalog_local_works']
      .map(table=>[table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n]));
    const beforeCounts=counts(),fresh=await service.repreviewCollection(original.id,{}),freshItems=service.items(fresh.batches[0].id).items;
    expect(fresh.id).not.toBe(original.id);expect(fresh.batches[0].id).not.toBe(batchId);expect(fresh.state).toBe('draft');
    expect(freshItems.map(item=>item.sourceRelativePath)).toEqual(selected);
    expect(inventory.mock.calls.map(([input])=>input.directories)).toEqual(selected.map(title=>[title]));
    expect(freshItems[0].reviewFingerprint).toBe(oldItems[0].reviewFingerprint);
    expect(freshItems[1].reviewFingerprint).not.toBe(oldItems[1].reviewFingerprint);
    expect(freshItems[1].summary.bytes).toBeGreaterThan(oldItems[1].summary.bytes);
    expect(freshItems[2].conflicts.length).toBeGreaterThan(0);expect(freshItems[2].reviewFingerprint).toBeUndefined();
    expect(freshItems.every(item=>item.action==='defer')).toBe(true);
    const replacement={...scope.scopes[0],directories:[selected[0],'016 明确新名','017 未选择的新增目录']};
    const adjusted=await service.repreviewCollection(original.id,{scopes:[replacement]});
    expect(service.collectionScope(adjusted.id)).toEqual({scopes:[replacement]});
    expect(service.items(adjusted.batches[0].id).items.every(item=>!item.conflicts.length)).toBe(true);
    expect(snapshot()).toEqual(saved);expect(counts()).toEqual(beforeCounts);expect(execute).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
    expect(db.prepare('SELECT confirmed_json FROM local_admission_web_collections WHERE id=?').get(fresh.id)?.confirmed_json).toBeNull();
    expect(db.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(fresh.batches[0].id)?.confirmed_json).toBeNull();
    await expect(fs.stat(path.join(waiting,names[0],selected[0]))).resolves.toBeTruthy();
  });
  it('fingerprints arbitrary searched Works and their source/task facts even when they are not item candidates',async()=>{
    const db=manager.connection,title='018 文件稳定身份变化';await make(0,title);
    const workId=Number(db.prepare('INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,?)').run(creators[0],'完全不同的既有作品').lastInsertRowid);
    const sourceCollection=Number(db.prepare("INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at) VALUES(?,'synthetic',?,'fingerprint','now')").run(creators[0],randomUUID()).lastInsertRowid);
    const sourceId=Number(db.prepare("INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at) VALUES(?,?,'synthetic','unrelated','完全不同的来源','now','now')").run(workId,sourceCollection).lastInsertRowid);
    const taskId=Number(db.prepare("INSERT INTO archive_catalog_download_tasks(source_work_id,provider,target_root,target_relative_directory,target_filename,status) VALUES(?,'synthetic','synthetic','synthetic','synthetic.7z','staged')").run(sourceId).lastInsertRowid);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:[title]}]});
    const originalItem=service.items(original.batches[0].id).items[0];expect(originalItem.candidates).toEqual([]);expect(originalItem.reviewFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const fingerprint=async()=>{const next=await service.repreviewCollection(original.id,{});return service.items(next.batches[0].id).items[0].reviewFingerprint;};
    expect(await fingerprint()).toBe(originalItem.reviewFingerprint);
    db.prepare('UPDATE archive_catalog_works SET display_title=? WHERE id=?').run('完全不同的更正标题',workId);
    const workChanged=await fingerprint();expect(workChanged).not.toBe(originalItem.reviewFingerprint);
    db.prepare('UPDATE archive_catalog_source_works SET source_title=? WHERE id=?').run('完全不同的更正来源',sourceId);
    const sourceChanged=await fingerprint();expect(sourceChanged).not.toBe(workChanged);
    db.prepare('UPDATE archive_catalog_download_tasks SET attempt_count=attempt_count+1 WHERE id=?').run(taskId);
    expect(await fingerprint()).not.toBe(sourceChanged);
    expect(service.items(original.batches[0].id).items[0]).toEqual(originalItem);
  });
  it('rejects confirmed, pending or owned collections and children before checking files',async()=>{
    const original=await preview('019 不可变确认保护'),db=manager.connection,scan=vi.spyOn(Admission.prototype,'preview');
    const before=Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n);
    for(const state of ['queued','running','partial','completed']){
      db.prepare('UPDATE local_admission_web_collections SET state=? WHERE id=?').run(state,original.id);
      await expect(service.repreviewCollection(original.id,{})).rejects.toThrow('不能重新预览');
    }
    db.prepare("UPDATE local_admission_web_collections SET state='draft',confirmed_json='{}' WHERE id=?").run(original.id);
    await expect(service.repreviewCollection(original.id,{})).rejects.toThrow('不能重新预览');
    db.prepare('UPDATE local_admission_web_collections SET confirmed_json=NULL,owner_pid=?,owner_token=? WHERE id=?').run(process.pid,'pending-owner',original.id);
    await expect(service.repreviewCollection(original.id,{})).rejects.toThrow('不能重新预览');
    db.prepare('UPDATE local_admission_web_collections SET owner_pid=NULL,owner_token=NULL WHERE id=?').run(original.id);
    for(const state of ['queued','running','completed','failed','needs_review']){
      db.prepare('UPDATE local_admission_web_batches SET state=? WHERE id=?').run(state,original.batches[0].id);
      await expect(service.repreviewCollection(original.id,{})).rejects.toThrow('子批次');
    }
    db.prepare("UPDATE local_admission_web_batches SET state='draft' WHERE id=?").run(original.batches[0].id);
    db.prepare("UPDATE local_admission_web_batches SET confirmed_json='{}' WHERE id=?").run(original.batches[0].id);
    await expect(service.repreviewCollection(original.id,{})).rejects.toThrow('子批次');
    db.prepare('UPDATE local_admission_web_batches SET confirmed_json=NULL WHERE id=?').run(original.batches[0].id);
    expect(scan).not.toHaveBeenCalled();expect(Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(before);
  });
  it('does not publish a replacement if another request confirms during asynchronous rechecking',async()=>{
    const original=await preview('020 重检期间确认'),db=manager.connection;
    const requestBody=request(original);requestBody.batches=requestBody.batches.map(batch=>({...batch,actions:batch.actions.map(action=>({...action,action:'defer' as const}))})) as typeof requestBody.batches;
    const before=Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n),scan=Admission.prototype.preview;
    let confirmed=false;
    vi.spyOn(Admission.prototype,'preview').mockImplementation(async function(this:InstanceType<typeof Admission>,input){
      const result=await scan.call(this,input);
      if(!confirmed){confirmed=true;await service.executeCollection(original.id,requestBody);}
      return result;
    });
    const move=vi.spyOn(fs,'rename'),apply=vi.spyOn(Admission.prototype,'apply');
    await expect(service.repreviewCollection(original.id,{})).rejects.toThrow('不能重新预览');
    await service.waitForIdle();
    expect(service.collection(original.id).state).toBe('completed');
    expect(Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(before);
    expect(JSON.parse(String(db.prepare('SELECT confirmed_json FROM local_admission_web_collections WHERE id=?').get(original.id)!.confirmed_json))).toMatchObject(requestBody);
    expect(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collection_requests WHERE collection_id=?').get(original.id)!.n).toBe(1);
    expect(apply).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
    for(const name of names)await expect(fs.stat(path.join(waiting,name,'020 重检期间确认'))).resolves.toBeTruthy();
  });
  it('serves saved scope by GET and accepts explicit POST repreview without enabling GET mutations',async()=>{
    const original=await preview('021 重检接口'),{createApp}=await import('../src/app.js'),app=createApp();
    const base=`/api/admin/local-admission/collections/${original.id}`,scan=vi.spyOn(Admission.prototype,'preview');
    const scope=await requestTestApp(app,'GET',`${base}/scope`);expect(scope.status).toBe(200);expect(scope.body).toEqual(service.collectionScope(original.id));expect(scan).not.toHaveBeenCalled();
    const before=Number(manager.connection.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n);
    expect((await requestTestApp(app,'GET',`${base}/repreview`)).status).not.toBe(201);
    expect((await requestTestApp(app,'POST',`${base}/repreview`,{},{})).status).toBe(403);
    expect(scan).not.toHaveBeenCalled();expect(Number(manager.connection.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(before);
    const result=await requestTestApp(app,'POST',`${base}/repreview`,{'x-foldergram-intent':'1'},{});
    expect(result.status).toBe(201);expect(result.body.state).toBe('draft');expect(result.body.id).not.toBe(original.id);
    expect(service.collectionScope(result.body.id)).toEqual(scope.body);
    expect((await requestTestApp(app,'POST',`${base}/repreview`,{'x-foldergram-intent':'1'},{scopes:[]})).status).toBe(400);
    expect((await requestTestApp(app,'POST',`${base}/repreview`,{'x-foldergram-intent':'1'},{scopes:[{creatorId:creators[0],parent:'..',directories:['bad']}]})).status).toBe(400);
  });
  it('keeps workspace, identity search and collection mutations behind management auth and explicit write intent',async()=>{
    const original=await preview('022 重检权限'),{createApp}=await import('../src/app.js');const app=createApp();
    const denied=await requestTestApp(app,'POST','/api/admin/local-admission/collections/previews',{},{});expect(denied.status).toBe(403);
    const {authService}=await import('../src/services/auth-service.js');authService.setAdminPassword('synthetic-admin-pass');authService.setViewerAccess('password','synthetic-viewer-pass');
    const login=await requestTestApp(app,'POST','/api/auth/login',{'x-foldergram-intent':'1'},{password:'synthetic-viewer-pass'});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    for(const route of ['workspace',`creators?q=${encodeURIComponent('甲')}`,'collections',`collections/${original.id}/scope`]){
      expect((await requestTestApp(app,'GET',`/api/admin/local-admission/${route}`)).status).toBe(401);
      expect((await requestTestApp(app,'GET',`/api/admin/local-admission/${route}`,{cookie})).status).toBe(403);
    }
    const route=`/api/admin/local-admission/collections/${original.id}/repreview`;
    expect((await requestTestApp(app,'POST',route,{'x-foldergram-intent':'1'},{})).status).toBe(401);
    expect((await requestTestApp(app,'POST',route,{'x-foldergram-intent':'1',cookie},{})).status).toBe(403);
  });
  it('persists explicit web recycle policy, reports recycle failure as partial, and resumes the same indexed item',async()=>{
    const dir=await make(0,'023 网页广告回收');await fs.writeFile(path.join(dir,'图集网站永久发布页.txt'),'synthetic advertisement');
    const next=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:['023 网页广告回收']}]});
    const child=next.batches[0],item=service.items(child.id).items[0];
    const {RecycleBinAdapter}=await import('../src/services/recycle-bin-adapter.js');
    const recycle=vi.spyOn(RecycleBinAdapter.prototype,'recycle').mockRejectedValueOnce(new Error('Synthetic recycle temporarily unavailable'));
    const input={requestKey:randomUUID(),confirmed:true as const,batches:[{batchId:child.id,acceptExistingVersion:true,advertisementDisposition:'recycle_bin' as const,adsConfirmed:true as const,actions:[{key:item.key,action:'new' as const,approvedAds:['图集网站永久发布页.txt']}]}]};
    await service.executeCollection(next.id,input);await service.waitForIdle();
    expect(service.collection(next.id)).toMatchObject({state:'partial',totals:{completed:0,selected:1}});
    expect(service.items(child.id).items[0]).toMatchObject({state:'indexed',lastError:'Synthetic recycle temporarily unavailable'});
    const saved=String(manager.connection.prepare('SELECT payload_json FROM archive_local_admission_plans WHERE plan_id=?').get(child.id)!.payload_json);
    expect(JSON.parse(saved).advertisementDisposition).toBe('recycle_bin');
    const trash=path.join(root,'synthetic-recycle-bin');await fs.mkdir(trash,{recursive:true});
    recycle.mockImplementation(async targetPath=>{await fs.rename(targetPath,path.join(trash,randomUUID()+'.txt'));return {targetPath,recycled:true};});
    const identities=manager.connection.prepare('SELECT work_id,local_work_id FROM archive_local_admission_items WHERE plan_id=?').get(child.id);
    service.resumeCollection(next.id,{requestKey:randomUUID(),confirmed:true});await service.waitForIdle();
    expect(service.collection(next.id)).toMatchObject({state:'completed',totals:{completed:1}});
    expect(manager.connection.prepare('SELECT work_id,local_work_id FROM archive_local_admission_items WHERE plan_id=?').get(child.id)).toEqual(identities);
    expect(manager.connection.prepare('SELECT payload_json FROM archive_local_admission_plans WHERE plan_id=?').get(child.id)!.payload_json).toBe(saved);
    expect(await fs.readdir(trash)).toHaveLength(1);expect(recycle).toHaveBeenCalledTimes(2);
  });
});
