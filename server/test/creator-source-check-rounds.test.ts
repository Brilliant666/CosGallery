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
import {CreatorSyncQueryService} from '../src/services/creator-sync-query-service.js';
import {parseCostuanDirectoryText} from '../src/services/costuan-numbering-service.js';

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
  const directRequest=(task:ArchiveMetadataTask,count=3)=>({...request(task,count),record:{...record(task,count),baidu:{
    transport:'direct-share',status:'share-verified',shareUrl:'https://pan.baidu.com/s/1fixture',sourceFolderName:'467',
    verification:{method:'share-read',complete:true,checkedAt:'2026-09-08T01:00:00Z',checkRoundId:task.checkRoundId,
      files:Array.from({length:count},(_,index)=>`${String(index+1).padStart(3,'0')}.7z`)}}}});
  beforeEach(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'creator-check-rounds-'));
    db=new DatabaseSync(':memory:');db.exec(schemaSql);service=new ArchiveMetadataTaskService(db);
    creatorId=new ManagedCreatorService(db,path.join(root,'gallery')).create({name:'Fixture',preference:'liked'}).id;
  });
  afterEach(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});

  it('hands a read-only original share to Stage2 without inventing an owned intermediate directory or staging early',()=>{
    const task=claim('direct'),payload=directRequest(task);
    service.complete(payload);
    const accepted=snapshot();service.complete(payload);expect(snapshot()).toBe(accepted);
    const delivery=db.prepare('SELECT * FROM archive_catalog_deliveries').get()!;
    expect(delivery).toMatchObject({status:'share-verified',destination_path:null,transferred_at:null,source_folder_name:'467'});
    expect(service.sourceState(creatorId)).toMatchObject({deliveryReady:true,deliveryEvidence:'verified',deliveryMode:'direct-share'});
    const query=new CreatorSyncQueryService(db);
    expect(query.roster().items[0].sourceState).toMatchObject({deliveryReady:true,deliveryEvidence:'verified',deliveryMode:'direct-share'});
    const downloads=new ArchiveDownloadTaskService(db);
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')}).created).toBe(3);
    const seed=downloads.list().items[0];
    expect(seed).toMatchObject({sourceMode:'direct-share',sourceShareUrl:payload.record.baidu.shareUrl,
      destinationPath:'',sourceFolderName:'467',status:'pending',targetRelativeDirectory:'Fixture'});
    expect(query.downloadTaskPage({creatorId}).items[0]).toMatchObject({sourceMode:'direct-share',sourceShareUrl:payload.record.baidu.shareUrl});
    const claimed=downloads.claim({seedTaskId:seed.id,workerId:'worker',limit:500});
    expect(claimed).toHaveLength(3);expect(claimed.every(item=>item.status==='claimed')).toBe(true);
    downloads.update(seed.id,{status:'staged',workerId:'worker'});
    expect(downloads.get(seed.id)?.status).toBe('staged');
    const next=plan('next').items[0].task!;
    expect(next.lastSuccessfulSource).toMatchObject({sourceMode:'direct-share',sourceShareUrl:payload.record.baidu.shareUrl,destinationPath:null});
  });

  it.each(['incomplete','old-round','missing-file','duplicate-file','owned-url','init-url','foreign-host','saved-lie','intermediate-lie'])
    ('rejects %s direct share evidence without changing previous accepted source or task state',mode=>{
      const first=claim('before-direct');service.complete(request(first));
      const task=claim('direct-invalid'),payload=directRequest(task);
      if(mode==='incomplete')payload.record.baidu.verification.complete=false;
      if(mode==='old-round')payload.record.baidu.verification.checkRoundId=first.checkRoundId;
      if(mode==='missing-file')payload.record.baidu.verification.files.pop();
      if(mode==='duplicate-file')payload.record.baidu.verification.files.push('001.7Z');
      if(mode==='owned-url')payload.record.baidu.shareUrl='https://pan.baidu.com/disk/main#/index?path=/cos图集/467';
      if(mode==='init-url')payload.record.baidu.shareUrl='https://pan.baidu.com/share/init?surl=fixture';
      if(mode==='foreign-host')payload.record.baidu.shareUrl='https://pan.baidu.com.example.org/s/fixture';
      if(mode==='saved-lie')payload.record.baidu.status='saved';
      if(mode==='intermediate-lie')Object.assign(payload.record.baidu,{destinationPath:'我的网盘/cos图集'});
      const before=snapshot();expect(()=>service.complete(payload)).toThrow(/原分享|原分享中的/);expect(snapshot()).toBe(before);
    });

  it('retains the complete raw share manifest without creating tasks for non-numbered appendices',()=>{
    const task=claim('full-manifest'),payload=directRequest(task);
    payload.record.baidu.verification.files=['001.7Z','002.7z','003.7z','微博图.7z','说明.txt'];
    service.complete(payload);
    const saved=JSON.parse(String(db.prepare('SELECT metadata_json FROM archive_catalog_deliveries').get()?.metadata_json));
    expect(saved.verification.files).toEqual(payload.record.baidu.verification.files);
    const downloads=new ArchiveDownloadTaskService(db);
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')}).created).toBe(3);
    expect(downloads.claim({seedTaskId:downloads.list().items[0].id,workerId:'worker',limit:500})).toHaveLength(3);
  });

  it('resumes the same metadata claim, replaces old intermediate delivery and preserves pending/claimed download identities',()=>{
    const first=claim('old-owned'),legacy=request(first);
    // An older source uses a different key; it must not win because it has a
    // transferred_at value while a read-only share deliberately has none.
    service.complete(legacy);
    const downloads=new ArchiveDownloadTaskService(db),targetRoot=path.join(root,'inbox');
    downloads.planMissing({creatorIds:[creatorId],targetRoot});
    const original=downloads.list().items;
    downloads.claim({seedTaskId:original[0].id,workerId:'worker',limit:1});
    const task=claim('resume-direct');
    expect(claim('resume-direct')).toMatchObject({id:task.id,checkRoundId:task.checkRoundId,attemptCount:task.attemptCount});
    const payload=directRequest(task);service.complete(payload);
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot})).toMatchObject({created:0,existing:3,removedOutOfScope:0});
    const current=downloads.list().items;
    expect(current.map(item=>item.id).sort()).toEqual(original.map(item=>item.id).sort());
    expect(current.every(item=>item.sourceMode==='direct-share' && item.sourceFolderName==='467' && item.destinationPath==='')).toBe(true);
    expect(downloads.get(original[0].id)).toMatchObject({status:'claimed',claimedBy:'worker',attemptCount:1});
    const originalSourceIds=db.prepare('SELECT id FROM archive_catalog_source_works ORDER BY id').all();
    const collection=JSON.parse(String(db.prepare('SELECT metadata_json FROM archive_catalog_collections').get()?.metadata_json));
    expect(collection.works).toHaveLength(3);
    expect(originalSourceIds).toHaveLength(3);
    // A corrupted/missing current file proof cannot fall back to an old saved
    // intermediate directory, and existing task identities are not deleted.
    const delivery=db.prepare("SELECT id,metadata_json FROM archive_catalog_deliveries WHERE source_folder_name='467'").get()!;
    const proof=JSON.parse(String(delivery.metadata_json));proof.verification.files=[];
    db.prepare('UPDATE archive_catalog_deliveries SET metadata_json=? WHERE id=?').run(JSON.stringify(proof),Number(delivery.id));
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot})).toMatchObject({created:0,removedOutOfScope:0,skippedWithoutDelivery:3});
    expect(()=>downloads.claim({seedTaskId:original[1].id,workerId:'worker',limit:500})).toThrow(/来源目录不可用/);
    expect(downloads.list().total).toBe(3);
  });

  it('only plans newly missing verified files from direct shares when historical packages are already local',async()=>{
    const first=claim('direct-first');service.complete(directRequest(first));
    const gallery=path.join(root,'gallery');
    for(let order=1;order<=3;order++) {
      const directory=path.join(gallery,'Fixture',`Fixture NO.${String(order).padStart(3,'0')} Work ${order}`);
      await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'1.jpg'),'synthetic scan fixture');
    }
    await new ArchiveCatalogService(db).reconcileLocalRoot(gallery);
    const second=claim('direct-incremental'),payload=directRequest(second,4);payload.record.baidu.verification.files=['004.7z'];
    expect(service.validateDirectory(payload).requiredFilenames).toEqual(['004.7z']);
    service.complete(payload);
    const downloads=new ArchiveDownloadTaskService(db);
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')}).created).toBe(1);
    expect(downloads.list().items.map(item=>item.targetFilename)).toEqual(['004.7z']);
    // A later local-state change must not turn an unverified old filename into
    // a claimable download just because another file in the share was proven.
    db.prepare('UPDATE archive_catalog_local_works SET is_active=0').run();
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')})).toMatchObject({created:0,skippedWithoutDelivery:3});
  });

  const reviewedFixture=(task:ArchiveMetadataTask)=>{
    const original='Fixture NO.002 Old [94P-442M]',selected='Fixture NO.002 New [96P10V-1.58GB]',supplement='Fixture 推图集 [1034P5V-133MB]';
    const raw=['资源目录',supplement,'Fixture NO.001 First [1P]',original,selected,'Fixture NO.003 Last [1P]'].join('\n');
    const payload={...record(task),costuan:{...record(task).costuan,resourceDirectoryText:raw,
      works:raw.split('\n').flatMap(line=>parseCostuanDirectoryText(line)).filter(work=>work.order!==undefined),
      directoryVerification:{complete:false,checkedAt:'2026-09-08T01:00:00Z',parsedWorkCount:4}}};
    const review={collectionTitle:payload.costuan.title,numberingKey:'NO:002',originalRawTitle:original,selectedRawTitle:selected,
      supplementalRawTitles:[supplement],approvedAt:'2026-09-10T01:00:00Z'};
    return {payload,review};
  };

  it('uses only a persisted exact human decision and keeps raw revisions without creating an appendix task',()=>{
    const task=claim('human-review'),{payload,review}=reviewedFixture(task),catalog=new ArchiveCatalogService(db);
    const options={id:task.id,workerId:'worker',expectedAttempt:task.attemptCount,canonicalCreatorId:creatorId,record:payload};
    const initial=snapshot();expect(()=>service.validateDirectory(options)).toThrow();expect(snapshot()).toBe(initial);
    catalog.saveCostuanDirectoryReview(creatorId,review);
    const before=snapshot();catalog.saveCostuanDirectoryReview(creatorId,review);expect(snapshot()).toBe(before);
    expect(()=>catalog.saveCostuanDirectoryReview(creatorId,{...review,selectedRawTitle:'different'})).toThrow(/覆盖/);
    expect(()=>catalog.saveCostuanDirectoryReview(creatorId+1,review)).toThrow(/身份/);
    const proof=service.validateDirectory(options);expect(snapshot()).toBe(before);
    expect(proof.canonicalWorks).toHaveLength(3);
    expect(proof.canonicalWorks[1].rawTitle).toBe(review.selectedRawTitle);
    expect(proof.supplementalContents).toMatchObject([{rawTitle:review.supplementalRawTitles[0],status:'awaiting_review'}]);
    expect(proof.acceptedDirectoryRevisions).toMatchObject([{originalRawTitle:review.originalRawTitle,selectedRawTitle:review.selectedRawTitle}]);
    const completion={...request(task),record:{...payload,costuan:{...payload.costuan,works:proof.canonicalWorks,directoryVerification:proof.canonicalDirectoryVerification}}};
    service.complete(completion);
    const saved=JSON.parse(String(db.prepare('SELECT metadata_json FROM archive_catalog_collections').get()?.metadata_json));
    expect(saved.resourceDirectoryText).toBe(payload.costuan.resourceDirectoryText);
    expect(saved.acceptedDirectoryRevisions).toEqual(proof.acceptedDirectoryRevisions);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_source_works WHERE is_active=1').get()?.n).toBe(3);
    new ArchiveDownloadTaskService(db).planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')});
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_download_tasks').get()?.n).toBe(3);
    const accepted=snapshot();service.complete(completion);expect(snapshot()).toBe(accepted);
  });

  it.each(['original','selected','appendix','extra-duplicate','title','missing-old','incomplete-input'])
    ('does not broaden the human approval to changed %s evidence',mode=>{
      const task=claim('invalid-human-review'),{payload,review}=reviewedFixture(task);
      new ArchiveCatalogService(db).saveCostuanDirectoryReview(creatorId,review);
      if(mode==='original')payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace('94P','95P');
      if(mode==='selected')payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace('96P','97P');
      if(mode==='appendix')payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace('1034P','1035P');
      if(mode==='extra-duplicate')payload.costuan.resourceDirectoryText+='\nFixture NO.001 Another [1P]';
      if(mode==='title')payload.costuan.title=payload.costuan.title.replace('[3套]','[4套]');
      if(mode==='missing-old')payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace(review.originalRawTitle,'');
      if(mode==='incomplete-input')payload.costuan.works.pop();
      const before=snapshot();expect(()=>service.validateDirectory({id:task.id,workerId:'worker',expectedAttempt:task.attemptCount,canonicalCreatorId:creatorId,record:payload})).toThrow(/审核记录/);
      expect(snapshot()).toBe(before);
    });

  it('accepts postposed Cosplay category through preflight and completion without widening creator ownership',()=>{
    const task=claim('postfix-title'),payload=request(task);
    payload.record.costuan.title='Fixture写真图片包合集[3套][Cosplay][持续更新]';
    const options={id:task.id,workerId:'worker',expectedAttempt:task.attemptCount,canonicalCreatorId:creatorId,
      postId:payload.record.costuan.postId,title:payload.record.costuan.title};
    const before=snapshot();expect(service.validateSource(options).id).toBe(task.id);expect(snapshot()).toBe(before);
    expect(service.validateDirectory({...options,record:payload.record}).sourceFilenames).toHaveLength(3);
    service.complete(payload);
    expect(db.prepare('SELECT creator_id FROM archive_catalog_collections').get()?.creator_id).toBe(creatorId);
    const other=new ManagedCreatorService(db,path.join(root,'gallery')).create({name:'Other'}).id;
    const catalog=new ArchiveCatalogService(db),accepted=snapshot();
    expect(()=>catalog.validateCostuanIdentity(other,payload.record.costuan.postId,'Other写真图片包合集[3套][Cosplay][持续更新]')).toThrow(/身份/);
    expect(()=>catalog.validateCostuanIdentity(creatorId,'new-post','Other写真图片包合集[3套][Cosplay][持续更新]')).toThrow(/身份/);
    expect(snapshot()).toBe(accepted);
    db.prepare("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES (?,?,?,'manual')").run(other,'Fixture','fixture');
    const ambiguous=snapshot();
    expect(()=>catalog.validateCostuanIdentity(creatorId,'unowned-post',payload.record.costuan.title)).toThrow(/歧义/);
    expect(snapshot()).toBe(ambiguous);
  });

  const withSupplement=(task:ArchiveMetadataTask,count=182,titleLabel='微博图',directoryLabel='微博图')=>{
    const payload=record(task,count);
    return {...payload,costuan:{...payload.costuan,title:`Fixture COS写真图片包合集[${count}套+${titleLabel}][持续更新]`,
      resourceDirectoryText:['资源目录',`Fixture ${directoryLabel}[354P-1.8GB]`,...payload.costuan.works.map(work=>
        `Fixture ${work.order===100?'NO.0100':work.sourceOrder} ${work.label}[1P]`)].join('\n')}};
  };

  it('accepts a synthetic 161-work direct-share fixture with mismatched Weibo aliases but never plans its appendix',()=>{
    // Synthetic numbered records exercise the reported title/directory shape;
    // they are not a capture or assertion of the current live 938.html catalog.
    const task=claim('weibo-alias-direct'),direct=directRequest(task,161);
    const payload={...direct,record:{...withSupplement(task,161,'微博散图','微博配图'),baidu:direct.record.baidu}};
    payload.record.baidu.verification.files.push('微博配图.7z');
    const before=snapshot(),proof=service.validateDirectory(payload);
    expect(snapshot()).toBe(before);
    expect(proof.requiredFilenames).toHaveLength(161);
    expect(proof.requiredFilenames[160]).toBe('161.7z');
    expect(proof.requiredFilenames.every(filename=>/^\d{3}\.7z$/u.test(filename))).toBe(true);
    expect(proof.supplementalContents).toMatchObject([{label:'Fixture 微博配图',rawTitle:'Fixture 微博配图[354P-1.8GB]',status:'awaiting_review'}]);
    service.complete(payload);
    const saved=JSON.parse(String(db.prepare('SELECT metadata_json FROM archive_catalog_collections').get()?.metadata_json));
    expect(saved.supplementalContents).toEqual(proof.supplementalContents);
    expect(saved.resourceDirectoryText).toBe(payload.record.costuan.resourceDirectoryText);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_source_works WHERE is_active=1').get()?.n).toBe(161);
    const downloads=new ArchiveDownloadTaskService(db);
    expect(downloads.planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')}).created).toBe(161);
    expect(downloads.list({limit:500}).items).toHaveLength(161);
    expect(downloads.list({limit:500}).items.every(item=>/^\d{3}\.7z$/u.test(item.targetFilename))).toBe(true);
    expect(new CreatorSyncQueryService(db).roster().items[0].pendingSupplementalTitles).toEqual(['Fixture 微博配图']);
    const accepted=snapshot();service.complete(payload);expect(snapshot()).toBe(accepted);
  });

  it.each(['unknown-title-alias','unknown-directory-alias','foreign-creator','duplicate-aliases','duplicate-number','missing-appendix','missing-number','incomplete-input'])
    ('keeps source data unchanged for %s even when Weibo aliases are recognized',mode=>{
      const original=claim('before-alias-invalid');service.complete(request(original));
      const task=claim('alias-invalid'),payload=withSupplement(task,3,'微博散图','微博配图');
      if(mode==='unknown-title-alias') payload.costuan.title=payload.costuan.title.replace('+微博散图','+微博合集');
      if(mode==='unknown-directory-alias') payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace('Fixture 微博配图','Fixture 微博写真');
      if(mode==='foreign-creator') payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace('Fixture 微博配图','Other 微博配图');
      if(mode==='duplicate-aliases') payload.costuan.resourceDirectoryText+='\nFixture 微博散图[2P-1MB]';
      if(mode==='duplicate-number') payload.costuan.resourceDirectoryText+='\nFixture NO.001 Work 1[1P]';
      if(mode==='missing-appendix') payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace('Fixture 微博配图[354P-1.8GB]','');
      if(mode==='missing-number') payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace(/\nFixture NO.003[^\n]*/u,'');
      if(mode==='incomplete-input') payload.costuan.works.pop();
      const options={...request(task),record:payload},before=snapshot();
      expect(()=>service.validateDirectory(options)).toThrow(/附加内容|编号目录/);
      expect(snapshot()).toBe(before);
      expect(()=>service.complete(options)).toThrow(/附加内容|编号目录/);
      expect(snapshot()).toBe(before);
    });

  it('keeps 182 numbered works automatic and persists the appendix as pending manual evidence, without a download task',()=>{
    const task=claim('appendix'),payload=withSupplement(task);
    const options={id:task.id,workerId:'worker',expectedAttempt:task.attemptCount,canonicalCreatorId:creatorId,record:payload};
    const before=snapshot(),proof=service.validateDirectory(options);
    expect(snapshot()).toBe(before);
    expect(proof.requiredFilenames).toHaveLength(182);
    expect(proof.requiredFilenames).toContain('100.7z');
    expect(proof.supplementalContents).toMatchObject([{label:'Fixture 微博图',rawTitle:'Fixture 微博图[354P-1.8GB]',status:'awaiting_review'}]);
    const completion={...request(task,182),record:payload};
    service.complete(completion);
    const saved=JSON.parse((db.prepare('SELECT metadata_json FROM archive_catalog_collections').get() as {metadata_json:string}).metadata_json);
    expect(saved.supplementalContents).toEqual(proof.supplementalContents);
    expect(saved.resourceDirectoryText).toBe(payload.costuan.resourceDirectoryText);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_source_works WHERE is_active=1').get()?.n).toBe(182);
    new ArchiveDownloadTaskService(db).planMissing({creatorIds:[creatorId],targetRoot:path.join(root,'inbox')});
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_download_tasks').get()?.n).toBe(182);
    const accepted=snapshot();service.complete(completion);expect(snapshot()).toBe(accepted);
    const next=claim('appendix-next'),missing=record(next,182),unchanged=snapshot();
    expect(()=>service.complete({...request(next,182),record:missing})).toThrow(/附加内容缺失/);
    expect(snapshot()).toBe(unchanged);
  });

  it.each(['missing-number','duplicate-number','unadvertised','foreign-appendix','unknown-appendix','duplicate-appendix','missing-appendix'])
    ('does not use supplemental separation to bypass %s validation',mode=>{
      const task=claim('appendix-invalid'),payload=withSupplement(task,3);
      if(mode==='missing-number') payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace(/\nFixture NO.003[^\n]*/u,'');
      if(mode==='duplicate-number') payload.costuan.resourceDirectoryText+='\nFixture NO.001 Work 1[1P]';
      if(mode==='unadvertised') payload.costuan.title=payload.costuan.title.replace('+微博图','');
      if(mode==='foreign-appendix') payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace('Fixture 微博图','Other 微博图');
      if(mode==='unknown-appendix') payload.costuan.resourceDirectoryText+='\nFixture 花絮[2P]';
      if(mode==='duplicate-appendix') payload.costuan.resourceDirectoryText+='\nFixture 微博图[354P-1.8GB]';
      if(mode==='missing-appendix') payload.costuan.resourceDirectoryText=payload.costuan.resourceDirectoryText.replace('Fixture 微博图[354P-1.8GB]','');
      const before=snapshot();
      expect(()=>service.validateDirectory({id:task.id,workerId:'worker',expectedAttempt:task.attemptCount,canonicalCreatorId:creatorId,record:payload})).toThrow(/附加内容|编号目录/);
      expect(snapshot()).toBe(before);
    });

  it('does not silently deactivate an appendix already recorded as an active historical Source Work',()=>{
    const first=claim('historical-special');service.complete(request(first));
    db.prepare("UPDATE archive_catalog_source_works SET source_order_label='SPECIAL:fixture微博图',source_work_id='SPECIAL:fixture微博图',source_title='Fixture 微博图' WHERE source_work_id='NO.001'").run();
    const next=claim('historical-special-next'),before=snapshot();
    expect(()=>service.complete({...request(next),record:withSupplement(next,3)})).toThrow(/已有来源编号缺失/);
    expect(snapshot()).toBe(before);
  });

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
