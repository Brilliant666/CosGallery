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
  async function makeWithin(parent:string,title:string){const dir=path.join(waiting,parent,title);await fs.mkdir(dir,{recursive:true});
    await sharp({create:{width:14,height:20,channels:3,background:'#ccbbaa'}}).jpeg().toFile(path.join(dir,'photo.jpg'));return dir;}
  async function preview(prefix:string){for(let n=0;n<2;n++)await make(n,prefix);
    return service.previewCollection({scopes:creators.map((creatorId,n)=>({creatorId,parent:names[n],directories:[prefix]}))});}
  function request(collection:ReturnType<typeof service.collection>){return {requestKey:randomUUID(),confirmed:true as const,
    batches:collection.batches.map(batch=>({batchId:batch.id,acceptExistingVersion:true,actions:service.items(batch.id).items.map(item=>({key:item.key,action:'new' as const}))}))};}
  it('discovers only one directory layer and matches active canonical identities or registered aliases without creating anyone',async()=>{
    const db=manager.connection;
    db.prepare("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(?,?,?,'manual')").run(creators[0],'甲的别名','甲的别名');
    db.prepare("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(?,?,?,'another-source')").run(creators[0],'甲的别名','甲的别名');
    await fs.mkdir(path.join(waiting,'甲的别名','待核对作品'),{recursive:true});await fs.mkdir(path.join(waiting,'未知名称','待核对作品'),{recursive:true});await fs.mkdir(path.join(waiting,'.local-admission-attachments'));
    for(const name of names)await fs.mkdir(path.join(waiting,name,'身份发现样本'),{recursive:true});
    const before=db.prepare('SELECT * FROM archive_catalog_creators ORDER BY id').all(),spy=vi.spyOn(fs,'readdir');
    const workspace=await service.workspace();expect(spy.mock.calls.every(call=>call[0]===waiting||path.dirname(String(call[0]))===waiting)).toBe(true);spy.mockRestore();
    expect(workspace.items.find(item=>item.name==='甲的别名')?.matches).toEqual([{creatorId:creators[0],creatorName:names[0],matchedName:'甲的别名',matchKind:'alias'}]);
    expect(workspace.items.find(item=>item.name==='未知名称')?.matches).toEqual([]);expect(workspace.items.some(item=>item.name.startsWith('.local-'))).toBe(false);
    expect(workspace.items.find(item=>item.name===names[0])?.matches).toEqual([{creatorId:creators[0],creatorName:names[0],matchedName:names[0],matchKind:'canonical'}]);
    expect(service.creators('甲的别名').items).toMatchObject([{id:creators[0],name:names[0],aliases:expect.arrayContaining(['甲的别名',names[0]])}]);
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=?').run(creators[1]);
    expect((await service.workspace()).items.find(item=>item.name===names[1])?.matches).toEqual([]);expect(service.creators(names[1]).items).toEqual([]);
    db.prepare('UPDATE archive_catalog_creators SET is_active=1 WHERE id=?').run(creators[1]);expect(db.prepare('SELECT * FROM archive_catalog_creators ORDER BY id').all()).toEqual(before);
  });
  it('omits parents containing only real internal residual directories without traversing or deleting their files',async()=>{
    const residualNames=['已完成仅附件','已完成仅审核隔离'];
    const directories=[['.local-admission-attachments'],['.local-review-originals','.local-review-staging']];
    const files:string[]=[];
    for(let n=0;n<residualNames.length;n++)for(const directory of directories[n]){
      const container=path.join(waiting,residualNames[n],directory);await fs.mkdir(container,{recursive:true});
      const file=path.join(container,'retained.txt');await fs.writeFile(file,'retained historical attachment');files.push(file);
    }
    const read=vi.spyOn(fs,'readdir'),remove=vi.spyOn(fs,'rm'),unlink=vi.spyOn(fs,'unlink'),move=vi.spyOn(fs,'rename');
    const workspace=await service.workspace();
    expect(workspace.items.filter(item=>residualNames.includes(item.name))).toEqual([]);
    expect(read.mock.calls.every(call=>call[0]===waiting||path.dirname(String(call[0]))===waiting)).toBe(true);
    expect(remove).not.toHaveBeenCalled();expect(unlink).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
    for(const file of files)expect(await fs.readFile(file,'utf8')).toBe('retained historical attachment');
  });
  it('hides empty parents but keeps ordinary content and reserved-name symbolic links visible for manual handling',async()=>{
    const cases=['附件加作品','附件加普通文件','系统名字普通文件','系统名字链接','空博主父目录'];
    for(const name of cases)await fs.mkdir(path.join(waiting,name),{recursive:true});
    await fs.mkdir(path.join(waiting,cases[0],'.local-admission-attachments'));await fs.mkdir(path.join(waiting,cases[0],'仍需处理作品'));
    await fs.mkdir(path.join(waiting,cases[1],'.local-review-originals'));await fs.writeFile(path.join(waiting,cases[1],'notes.txt'),'manual content');
    await fs.writeFile(path.join(waiting,cases[2],'.local-admission-attachments'),'not a system directory');
    const linkTarget=path.join(root,'outside-waiting-link-target');await fs.mkdir(linkTarget);
    await fs.writeFile(path.join(linkTarget,'important.txt'),'do not follow');
    await fs.symlink(linkTarget,path.join(waiting,cases[3],'.local-admission-attachments'),process.platform==='win32'?'junction':'dir');
    const read=vi.spyOn(fs,'readdir'),workspace=await service.workspace();
    expect(workspace.items.filter(item=>cases.includes(item.name)).map(item=>item.name).sort()).toEqual(cases.slice(0,4).sort());
    expect(await fs.readdir(path.join(waiting,cases[4]))).toEqual([]);
    expect(read.mock.calls.some(call=>String(call[0]).startsWith(linkTarget))).toBe(false);
    expect((await fs.lstat(path.join(waiting,cases[3],'.local-admission-attachments'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(linkTarget,'important.txt'),'utf8')).toBe('do not follow');
  });
  it('keeps an unreadable parent visible and nonselectable instead of assuming it only contains residuals',async()=>{
    const name='无法读取需人工核对',parent=path.join(waiting,name);await fs.mkdir(parent);
    const readdir=fs.readdir;
    vi.spyOn(fs,'readdir').mockImplementation((async (...args:Parameters<typeof fs.readdir>)=>{
      if(String(args[0])===parent)throw Object.assign(new Error('Cannot inspect waiting parent'),{code:'EACCES'});
      return readdir(...args);
    }) as typeof fs.readdir);
    expect((await service.workspace()).items.find(item=>item.name===name)).toMatchObject({name,selectable:false,reason:'Cannot inspect waiting parent'});
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
    expect(service.items(collection.batches[0].id).items).toMatchObject([
      {state:'skip',executionState:null,nextAction:'none'}, {state:'defer',executionState:null,nextAction:'none'}]);
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
    expect(original).toMatchObject({previousCollectionId:null,nextCollectionIds:[]});
    expect(unchanged).toMatchObject({previousCollectionId:original.id,nextCollectionIds:[]});
    expect(service.collection(original.id).nextCollectionIds).toEqual([unchanged.id]);
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
    expect(service.collection(original.id).nextCollectionIds.sort()).toEqual([unchanged.id,fresh.id,adjusted.id].sort());
    expect(service.collections().items.find(item=>item.id===adjusted.id)?.previousCollectionId).toBe(original.id);
    expect(service.collectionScope(adjusted.id)).toEqual({scopes:[replacement]});
    expect(service.items(adjusted.batches[0].id).items.every(item=>!item.conflicts.length)).toBe(true);
    expect(snapshot()).toEqual(saved);expect(counts()).toEqual(beforeCounts);expect(execute).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
    expect(db.prepare('SELECT confirmed_json FROM local_admission_web_collections WHERE id=?').get(fresh.id)?.confirmed_json).toBeNull();
    expect(db.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(fresh.batches[0].id)?.confirmed_json).toBeNull();
    await expect(fs.stat(path.join(waiting,names[0],selected[0]))).resolves.toBeTruthy();
  });
  it('refreshes selected creator parents after a split without expanding originally unselected siblings or executing anything',async()=>{
    const db=manager.connection,parents=['刷新范围甲','刷新范围乙'],selected=['原保留作品','内部更新作品','待拆分合集'],unselected='原有但未选择';
    for(const title of [...selected,unselected])await makeWithin(parents[0],title);await makeWithin(parents[1],'另一博主原作品');
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:parents[0],directories:selected},{creatorId:creators[1],parent:parents[1],directories:['另一博主原作品']}]}),batchId=original.batches[0].id;
    const oldItems=service.items(batchId).items,context=JSON.parse(String(db.prepare('SELECT context_json FROM local_admission_web_batches WHERE id=?').get(batchId)!.context_json));
    expect(context.knownSiblingDirectories).toEqual(expect.arrayContaining([...selected,unselected]));
    const before=()=>({collection:db.prepare('SELECT * FROM local_admission_web_collections WHERE id=?').get(original.id),
      batches:original.batches.map(batch=>db.prepare('SELECT * FROM local_admission_web_batches WHERE id=?').get(batch.id)),
      items:original.batches.map(batch=>db.prepare('SELECT * FROM local_admission_web_items WHERE batch_id=? ORDER BY position').all(batch.id))});
    const saved=before();
    await fs.rename(path.join(waiting,parents[0],selected[2]),path.join(root,'已拆出原合集'));
    const added=['拆分后第一套','拆分后第二套'];for(const title of added)await makeWithin(parents[0],title);
    await fs.appendFile(path.join(waiting,parents[0],selected[1],'photo.jpg'),'synthetic changed metadata');
    await makeWithin(parents[0],'.local-admission-attachments');await makeWithin(parents[0],'.local-review-originals');
    await fs.writeFile(path.join(waiting,parents[0],'普通说明.txt'),'not a work directory');
    const outside=path.join(root,'不可跟随的链接目标');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'private.txt'),'leave untouched');
    await fs.symlink(outside,path.join(waiting,parents[0],'新符号链接'),process.platform==='win32'?'junction':'dir');
    await makeWithin('未选择的博主父目录','新作品不能引入');
    const counts=()=>Object.fromEntries(['archive_local_admission_plans','archive_local_admission_items','local_admission_web_requests','local_admission_web_collection_requests','archive_catalog_works','archive_catalog_local_works']
      .map(table=>[table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n]));
    const savedCounts=counts(),execute=vi.spyOn(Admission.prototype,'apply'),move=vi.spyOn(fs,'rename'),inventory=vi.spyOn(Admission.prototype,'preview');
    const refreshed=await service.repreviewCollection(original.id,{refreshDirectories:true});
    expect(refreshed).toMatchObject({state:'draft',previousCollectionId:original.id});
    expect(refreshed.directoryRefresh.added).toHaveLength(2);
    expect(refreshed.directoryRefresh.added).toEqual(expect.arrayContaining(added.map(name=>({creatorId:creators[0],parent:parents[0],name}))));
    expect(refreshed.directoryRefresh.removed).toEqual([{creatorId:creators[0],parent:parents[0],name:selected[2]}]);
    const scopes=service.collectionScope(refreshed.id).scopes;
    expect(scopes.map(scope=>scope.parent)).toEqual(parents);expect(scopes[0].directories.slice().sort()).toEqual([selected[0],selected[1],...added].sort());
    expect(scopes[1].directories).toEqual(['另一博主原作品']);
    expect(inventory.mock.calls.flatMap(([scope])=>scope.directories)).not.toContain(unselected);
    expect(inventory.mock.calls.flatMap(([scope])=>scope.directories)).not.toContain('新符号链接');
    const newItems=service.items(refreshed.batches[0].id).items,byName=(items:typeof oldItems,name:string)=>items.find(item=>item.sourceRelativePath===name)!;
    expect(byName(newItems,selected[0]).reviewFingerprint).toBe(byName(oldItems,selected[0]).reviewFingerprint);
    expect(byName(newItems,selected[1]).reviewFingerprint).not.toBe(byName(oldItems,selected[1]).reviewFingerprint);
    expect(byName(newItems,selected[1]).summary.bytes).toBeGreaterThan(byName(oldItems,selected[1]).summary.bytes);
    expect(newItems.every(item=>item.action==='defer')).toBe(true);
    expect(before()).toEqual(saved);expect(counts()).toEqual(savedCounts);expect(execute).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(outside,'private.txt'),'utf8')).toBe('leave untouched');
    for(const batch of refreshed.batches)expect(db.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(batch.id)!.confirmed_json).toBeNull();
  });
  it('keeps newly discovered legacy-draft directories explicitly deferred when no sibling baseline was saved',async()=>{
    const db=manager.connection,parent='旧草稿无兄弟基线',selected='旧选择',unselected='原有未选但旧草稿未记录';
    await makeWithin(parent,selected);await makeWithin(parent,unselected);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent,directories:[selected]}]}),batchId=original.batches[0].id;
    const context=JSON.parse(String(db.prepare('SELECT context_json FROM local_admission_web_batches WHERE id=?').get(batchId)!.context_json));
    delete context.knownSiblingDirectories;db.prepare('UPDATE local_admission_web_batches SET context_json=? WHERE id=?').run(JSON.stringify(context),batchId);
    const originalState=db.prepare('SELECT * FROM local_admission_web_batches WHERE id=?').get(batchId),added='后来新目录';await makeWithin(parent,added);
    const execute=vi.spyOn(Admission.prototype,'apply'),refreshed=await service.repreviewCollection(original.id,{refreshDirectories:true});
    expect(refreshed.directoryRefresh.warnings.length).toBeGreaterThan(0);
    expect(refreshed.directoryRefresh.added).toEqual(expect.arrayContaining([unselected,added].map(name=>({creatorId:creators[0],parent,name}))));
    const items=service.items(refreshed.batches[0].id).items;
    for(const name of [unselected,added])expect(items.find(item=>item.sourceRelativePath===name)?.suggestedAction).toMatchObject({action:'defer'});
    expect(items.every(item=>item.action==='defer')).toBe(true);expect(execute).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM local_admission_web_batches WHERE id=?').get(batchId)).toEqual(originalState);
  });
  it('does not replace the original draft when rereading leaves no eligible selected directories',async()=>{
    const db=manager.connection,parent='刷新后无可选目录',title='已移出作品';await makeWithin(parent,title);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent,directories:[title]}]});
    await fs.rename(path.join(waiting,parent,title),path.join(root,'刷新移出的作品'));await makeWithin(parent,'.local-admission-attachments');
    const count=Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n),saved=db.prepare('SELECT * FROM local_admission_web_collections WHERE id=?').get(original.id);
    const apply=vi.spyOn(Admission.prototype,'apply'),move=vi.spyOn(fs,'rename');
    await expect(service.repreviewCollection(original.id,{refreshDirectories:true})).rejects.toThrow(/目录|范围/);
    expect(db.prepare('SELECT * FROM local_admission_web_collections WHERE id=?').get(original.id)).toEqual(saved);
    expect(service.collection(original.id).nextCollectionIds).toEqual([]);expect(Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(count);
    expect(apply).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
  });
  it('rejects refreshed-directory requests for confirmed or active collections before touching the filesystem',async()=>{
    const db=manager.connection,parent='刷新确认保护',title='保持原记录';await makeWithin(parent,title);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent,directories:[title]}]});
    const read=vi.spyOn(fs,'readdir'),scan=vi.spyOn(Admission.prototype,'preview'),count=Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n);
    db.prepare("UPDATE local_admission_web_collections SET confirmed_json='{}' WHERE id=?").run(original.id);
    await expect(service.repreviewCollection(original.id,{refreshDirectories:true})).rejects.toThrow('不能重新预览');
    db.prepare('UPDATE local_admission_web_collections SET confirmed_json=NULL,owner_pid=?,owner_token=? WHERE id=?').run(process.pid,'synthetic-refresh-owner',original.id);
    await expect(service.repreviewCollection(original.id,{refreshDirectories:true})).rejects.toThrow('不能重新预览');
    db.prepare('UPDATE local_admission_web_collections SET owner_pid=NULL,owner_token=NULL WHERE id=?').run(original.id);
    db.prepare('UPDATE local_admission_web_batches SET owner_pid=?,owner_token=? WHERE id=?').run(process.pid,'synthetic-child-owner',original.batches[0].id);
    try{await expect(service.repreviewCollection(original.id,{refreshDirectories:true})).rejects.toThrow(/子批次|执行/);}
    finally{db.prepare('UPDATE local_admission_web_batches SET owner_pid=NULL,owner_token=NULL WHERE id=?').run(original.batches[0].id);}
    expect(read).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();expect(Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(count);
  });
  it('does not automatically select newly discovered directories already claimed or skipped by another confirmed plan',async()=>{
    const db=manager.connection,parent='刷新范围其他计划占用',originalTitle='原范围作品';await makeWithin(parent,originalTitle);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent,directories:[originalTitle]}]});
    const reservedNames=['其他入口已确认','其他入口明确跳过'];
    for(const [index,title] of reservedNames.entries()){
      await makeWithin(parent,title);const other=await service.preview({creatorId:creators[0],parent,directories:[title]});
      if(index===0)vi.spyOn(Admission.prototype,'apply').mockRejectedValueOnce(new Error('Synthetic stop before archive plan registration'));
      await service.execute(other.id,{requestKey:randomUUID(),confirmed:true,acceptExistingVersion:true,actions:other.items.map(item=>({key:item.key,action:index?'skip':'new'}))});
      await service.waitForIdle();vi.restoreAllMocks();
      expect(db.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(other.id)!.confirmed_json).not.toBeNull();
      expect(db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=?').get(other.id)).toBeUndefined();
    }
    const free='新发现且未占用';await makeWithin(parent,free);
    const plans=db.prepare('SELECT * FROM archive_local_admission_plans ORDER BY plan_id').all(),apply=vi.spyOn(Admission.prototype,'apply');
    const refreshed=await service.repreviewCollection(original.id,{refreshDirectories:true});
    expect(service.collectionScope(refreshed.id).scopes[0].directories).toEqual([originalTitle,free]);
    expect(refreshed.directoryRefresh.added).toEqual([{creatorId:creators[0],parent,name:free}]);
    expect(refreshed.directoryRefresh.warnings.join(' ')).toMatch(/占用|跳过|确认计划/);
    expect(db.prepare('SELECT * FROM archive_local_admission_plans ORDER BY plan_id').all()).toEqual(plans);expect(apply).not.toHaveBeenCalled();
    for(const title of reservedNames)await expect(fs.stat(path.join(waiting,parent,title))).resolves.toBeTruthy();
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
    expect(service.collection(original.id).nextCollectionIds).toEqual([]);
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
    const added='021 HTTP目录刷新新增';await make(0,added);
    const refreshed=await requestTestApp(app,'POST',`${base}/repreview`,{'x-foldergram-intent':'1'},{refreshDirectories:true});
    expect(refreshed.status).toBe(201);expect(refreshed.body.directoryRefresh.added).toEqual([{creatorId:creators[0],parent:names[0],name:added}]);
    expect((await requestTestApp(app,'POST',`${base}/repreview`,{'x-foldergram-intent':'1'},{scopes:[]})).status).toBe(400);
    expect((await requestTestApp(app,'POST',`${base}/repreview`,{'x-foldergram-intent':'1'},{scopes:[{creatorId:creators[0],parent:'..',directories:['bad']}]})).status).toBe(400);
  });
  it('continues only unstarted deferred items in a linked draft while preserving completed identities and immutable receipts',async()=>{
    const db=manager.connection,titles=['024 已完成作品','025 暂缓作品','026 明确跳过'],second='027 另一博主暂缓';
    for(const title of titles)await make(0,title);await make(1,second);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:titles},{creatorId:creators[1],parent:names[1],directories:[second]}]}),input=request(original);
    expect(original.remainingCount).toBe(0);
    await expect(service.remainingCollection(original.id)).rejects.toThrow('未确认');
    input.batches[0].actions=input.batches[0].actions.map((item,index)=>({...item,action:['new','defer','skip'][index],...(index===1?{reason:'等待用户确定拆分边界'}:{})})) as typeof input.batches[0]['actions'];
    input.batches[1].actions=input.batches[1].actions.map(item=>({...item,action:'defer'})) as typeof input.batches[1]['actions'];
    await service.executeCollection(original.id,input);await service.waitForIdle();
    expect(service.collection(original.id)).toMatchObject({state:'completed',remainingCount:2,totals:{completed:1,deferred:2,skipped:1}});
    const snapshot=()=>({collection:db.prepare('SELECT * FROM local_admission_web_collections WHERE id=?').get(original.id),
      batches:original.batches.map(batch=>db.prepare('SELECT * FROM local_admission_web_batches WHERE id=?').get(batch.id)),
      items:original.batches.map(batch=>db.prepare('SELECT * FROM local_admission_web_items WHERE batch_id=? ORDER BY position').all(batch.id)),
      plans:original.batches.map(batch=>db.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(batch.id)),
      checkpoints:original.batches.map(batch=>db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? ORDER BY item_key').all(batch.id)),
      receipts:db.prepare('SELECT * FROM local_admission_web_collection_requests WHERE collection_id=? ORDER BY request_key').all(original.id)});
    const before=snapshot(),apply=vi.spyOn(Admission.prototype,'apply'),move=vi.spyOn(fs,'rename');
    const [next,concurrent]=await Promise.all([service.remainingCollection(original.id),service.remainingCollection(original.id)]);
    expect(concurrent.id).toBe(next.id);
    expect(next).toMatchObject({state:'draft',remainingCount:0,previousCollectionId:original.id,totals:{creators:2,total:2}});
    expect(service.collectionScope(next.id).scopes.map(scope=>scope.directories)).toEqual([[titles[1]],[second]]);
    expect(service.items(next.batches[0].id).items[0].suggestedAction).toMatchObject({action:'defer',reason:'等待用户确定拆分边界'});
    expect(next.batches.flatMap(batch=>service.items(batch.id).items).every(item=>item.action==='defer'&&item.executionState===null)).toBe(true);
    expect(db.prepare('SELECT confirmed_json FROM local_admission_web_collections WHERE id=?').get(next.id)?.confirmed_json).toBeNull();
    for(const batch of next.batches)expect(db.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(batch.id)?.confirmed_json).toBeNull();
    expect(snapshot()).toEqual(before);expect(apply).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
    const count=Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n);
    service=new Service(db,gallery);
    expect((await service.remainingCollection(original.id)).id).toBe(next.id);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(count);
    expect(service.collection(original.id).remainingCount).toBe(2);
    expect(snapshot()).toEqual(before);
    const adjusted=await service.repreviewCollection(next.id,{});
    expect(adjusted.previousCollectionId).toBe(next.id);
    expect((await service.remainingCollection(original.id)).id).toBe(adjusted.id);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(count+1);
    expect(snapshot()).toEqual(before);
  });
  it('never reintroduces an item with any original execution checkpoint even if its web action says defer',async()=>{
    const db=manager.connection,states=['planned','move_intent','files_verified','indexed','completed'];
    const titles=['028 真实已完成',...states.map(state=>`028 状态 ${state}`),'028 真正未开始'];
    for(const title of titles)await make(0,title);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:titles}]}),input=request(original);
    input.batches[0].actions=input.batches[0].actions.map((item,index)=>({...item,action:index?'defer':'new'})) as typeof input.batches[0]['actions'];
    await service.executeCollection(original.id,input);await service.waitForIdle();
    const batchId=original.batches[0].id,items=service.items(batchId).items;
    for(const [index,state] of states.entries())db.prepare('INSERT INTO archive_local_admission_items(plan_id,item_key,state,manifest_json) VALUES(?,?,?,?)').run(batchId,items[index+1].key,state,'[]');
    const old=db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? ORDER BY item_key').all(batchId);
    expect(service.collection(original.id).remainingCount).toBe(1);
    const next=await service.remainingCollection(original.id);
    expect(service.collectionScope(next.id).scopes[0].directories).toEqual([titles.at(-1)]);
    expect(db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? ORDER BY item_key').all(batchId)).toEqual(old);
  });
  it('rejects continuing deferred items while their collection or child has a live owner',async()=>{
    const db=manager.connection,original=await preview('029 活动拥有者'),input=request(original);
    input.batches=input.batches.map(batch=>({...batch,actions:batch.actions.map(item=>({...item,action:'defer'}))})) as typeof input.batches;
    await service.executeCollection(original.id,input);await service.waitForIdle();
    const count=Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n),scan=vi.spyOn(Admission.prototype,'preview');
    for(const [table,id] of [['local_admission_web_collections',original.id],['local_admission_web_batches',original.batches[0].id]]){
      db.prepare(`UPDATE ${table} SET state='running',owner_pid=?,owner_token='active-synthetic-owner' WHERE id=?`).run(process.pid,id);
      try{await expect(service.remainingCollection(original.id)).rejects.toThrow(/执行|拥有|owner|活动/);}
      finally{db.prepare(`UPDATE ${table} SET state='completed',owner_pid=NULL,owner_token=NULL WHERE id=?`).run(id);}
    }
    expect(scan).not.toHaveBeenCalled();expect(Number(db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(count);
  });
  it('keeps the exact missing deferred name as a review conflict instead of silently admitting renamed or newly added directories',async()=>{
    const db=manager.connection,title='030 原暂缓目录';await make(0,title);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:[title]}]}),input=request(original);
    input.batches[0].actions=input.batches[0].actions.map(item=>({...item,action:'defer'})) as typeof input.batches[0]['actions'];
    await service.executeCollection(original.id,input);await service.waitForIdle();
    await fs.rename(path.join(waiting,names[0],title),path.join(waiting,names[0],'030 用户改名后的目录'));await make(0,'030 后来新增目录');
    const apply=vi.spyOn(Admission.prototype,'apply'),move=vi.spyOn(fs,'rename'),before=db.prepare('SELECT * FROM local_admission_web_collection_requests WHERE collection_id=?').all(original.id);
    const next=await service.remainingCollection(original.id),items=service.items(next.batches[0].id).items;
    expect(items).toHaveLength(1);expect(items[0]).toMatchObject({sourceRelativePath:title,action:'defer',group:'D'});expect(items[0].conflicts.length).toBeGreaterThan(0);
    expect(service.collectionScope(next.id).scopes[0].directories).toEqual([title]);expect(service.collection(original.id).remainingCount).toBe(1);
    expect((await service.remainingCollection(original.id)).id).toBe(next.id);
    expect(db.prepare('SELECT * FROM local_admission_web_collection_requests WHERE collection_id=?').all(original.id)).toEqual(before);
    expect(apply).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
  });
  it('excludes deferred paths already admitted or reserved by another immutable confirmed plan',async()=>{
    const db=manager.connection,titles=['031 后来其他入口已收录','032 后来其他入口已开始','033 仍然暂缓'];
    for(const title of titles)await make(0,title);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:titles}]}),input=request(original);
    input.batches[0].actions=input.batches[0].actions.map(item=>({...item,action:'defer'})) as typeof input.batches[0]['actions'];
    await service.executeCollection(original.id,input);await service.waitForIdle();
    for(const [index,title] of titles.slice(0,2).entries()){
      const later=await service.preview({creatorId:creators[0],parent:names[0],directories:[title]});
      if(index===1){const apply=Admission.prototype.apply;vi.spyOn(Admission.prototype,'apply').mockImplementationOnce(function(this:InstanceType<typeof Admission>,plan){return apply.call(this,plan,{stopAfterMove:true});});}
      await service.execute(later.id,{requestKey:randomUUID(),confirmed:true,acceptExistingVersion:true,actions:later.items.map(item=>({key:item.key,action:'new'}))});await service.waitForIdle();vi.restoreAllMocks();
      expect(db.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(later.id)).toBeTruthy();
    }
    const facts=db.prepare('SELECT * FROM archive_catalog_local_works ORDER BY id').all();
    expect(service.collection(original.id).remainingCount).toBe(1);
    const next=await service.remainingCollection(original.id);
    expect(service.collectionScope(next.id).scopes[0].directories).toEqual([titles[2]]);
    expect(db.prepare('SELECT * FROM archive_catalog_local_works ORDER BY id').all()).toEqual(facts);
  });
  it('requires explicit write intent to create a remaining draft and never creates one through GET',async()=>{
    const original=await preview('034 暂缓续接接口'),input=request(original);
    input.batches=input.batches.map(batch=>({...batch,actions:batch.actions.map(item=>({...item,action:'defer'}))})) as typeof input.batches;
    await service.executeCollection(original.id,input);await service.waitForIdle();
    const {createApp}=await import('../src/app.js'),app=createApp(),url=`/api/admin/local-admission/collections/${original.id}/remaining-preview`;
    const count=Number(manager.connection.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n);
    expect((await requestTestApp(app,'GET',url)).status).not.toBe(201);
    expect((await requestTestApp(app,'POST',url,{},{})).status).toBe(403);
    const cleanupUrl=`/api/admin/local-admission/collections/${original.id}/cleanup-empty-parents`;
    expect((await requestTestApp(app,'GET',cleanupUrl)).status).not.toBe(200);
    expect((await requestTestApp(app,'POST',cleanupUrl,{},{})).status).toBe(403);
    expect(Number(manager.connection.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(count);
    const result=await requestTestApp(app,'POST',url,{'x-foldergram-intent':'1'},{});
    expect(result.status).toBe(201);expect(result.body).toMatchObject({state:'draft',previousCollectionId:original.id});
    const repeated=await requestTestApp(app,'POST',url,{'x-foldergram-intent':'1'},{});expect(repeated.body.id).toBe(result.body.id);
    expect(Number(manager.connection.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n)).toBe(count+1);
  });
  it('respects another confirmed web plan before it has created an archive checkpoint or LocalWork',async()=>{
    const db=manager.connection,titles=['035 确认后尚未开始','035 未占用暂缓'];
    for(const title of titles)await make(0,title);
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:titles}]}),input=request(original);
    input.batches[0].actions=input.batches[0].actions.map(item=>({...item,action:'defer'})) as typeof input.batches[0]['actions'];
    await service.executeCollection(original.id,input);await service.waitForIdle();
    const reserved=await service.preview({creatorId:creators[0],parent:names[0],directories:[titles[0]]});
    vi.spyOn(Admission.prototype,'apply').mockRejectedValueOnce(new Error('Synthetic process failure before registering the archive plan'));
    await service.execute(reserved.id,{requestKey:randomUUID(),confirmed:true,acceptExistingVersion:true,actions:reserved.items.map(item=>({key:item.key,action:'new'}))});await service.waitForIdle();vi.restoreAllMocks();
    const confirmation=db.prepare('SELECT confirmed_json,owner_pid,owner_token FROM local_admission_web_batches WHERE id=?').get(reserved.id);
    expect(confirmation?.confirmed_json).not.toBeNull();expect(confirmation).toMatchObject({owner_pid:null,owner_token:null});
    expect(db.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(reserved.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=?').get(reserved.id)).toBeUndefined();
    expect(service.collection(original.id).remainingCount).toBe(1);
    const next=await service.remainingCollection(original.id);
    expect(service.collectionScope(next.id).scopes[0].directories).toEqual([titles[1]]);
    expect(db.prepare('SELECT confirmed_json,owner_pid,owner_token FROM local_admission_web_batches WHERE id=?').get(reserved.id)).toEqual(confirmation);
    await expect(fs.stat(path.join(waiting,names[0],titles[0]))).resolves.toBeTruthy();
  });
  it('excludes a target registered after confirmation without hiding target conflicts already present in the original preview',async()=>{
    const db=manager.connection,titles=['036 后来扫描已登记目标','036 尚未登记','036 原来已有目标冲突'];
    for(const title of titles)await make(0,title);
    const folder=db.prepare('SELECT id,absolute_path FROM archive_catalog_local_creator_folders WHERE creator_id=? AND is_active=1 ORDER BY id LIMIT 1').get(creators[0])!;
    const register=(title:string,target:string,createdAt:string)=>{
      const workId=Number(db.prepare('INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,?)').run(creators[0],title).lastInsertRowid);
      return Number(db.prepare(`INSERT INTO archive_catalog_local_works(local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,match_status,scanned_at,created_at)
        VALUES(?,?,?,?,?,'unmatched',?,?)`).run(folder.id,workId,title,target,title,createdAt,createdAt).lastInsertRowid);
    };
    const oldTarget=path.join(String(folder.absolute_path),titles[2]);await fs.mkdir(oldTarget,{recursive:true});
    const oldLocalId=register(titles[2],oldTarget,'2000-01-01T00:00:00.000Z');
    const original=await service.previewCollection({scopes:[{creatorId:creators[0],parent:names[0],directories:titles}]}),input=request(original);
    expect(service.items(original.batches[0].id).items[2].conflicts).toContain('target exists');
    input.batches[0].actions=input.batches[0].actions.map(item=>({...item,action:'defer'})) as typeof input.batches[0]['actions'];
    await service.executeCollection(original.id,input);await service.waitForIdle();
    const item=service.items(original.batches[0].id).items[0];
    const laterThanOriginal=new Date(Date.parse(String(db.prepare('SELECT created_at FROM local_admission_web_collections WHERE id=?').get(original.id)!.created_at))+1000).toISOString();
    const localId=register(titles[0],item.targetPath,laterThanOriginal);
    const facts=()=>db.prepare('SELECT * FROM archive_catalog_local_works WHERE id IN (?,?) ORDER BY id').all(localId,oldLocalId),before=facts();
    expect(db.prepare('SELECT * FROM archive_local_admission_items WHERE local_work_id=?').get(localId)).toBeUndefined();
    expect(service.collection(original.id).remainingCount).toBe(2);
    const next=await service.remainingCollection(original.id);
    expect(service.collectionScope(next.id).scopes[0].directories).toEqual([titles[1],titles[2]]);
    expect(service.items(next.batches[0].id).items[1].conflicts).toContain('target exists');
    expect(facts()).toEqual(before);
    await expect(fs.stat(path.join(waiting,names[0],titles[0]))).resolves.toBeTruthy();
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
    for(const action of ['repreview','remaining-preview','cleanup-empty-parents']){
      const route=`/api/admin/local-admission/collections/${original.id}/${action}`;
      expect((await requestTestApp(app,'POST',route,{'x-foldergram-intent':'1'},{})).status).toBe(401);
      expect((await requestTestApp(app,'POST',route,{'x-foldergram-intent':'1',cookie},{})).status).toBe(403);
    }
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
    expect(service.items(child.id).items[0]).toMatchObject({state:'indexed',executionState:'indexed',nextAction:'resume_plan',lastError:'Synthetic recycle temporarily unavailable'});
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
