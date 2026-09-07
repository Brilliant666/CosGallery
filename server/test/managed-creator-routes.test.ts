import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';

describe.sequential('managed creator admin API', () => {
  let app:express.Application, tempRoot:string;
  let db:typeof import('../src/db/database.js')['databaseManager'];
  let id:number, folderId:number;
  const base='/api/admin/archive-catalog';
  const headers={'x-foldergram-intent':'1'};
  beforeAll(async()=>{
    tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'roster-routes-'));
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('COS_GALLERY_MODE','1');vi.stubEnv('DATA_ROOT',tempRoot);vi.stubEnv('GALLERY_ROOT',path.join(tempRoot,'gallery'));vi.stubEnv('DB_DIR',path.join(tempRoot,'db'));
    await fs.mkdir(path.join(tempRoot,'gallery','Unlinked'),{recursive:true});vi.resetModules();
    db=(await import('../src/db/database.js')).databaseManager;
    app=(await import('../src/app.js')).createApp();
    folderId=Number(db.connection.prepare(`INSERT INTO folders(slug,name,folder_path) VALUES('unlinked','Unlinked','Unlinked')`).run().lastInsertRowid);
    db.connection.prepare(`INSERT INTO posts(folder_id,source_path,caption,post_type,sort_timestamp) VALUES(?,'Unlinked/work/image.jpg','Test','single',1)`).run(folderId);
    const imageId=Number(db.connection.prepare(`INSERT INTO images(folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
      VALUES(?,'image.jpg','.jpg','Unlinked/work/image.jpg','fixture',1,20,30,'image/jpeg','fixture',1,'fixed',1,'fixture.jpg','fixture.jpg')`).run(folderId).lastInsertRowid);
    db.connection.prepare('INSERT INTO post_items(post_id,image_id,position) VALUES(1,?,1)').run(imageId);
  });
  afterAll(async()=>{db.close();vi.unstubAllEnvs();vi.resetModules();await fs.rm(tempRoot,{recursive:true,force:true});});
  it('enforces intent, strict input and creates only canonical metadata',async()=>{
    expect((await requestTestApp(app,'POST',base+'/creators',{}, {name:'A'})).status).toBe(403);
    expect((await requestTestApp(app,'POST',base+'/creators',headers,{name:'A',seed_source:'bad'})).status).toBe(400);
    const result=await requestTestApp(app,'POST',base+'/creators',headers,{name:'A',rating:'R18'});
    expect(result.status).toBe(201);id=result.body.id;
    expect(result.body).toMatchObject({name:'A',isActive:true,rating:'R18',preference:null});
    expect((await requestTestApp(app,'POST',base+'/creators',headers,{name:'A'})).body).toMatchObject({code:'CREATOR_IDENTITY_AMBIGUOUS',candidates:[{id,name:'A'}]});
    expect((await requestTestApp(app,'PATCH',base+'/creators/9999',headers,{rating:null})).status).toBe(404);
    expect((await requestTestApp(app,'DELETE',base+`/creators/${id}`,headers)).status).toBe(404);
  });
  it('uses explicit IDs for legacy rating PATCH, distinguishes unlinked and unclassified, hides inactive',async()=>{
    let response=await requestTestApp(app,'PATCH',`/api/cos-gallery/creators/${folderId}/content-rating`,headers,{contentRating:'R15'});
    expect(response.status).toBe(409);expect(response.body.code).toBe('CREATOR_NOT_LINKED');
    expect((await requestTestApp(app,'GET','/api/cos-gallery/creators?contentRating=unlinked')).body.items).toHaveLength(1);
    expect((await requestTestApp(app,'POST',base+`/local-creator-folders/${folderId}/link`,headers,{creatorId:id})).status).toBe(200);
    response=await requestTestApp(app,'PATCH',`/api/cos-gallery/creators/${folderId}/content-rating`,headers,{contentRating:null});
    expect(response.status).toBe(200);expect(response.body.creator).toMatchObject({canonicalCreatorId:id,canonicalName:'A',contentRating:null,linkStatus:'linked'});
    expect((await requestTestApp(app,'GET','/api/cos-gallery/creators?contentRating=unclassified')).body.total).toBe(1);
    expect((await requestTestApp(app,'GET','/api/cos-gallery/creators?contentRating=unlinked')).body.total).toBe(0);
    await requestTestApp(app,'POST',base+`/creators/${id}/deactivate`,headers,{confirm:true});
    expect((await requestTestApp(app,'GET','/api/cos-gallery/creators')).body.total).toBe(0);
    expect((await requestTestApp(app,'GET','/api/cos-gallery/creators?contentRating=inactive')).body.total).toBe(1);
    expect((await requestTestApp(app,'GET','/api/folders/unlinked')).status).toBe(200);
    expect(db.connection.prepare('SELECT count(*) AS count FROM creator_rating_sources').get()).toEqual({count:0});
  });
  it('validates and serializes preferred destination changes without scanning or creating jobs',async()=>{
    const beforeScans=db.connection.prepare('SELECT COUNT(*) AS count FROM scan_runs').get();
    const beforeJobs=db.connection.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get();
    const preferenceUrl=base+`/creators/${id}/ingest-destination`;
    let response=await requestTestApp(app,'GET',preferenceUrl);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      creatorId:id,
      mode:'single-linked',
      preferredLocalCreatorFolderId:null,
      resolvedGalleryFolderId:folderId,
      candidates:[expect.objectContaining({galleryFolderId:folderId,valid:true})]
    });
    const bridgeId=response.body.candidates[0].localCreatorFolderId as number;
    expect((await requestTestApp(app,'PUT',preferenceUrl,headers,{localCreatorFolderId:bridgeId,extra:true})).status).toBe(400);

    const {localIngestOperationCoordinator}=await import('../src/services/local-ingest-operation-coordinator.js');
    let release!:()=>void;
    const held=localIngestOperationCoordinator.run(
      {state:'running',kind:'batch',message:'held for route test'},
      ()=>new Promise<void>(resolve=>{release=resolve;})
    );
    await vi.waitFor(()=>expect(localIngestOperationCoordinator.snapshot().state).toBe('running'));
    response=await requestTestApp(app,'PUT',preferenceUrl,headers,{localCreatorFolderId:bridgeId});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('LOCAL_INGEST_OPERATION_ACTIVE');
    response=await requestTestApp(app,'POST',base+`/local-creator-folders/${folderId}/unlink`,headers,{confirm:true});
    expect(response.status).toBe(409);
    release();await held;

    response=await requestTestApp(app,'PUT',preferenceUrl,headers,{localCreatorFolderId:bridgeId});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({mode:'explicit',preferredLocalCreatorFolderId:bridgeId});
    response=await requestTestApp(app,'PUT',preferenceUrl,headers,{localCreatorFolderId:null});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({mode:'single-linked',preferredLocalCreatorFolderId:null});
    expect(db.connection.prepare('SELECT COUNT(*) AS count FROM scan_runs').get()).toEqual(beforeScans);
    expect(db.connection.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get()).toEqual(beforeJobs);
  });
  it('requires administrator capability even for alias and relationship mutations',async()=>{
    const {authService}=await import('../src/services/auth-service.js');
    authService.setAdminPassword('fixture-admin-password');
    authService.setViewerAccess('password','fixture-viewer-password');
    const login=await requestTestApp(app,'POST','/api/auth/login',headers,{password:'fixture-viewer-password'});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    for(const [method,url,body] of [
      ['POST',base+'/creators',{name:'Blocked'}],['PATCH',base+`/creators/${id}`,{rating:'R18'}],
      ['POST',base+`/creators/${id}/aliases`,{alias:'Blocked'}],['POST',base+`/creators/${id}/restore`,{confirm:true}],
      ['POST',base+`/local-creator-folders/${folderId}/unlink`,{confirm:true}]
    ] as const) expect((await requestTestApp(app,method,url,{...headers,cookie},body)).status).toBe(403);
    expect((await requestTestApp(app,'GET',base,{cookie})).status).toBe(403);
    for(const table of ['local_ingest_jobs','archive_catalog_download_tasks','archive_catalog_metadata_tasks']) expect(db.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({count:0});
  });
});
