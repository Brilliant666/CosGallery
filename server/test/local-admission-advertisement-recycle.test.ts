import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

describe.sequential('exact admission advertisement recycling',()=>{
  let root:string,gallery:string,creator:number,sequence=0;
  let manager:typeof import('../src/db/database.js')['databaseManager'];
  let Service:typeof import('../src/services/local-folder-admission-service.js')['LocalFolderAdmissionService'];
  let service:InstanceType<typeof Service>;
  const recycled:string[]=[];
  const recycle=vi.fn(async(targetPath:string)=>{
    const destination=path.join(root,'synthetic-recycle',String(recycled.length));
    await fs.mkdir(path.dirname(destination),{recursive:true});await fs.rename(targetPath,destination);recycled.push(targetPath);
    return {targetPath,recycled:true};
  });
  beforeAll(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'admission-ad-recycle-'));gallery=path.join(root,'gallery');
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');vi.stubEnv('PUBLIC_DEMO_MODE','1');
    for(const [key,dir] of Object.entries({DATA_ROOT:path.join(root,'data'),GALLERY_ROOT:gallery,DB_DIR:path.join(root,'db'),THUMBNAILS_DIR:path.join(root,'thumbs'),PREVIEWS_DIR:path.join(root,'previews')})){
      vi.stubEnv(key,dir);await fs.mkdir(dir,{recursive:true});
    }
    vi.resetModules();({databaseManager:manager}=await import('../src/db/database.js'));
    const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');
    creator=new ManagedCreatorService(manager.connection,gallery).create({name:'Synthetic Recycle Creator',rating:'R15',preference:'liked'}).id;
    ({LocalFolderAdmissionService:Service}=await import('../src/services/local-folder-admission-service.js'));
  });
  beforeEach(()=>{recycle.mockClear();service=new Service(manager.connection,gallery,{recycler:{recycle}});});
  afterAll(()=>{manager.close();vi.unstubAllEnvs();});
  async function plan(mode?:'recycle_bin'){
    const name=`Synthetic advertisement ${++sequence}`,input=path.join(root,`input-${sequence}`),source=path.join(input,name);
    await fs.mkdir(path.join(source,'nested'),{recursive:true});
    await sharp({create:{width:24,height:36,channels:3,background:'#2468aa'}}).jpeg().toFile(path.join(source,'photo.jpg'));
    await fs.copyFile(path.join(source,'photo.jpg'),path.join(source,'492.jpg'));
    await fs.writeFile(path.join(source,'nested','ad.url'),'[InternetShortcut]\nURL=https://invalid.example');
    await fs.writeFile(path.join(source,'keep.txt'),'Unselected attachment');
    const preview=await service.preview({creatorId:creator,inputRoot:input,directories:[name]});
    return {...preview,confirmed:true,...(mode?{advertisementDisposition:mode}:{}),items:preview.items.map(item=>({...item,reason:'Exact synthetic advertisement consent',approvedAds:['492.jpg','nested/ad.url']}))};
  }
  type Plan=Awaited<ReturnType<typeof plan>>;
  const checkpoint=(p:Plan)=>manager.connection.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(p.planId,p.items[0].key)!;
  const savedPlan=(p:Plan)=>manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId)!;
  const savedAd=(p:Plan,relative='492.jpg')=>path.join(p.inputRoot,'.local-admission-attachments',p.planId,p.items[0].key,relative);
  const entries=(p:Plan)=>p.items[0].approvedAds.map(relativePath=>({itemKey:p.items[0].key,entry:p.items[0].manifest.find(entry=>entry.relativePath===relativePath)!}));
  const request=(p:Plan)=>({confirmed:true,planId:p.planId,key:`historical-${p.planId}`,reason:'Explicit exact historical advertisement recycle',files:entries(p)});

  it('recycles explicit new-plan advertisements once, prunes only empty containers and still verifies completed media',async()=>{
    const p=await plan('recycle_bin');const done=await service.apply(p);
    expect(done.completed).toBe(true);expect(checkpoint(p).state).toBe('completed');expect(recycle).toHaveBeenCalledTimes(2);
    expect(done.items[0].excludedAttachments.every(file=>file.status==='removed_by_explicit_decision')).toBe(true);
    await expect(fs.stat(path.join(p.inputRoot,'.local-admission-attachments'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await fs.readFile(path.join(p.items[0].targetPath,'keep.txt'),'utf8')).toBe('Unselected attachment');
    const before=savedPlan(p);await service.apply(p);expect(recycle).toHaveBeenCalledTimes(2);expect(savedPlan(p)).toEqual(before);
    await fs.appendFile(path.join(p.items[0].targetPath,'photo.jpg'),'changed');
    await expect(service.apply(p)).rejects.toThrow('changed');expect(recycle).toHaveBeenCalledTimes(2);
  });

  it('keeps recycle failure indexed and retries only the remaining exact advertisements',async()=>{
    const p=await plan('recycle_bin');recycle.mockRejectedValueOnce(new Error('Synthetic recycler unavailable'));
    await expect(service.apply(p)).rejects.toThrow('Synthetic recycler unavailable');
    expect(checkpoint(p).state).toBe('indexed');expect(checkpoint(p).last_error).toContain('Synthetic recycler unavailable');
    await expect(fs.stat(savedAd(p))).resolves.toBeTruthy();
    const before=savedPlan(p);const restarted=new Service(manager.connection,gallery,{recycler:{recycle}});
    await restarted.apply(p);expect(checkpoint(p).state).toBe('completed');expect(savedPlan(p)).toEqual(before);expect(recycle).toHaveBeenCalledTimes(3);
  });

  it('recovers recycle-success/result-write failure from persisted intent before entry verification',async()=>{
    const p=await plan('recycle_bin');
    manager.connection.exec("CREATE TRIGGER synthetic_ad_removal_failure BEFORE INSERT ON archive_catalog_work_decisions WHEN NEW.kind='admission_file_removal' BEGIN SELECT RAISE(FAIL,'Synthetic removal write failure'); END");
    try{await expect(service.apply(p)).rejects.toThrow('Synthetic removal write failure');}
    finally{manager.connection.exec('DROP TRIGGER synthetic_ad_removal_failure');}
    expect(checkpoint(p).state).toBe('indexed');expect(recycle).toHaveBeenCalledTimes(1);
    await expect(fs.stat(savedAd(p))).rejects.toMatchObject({code:'ENOENT'});
    const journal=manager.connection.prepare("SELECT payload_json FROM archive_catalog_work_decisions WHERE kind='admission_advertisement_recycle' AND local_work_id=?").get(checkpoint(p).local_work_id)!;
    expect(JSON.parse(String(journal.payload_json)).phase).toBe('intent');
    await new Service(manager.connection,gallery,{recycler:{recycle}}).apply(p);
    expect(checkpoint(p).state).toBe('completed');expect(recycle).toHaveBeenCalledTimes(2);
    expect(recycle.mock.calls.filter(([target])=>target===savedAd(p))).toHaveLength(1);
  });

  it('handles a lost native success response without repeating the recycled file',async()=>{
    const p=await plan('recycle_bin');
    recycle.mockImplementationOnce(async targetPath=>{await fs.rename(targetPath,path.join(root,'lost-success-ad'));throw Error('Synthetic lost success response');});
    await expect(service.apply(p)).rejects.toThrow('Synthetic lost success response');expect(checkpoint(p).state).toBe('indexed');
    await service.apply(p);expect(checkpoint(p).state).toBe('completed');expect(recycle).toHaveBeenCalledTimes(2);
  });

  it('does not repeat recycling after result persistence but before the completed checkpoint',async()=>{
    const p=await plan('recycle_bin');
    manager.connection.exec("CREATE TRIGGER synthetic_ad_completed_failure BEFORE UPDATE ON archive_local_admission_items WHEN NEW.state='completed' BEGIN SELECT RAISE(FAIL,'Synthetic completed write failure'); END");
    try{await expect(service.apply(p)).rejects.toThrow('Synthetic completed write failure');}
    finally{manager.connection.exec('DROP TRIGGER synthetic_ad_completed_failure');}
    expect(checkpoint(p).state).toBe('indexed');expect(recycle).toHaveBeenCalledTimes(2);
    await service.apply(p);expect(checkpoint(p).state).toBe('completed');expect(recycle).toHaveBeenCalledTimes(2);
  });

  it('never accepts unexplained disappearance before durable intent or changed saved evidence',async()=>{
    const p=await plan('recycle_bin');
    manager.connection.exec("CREATE TRIGGER synthetic_ad_intent_failure BEFORE INSERT ON archive_catalog_work_decisions WHEN NEW.kind='admission_advertisement_recycle' BEGIN SELECT RAISE(FAIL,'Synthetic intent write failure'); END");
    try{await expect(service.apply(p)).rejects.toThrow('Synthetic intent write failure');}
    finally{manager.connection.exec('DROP TRIGGER synthetic_ad_intent_failure');}
    expect(recycle).not.toHaveBeenCalled();await fs.rename(savedAd(p),path.join(root,'unexplained-missing-ad'));
    await expect(service.apply(p)).rejects.toThrow('changed');expect(recycle).not.toHaveBeenCalled();
    const q=await plan('recycle_bin');recycle.mockRejectedValueOnce(new Error('Synthetic pause'));
    await expect(service.apply(q)).rejects.toThrow('Synthetic pause');await fs.appendFile(savedAd(q),'changed');
    await expect(service.apply(q)).rejects.toThrow('changed');expect(recycle).toHaveBeenCalledTimes(1);
  });

  it('preserves legacy plan behavior and offers exact explicit cleanup without rewriting its checkpoint',async()=>{
    const p=await plan();await service.apply(p);expect(recycle).not.toHaveBeenCalled();await expect(fs.stat(savedAd(p))).resolves.toBeTruthy();
    const original=savedPlan(p),before=checkpoint(p);
    await expect(service.apply({...p,advertisementDisposition:'recycle_bin'})).rejects.toThrow('content changed');
    const preview=await service.previewAdvertisementRecycling({planId:p.planId,itemKeys:[p.items[0].key]});
    expect(preview.confirmed).toBe(false);expect(preview.files).toEqual(entries(p));expect(recycle).not.toHaveBeenCalled();
    const input=request(p);await expect(service.recycleAdvertisements({...input,confirmed:false})).rejects.toThrow();
    await expect(service.recycleAdvertisements({...input,files:[{itemKey:p.items[0].key,entry:p.items[0].manifest.find(entry=>entry.relativePath==='keep.txt')!}]})).rejects.toThrow('exact original approved');
    await service.recycleAdvertisements(input);expect(savedPlan(p)).toEqual(original);expect(checkpoint(p)).toEqual(before);expect(recycle).toHaveBeenCalledTimes(2);
    await service.recycleAdvertisements(input);await service.apply(p);expect(recycle).toHaveBeenCalledTimes(2);
    await expect(service.recycleAdvertisements({...input,reason:'Changed request'})).rejects.toThrow('request changed');
  });

  it('preflights every historical item before recycling any selection',async()=>{
    const draft=await plan(),secondName=draft.items[0].sourceRelativePath+' next';
    await fs.cp(path.join(draft.inputRoot,draft.items[0].sourceRelativePath),path.join(draft.inputRoot,secondName),{recursive:true});
    const preview=await service.preview({creatorId:creator,inputRoot:draft.inputRoot,directories:[draft.items[0].sourceRelativePath,secondName]});
    const p={...preview,confirmed:true,items:preview.items.map(item=>({...item,reason:'Explicit two-item fixture',approvedAds:['492.jpg','nested/ad.url']}))};
    await service.apply(p);await fs.appendFile(path.join(p.items[1].targetPath,'photo.jpg'),'unexpected change');
    const input={confirmed:true,planId:p.planId,key:`scope-${p.planId}`,reason:'Exact two-item cleanup',files:p.items.flatMap(item=>item.approvedAds.map(relativePath=>({itemKey:item.key,entry:item.manifest.find(entry=>entry.relativePath===relativePath)!})))};
    await expect(service.recycleAdvertisements(input)).rejects.toThrow('changed');expect(recycle).not.toHaveBeenCalled();
    expect(manager.connection.prepare("SELECT id FROM archive_catalog_work_decisions WHERE decision_key=?").get(`admission-ad-recycle-request:${input.key}`)).toBeUndefined();
    await expect(fs.stat(savedAd(p))).resolves.toBeTruthy();
  });

  it('keeps interrupted historical cleanup separate and retries its original exact request',async()=>{
    const p=await plan();await service.apply(p);const original=savedPlan(p),input=request(p);
    recycle.mockRejectedValueOnce(new Error('Synthetic historical recycle failure'));
    await expect(service.recycleAdvertisements(input)).rejects.toThrow('Synthetic historical recycle failure');
    expect(checkpoint(p).state).toBe('completed');await service.apply(p);expect(recycle).toHaveBeenCalledTimes(1);
    await expect(service.recycleAdvertisements({...input,key:'different-key'})).rejects.toThrow('original advertisement recycling request');
    await service.recycleAdvertisements(input);expect(recycle).toHaveBeenCalledTimes(3);expect(savedPlan(p)).toEqual(original);
    manager.connection.prepare("UPDATE archive_catalog_work_decisions SET state='revoked' WHERE decision_key=?").run(`admission-ad-recycle-request:${input.key}`);
    await expect(service.apply(p)).rejects.toThrow('request changed or was revoked');expect(recycle).toHaveBeenCalledTimes(3);
  });

  it('does not erase unrelated files or attachment trees while pruning exact empty ancestors',async()=>{
    const p=await plan();await service.apply(p);
    const ownForeign=path.join(path.dirname(savedAd(p)),'keep-foreign.txt');await fs.writeFile(ownForeign,'foreign');
    const sibling=path.join(p.inputRoot,'.local-admission-attachments','unrelated-plan','keep.txt');await fs.mkdir(path.dirname(sibling),{recursive:true});await fs.writeFile(sibling,'unrelated');
    await service.recycleAdvertisements(request(p));
    expect(await fs.readFile(ownForeign,'utf8')).toBe('foreign');expect(await fs.readFile(sibling,'utf8')).toBe('unrelated');
    await expect(fs.stat(path.dirname(savedAd(p,'nested/ad.url')))).rejects.toMatchObject({code:'ENOENT'});
    await service.apply(p);
  });

  it('rejects even an in-root attachment junction before recycling or journaling a file',async()=>{
    const p=await plan();await service.apply(p);
    const itemDirectory=path.dirname(savedAd(p)),relocated=path.join(p.inputRoot,'relocated-advertisements');
    await fs.rename(itemDirectory,relocated);await fs.symlink(relocated,itemDirectory,'junction');
    await expect(service.recycleAdvertisements(request(p))).rejects.toThrow('Linked advertisement path');
    expect(recycle).not.toHaveBeenCalled();expect(await fs.readFile(path.join(relocated,'nested','ad.url'),'utf8')).toContain('invalid.example');
    expect(manager.connection.prepare("SELECT id FROM archive_catalog_work_decisions WHERE kind='admission_advertisement_recycle' AND local_work_id=?").get(checkpoint(p).local_work_id)).toBeUndefined();
    await expect(service.apply(p)).rejects.toThrow('Linked advertisement path');
  });

  it('does not recycle while a caller transaction could still roll back the intent',async()=>{
    const p=await plan();await service.apply(p);manager.connection.exec('BEGIN');
    try{await expect(service.recycleAdvertisements(request(p))).rejects.toThrow('committed intent outside a caller transaction');}
    finally{manager.connection.exec('ROLLBACK');}
    expect(recycle).not.toHaveBeenCalled();await expect(fs.stat(savedAd(p))).resolves.toBeTruthy();
  });

  it('rejects reappeared recycled advertisements and revoked removal evidence',async()=>{
    const p=await plan('recycle_bin');await service.apply(p);
    await fs.mkdir(path.dirname(savedAd(p)),{recursive:true});await fs.writeFile(savedAd(p),'returned');
    await expect(service.apply(p)).rejects.toThrow('present again');expect(recycle).toHaveBeenCalledTimes(2);
    await fs.rename(savedAd(p),path.join(root,'returned-ad'));
    manager.connection.prepare("UPDATE archive_catalog_work_decisions SET state='revoked' WHERE kind='admission_file_removal' AND local_work_id=?").run(checkpoint(p).local_work_id);
    await expect(service.apply(p)).rejects.toThrow('changed');expect(recycle).toHaveBeenCalledTimes(2);
  });
});
