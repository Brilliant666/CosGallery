import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {requestTestApp} from './http-test-utils.js';

describe.sequential('source evidence protected HTTP and claimed plugin handoff',()=>{
  let app:express.Application,root:string,creatorId:number,taskId:number,attempt:number,observationId:number;
  let db:typeof import('../src/db/database.js')['databaseManager'];
  let bridgeHeaders:Record<string,string>;
  const base='/api/admin/archive-catalog/source-evidence',bridge='/api/archive-bridge';
  const headers={'x-foldergram-intent':'1'};
  const record={platform:'costuan',pageUrl:'https://www.costuan.com/123.html',pageTitle:'Evidence COS写真图片包合集[3套][持续更新]',
    method:'plugin',rawDirectoryText:'NO.001 No name\nNO.018-NO.026 Group\nUnknown text',observedAt:'2026-09-01T00:00:00Z'};
  beforeAll(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'source-evidence-http-'));
    await fs.mkdir(path.join(root,'gallery'));
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');
    for(const [key,leaf] of Object.entries({DATA_ROOT:'',DB_DIR:'db',GALLERY_ROOT:'gallery',THUMBNAILS_DIR:'thumbnails',PREVIEWS_DIR:'previews'}))vi.stubEnv(key,path.join(root,leaf));
    vi.resetModules();db=(await import('../src/db/database.js')).databaseManager;
    app=(await import('../src/app.js')).createApp();
    creatorId=new (await import('../src/services/managed-creator-service.js')).ManagedCreatorService().create({name:'Evidence'}).id;
    const metadata=new (await import('../src/services/archive-metadata-task-service.js')).ArchiveMetadataTaskService();
    const plan=metadata.planSelected({creatorIds:[creatorId],requestId:'isolated'});
    const task=metadata.claim({workerId:'fixture-plugin',taskIds:plan.taskIds,rounds:plan.items.map(item=>({taskId:item.task!.id,checkRoundId:item.task!.checkRoundId!}))})[0];
    taskId=task.id;attempt=task.attemptCount;
    bridgeHeaders={'x-cosgallery-bridge-token':new (await import('../src/services/archive-bridge-service.js')).ArchiveBridgeService().rotateToken()};
  });
  afterAll(async()=>{db.close();vi.unstubAllEnvs();vi.resetModules();await fs.rm(root,{recursive:true,force:true});});
  it('requires bridge token, advertises capability and stores partial evidence without completing task',async()=>{
    expect((await requestTestApp(app,'GET',bridge+'/ping',bridgeHeaders)).body.capabilities.sourceEvidenceV1).toBe(true);
    const endpoint=bridge+`/metadata-tasks/${taskId}/source-evidence`;
    const payload={workerId:'fixture-plugin',expectedAttempt:attempt,canonicalCreatorId:creatorId,requestId:'http-receipt',record};
    expect((await requestTestApp(app,'POST',endpoint,{},payload)).status).toBe(401);
    const before=db.connection.prepare('SELECT * FROM archive_catalog_metadata_tasks').all();
    const result=await requestTestApp(app,'POST',endpoint,bridgeHeaders,payload);
    expect(result.status,JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ok:true,recorded:true,observation:{identityState:'candidate',completeness:'partial'}});
    observationId=result.body.observation.id;
    expect((await requestTestApp(app,'POST',endpoint,bridgeHeaders,payload)).body.observation.id).toBe(observationId);
    expect(db.connection.prepare('SELECT * FROM archive_catalog_metadata_tasks').all()).toEqual(before);
    expect(db.connection.prepare('SELECT count(*) n FROM archive_catalog_download_tasks').get()).toEqual({n:0});
    expect(db.connection.prepare('SELECT count(*) n FROM archive_catalog_works').get()).toEqual({n:0});
    for(const change of [{workerId:'other'},{expectedAttempt:attempt+1},{canonicalCreatorId:creatorId+999}])expect((await requestTestApp(app,'POST',endpoint,bridgeHeaders,{...payload,...change})).body.ok).not.toBe(true);
  });
  it('manual writes need intent, strict schema and authenticated capability; identity uses revision not client creator alone',async()=>{
    const input={creatorId,requestId:'manual',record:{platform:'sndiary',pageUrl:'https://example.test/source',pageTitle:'No list',method:'manual',rawDirectoryText:''}};
    expect((await requestTestApp(app,'POST',base,{},input)).status).toBe(403);
    const created=await requestTestApp(app,'POST',base,headers,input);
    expect(created.status).toBe(201);
    expect(created.body.observation.identityState).toBe('candidate');
    const id=created.body.observation.id;
    expect((await requestTestApp(app,'POST',base+`/${id}/confirm-identity`,headers,{creatorId,requestId:'confirm',reason:'verified page',expectedRevision:0})).body.observation.identityState).toBe('confirmed');
    expect((await requestTestApp(app,'POST',base+`/${id}/confirm-identity`,headers,{creatorId,requestId:'old',reason:'late',expectedRevision:0})).status).toBe(409);
    expect((await requestTestApp(app,'GET',base+`?creatorId=${creatorId}&limit=1`)).body).toMatchObject({total:2,limit:1});
    expect((await requestTestApp(app,'GET',base+`/${observationId}`)).body.rawDirectoryText).toBe(record.rawDirectoryText);
    expect((await requestTestApp(app,'POST',base,headers,{...input,record:{...input.record,forceComplete:true}})).status).toBe(400);
  });
  it('accepts bounded larger plain text on evidence routes only; denies HTML and over-limit text',async()=>{
    const input={creatorId,requestId:'large',record:{platform:'ecytt',pageUrl:'https://example.test/large',pageTitle:'Large',method:'manual',rawDirectoryText:'资料'.repeat(60000)}};
    const result=await requestTestApp(app,'POST',base,headers,input);
    expect(result.status,JSON.stringify(result.body)).toBe(201);
    expect(result.body.observation.rawDirectoryText.length).toBe(120000);
    expect((await requestTestApp(app,'POST',base,headers,{...input,requestId:'too-large',record:{...input.record,rawDirectoryText:'x'.repeat(200001)}})).status).toBe(400);
    expect((await requestTestApp(app,'POST',base,headers,{...input,requestId:'html',record:{...input.record,rawDirectoryText:'<body><script>bad</script></body>'}})).status).toBe(400);
  });
  it('viewer cannot enumerate, read or mutate evidence; bridge remains independent of browser admin session',async()=>{
    const {authService}=await import('../src/services/auth-service.js');
    authService.setAdminPassword('synthetic-admin-pass');authService.setViewerAccess('password','synthetic-viewer-pass');
    const login=await requestTestApp(app,'POST','/api/auth/login',headers,{password:'synthetic-viewer-pass'});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    expect((await requestTestApp(app,'GET',base+`?creatorId=${creatorId}`,{cookie})).status).toBe(403);
    expect((await requestTestApp(app,'GET',base+`/${observationId}`,{cookie})).status).toBe(403);
    expect((await requestTestApp(app,'POST',base+`/${observationId}/confirm-identity`,{...headers,cookie},{creatorId,requestId:'deny',reason:'denied',expectedRevision:0})).status).toBe(403);
    expect((await requestTestApp(app,'GET',bridge+'/ping',bridgeHeaders)).status).toBe(200);
  });
});
