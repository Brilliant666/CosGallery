import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {schemaSql} from '../src/db/schema.js';
import {ManagedCreatorService} from '../src/services/managed-creator-service.js';
import {ArchiveMetadataTaskService,type ArchiveMetadataTask} from '../src/services/archive-metadata-task-service.js';
import {ArchiveCatalogService} from '../src/services/archive-catalog-service.js';
import {ArchiveDownloadTaskService} from '../src/services/archive-download-task-service.js';

describe('explicit creator source check rounds',()=>{
  let db:DatabaseSync,service:ArchiveMetadataTaskService,root:string,creatorId:number;
  const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row=>[row.name,db.prepare(`SELECT * FROM "${row.name}" ORDER BY 1`).all()]));
  const sources=()=>JSON.stringify(['archive_catalog_collections','archive_catalog_works','archive_catalog_source_works','archive_catalog_deliveries','archive_catalog_local_works','archive_catalog_download_tasks']
    .map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  const plan=(requestId:string)=>service.planSelected({creatorIds:[creatorId],requestId});
  const claim=(requestId:string,workerId='worker')=>{
    const result=plan(requestId),task=result.items[0].task!;
    return service.claim({workerId,taskIds:result.taskIds,rounds:[{taskId:task.id,checkRoundId:task.checkRoundId!}]})[0];
  };
  const record=(task:ArchiveMetadataTask,count=3)=>({creatorName:'Fixture',aliases:[],
    costuan:{postId:'fixture-collection',url:'https://www.costuan.com/fixture',title:`Fixture COS写真图片包合集[${count}套][持续更新]`,collectionCount:count,
      directoryVerification:{complete:true,checkedAt:'2026-09-08T01:00:00Z',parsedWorkCount:count},
      works:Array.from({length:count},(_,index)=>({order:index+1,sourceOrder:`NO.${String(index+1).padStart(3,'0')}`,label:`Work ${index+1}`,mediaSummary:'1P'}))},
    baidu:{status:'already-saved',sourceFolderName:'fixture',destinationPath:'我的网盘/cos图集',verification:{method:'reused',checkedAt:'2026-09-08T01:00:00Z',
      sourceDirectory:'我的网盘/cos图集/fixture',checkRoundId:task.checkRoundId,files:Array.from({length:count},(_,index)=>`${String(index+1).padStart(3,'0')}.7z`)}}});
  const request=(task:ArchiveMetadataTask,count=3,receiptId=`receipt-${task.attemptCount}`)=>({id:task.id,workerId:'worker',canonicalCreatorId:creatorId,
    expectedAttempt:task.attemptCount,receiptId,record:record(task,count)});
  beforeEach(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'creator-check-rounds-'));
    db=new DatabaseSync(':memory:');db.exec(schemaSql);service=new ArchiveMetadataTaskService(db);
    creatorId=new ManagedCreatorService(db,path.join(root,'gallery')).create({name:'Fixture',preference:'liked'}).id;
  });
  afterEach(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});

  it('network retries reuse one round; a later explicit request really opens a new check; receipts stay auditable',()=>{
    const first=claim('one'),accepted=service.complete(request(first));const before=snapshot();
    expect(plan('one')).toMatchObject({replayed:true,taskIds:[],items:[{task:{status:'completed',attemptCount:1}}]});
    expect(service.complete(request(first))).toEqual(accepted);expect(snapshot()).toBe(before);
    const next=plan('two');expect(next.items[0].task).toMatchObject({id:first.id,status:'pending',attemptCount:1});
    expect(next.items[0].task!.checkRoundId).not.toBe(first.checkRoundId);
    expect(next.items[0].task!.lastSuccessfulSource).toMatchObject({postId:'fixture-collection',sourceFolderName:'fixture'});
    expect(()=>plan('one')).toThrow(/轮次已被/);
    const second=claim('two');expect(second.attemptCount).toBe(2);
    expect(()=>service.complete(request(first))).toThrow(/尝试已变化/);
    expect(()=>service.complete(request(second,3,'receipt-1'))).toThrow(/旧尝试/);
    service.complete(request(second));
    const context=JSON.parse((db.prepare('SELECT value FROM app_settings WHERE key=?').get(`archive.metadata-task.context.${first.id}`) as {value:string}).value);
    expect(context.history[0]).toMatchObject({attemptCount:1,status:'completed',receipt:{receiptId:'receipt-1'}});
    expect(context.receipt.receiptId).toBe('receipt-2');
    expect(()=>service.validateFinalize({creatorIds:[creatorId],taskIds:[first.id],workerId:'worker',attempts:[{taskId:first.id,expectedAttempt:1}]})).toThrow(/旧轮次/);
    expect(service.validateFinalize({creatorIds:[creatorId],taskIds:[second.id],workerId:'worker',attempts:[{taskId:second.id,expectedAttempt:2}]})).toEqual([creatorId]);
  });

  it('pending/claimed reuse keeps the original round and claim, while scopes and missing/old round tokens fail closed',()=>{
    const first=plan('one').items[0].task!;
    expect(plan('two').items[0].task!.checkRoundId).toBe(first.checkRoundId);
    expect(()=>service.claim({workerId:'worker',taskIds:[first.id]})).toThrow(/checkRoundId/);
    expect(()=>service.claim({workerId:'worker',taskIds:[first.id],rounds:[{taskId:first.id,checkRoundId:'wrong'}]})).toThrow(/轮次/);
    const current=claim('two');const before=snapshot();
    expect(service.claim({workerId:'someone-else',taskIds:[current.id],rounds:[{taskId:current.id,checkRoundId:current.checkRoundId!}]})).toEqual([]);
    expect(snapshot()).toBe(before);
    expect(plan('three').items[0].task).toMatchObject({claimedBy:'worker',attemptCount:1,checkRoundId:current.checkRoundId});
    const other=new ManagedCreatorService(db,path.join(root,'gallery')).create({name:'Other'}).id;
    expect(()=>service.planSelected({creatorIds:[other],requestId:'one'})).toThrow(/其他选择范围/);
    expect(()=>service.planSelected({creatorIds:[],requestId:'empty'})).toThrow();
  });

  it('failure/not-found preserves the last valid source and local links, and a new request may check again',()=>{
    const first=claim('one');service.complete(request(first));const original=sources();
    const second=claim('two');service.report({id:second.id,workerId:'worker',expectedAttempt:second.attemptCount,status:'not_found',error:'This attempt found no collection'});
    expect(sources()).toBe(original);
    expect(service.get(second.id)).toMatchObject({status:'not_found',lastSuccessfulSource:{postId:'fixture-collection'},sourceState:{metadataAccepted:true}});
    const third=claim('three');expect(third.attemptCount).toBe(3);
    expect(()=>service.report({id:first.id,workerId:'worker',expectedAttempt:1,status:'failed'})).toThrow(/尝试已变化/);
  });

  it('validates directory identity and completeness read-only before any cloud action, then requires fresh cloud evidence on completion',()=>{
    const task=claim('preflight'),payload=record(task);payload.baidu.verification.files=[];
    const options={id:task.id,workerId:'worker',expectedAttempt:task.attemptCount,canonicalCreatorId:creatorId,record:payload};
    const before=snapshot();
    expect(service.validateDirectory(options)).toMatchObject({requiredFilenames:['001.7z','002.7z','003.7z'],task:{checkRoundId:task.checkRoundId}});
    expect(snapshot()).toBe(before);
    expect(()=>service.complete({...request(task),record:payload})).toThrow(/网盘来源文件/);
    payload.costuan.works.pop();
    expect(()=>service.validateDirectory(options)).toThrow(/完整核验/);
    expect(()=>service.validateDirectory({...options,canonicalCreatorId:creatorId+1})).toThrow(/规范博主/);
    expect(snapshot()).toBe(before);
  });

  it('serializes finalization across service instances, blocks reopening mid-handoff, and replays finalized result without writes',async()=>{
    const task=claim('one');service.complete(request(task));
    const options={creatorIds:[creatorId],taskIds:[task.id],workerId:'worker',attempts:[{taskId:task.id,expectedAttempt:task.attemptCount}]};
    let unblock!:()=>void;
    const waiting=new Promise<void>(resolve=>{unblock=resolve;});
    let executions=0;
    const pending=service.finalizeSelected(options,async ids=>{executions++;await waiting;return {creatorIds:ids,created:3};});
    const another=new ArchiveMetadataTaskService(db);
    expect(()=>another.planSelected({creatorIds:[creatorId],requestId:'two'})).toThrow(/正在完成/);
    await expect(another.finalizeSelected(options,async()=>({created:999}))).rejects.toThrow(/正在执行/);
    unblock();expect(await pending).toEqual({creatorIds:[creatorId],created:3});
    const before=snapshot();
    expect(await another.finalizeSelected(options,async()=>{executions++;throw new Error('must not run');})).toEqual({creatorIds:[creatorId],created:3});
    expect(executions).toBe(1);expect(snapshot()).toBe(before);
    expect(plan('two').items[0].task?.status).toBe('pending');
  });

  it('failed finalization retains source/receipt, releases its scope lock and permits explicit retry',async()=>{
    const task=claim('one');service.complete(request(task));
    const options={creatorIds:[creatorId],taskIds:[task.id],workerId:'worker',attempts:[{taskId:task.id,expectedAttempt:task.attemptCount}]};
    const before=snapshot();
    await expect(service.finalizeSelected(options,async()=>{throw new Error('synthetic disk offline');})).rejects.toThrow(/offline/);
    expect(snapshot()).toBe(before);
    expect(await service.finalizeSelected(options,async()=>({created:3}))).toEqual({created:3});
  });

  it.each(['empty','partial','renumber','changed-title','missing-proof','stale-cloud','missing-file','duplicate-key','filename-collision'])
    ('rejects %s source without changing accepted data or pending download states',mode=>{
      const first=claim('one');service.complete(request(first));
      new ArchiveDownloadTaskService(db).planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')});
      const next=claim('two'),payload=request(next,4);
      if(mode==='empty') payload.record.costuan.works=[];
      if(mode==='partial') payload.record.costuan.works.pop();
      if(mode==='renumber') payload.record.costuan.works[0].sourceOrder='NO.020';
      if(mode==='changed-title') payload.record.costuan.works[0].label='Different content';
      if(mode==='missing-proof') payload.record.costuan.directoryVerification.complete=false;
      if(mode==='stale-cloud') payload.record.baidu.verification.checkRoundId=first.checkRoundId;
      if(mode==='missing-file') payload.record.baidu.verification.files.pop();
      if(mode==='duplicate-key') payload.record.costuan.works[3].sourceOrder='NO.001';
      if(mode==='filename-collision') {payload.record.costuan.works[3].sourceOrder='VOL.001';payload.record.costuan.works[3].order=1;}
      const before=snapshot();expect(()=>service.complete(payload)).toThrow();expect(snapshot()).toBe(before);
    });

  it('first 3 works then append 4th then unchanged uses one task/round chain and only one missing download',async()=>{
    const first=claim('one');service.complete(request(first));
    const gallery=path.join(root,'gallery');
    for(let order=1;order<=3;order++) {
      const directory=path.join(gallery,'Fixture',`Fixture NO.${String(order).padStart(3,'0')} Work ${order}`);
      await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'1.jpg'),'synthetic scan fixture');
    }
    await new ArchiveCatalogService(db).reconcileLocalRoot(gallery);
    const downloads=new ArchiveDownloadTaskService(db);
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')}).created).toBe(0);
    const second=claim('two'),secondRequest=request(second,4);
    // Own cloud no longer has historical packages 001-003, but their exact
    // source/local relationships and readable local directories still exist.
    secondRequest.record.baidu.verification.files=['004.7z'];
    expect(service.validateDirectory(secondRequest)).toMatchObject({sourceFilenames:['001.7z','002.7z','003.7z','004.7z'],requiredFilenames:['004.7z']});
    service.complete(secondRequest);
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')}).created).toBe(1);
    expect(downloads.list().items.map(task=>task.targetFilename)).toEqual(['004.7z']);
    db.prepare("UPDATE archive_catalog_download_tasks SET status='staged' WHERE id=?").run(downloads.list().items[0].id);
    const existing=JSON.stringify(downloads.list().items);
    const third=claim('three');service.complete(request(third,4));
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')})).toMatchObject({created:0,existing:1});
    expect(JSON.stringify(downloads.list().items)).toBe(existing);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_metadata_tasks').get()).toEqual({n:1});
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_local_works WHERE is_active=1 AND work_id IS NOT NULL').get()).toEqual({n:3});
  });

  it('an all-local check accepts an empty Stage2 file requirement while still validating the complete source and current round',async()=>{
    const first=claim('one');service.complete(request(first));
    const gallery=path.join(root,'gallery');
    for(let order=1;order<=3;order++) {
      const directory=path.join(gallery,'Fixture',`Fixture NO.${String(order).padStart(3,'0')} Work ${order}`);
      await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'1.jpg'),'synthetic scan fixture');
    }
    await new ArchiveCatalogService(db).reconcileLocalRoot(gallery);
    const next=claim('two'),payload=request(next);payload.record.baidu.verification.files=[];
    expect(service.validateDirectory(payload)).toMatchObject({sourceFilenames:['001.7z','002.7z','003.7z'],requiredFilenames:[]});
    service.complete(payload);
    expect(new ArchiveDownloadTaskService(db).planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')}).created).toBe(0);
    const third=claim('three'),incomplete=request(third);incomplete.record.costuan.works.pop();
    const before=snapshot();expect(()=>service.validateDirectory(incomplete)).toThrow(/完整|数量/);expect(snapshot()).toBe(before);
  });

  it('offline historical local folders are unknown, not an empty set to replenish from cloud',async()=>{
    const first=claim('one');service.complete(request(first));
    const gallery=path.join(root,'gallery'),directory=path.join(gallery,'Fixture','Fixture NO.001 Work 1');
    await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'1.jpg'),'synthetic scan fixture');
    await new ArchiveCatalogService(db).reconcileLocalRoot(gallery);
    await fs.rename(path.join(gallery,'Fixture'),path.join(root,'temporarily-offline'));
    const next=claim('two'),payload=request(next,4),before=snapshot();
    expect(()=>service.validateDirectory(payload)).toThrow(/离线|不可读|未知/);
    expect(()=>service.complete(payload)).toThrow(/离线|不可读|未知/);
    expect(snapshot()).toBe(before);
  });

  it('an unresolved registered local work is unknown rather than a cloud replenishment candidate',async()=>{
    const first=claim('one');service.complete(request(first));
    const gallery=path.join(root,'gallery'),directory=path.join(gallery,'Fixture','Fixture NO.001 Work 1');
    await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'1.jpg'),'synthetic scan fixture');
    await new ArchiveCatalogService(db).reconcileLocalRoot(gallery);
    db.prepare("UPDATE archive_catalog_local_works SET work_id=NULL,match_status='unmatched' WHERE is_active=1").run();
    const next=claim('two'),payload=request(next,4),before=snapshot();
    expect(()=>service.validateDirectory(payload)).toThrow(/未知|歧义/);
    expect(()=>service.complete(payload)).toThrow(/未知|歧义/);
    expect(snapshot()).toBe(before);
  });
});
