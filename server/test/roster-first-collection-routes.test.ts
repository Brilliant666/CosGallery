import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {requestTestApp} from './http-test-utils.js';

describe.sequential('roster first-collection HTTP contract',()=>{
  let app:express.Application,root:string,id:number,taskId:number,noTaskId:number,checkRoundId:string;
  let db:typeof import('../src/db/database.js')['databaseManager'];
  let bridgeHeaders:Record<string,string>;
  const base='/api/admin/archive-catalog/metadata-tasks',bridge='/api/archive-bridge';
  const headers={'x-foldergram-intent':'1'};
  const admin='/api/admin/archive-catalog';
  const snapshot=()=>JSON.stringify(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>{
    const name=String(row.name);
    return [name,db.connection.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()];
  }));
  const withoutReadAt=(body:Record<string,unknown>)=>{const {readAt,...result}=body;expect(readAt).toEqual(expect.any(String));return result;};
  beforeAll(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'roster-handoff-routes-'));
    await fs.mkdir(path.join(root,'gallery'));
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');
    for(const [key,leaf] of Object.entries({DATA_ROOT:'',DB_DIR:'db',GALLERY_ROOT:'gallery',THUMBNAILS_DIR:'thumbnails',PREVIEWS_DIR:'previews'})) vi.stubEnv(key,path.join(root,leaf));
    vi.resetModules();db=(await import('../src/db/database.js')).databaseManager;
    app=(await import('../src/app.js')).createApp();
    const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');
    id=new ManagedCreatorService().create({name:'HttpFirst',rating:'R18',aliases:['HttpAlias']}).id;
    noTaskId=new ManagedCreatorService().create({name:'HttpNoTask',rating:'R15'}).id;
    const {ArchiveBridgeService}=await import('../src/services/archive-bridge-service.js');
    bridgeHeaders={'x-cosgallery-bridge-token':new ArchiveBridgeService().rotateToken()};
  });
  afterAll(async()=>{db.close();vi.unstubAllEnvs();vi.resetModules();await fs.rm(root,{recursive:true,force:true});});

  it('read-only candidates do not plan, mutation needs intent and strict nonempty ID input',async()=>{
    expect((await requestTestApp(app,'GET',base+'/candidates?q=HttpAlias')).body).toMatchObject({total:1,items:[{creatorId:id,localWorks:0,task:null}]});
    expect(db.connection.prepare('SELECT COUNT(*) AS n FROM archive_catalog_metadata_tasks').get()).toEqual({n:0});
    expect((await requestTestApp(app,'POST',base+'/plan-selected',{}, {creatorIds:[id]})).status).toBe(403);
    for(const body of [{creatorIds:[id]},{creatorIds:[],requestId:'invalid'}, {creatorIds:[String(id)],requestId:'invalid'},{creatorIds:[id],requestId:'invalid',all:true},{creatorIds:[99999],requestId:'invalid'}]) {
      expect((await requestTestApp(app,'POST',base+'/plan-selected',headers,body)).status).toBe(400);
    }
    const plan=await requestTestApp(app,'POST',base+'/plan-selected',headers,{creatorIds:[id],requestId:'http-first-round'});
    expect(plan.status).toBe(200); taskId=plan.body.taskIds[0];
    checkRoundId=plan.body.items[0].task.checkRoundId;
    expect(checkRoundId).toEqual(expect.any(String));
    expect((await requestTestApp(app,'POST',base+'/plan-selected',headers,{creatorIds:[id],requestId:'http-first-round'})).body).toMatchObject({taskIds:[taskId],replayed:true});
  });

  it('advertises capabilities, old claim cannot take explicit tasks, GET refresh has no side effects',async()=>{
    expect((await requestTestApp(app,'GET',bridge+'/ping')).status).toBe(401);
    expect((await requestTestApp(app,'GET',bridge+'/ping',bridgeHeaders)).body).toMatchObject({version:4,capabilities:{rosterFirstCollectionV1:true,unifiedCreatorSyncV1:true,baiduDirectStageV1:true}});
    expect((await requestTestApp(app,'POST',bridge+'/metadata-tasks/claim',bridgeHeaders,{workerId:'old'})).status).toBe(400);
    expect((await requestTestApp(app,'POST',bridge+'/metadata-tasks/claim',bridgeHeaders,{workerId:'new',taskIds:[]})).status).toBe(400);
    for(const rounds of [undefined,[{taskId,checkRoundId:'wrong-round'}]]) {
      const rejected=await requestTestApp(app,'POST',bridge+'/metadata-tasks/claim',bridgeHeaders,{workerId:'new',taskIds:[taskId],rounds});
      expect(rejected.status,JSON.stringify(rejected.body)).toBe(409);
      expect(rejected.body.message).toContain('checkRoundId');
    }
    const result=await requestTestApp(app,'POST',bridge+'/metadata-tasks/claim',bridgeHeaders,{workerId:'new',taskIds:[taskId],rounds:[{taskId,checkRoundId}]});
    expect(result.body.items).toMatchObject([{id:taskId,creatorId:id,canonicalCreatorId:id,creatorName:'HttpFirst',aliases:['HttpAlias'],explicitSelection:true,status:'claimed'}]);
    const before=JSON.stringify(db.connection.prepare('SELECT * FROM archive_catalog_metadata_tasks').all());
    await requestTestApp(app,'GET',bridge+'/metadata-tasks?page=1&limit=1',bridgeHeaders);
    await requestTestApp(app,'GET',base+'/candidates?hasSource=all');
    expect(JSON.stringify(db.connection.prepare('SELECT * FROM archive_catalog_metadata_tasks').all())).toBe(before);
  });

  it('preflight is read only, complete requires canonical identity and replay receipt; finalize empty explicit body is rejected',async()=>{
    const validation={workerId:'new',expectedAttempt:1,canonicalCreatorId:id,postId:'fixture-http',title:'HttpFirst COS写真图片包合集[1套][持续更新]'};
    expect((await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-source`,bridgeHeaders,validation)).body.ok).toBe(true);
    const evidenceRequest={...validation,postId:'463',resourceDirectoryText:'HttpFirst NO.001 One [1P-1MB]',
      identityEvidence:{version:1,pageUrl:'https://www.costuan.com/463.html',creatorTags:[{name:'HttpFirst',url:'https://www.costuan.com/tag/87'}]}};
    const beforeEvidence=snapshot();
    const evidenceResult=await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-source`,bridgeHeaders,evidenceRequest);
    expect(evidenceResult.status).toBe(200);
    expect(evidenceResult.body.task.identityVerification).toMatchObject({method:'exact-name',creatorId:id,postId:'463'});
    const wrongPage=await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-source`,bridgeHeaders,
      {...evidenceRequest,identityEvidence:{...evidenceRequest.identityEvidence,pageUrl:'https://www.costuan.com/999.html'}});
    expect(wrongPage.status).toBe(400);expect(wrongPage.body.message).toContain('身份页面证据无效');
    expect((await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-source`,bridgeHeaders,{...evidenceRequest,approved:true})).status).toBe(400);
    expect(snapshot()).toBe(beforeEvidence);
    expect(db.connection.prepare('SELECT COUNT(*) AS n FROM archive_catalog_collections').get()).toEqual({n:0});
    const record={creatorName:'HttpFirst',costuan:{postId:'fixture-http',title:validation.title,works:[{order:1,sourceOrder:'NO.001',label:'One'}],
      directoryVerification:{complete:true,checkedAt:'2026-09-08T00:00:00Z',parsedWorkCount:1}},
      baidu:{status:'saved',sourceFolderName:'fixture-http',destinationPath:'我的网盘/cos图集',verification:{method:'saved',checkedAt:'2026-09-08T00:00:00Z',sourceDirectory:'我的网盘/cos图集/fixture-http',checkRoundId,files:['001.7z']}}};
    const before=snapshot();
    const rangeRecord={...record,costuan:{...record.costuan,title:'HttpFirst COS写真合集[4套][持续更新]',collectionCount:4,
      resourceDirectoryText:'HttpFirst NO.001-NO.003 合集 [30P-20MB]\nHttpFirst NO.004 One [1P-1MB]',
      works:[{sourceOrder:'NO.001-NO.003',label:'合集'},{sourceOrder:'NO.004',label:'One',order:4}]}};
    const rangeRequest={workerId:'new',canonicalCreatorId:id,expectedAttempt:1,record:rangeRecord};
    const rangeResponse=await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-directory`,bridgeHeaders,rangeRequest);
    expect(rangeResponse.status).toBe(400);
    expect(rangeResponse.body).toMatchObject({ok:false,code:'COSTUAN_RANGE_DIRECTORY_REVIEW_REQUIRED',coverage:{rawEntryCount:2,
      numberedEntryCount:2,singleEntryCount:1,rangeEntryCount:1,uniqueNumberCount:4,numberingComplete:true,
      ranges:[{sourceOrder:'NO.001-NO.003',count:3,declaredImageCount:30}]}});
    expect(rangeResponse.body).not.toHaveProperty('requiredFilenames');
    const wrongWorker=await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-directory`,bridgeHeaders,{...rangeRequest,workerId:'wrong'});
    expect(wrongWorker.status).not.toBe(200);
    expect(wrongWorker.body).not.toHaveProperty('coverage');
    expect((await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-directory`,{},rangeRequest)).status).toBe(401);
    expect(snapshot()).toBe(before);
    const directory=await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-directory`,bridgeHeaders,{workerId:'new',canonicalCreatorId:id,expectedAttempt:1,record});
    expect(directory.status).toBe(200);expect(directory.body.requiredFilenames).toEqual(['001.7z']);
    expect(snapshot()).toBe(before);
    expect((await requestTestApp(app,'PATCH',bridge+`/metadata-tasks/${taskId}`,bridgeHeaders,{workerId:'new',status:'completed',record})).status).toBe(409);
    expect((await requestTestApp(app,'PATCH',bridge+`/metadata-tasks/${taskId}`,bridgeHeaders,{workerId:'new',status:'completed',expectedAttempt:1,record})).status).toBe(400);
    const body={workerId:'new',status:'completed',expectedAttempt:1,canonicalCreatorId:id,receiptId:'http-fixture',record};
    const result=await requestTestApp(app,'PATCH',bridge+`/metadata-tasks/${taskId}`,bridgeHeaders,body);
    expect(result.status).toBe(200);
    expect(result.body.task).toMatchObject({status:'completed',sourceState:{metadataAccepted:true,deliveryReady:true}});
    expect((await requestTestApp(app,'PATCH',bridge+`/metadata-tasks/${taskId}`,bridgeHeaders,body)).body).toEqual(result.body);
    for(const invalid of [undefined,{}, {creatorIds:[],taskIds:[],workerId:'new'}]) {
      expect((await requestTestApp(app,'POST',bridge+'/metadata-tasks/finalize-selected',bridgeHeaders,invalid)).status).toBe(400);
    }
    expect(db.connection.prepare('SELECT COUNT(*) AS n FROM scan_runs').get()).toEqual({n:0});
  });

  it('finalizes only the accepted attempt, creates scoped gaps once and never scans',async()=>{
    const body={workerId:'new',creatorIds:[id],taskIds:[taskId],attempts:[{taskId,expectedAttempt:1}]};
    const stale=await requestTestApp(app,'POST',bridge+'/metadata-tasks/finalize-selected',bridgeHeaders,{...body,attempts:[{taskId,expectedAttempt:2}]});
    expect(stale.status).toBe(409);expect(stale.body.message).toContain('收尾尝试已变化');
    const result=await requestTestApp(app,'POST',bridge+'/metadata-tasks/finalize-selected',bridgeHeaders,body);
    expect(result.status).toBe(200);
    expect(db.connection.prepare('SELECT COUNT(*) AS n FROM archive_catalog_download_tasks').get()).toEqual({n:1});
    const before=snapshot();
    expect((await requestTestApp(app,'POST',bridge+'/metadata-tasks/finalize-selected',bridgeHeaders,body)).body).toEqual(result.body);
    expect(snapshot()).toBe(before);
    expect(db.connection.prepare('SELECT COUNT(*) AS n FROM scan_runs').get()).toEqual({n:0});
  });

  it('admin and bridge share complete roster, stats and paged download counts without writes',async()=>{
    const before=snapshot();
    for(const endpoint of ['/creator-sync/roster?enabled=all&local=absent&source=all&limit=1',
      '/creator-sync/stats?enabled=all&local=absent&source=all',
      '/creator-sync/metadata-creators?enabled=all&limit=1',
      '/download-creators?enabled=all&status=pending&limit=1',
      `/download-task-page?enabled=all&creatorId=${id}&status=pending&limit=1`]) {
      const web=await requestTestApp(app,'GET',admin+endpoint);
      const extension=await requestTestApp(app,'GET',bridge+endpoint,bridgeHeaders);
      expect(web.status).toBe(200);expect(extension.status).toBe(200);
      expect(web.headers.get('cache-control')).toBe('no-store');expect(extension.headers.get('cache-control')).toBe('no-store');
      expect(withoutReadAt(web.body)).toEqual(withoutReadAt(extension.body));
    }
    const roster=await requestTestApp(app,'GET',admin+'/creator-sync/roster?enabled=all');
    expect(roster.body.total).toBe(2);
    expect(roster.body.items).toContainEqual(expect.objectContaining({creatorId:noTaskId,metadataTask:null,localWorks:0,sourceWorks:0}));
    const stats=await requestTestApp(app,'GET',admin+'/creator-sync/stats?enabled=all');
    expect(stats.body).toMatchObject({creators:{total:2,withSource:1},works:{source:1,missing:1},execution:{metadata:{total:1},download:{total:1}}});
    const metadata=await requestTestApp(app,'GET',admin+'/creator-sync/metadata-creators?enabled=all');
    expect(metadata.body).toMatchObject({total:1,items:[{creatorId:id,metadataTask:{id:taskId,status:'completed'}}],
      summary:{sourceCreators:1,sourceCollections:1,taskTotal:1,tasks:{total:1,completed:1}}});
    for(const endpoint of ['/download-creators?enabled=all&status=pending&limit=1&page=2',`/download-task-page?enabled=all&creatorId=${id}&status=pending&limit=1&page=2`]) {
      expect((await requestTestApp(app,'GET',admin+endpoint)).body).toMatchObject({items:[],total:1,page:2,hasMore:false,summary:{total:1,pending:1}});
    }
    expect((await requestTestApp(app,'GET',admin+`/download-task-page?creatorId=${noTaskId}`)).body).toMatchObject({items:[],total:0,summary:{total:0}});
    expect(snapshot()).toBe(before);
  });

  it('read scopes fail closed and legacy global mutations are retired',async()=>{
    const before=snapshot();
    for(const endpoint of ['/creator-sync/roster?all=true','/creator-sync/stats?local=unknown','/creator-sync/metadata-creators?status=unknown','/creator-sync/metadata-creators?limit=101','/download-creators?status=queued','/download-task-page','/download-task-page?creatorId=0','/download-task-page?creatorId=1&limit=101']) {
      expect((await requestTestApp(app,'GET',admin+endpoint)).status).toBe(400);
      expect((await requestTestApp(app,'GET',bridge+endpoint,bridgeHeaders)).status).toBe(400);
    }
    expect((await requestTestApp(app,'POST',base+'/plan',headers,{})).status).toBe(410);
    expect((await requestTestApp(app,'POST',bridge+'/metadata-tasks/finalize',bridgeHeaders,{})).status).toBe(410);
    expect(snapshot()).toBe(before);
  });

  it('reports validly shaped but impossible read scopes as business input errors without writes',async()=>{
    const before=snapshot();
    const cases=[
      {endpoint:'/creator-sync/roster?page=9007199254740991&limit=100',code:'PAGINATION_RANGE_INVALID',message:'分页范围过大。'},
      {endpoint:'/download-task-page?creatorId=999999999',code:'CREATOR_SCOPE_NOT_FOUND',message:'规范博主不存在，不能将查询失败显示为 0 条。'}
    ];
    for(const item of cases)for(const [prefix,requestHeaders] of [[admin,{}],[bridge,bridgeHeaders]] as const) {
      const result=await requestTestApp(app,'GET',prefix+item.endpoint,requestHeaders);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({code:item.code,message:item.message,requestId:expect.any(String)});
    }
    expect(snapshot()).toBe(before);
  });

  it('viewer cannot enumerate selection candidates or plan explicit tasks',async()=>{
    const {authService}=await import('../src/services/auth-service.js');
    authService.setAdminPassword('synthetic-admin-pass');authService.setViewerAccess('password','synthetic-viewer-pass');
    const login=await requestTestApp(app,'POST','/api/auth/login',headers,{password:'synthetic-viewer-pass'});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    expect((await requestTestApp(app,'GET',base+'/candidates',{cookie})).status).toBe(403);
    expect((await requestTestApp(app,'POST',base+'/plan-selected',{...headers,cookie},{creatorIds:[id]})).status).toBe(403);
    for(const endpoint of ['/creator-sync/roster','/creator-sync/stats','/creator-sync/metadata-creators','/download-creators',`/download-task-page?creatorId=${id}`]) {
      expect((await requestTestApp(app,'GET',admin+endpoint,{cookie})).status).toBe(403);
      expect((await requestTestApp(app,'GET',bridge+endpoint)).status).toBe(401);
      expect((await requestTestApp(app,'GET',bridge+endpoint,bridgeHeaders)).status).toBe(200);
    }
  });
});
