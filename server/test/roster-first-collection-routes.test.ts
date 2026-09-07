import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {requestTestApp} from './http-test-utils.js';

describe.sequential('roster first-collection HTTP contract',()=>{
  let app:express.Application,root:string,id:number,taskId:number;
  let db:typeof import('../src/db/database.js')['databaseManager'];
  let bridgeHeaders:Record<string,string>;
  const base='/api/admin/archive-catalog/metadata-tasks',bridge='/api/archive-bridge';
  const headers={'x-foldergram-intent':'1'};
  beforeAll(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'roster-handoff-routes-'));
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');
    for(const [key,leaf] of Object.entries({DATA_ROOT:'',DB_DIR:'db',GALLERY_ROOT:'gallery',THUMBNAILS_DIR:'thumbnails',PREVIEWS_DIR:'previews'})) vi.stubEnv(key,path.join(root,leaf));
    vi.resetModules();db=(await import('../src/db/database.js')).databaseManager;
    app=(await import('../src/app.js')).createApp();
    const {ManagedCreatorService}=await import('../src/services/managed-creator-service.js');
    id=new ManagedCreatorService().create({name:'HttpFirst',rating:'R18',aliases:['HttpAlias']}).id;
    const {ArchiveBridgeService}=await import('../src/services/archive-bridge-service.js');
    bridgeHeaders={'x-cosgallery-bridge-token':new ArchiveBridgeService().rotateToken()};
  });
  afterAll(async()=>{db.close();vi.unstubAllEnvs();vi.resetModules();await fs.rm(root,{recursive:true,force:true});});

  it('read-only candidates do not plan, mutation needs intent and strict nonempty ID input',async()=>{
    expect((await requestTestApp(app,'GET',base+'/candidates?q=HttpAlias')).body).toMatchObject({total:1,items:[{creatorId:id,localWorks:0,task:null}]});
    expect(db.connection.prepare('SELECT COUNT(*) AS n FROM archive_catalog_metadata_tasks').get()).toEqual({n:0});
    expect((await requestTestApp(app,'POST',base+'/plan-selected',{}, {creatorIds:[id]})).status).toBe(403);
    for(const body of [{creatorIds:[]},{creatorIds:[String(id)]},{creatorIds:[id],all:true},{creatorIds:[99999]}]) {
      expect((await requestTestApp(app,'POST',base+'/plan-selected',headers,body)).status).toBe(400);
    }
    const plan=await requestTestApp(app,'POST',base+'/plan-selected',headers,{creatorIds:[id]});
    expect(plan.status).toBe(200); taskId=plan.body.taskIds[0];
    expect((await requestTestApp(app,'POST',base+'/plan-selected',headers,{creatorIds:[id]})).body.taskIds).toEqual([taskId]);
  });

  it('advertises capabilities, old claim cannot take explicit tasks, GET refresh has no side effects',async()=>{
    expect((await requestTestApp(app,'GET',bridge+'/ping')).status).toBe(401);
    expect((await requestTestApp(app,'GET',bridge+'/ping',bridgeHeaders)).body).toMatchObject({version:3,capabilities:{rosterFirstCollectionV1:true}});
    expect((await requestTestApp(app,'POST',bridge+'/metadata-tasks/claim',bridgeHeaders,{workerId:'old'})).body.items).toEqual([]);
    expect((await requestTestApp(app,'POST',bridge+'/metadata-tasks/claim',bridgeHeaders,{workerId:'new',taskIds:[]})).status).toBe(400);
    const result=await requestTestApp(app,'POST',bridge+'/metadata-tasks/claim',bridgeHeaders,{workerId:'new',taskIds:[taskId]});
    expect(result.body.items).toMatchObject([{id:taskId,creatorId:id,canonicalCreatorId:id,aliases:['HttpAlias','HttpFirst'],explicitSelection:true,status:'claimed'}]);
    const before=JSON.stringify(db.connection.prepare('SELECT * FROM archive_catalog_metadata_tasks').all());
    await requestTestApp(app,'GET',bridge+'/metadata-tasks?page=1&limit=1',bridgeHeaders);
    await requestTestApp(app,'GET',base+'/candidates?hasSource=all');
    expect(JSON.stringify(db.connection.prepare('SELECT * FROM archive_catalog_metadata_tasks').all())).toBe(before);
  });

  it('preflight is read only, complete requires canonical identity and replay receipt; finalize empty explicit body is rejected',async()=>{
    const validation={workerId:'new',expectedAttempt:1,canonicalCreatorId:id,postId:'fixture-http',title:'HttpFirst COS写真图片包合集[1套][持续更新]'};
    expect((await requestTestApp(app,'POST',bridge+`/metadata-tasks/${taskId}/validate-source`,bridgeHeaders,validation)).body.ok).toBe(true);
    expect(db.connection.prepare('SELECT COUNT(*) AS n FROM archive_catalog_collections').get()).toEqual({n:0});
    const record={creatorName:'HttpFirst',costuan:{postId:'fixture-http',title:validation.title,works:[{order:1,sourceOrder:'NO.001',label:'One'}]}};
    expect((await requestTestApp(app,'PATCH',bridge+`/metadata-tasks/${taskId}`,bridgeHeaders,{workerId:'new',status:'completed',record})).status).toBe(400);
    const body={workerId:'new',status:'completed',expectedAttempt:1,canonicalCreatorId:id,receiptId:'http-fixture',record};
    const result=await requestTestApp(app,'PATCH',bridge+`/metadata-tasks/${taskId}`,bridgeHeaders,body);
    expect(result.body.task).toMatchObject({status:'completed',sourceState:{metadataAccepted:true,deliveryReady:false}});
    expect((await requestTestApp(app,'PATCH',bridge+`/metadata-tasks/${taskId}`,bridgeHeaders,body)).body).toEqual(result.body);
    for(const invalid of [undefined,{}, {creatorIds:[],taskIds:[],workerId:'new'}]) {
      expect((await requestTestApp(app,'POST',bridge+'/metadata-tasks/finalize-selected',bridgeHeaders,invalid)).status).toBe(400);
    }
    expect(db.connection.prepare('SELECT COUNT(*) AS n FROM scan_runs').get()).toEqual({n:0});
  });

  it('viewer cannot enumerate selection candidates or plan explicit tasks',async()=>{
    const {authService}=await import('../src/services/auth-service.js');
    authService.setAdminPassword('synthetic-admin-pass');authService.setViewerAccess('password','synthetic-viewer-pass');
    const login=await requestTestApp(app,'POST','/api/auth/login',headers,{password:'synthetic-viewer-pass'});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    expect((await requestTestApp(app,'GET',base+'/candidates',{cookie})).status).toBe(403);
    expect((await requestTestApp(app,'POST',base+'/plan-selected',{...headers,cookie},{creatorIds:[id]})).status).toBe(403);
  });
});
