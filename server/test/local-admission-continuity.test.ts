import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {beforeAll,beforeEach,afterEach,afterAll,describe,it,expect,vi} from 'vitest';

describe.sequential('local admission isolates content review without hiding system failures',()=>{
  let root:string,waiting:string,gallery:string;
  let manager:typeof import('../src/db/database.js')['databaseManager'];
  let service:import('../src/services/local-admission-web-service.js').LocalAdmissionWebService;
  let Service:typeof import('../src/services/local-admission-web-service.js')['LocalAdmissionWebService'];
  let Admission:typeof import('../src/services/local-folder-admission-service.js')['LocalFolderAdmissionService'];
  let scanner:typeof import('../src/services/scanner-service.js')['scannerService'];
  beforeAll(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'admission-continuity-'));
    waiting=path.join(root,'cos等待入库');gallery=path.join(root,'gallery');
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');vi.stubEnv('PUBLIC_DEMO_MODE','0');vi.stubEnv('DERIVATIVE_MODE','lazy');
    for(const [key,value] of Object.entries({DATA_ROOT:path.join(root,'data'),DB_DIR:path.join(root,'db'),GALLERY_ROOT:gallery,THUMBNAILS_DIR:path.join(root,'thumbs'),PREVIEWS_DIR:path.join(root,'previews')})){
      vi.stubEnv(key,value);await fs.mkdir(value,{recursive:true});
    }
    await fs.mkdir(waiting);vi.resetModules();
    ({databaseManager:manager}=await import('../src/db/database.js'));
    ({LocalAdmissionWebService:Service}=await import('../src/services/local-admission-web-service.js'));
    ({LocalFolderAdmissionService:Admission}=await import('../src/services/local-folder-admission-service.js'));
    ({scannerService:scanner}=await import('../src/services/scanner-service.js'));
  },30000);
  beforeEach(()=>{service=new Service(manager.connection,gallery);});
  afterEach(async()=>{await service.waitForIdle();vi.restoreAllMocks();});
  afterAll(async()=>{await service?.waitForIdle();manager?.close();vi.unstubAllEnvs();});
  async function scope(name:string,titles:string[]){
    const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');
    const creatorId=new ManagedCreatorService(manager.connection,gallery).create({name,rating:'R15',preference:'liked'}).id;
    for(const title of titles){
      const dir=path.join(waiting,name,title);await fs.mkdir(dir,{recursive:true});
      await sharp({create:{width:14,height:20,channels:3,background:'#336699'}}).jpeg().toFile(path.join(dir,'photo.jpg'));
    }
    return {creatorId,parent:name,directories:titles};
  }
  function failedScan(detail='Input file contains unsupported image format'){
    return {id:1,started_at:'now',finished_at:'now',status:'failed',scanned_files:1,new_files:0,updated_files:0,removed_files:0,
      error_text:detail,warning_count:0,warning_text:null};
  }
  function reviewScan(){
    return {...failedScan(),admissionIssue:{kind:'review' as const,code:'MEDIA_CONTENT_REVIEW_REQUIRED',message:'图集中有需要核对的媒体文件，请处理本项后继续',detail:'Input file contains unsupported image format'}};
  }
  function request(batch:Awaited<ReturnType<typeof service.preview>>,actions?:Record<string,unknown>[]){
    return {requestKey:randomUUID(),confirmed:true,acceptExistingVersion:true,
      actions:actions??batch.items.map(item=>({key:item.key,action:'new'}))};
  }
  const savedPlan=(id:string)=>manager.connection.prepare('SELECT payload_json,content_hash FROM archive_local_admission_plans WHERE plan_id=?').get(id);

  it('keeps CLI fail-fast as the default even for an explicitly classified content problem',async()=>{
    const selected=await scope('CLI continuity fixture',['01 Review','02 Independent']);
    const preview=await new Admission(manager.connection,gallery).preview({creatorId:selected.creatorId,inputRoot:path.join(waiting,selected.parent),directories:selected.directories});
    const plan={...preview,confirmed:true,items:preview.items.map(item=>({...item,reason:'Synthetic confirmed plan'}))};
    const scan=vi.spyOn(scanner,'scanCosCreators').mockResolvedValueOnce(reviewScan());
    await expect(new Admission(manager.connection,gallery).apply(plan)).rejects.toThrow();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(manager.connection.prepare('SELECT state,local_work_id FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,plan.items[1].key)).toEqual({state:'planned',local_work_id:null});
    await expect(fs.stat(path.join(waiting,selected.parent,selected.directories[1]))).resolves.toBeTruthy();
    await expect(fs.stat(plan.items[1].targetPath)).rejects.toThrow();
    const immutable=savedPlan(plan.planId);scan.mockResolvedValueOnce(reviewScan());
    const continued=await new Admission(manager.connection,gallery).apply(plan,{continueReviewable:true});
    expect(continued.completed).toBe(false);expect(continued.items).toHaveLength(2);
    expect(manager.connection.prepare('SELECT state FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,plan.items[1].key)).toEqual({state:'completed'});
    expect(scan.mock.calls.map(call=>call[2]?.workFolderName)).toEqual([selected.directories[0],selected.directories[0],selected.directories[1]]);
    expect(savedPlan(plan.planId)).toEqual(immutable);
  });

  it('continues independent albums and resumes the immutable plan without rescanning completed or manually deferred items',async()=>{
    const selected=await scope('Independent continuity fixture',['01 Review','02 Independent','03 Manual defer']);
    const batch=await service.preview(selected),actions=batch.items.map((item,index)=>({key:item.key,action:index===2?'defer':'new'}));
    const scan=vi.spyOn(scanner,'scanCosCreators').mockResolvedValueOnce(reviewScan());
    await service.execute(batch.id,request(batch,actions));await service.waitForIdle();scan.mockRestore();
    expect(service.get(batch.id)).toMatchObject({state:'needs_review',totals:{total:3,selected:2,completed:1,review:1,dependency:0,unstarted:0,deferred:1,skipped:0}});
    const [review,completed,deferred]=service.items(batch.id).items;
    expect(review).toMatchObject({state:'files_verified',nextAction:'review_files',executionIssue:{kind:'review',code:'MEDIA_CONTENT_REVIEW_REQUIRED'},errorMessage:reviewScan().admissionIssue.message});
    expect(review.lastError).toContain('Input file contains unsupported image format');
    expect(completed.state).toBe('completed');expect(completed.executionIssue).toBeUndefined();
    expect(deferred).toMatchObject({state:'defer',executionState:null});
    const immutable=savedPlan(batch.id);expect(JSON.parse(String(immutable!.payload_json)).items).toHaveLength(2);
    const completedMedia=manager.connection.prepare('SELECT * FROM post_items WHERE post_id=? ORDER BY position').all(Number(completed.postId));
    const retryScan=vi.spyOn(scanner,'scanCosCreators');
    service.resume(batch.id,{requestKey:randomUUID(),confirmed:true});await service.waitForIdle();
    expect(service.get(batch.id)).toMatchObject({state:'completed',totals:{completed:2,review:0,dependency:0,unstarted:0,deferred:1}});
    expect(retryScan.mock.calls.map(call=>call[2]?.workFolderName)).toEqual([selected.directories[0]]);
    expect(service.items(batch.id).items[1]).toEqual(completed);expect(savedPlan(batch.id)).toEqual(immutable);
    expect(manager.connection.prepare('SELECT * FROM post_items WHERE post_id=? ORDER BY position').all(Number(completed.postId))).toEqual(completedMedia);
    await expect(fs.stat(path.join(waiting,selected.parent,selected.directories[2]))).resolves.toBeTruthy();
    await expect(fs.stat(deferred.targetPath)).rejects.toThrow();
  });

  it('waits for a same-as prerequisite while an independent album finishes, then preserves Work identity on resume',async()=>{
    const selected=await scope('Same as dependency fixture',['01 Shared','02 Shared copy','03 Chained copy','04 Independent']);
    const batch=await service.preview(selected),actions=[{key:batch.items[0].key,action:'new'},
      {key:batch.items[1].key,action:'same-as',sameAsKey:batch.items[0].key,primary:true},
      {key:batch.items[2].key,action:'same-as',sameAsKey:batch.items[1].key},{key:batch.items[3].key,action:'new'}];
    const scan=vi.spyOn(scanner,'scanCosCreators').mockResolvedValueOnce(reviewScan());
    await service.execute(batch.id,request(batch,actions));await service.waitForIdle();scan.mockRestore();
    const [first,dependent,chained,independent]=service.items(batch.id).items;
    expect(service.get(batch.id)).toMatchObject({state:'needs_review',totals:{completed:1,review:1,dependency:2,unstarted:0}});
    expect(dependent).toMatchObject({state:'planned',workId:null,localWorkId:null,nextAction:'none',executionIssue:{kind:'dependency',blockedByItemKey:first.key}});
    await expect(fs.stat(path.join(waiting,selected.parent,selected.directories[1]))).resolves.toBeTruthy();await expect(fs.stat(dependent.targetPath)).rejects.toThrow();
    expect(chained).toMatchObject({state:'planned',workId:null,localWorkId:null,nextAction:'none',executionIssue:{kind:'dependency',blockedByItemKey:dependent.key}});
    await expect(fs.stat(path.join(waiting,selected.parent,selected.directories[2]))).resolves.toBeTruthy();await expect(fs.stat(chained.targetPath)).rejects.toThrow();
    const immutable=savedPlan(batch.id),resumeScan=vi.spyOn(scanner,'scanCosCreators');
    service.resume(batch.id,{requestKey:randomUUID(),confirmed:true});await service.waitForIdle();
    const after=service.items(batch.id).items;
    expect(service.get(batch.id).state).toBe('completed');expect(after[0].workId).toBe(first.workId);expect(after[1].workId).toBe(first.workId);expect(after[2].workId).toBe(first.workId);expect(after[3]).toEqual(independent);
    expect(manager.connection.prepare('SELECT primary_local_work_id FROM archive_catalog_works WHERE id=?').get(Number(first.workId))!.primary_local_work_id).toBe(after[1].localWorkId);
    expect(resumeScan.mock.calls.map(call=>call[2]?.workFolderName)).toEqual(selected.directories.slice(0,3));expect(savedPlan(batch.id)).toEqual(immutable);
  });

  it('holds another existing copy of the same Work without holding an unrelated Work',async()=>{
    const selected=await scope('Existing Work dependency fixture',['01 Existing copy','02 Another copy','03 Independent']);
    const workId=Number(manager.connection.prepare("INSERT INTO archive_catalog_works(creator_id,display_title,title_policy) VALUES(?,?,'manual')").run(selected.creatorId,'Canonical shared work').lastInsertRowid);
    const batch=await service.preview(selected),actions=batch.items.map((item,index)=>index<2?{key:item.key,action:'existing',workId}:{key:item.key,action:'new'});
    const scan=vi.spyOn(scanner,'scanCosCreators').mockResolvedValueOnce(reviewScan());
    await service.execute(batch.id,request(batch,actions));await service.waitForIdle();scan.mockRestore();
    const [first,dependent,independent]=service.items(batch.id).items;
    expect(first.workId).toBe(workId);expect(independent.state).toBe('completed');
    expect(dependent).toMatchObject({state:'planned',localWorkId:null,executionIssue:{kind:'dependency',blockedByItemKey:first.key},nextAction:'none'});
    await expect(fs.stat(path.join(waiting,selected.parent,selected.directories[1]))).resolves.toBeTruthy();await expect(fs.stat(dependent.targetPath)).rejects.toThrow();
    expect(manager.connection.prepare('SELECT display_title,primary_local_work_id FROM archive_catalog_works WHERE id=?').get(workId)).toMatchObject({display_title:'Canonical shared work',primary_local_work_id:null});
  });

  it('resolves sourceWorkId-only identities to the same Work before starting a dependent copy',async()=>{
    const selected=await scope('Source Work dependency fixture',['01 Source copy','02 Another source copy','03 Independent']);
    const db=manager.connection,workId=Number(db.prepare("INSERT INTO archive_catalog_works(creator_id,display_title,title_policy) VALUES(?,?,'manual')").run(selected.creatorId,'Canonical source work').lastInsertRowid);
    const collectionId=Number(db.prepare("INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at) VALUES(?,'test','source-dependency','Synthetic source','now')").run(selected.creatorId).lastInsertRowid);
    const sources=[1,2].map(index=>Number(db.prepare("INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_order,source_title,media_summary,first_seen_at,last_seen_at) VALUES(?,?,'test',?,?,'Source canonical work','1P','now','now')").run(workId,collectionId,`source-${index}`,index).lastInsertRowid));
    const admission=new Admission(db,gallery),preview=await admission.preview({creatorId:selected.creatorId,inputRoot:path.join(waiting,selected.parent),directories:selected.directories});
    const plan={...preview,confirmed:true,items:preview.items.map((item,index)=>({...item,reason:'Synthetic source identity confirmation',acceptExistingVersion:true,
      ...(index<2?{displayTitle:'Canonical source work',identity:{kind:'existing',sourceWorkId:sources[index]}}:{})}))};
    const scan=vi.spyOn(scanner,'scanCosCreators').mockResolvedValueOnce(reviewScan());
    const result=await admission.apply(plan,{continueReviewable:true});
    expect(result.completed).toBe(false);expect(scan.mock.calls.map(call=>call[2]?.workFolderName)).toEqual([selected.directories[0],selected.directories[2]]);
    expect(db.prepare('SELECT state,work_id FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,plan.items[0].key)).toEqual({state:'files_verified',work_id:workId});
    const dependent=db.prepare('SELECT state,local_work_id,last_error FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,plan.items[1].key)!;
    expect(dependent).toMatchObject({state:'planned',local_work_id:null});expect(String(dependent.last_error)).toContain('ADMISSION_DEPENDENCY_PENDING');
    await expect(fs.stat(path.join(waiting,selected.parent,selected.directories[1]))).resolves.toBeTruthy();await expect(fs.stat(plan.items[1].targetPath)).rejects.toThrow();
    expect(db.prepare('SELECT state FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,plan.items[2].key)).toEqual({state:'completed'});
  });

  it('continues a later creator after a classified content problem and retries only the unfinished child',async()=>{
    const scopes=[await scope('Content review creator A',['01 Review']),await scope('Content review creator B',['02 Independent'])];
    const collection=await service.previewCollection({scopes});
    const input={requestKey:randomUUID(),confirmed:true,batches:collection.batches.map(batch=>({batchId:batch.id,acceptExistingVersion:true,actions:service.items(batch.id).items.map(item=>({key:item.key,action:'new'}))}))};
    const scan=vi.spyOn(scanner,'scanCosCreators').mockResolvedValueOnce(reviewScan());
    await service.executeCollection(collection.id,input);await service.waitForIdle();scan.mockRestore();
    expect(service.collection(collection.id)).toMatchObject({state:'partial',totals:{completed:1,review:1,dependency:0,unstarted:0}});
    const completed=service.items(collection.batches[1].id).items[0],immutable=collection.batches.map(batch=>savedPlan(batch.id));
    expect(completed.state).toBe('completed');
    const retryScan=vi.spyOn(scanner,'scanCosCreators');service.resumeCollection(collection.id,{requestKey:randomUUID(),confirmed:true});await service.waitForIdle();
    expect(service.collection(collection.id)).toMatchObject({state:'completed',totals:{completed:2,review:0,dependency:0,unstarted:0}});
    expect(retryScan.mock.calls.map(call=>call[2]?.workFolderName)).toEqual([scopes[0].directories[0]]);
    expect(service.items(collection.batches[1].id).items[0]).toEqual(completed);
    expect(collection.batches.map(batch=>savedPlan(batch.id))).toEqual(immutable);
  });

  it('stops later albums and creators for an unclassified failed scan even when its text resembles a decoder error',async()=>{
    const scopes=[await scope('Unknown scan creator A',['01 Failed','02 Unstarted']),await scope('Unknown scan creator B',['03 Unstarted'])];
    const collection=await service.previewCollection({scopes});
    const input={requestKey:randomUUID(),confirmed:true,batches:collection.batches.map(batch=>({batchId:batch.id,acceptExistingVersion:true,actions:service.items(batch.id).items.map(item=>({key:item.key,action:'new'}))}))};
    const scan=vi.spyOn(scanner,'scanCosCreators').mockResolvedValueOnce(failedScan());
    await service.executeCollection(collection.id,input);await service.waitForIdle();scan.mockRestore();
    expect(service.collection(collection.id)).toMatchObject({state:'partial',totals:{completed:0,review:0,dependency:0,unstarted:2}});
    const firstItems=service.items(collection.batches[0].id).items,lastItems=service.items(collection.batches[1].id).items;
    expect(firstItems[0]).toMatchObject({state:'files_verified',executionIssue:{kind:'system'}});
    expect(firstItems[0].errorMessage).toMatch(/[\u4e00-\u9fff]/);expect(firstItems[0].lastError).toContain('Input file contains unsupported image format');
    expect(firstItems[1]).toMatchObject({state:'planned',localWorkId:null});expect(lastItems[0].localWorkId).toBeNull();
    for(const selected of scopes)for(const title of selected.directories.slice(selected===scopes[0]?1:0)){
      await expect(fs.stat(path.join(waiting,selected.parent,title))).resolves.toBeTruthy();await expect(fs.stat(path.join(gallery,selected.parent,title))).rejects.toThrow();
    }
    expect(savedPlan(collection.batches[1].id)).toBeUndefined();
    for(const batch of collection.batches)expect(manager.connection.prepare('SELECT owner_pid,owner_token FROM local_admission_web_batches WHERE id=?').get(batch.id)).toEqual({owner_pid:null,owner_token:null});
    service.resumeCollection(collection.id,{requestKey:randomUUID(),confirmed:true});await service.waitForIdle();
    expect(service.collection(collection.id)).toMatchObject({state:'completed',totals:{completed:3,review:0,dependency:0,unstarted:0}});
  });

  it('does not continue after a directory move is refused by the filesystem',async()=>{
    const selected=await scope('Move refusal fixture',['01 Blocked','02 Unstarted']);
    const batch=await service.preview(selected);
    vi.spyOn(fs,'rename').mockImplementationOnce(async(source,destination)=>{
      expect(source).toBe(path.join(waiting,selected.parent,selected.directories[0]));expect(destination).toBe(batch.items[0].targetPath);
      throw Object.assign(new Error('Synthetic EACCES move denied'),{code:'EACCES'});
    });
    await service.execute(batch.id,request(batch));await service.waitForIdle();
    expect(service.get(batch.id)).toMatchObject({totals:{completed:0,review:0,dependency:0,unstarted:1}});
    const [blocked,later]=service.items(batch.id).items;
    expect(blocked).toMatchObject({state:'move_intent',executionIssue:{kind:'system'}});expect(blocked.lastError).toContain('EACCES');
    expect(later).toMatchObject({state:'planned',localWorkId:null});
    for(const title of selected.directories)await expect(fs.stat(path.join(waiting,selected.parent,title))).resolves.toBeTruthy();
    await expect(fs.stat(later.targetPath)).rejects.toThrow();
  });

  it.each([
    {label:'indexing',error:'Scoped media indexing did not complete',display:'图集索引未完成，请核对异常文件'},
    {label:'database',error:'SQLITE_BUSY: database is locked',display:'入库未完成，请查看技术详情并核对原因'}
  ])('localizes historical $label errors without diagnosing content or starting later albums',async({label,error,display})=>{
    const selected=await scope(`Historical error fixture ${label}`,['01 Historical','02 Unstarted']);const batch=await service.preview(selected);
    const scan=vi.spyOn(scanner,'scanCosCreators').mockRejectedValueOnce(new Error(error));
    await service.execute(batch.id,request(batch));await service.waitForIdle();scan.mockRestore();
    manager.connection.prepare('UPDATE archive_local_admission_items SET last_error=? WHERE plan_id=? AND item_key=?').run(error,batch.id,batch.items[0].key);
    manager.connection.prepare('UPDATE local_admission_web_batches SET error=? WHERE id=?').run(error,batch.id);
    const before=savedPlan(batch.id),checkpoints=manager.connection.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? ORDER BY item_key').all(batch.id);
    const reads=[vi.spyOn(fs,'readdir'),vi.spyOn(fs,'lstat'),vi.spyOn(fs,'readFile')];
    expect(service.get(batch.id)).toMatchObject({errorMessage:display,totals:{review:0,unstarted:1}});
    const items=service.items(batch.id).items;
    expect(items[0]).toMatchObject({state:'files_verified',lastError:error,errorMessage:display});expect(items[0].executionIssue).toBeUndefined();
    expect(items[1]).toMatchObject({state:'planned',localWorkId:null,lastError:null});
    for(const read of reads)expect(read).not.toHaveBeenCalled();expect(savedPlan(batch.id)).toEqual(before);
    expect(manager.connection.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? ORDER BY item_key').all(batch.id)).toEqual(checkpoints);
    await expect(fs.stat(path.join(waiting,selected.parent,selected.directories[1]))).resolves.toBeTruthy();await expect(fs.stat(items[1].targetPath)).rejects.toThrow();
  });
});
