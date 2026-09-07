import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {schemaSql} from '../src/db/schema.js';
import {ManagedCreatorService} from '../src/services/managed-creator-service.js';
import {ArchiveMetadataTaskService} from '../src/services/archive-metadata-task-service.js';
import {ArchiveCatalogService} from '../src/services/archive-catalog-service.js';
import {ArchiveCatalogPipelineService} from '../src/services/archive-catalog-pipeline-service.js';
import {ArchiveDownloadTaskService} from '../src/services/archive-download-task-service.js';

describe('explicit roster first collection service',()=>{
  let db:DatabaseSync, service:ArchiveMetadataTaskService, managed:ManagedCreatorService, root:string;
  const record=(name='First',postId='100',saved=true)=>({creatorId:`legacy:${name}`,creatorName:name,aliases:[name],
    costuan:{postId,title:`${name} COS写真图片包合集[2套][持续更新]`,works:[
      {order:1,sourceOrder:'NO.001',label:'One',mediaSummary:'1P'},
      {order:2,sourceOrder:'NO.002',label:'Two',mediaSummary:'1P'}]},
    baidu:saved ? {status:'saved',sourceFolderName:postId,destinationPath:'我的网盘/cos图集',
      verification:{checkedAt:'2026-09-08T00:00:00Z',method:'saved',sourceDirectory:`我的网盘/cos图集/${postId}`}} : null});
  const table=(name:string)=>JSON.stringify(db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
  const all=()=>['archive_catalog_creators','archive_catalog_creator_aliases','archive_catalog_creator_sources',
    'archive_catalog_collections','archive_catalog_works','archive_catalog_source_works','archive_catalog_deliveries',
    'archive_catalog_metadata_tasks','archive_catalog_download_tasks','archive_catalog_import_runs','app_settings'].map(table);
  const creator=(name='First')=>managed.create({name,preference:'liked',rating:'R18',aliases:[`${name}Alias`]});
  const claimed=(id:number,workerId='worker')=>{
    const plan=service.planSelected({creatorIds:[id]});
    return service.claim({workerId,taskIds:plan.taskIds})[0];
  };
  beforeEach(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'roster-first-service-'));
    db=new DatabaseSync(':memory:'); db.exec(schemaSql);
    service=new ArchiveMetadataTaskService(db); managed=new ManagedCreatorService(db,path.join(root,'gallery'));
  });
  afterEach(async()=>{vi.restoreAllMocks();db.close();await fs.rm(root,{recursive:true,force:true});});

  it('plans only selected stable IDs, no folders, canonical metadata unchanged and duplicate idempotency',async()=>{
    const first=creator(),other=creator('Other'); const before=table('archive_catalog_creators');
    expect(service.planLocalOnly().created).toBe(0);
    const plan=service.planSelected({creatorIds:[first.id,first.id]});
    expect(plan.items).toHaveLength(1); expect(plan.items[0]).toMatchObject({creatorId:first.id,result:'created'});
    expect(service.planSelected({creatorIds:[first.id]}).items[0].result).toBe('reused');
    expect(table('archive_catalog_creators')).toBe(before); expect(service.list().total).toBe(1);
    expect(service.candidates({q:'FirstAlias'}).items.map(c=>c.creatorId)).toEqual([first.id]);
    expect(service.candidates().items.some(c=>c.creatorId===other.id)).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
    expect(service.claim({workerId:'old-plugin'})).toEqual([]);
  });

  it('rejects empty/invalid/nonexistent ranges before any write; inactive selection is explicit',()=>{
    const first=creator(); const before=all();
    for(const ids of [[],[0],[1.1],[first.id,999999]]) expect(()=>service.planSelected({creatorIds:ids})).toThrow();
    expect(all()).toEqual(before);
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=?').run(first.id);
    expect(service.planSelected({creatorIds:[first.id]})).toMatchObject({taskIds:[],items:[{result:'inactive'}]});
    expect(service.list().total).toBe(0);
  });

  it('pages and searches aliases without merging same-named distinct creators or selecting filters',()=>{
    const first=creator('Same'); const second=managed.create({name:'Same',confirmDistinct:true});
    expect(service.candidates({q:'Same',limit:1,page:1})).toMatchObject({total:2,pages:2});
    const ids=[1,2].flatMap(page=>service.candidates({q:'Same',limit:1,page}).items.map(c=>c.creatorId));
    expect(new Set(ids)).toEqual(new Set([first.id,second.id])); expect(service.list().total).toBe(0);
    const task=claimed(first.id); const before=all();
    expect(()=>service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'same',record:record('Same')})).toThrow(/歧义/);
    expect(all()).toEqual(before);
  });

  it('fixed claim scope cannot take pending tasks added later; disabled creators and empty scope fail closed',()=>{
    const first=creator(),other=creator('Other');const one=service.planSelected({creatorIds:[first.id]});
    const two=service.planSelected({creatorIds:[other.id]});
    expect(service.claim({workerId:'worker',taskIds:one.taskIds}).map(t=>t.creatorId)).toEqual([first.id]);
    expect(service.get(two.taskIds[0])?.status).toBe('pending');
    expect(()=>service.claim({workerId:'worker',taskIds:[]})).toThrow();
    expect(()=>service.claim({workerId:'worker',taskIds:[999]})).toThrow();
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=?').run(other.id);
    expect(()=>service.claim({workerId:'worker',taskIds:two.taskIds})).toThrow(/停用/);
  });

  it('preserves claimed worker/attempt and failed, not_found, cancelled without explicit retry',()=>{
    const first=creator(),task=claimed(first.id);
    expect(service.planSelected({creatorIds:[first.id]}).items[0]).toMatchObject({result:'claimed',task:{claimedBy:'worker',attemptCount:1}});
    expect(service.claim({workerId:'someone-else',taskIds:[task.id]})).toEqual([]);
    for(const status of ['failed','not_found','cancelled']) {
      db.prepare('UPDATE archive_catalog_metadata_tasks SET status=?,claimed_by=NULL WHERE id=?').run(status,task.id);
      const before=table('archive_catalog_metadata_tasks');
      expect(service.planSelected({creatorIds:[first.id]}).items[0].result).toBe('retry_required');
      expect(table('archive_catalog_metadata_tasks')).toBe(before);
    }
    expect(service.planSelected({creatorIds:[first.id],retry:true})).toMatchObject({taskIds:[task.id],items:[{result:'reused',task:{status:'pending'}}]});
  });

  it('checks independent title and owner before import, even if one wrong creator matches',()=>{
    const first=creator(),other=creator('Other'),task=claimed(first.id);
    const before=all();
    expect(()=>service.validateSource({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,postId:'200',title:record('Other').costuan.title})).toThrow();
    expect(()=>service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'wrong',record:record('Other')})).toThrow();
    expect(all()).toEqual(before);
    new ArchiveCatalogService(db).importCostuanRecord(record('Other','200'));
    const ownedBefore=all();
    expect(()=>service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'wrong-owner',record:record('First','200')})).toThrow();
    expect(all()).toEqual(ownedBefore);
    expect(()=>service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:other.id,receiptId:'wrong-id',record:record()})).toThrow();
    expect(all()).toEqual(ownedBefore);
  });

  it('atomically imports and acknowledges; exact lost-response replay is read-only and other worker/payload rejected',()=>{
    const first=creator(),task=claimed(first.id),beforeCreator=table('archive_catalog_creators'),beforeAliases=table('archive_catalog_creator_aliases');
    const request={id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'receipt',record:record()};
    const response=service.complete(request);
    expect(response.task).toMatchObject({status:'completed',sourceState:{metadataAccepted:true,deliveryReady:true,deliveryEvidence:'verified'}});
    expect(table('archive_catalog_creators')).toBe(beforeCreator);expect(table('archive_catalog_creator_aliases')).toBe(beforeAliases);
    const after=all();
    expect(new ArchiveMetadataTaskService(db).complete(request)).toEqual(response); expect(all()).toEqual(after);
    expect(()=>service.complete({...request,workerId:'late-worker'})).toThrow();
    expect(()=>service.complete({...request,record:record('First','changed')})).toThrow(); expect(all()).toEqual(after);
    expect(service.planSelected({creatorIds:[first.id],retry:true}).items[0].result).toBe('source_ready'); expect(all()).toEqual(after);
  });

  it('rolls back source writes if task completion fails, and preserves claim for retry',()=>{
    const first=creator(),task=claimed(first.id);
    db.exec("CREATE TRIGGER reject_metadata_complete BEFORE UPDATE OF status ON archive_catalog_metadata_tasks WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'fixture completion failure'); END;");
    const before=all();
    expect(()=>service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'rollback',record:record()})).toThrow(/fixture/);
    expect(all()).toEqual(before);
  });

  it('rejects same-worker late attempt receipts, source preflights and reports without affecting the new claim',()=>{
    const first=creator(),task=claimed(first.id);
    const old={id:task.id,workerId:'worker',canonicalCreatorId:first.id,expectedAttempt:1,receiptId:'late-never-accepted',record:record()};
    service.report({id:task.id,workerId:'worker',expectedAttempt:1,status:'failed',error:'fixture network interruption'});
    service.planSelected({creatorIds:[first.id],retry:true});
    expect(service.claim({workerId:'worker',taskIds:[task.id]})[0].attemptCount).toBe(2);
    const before=all();
    expect(()=>service.complete(old)).toThrow(/尝试已变化/);
    expect(()=>service.report({id:task.id,workerId:'worker',expectedAttempt:1,status:'pending'})).toThrow(/尝试已变化/);
    expect(()=>service.validateSource({id:task.id,workerId:'worker',canonicalCreatorId:first.id,expectedAttempt:1,postId:'100',title:record().costuan.title})).toThrow(/尝试已变化/);
    expect(()=>service.complete({...old,expectedAttempt:undefined})).toThrow(/尝试已变化/);
    expect(all()).toEqual(before);
    service.complete({...old,expectedAttempt:2,receiptId:'fresh-attempt'});
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=?').run(first.id);
    const accepted=all();
    // A response-loss replay is read-only; later deactivation need not conceal the accepted receipt.
    expect(service.complete({...old,expectedAttempt:2,receiptId:'fresh-attempt'}).task.status).toBe('completed');
    expect(all()).toEqual(accepted);
  });

  it('does not complete an empty source collection and rolls back even the empty import metadata',()=>{
    const first=creator(),task=claimed(first.id),empty=record();empty.costuan.works=[];
    const before=all();
    expect(()=>service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'empty',record:empty})).toThrow(/有效作品/);
    expect(all()).toEqual(before);
  });

  it('metadata-only completion stays A, has explicit delivery repair, old planner cannot complete that retry',()=>{
    const first=creator(),task=claimed(first.id);
    service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'metadata',record:record('First','100',false)});
    expect(service.get(task.id)?.sourceState).toMatchObject({metadataAccepted:true,deliveryReady:false,deliveryEvidence:'missing'});
    const before=all(); expect(service.planSelected({creatorIds:[first.id]}).items[0].result).toBe('delivery_required');expect(all()).toEqual(before);
    expect(service.planSelected({creatorIds:[first.id],retry:true}).taskIds).toEqual([task.id]);
    service.planLocalOnly(); expect(service.get(task.id)?.status).toBe('pending');
    const [retry]=service.claim({workerId:'repair',taskIds:[task.id]});expect(retry.attemptCount).toBe(2);
    service.complete({id:task.id,workerId:'repair',expectedAttempt:2,canonicalCreatorId:first.id,receiptId:'delivery',record:record()});
    expect(service.get(task.id)?.sourceState.deliveryReady).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_works').get()).toEqual({n:2});
  });

  it('distinguishes historical delivery from new verification and excludes missing paths from Stage2',()=>{
    const first=creator(); const legacy=record(); delete (legacy.baidu as {verification?:unknown}).verification;
    new ArchiveCatalogService(db).importCostuanRecord(legacy);
    expect(service.sourceState(first.id).deliveryEvidence).toBe('historical');
    db.prepare("UPDATE archive_catalog_deliveries SET destination_path='' ").run();
    expect(service.sourceState(first.id).deliveryReady).toBe(false);
    expect(new ArchiveDownloadTaskService(db).planMissing({creatorIds:[first.id],targetRoot:path.join(root,'inbox')})).toMatchObject({created:0,skippedWithoutDelivery:2});
  });

  it('finalizes zero-local only for accepted exact receipt scope, without local scanning or unrelated writes',async()=>{
    const first=creator(),other=creator('Other'),task=claimed(first.id);
    const untouched=service.planSelected({creatorIds:[other.id]});
    service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'first',record:record()});
    expect(()=>service.validateFinalize({creatorIds:[first.id,other.id],taskIds:[task.id],workerId:'worker'})).toThrow();
    expect(()=>service.validateFinalize({creatorIds:[first.id],taskIds:[task.id],workerId:'late'})).toThrow();
    expect(()=>service.validateFinalize({creatorIds:[other.id],taskIds:untouched.taskIds,workerId:'worker'})).toThrow();
    const others=JSON.stringify(service.get(untouched.taskIds[0]));
    const scan=vi.spyOn(ArchiveCatalogService.prototype,'reconcileLocalRoot');
    const local=vi.spyOn(ArchiveCatalogService.prototype,'reconcileLocalCreators');
    const ids=service.validateFinalize({creatorIds:[first.id],taskIds:[task.id],workerId:'worker'});
    const pipeline=new ArchiveCatalogPipelineService(db);
    expect(await pipeline.refreshAfterMetadataTasks({creatorIds:ids,galleryRoot:path.join(root,'gallery'),defaultInboxRoot:path.join(root,'inbox')})).toMatchObject({local:null,plan:{created:2}});
    expect(await pipeline.refreshAfterMetadataTasks({creatorIds:ids,galleryRoot:path.join(root,'gallery'),defaultInboxRoot:path.join(root,'inbox')})).toMatchObject({plan:{created:0,existing:2}});
    expect(scan).not.toHaveBeenCalled();expect(local).not.toHaveBeenCalled();expect(await fs.readdir(root)).toEqual([]);
    expect(JSON.stringify(service.get(untouched.taskIds[0]))).toBe(others);
  });

  it('scoped handoff with partially local works plans only missing and never runs global metadata planning',async()=>{
    const first=creator(),other=creator('Other');
    const gallery=path.join(root,'gallery'),work=path.join(gallery,'First','First NO.001 One');
    await fs.mkdir(work,{recursive:true}); await fs.writeFile(path.join(work,'01.jpg'),'fixture');
    await new ArchiveCatalogService(db).reconcileLocalRoot(gallery);
    const task=claimed(first.id); service.planSelected({creatorIds:[other.id]});
    service.complete({id:task.id,workerId:'worker',expectedAttempt:1,canonicalCreatorId:first.id,receiptId:'partial',record:record()});
    const beforeOther=table('archive_catalog_metadata_tasks');
    const global=vi.spyOn(ArchiveCatalogService.prototype,'reconcileLocalRoot');
    const plan=vi.spyOn(ArchiveMetadataTaskService.prototype,'planLocalOnly');
    expect(await new ArchiveCatalogPipelineService(db).refreshAfterMetadataTasks({creatorIds:[first.id],galleryRoot:gallery,defaultInboxRoot:path.join(root,'inbox')})).toMatchObject({plan:{created:1}});
    expect(new ArchiveDownloadTaskService(db).list().items.map(task=>task.targetFilename)).toEqual(['002.7z']);
    expect(global).not.toHaveBeenCalled();expect(plan).not.toHaveBeenCalled();expect(table('archive_catalog_metadata_tasks')).toBe(beforeOther);
  });

  it('seeded Stage2 claim only reconciles that creator and rejects unavailable sources without widening scope',async()=>{
    const first=creator(),other=creator('Other'),catalog=new ArchiveCatalogService(db),download=new ArchiveDownloadTaskService(db);
    catalog.importCostuanRecord(record());catalog.importCostuanRecord(record('Other','200'));
    download.planMissing({creatorIds:[first.id,other.id],targetRoot:path.join(root,'inbox')});
    const gallery=path.join(root,'gallery'),work=path.join(gallery,'Other','Other NO.001 One');
    await fs.mkdir(work,{recursive:true});await fs.writeFile(path.join(work,'01.jpg'),'fixture');
    await catalog.reconcileLocalRoot(gallery);
    const others=JSON.stringify(download.list({creatorId:other.id}).items);
    const seed=download.list({creatorId:first.id}).items[0].id;
    expect(download.claim({workerId:'stage2',seedTaskId:seed,limit:500}).map(task=>task.creatorId)).toEqual([first.id,first.id]);
    expect(JSON.stringify(download.list({creatorId:other.id}).items)).toBe(others);
    const otherSeed=download.list({creatorId:other.id}).items[0].id;
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=?').run(other.id);
    const before=all();
    expect(()=>download.claim({workerId:'stage2',seedTaskId:otherSeed})).toThrow(/停用/);
    expect(()=>download.claim({workerId:'stage2',seedTaskId:0})).toThrow(/无效/);
    expect(()=>download.claim({workerId:'stage2',seedTaskId:99999})).toThrow(/不存在/);
    expect(all()).toEqual(before);
    db.prepare('UPDATE archive_catalog_creators SET is_active=1 WHERE id=?').run(other.id);
    db.prepare("UPDATE archive_catalog_deliveries SET destination_path='' WHERE source_folder_name='200'").run();
    const missingDelivery=all();
    expect(()=>download.claim({workerId:'stage2',seedTaskId:otherSeed})).toThrow(/来源目录不可用/);expect(all()).toEqual(missingDelivery);
  });
});
