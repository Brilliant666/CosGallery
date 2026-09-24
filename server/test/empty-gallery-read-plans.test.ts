import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

describe.sequential('sparse saved-item and place reads',()=>{
 let root:string;
 let repos:typeof import('../src/db/repositories.js');
 let manager:typeof import('../src/db/database.js')['databaseManager'];
 let gallery:typeof import('../src/services/gallery-service.js')['galleryService'];
 beforeAll(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'sparse-gallery-reads-'));
  for(const key of ['DATA_ROOT','GALLERY_ROOT','DB_DIR','THUMBNAILS_DIR','PREVIEWS_DIR'])vi.stubEnv(key,path.join(root,key));
  vi.stubEnv('NODE_ENV','test');vi.resetModules();
  ({databaseManager:manager}=await import('../src/db/database.js'));
  repos=await import('../src/db/repositories.js');
  ({galleryService:gallery}=await import('../src/services/gallery-service.js'));
 });
 afterAll(async()=>{manager.close();vi.unstubAllEnvs();vi.resetModules();await fs.rm(root,{recursive:true,force:true});});
 it.each(['likes','collections','places'] as const)('%s restricts candidate Posts before expensive visibility relationships',kind=>{
  const prepared=vi.spyOn(manager.connection,'prepare');
  if(kind==='likes')expect(repos.likeRepository.listLikedImages()).toEqual([]);
  if(kind==='collections')expect(repos.collectionRepository.listSummaries().every(row=>row.item_count===0)).toBe(true);
  if(kind==='places')expect(repos.placeRepository.list()).toEqual([]);
  const sql=prepared.mock.calls.map(call=>call[0]).find(s=>s.includes('presentation_copy'))!;prepared.mockRestore();
  expect(sql).toBeTruthy();
  const plan=manager.connection.prepare('EXPLAIN QUERY PLAN '+sql).all(...(kind==='likes'?[1000,0]:[])) as Array<{detail:string}>;
  expect(plan.map(p=>p.detail).join('\n')).not.toContain('idx_posts_visible_sort');
  expect(plan.map(p=>p.detail).join('\n')).toMatch(kind==='places'?/idx_posts_place_visibility/:/SEARCH posts USING INTEGER PRIMARY KEY/);
 });
 it('reflects nonempty likes, saved membership, place changes, removal and current storage failures without cached empty answers',()=>{
  const folder=repos.folderRepository.upsert({slug:'synthetic',name:'Synthetic',folderPath:'synthetic'});
  const image=repos.imageRepository.upsert({folderId:folder.id,filename:'photo.jpg',extension:'.jpg',relativePath:'synthetic/photo.jpg',absolutePath:path.join(root,'GALLERY_ROOT','synthetic','photo.jpg'),fileSize:10,width:10,height:10,mediaType:'image',mimeType:'image/jpeg',durationMs:null,fingerprint:'synthetic',mtimeMs:1000,firstSeenAt:'2026-01-01',sortTimestamp:1000,takenAt:1000,takenAtSource:'mtime',exifJson:'{}',thumbnailPath:'a/photo.webp',previewPath:'a/photo.webp'});
  gallery.likeImage(image.id);gallery.addImageToCollection('saved',image.id);
  const placeId=Number(manager.connection.prepare("INSERT INTO places(slug,display_name,kind,source) VALUES('test-place','Test place','city','manual')").run().lastInsertRowid);
  manager.connection.prepare('UPDATE posts SET place_id=? WHERE id=?').run(placeId,image.id);
  expect(gallery.getLikes().items.map(i=>i.id)).toEqual([image.id]);
  expect(gallery.getCollections().items.find(c=>c.slug==='saved')?.itemCount).toBe(1);
  expect(gallery.listPlaces().map(p=>p.id)).toEqual([placeId]);
  for(const kind of ['likes','collections','places'] as const){
   const captured=vi.spyOn(manager.connection,'prepare');
   if(kind==='likes')repos.likeRepository.listLikedImages();
   if(kind==='collections')repos.collectionRepository.listSummaries();
   if(kind==='places')repos.placeRepository.list();
   const sql=captured.mock.calls.map(call=>call[0]).find(s=>s.includes('presentation_copy'))!;captured.mockRestore();
   const args=kind==='likes'?[1000,0]:[];
   expect(manager.connection.prepare(sql).all(...args)).toEqual(manager.connection.prepare(sql.replaceAll('CROSS JOIN posts','INNER JOIN posts')).all(...args));
  }
  manager.connection.prepare('UPDATE posts SET is_trashed=1 WHERE id=?').run(image.id);
  expect(gallery.getLikes().items).toEqual([]);expect(gallery.listPlaces()).toEqual([]);
  expect(gallery.getCollections().items.find(c=>c.slug==='saved')?.itemCount).toBe(0);
  manager.connection.prepare('UPDATE posts SET is_trashed=0 WHERE id=?').run(image.id);
  const stat=fsSync.statSync;
  const failing=vi.spyOn(fsSync,'statSync').mockImplementation(((file,...args)=>{
   if(String(file)===path.join(root,'GALLERY_ROOT'))throw new Error('Synthetic storage failure');
   return (stat as (...args:unknown[])=>unknown)(file,...args);
  }) as typeof fsSync.statSync);
  try {expect(gallery.getStatus().storage.available).toBe(false);expect(gallery.getLikes().items).toEqual([]);}
  finally {failing.mockRestore();}
  expect(gallery.getStatus().storage.available).toBe(true);
  expect(gallery.getLikes().items.map(i=>i.id)).toEqual([image.id]);
  gallery.unlikeImage(image.id);gallery.unsaveImage(image.id);
  manager.connection.prepare('UPDATE posts SET place_id=NULL WHERE id=?').run(image.id);
  expect(gallery.getLikes().items).toEqual([]);expect(gallery.listPlaces()).toEqual([]);
  expect(gallery.getCollections().items.find(c=>c.slug==='saved')?.itemCount).toBe(0);
 });
});
