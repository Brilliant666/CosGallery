import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workSortSchemaSql } from '../src/db/work-sort-schema.js';
import { ConfirmedWorkSortService } from '../src/services/confirmed-work-sort-service.js';
import { ResourceCatalogBuilder } from '../src/services/resource-catalog-builder.js';
import { ResourceCatalogReadModel } from '../src/services/resource-catalog-read-model.js';
import { ArchiveLocalFulfillmentService, localVersionSql, fulfillmentValidSql, sourceNeedsAcquisitionSql } from '../src/services/archive-local-fulfillment-service.js';

describe.sequential('confirmed work sort timestamp', () => {
  let root: string;
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  let db: DatabaseSync;
  let repo: typeof import('../src/db/repositories.js')['canonicalCreatorGalleryRepository'];
  let gallery: typeof import('../src/services/gallery-service.js')['galleryService'];
  const plan = () => ({ confirmed: true, decisions: [{
    decisionKey: 'synthetic-birthtime-review', creatorId: 1, workId: 1,
    primaryLocalWorkId: 1, primaryPostId: 1, originalTimestamp: 1001,
    adoptedTimestamp: 9000.25, evidence: { basis: 'original-media-birthtime-max', count: 2, min: 8999.5, max: 9000.25 },
    confirmationSource: 'explicit-user-confirmation',
  }] });
  const generation = (creator = 1) => db.prepare('SELECT generation FROM resource_catalog_state WHERE creator_id=?').get(creator)!.generation;
  const facts = () => Object.fromEntries(['archive_catalog_works','archive_catalog_local_works','posts','images','post_items',
    'archive_catalog_source_works','archive_catalog_download_tasks','archive_catalog_local_fulfillments','archive_catalog_work_decisions']
    .map(table => [table, db.prepare('SELECT * FROM ' + table).all()]));
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-sort-'));
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('COS_GALLERY_MODE', '1');
    for (const key of ['DATA_ROOT','DB_DIR','GALLERY_ROOT','THUMBNAILS_DIR','PREVIEWS_DIR']) {
      const directory = path.join(root,key); fs.mkdirSync(directory); vi.stubEnv(key,directory);
    }
    vi.resetModules();
    ({databaseManager: manager} = await import('../src/db/database.js'));
    db = manager.connection;
    ({canonicalCreatorGalleryRepository: repo} = await import('../src/db/repositories.js'));
    ({galleryService: gallery} = await import('../src/services/gallery-service.js'));
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'One','one','test','1'),(2,'Two','two','test','2');
      INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'one','One','One');
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,1,'root','One','root/One','One','matched','now');`);
    for (let id=1; id<=28; id++) {
      db.prepare('INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(?,1,?)').run(id, id<3?'Same title': 'Title ' + id);
      db.prepare('INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(?,1,?,?)').run(id,'One/Work'+id,1000+id);
      db.prepare(`INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES(?,1,?,NULL,?,?,?,'matched','now')`).run(id,id,'Work'+id,'root/One/Work'+id,'Work'+id);
      // Legacy null post/primary IDs intentionally exercise reliable path resolution.
      for (let position=1; position<=2; position++) {
        const image=id*10+position;
        db.prepare(`INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
          VALUES(?,1,? ,'.jpg',?,?,100,10,10,'image/jpeg','hash',1,'now',?,?,?)`)
          .run(image,image+'.jpg','One/Work'+id+'/'+image+'.jpg',path.join(root,image+'.jpg'),1000+position,'thumb'+image,'preview'+image);
        db.prepare('INSERT INTO post_items(post_id,image_id,position) VALUES(?,?,?)').run(id,image,position);
      }
    }
  });
  afterEach(() => { manager?.close(); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root,{recursive:true,force:true}); });

  it('shares effective time across database pagination, card, detail and full numbering without changing media evidence', () => {
    const before=facts();
    const media=gallery.getCanonicalCreatorWork(1,1)!.mediaItems;
    const snapshotBefore=db.prepare(`SELECT ${localVersionSql('l')} AS evidence FROM archive_catalog_local_works l WHERE id=1`).get();
    expect(repo.listVisibleWorks(1,1,24,'oldest')[0]!.id).toBe(1);
    new ConfirmedWorkSortService(db).apply(plan());
    expect(repo.listVisibleWorks(1,1,24,'oldest')[0]!.id).toBe(2);
    expect(repo.listVisibleWorks(1,2,24,'oldest').at(-1)).toMatchObject({id:1,sortTimestamp:9000.25});
    expect(repo.listVisibleWorks(1,1,24,'newest')[0]).toMatchObject({id:1,sortTimestamp:9000.25});
    expect(gallery.getCanonicalCreatorWork(1,1)).toMatchObject({sortTimestamp:9000.25,mediaItems:media});
    const rows=new ResourceCatalogBuilder(db).generate(1).page.items;
    expect(rows.find(row=>row.workId===1)).toMatchObject({sortTimestamp:9000.25,no:'NO.028'});
    expect(rows.filter(row=>row.title==='Same title')).toHaveLength(2);
    expect(facts()).toEqual(before);
    expect(db.prepare(`SELECT ${localVersionSql('l')} AS evidence FROM archive_catalog_local_works l WHERE id=1`).get()).toEqual(snapshotBefore);
  });

  it('marks only one creator, publishes and reuses persisted values, and identical replay is a no-op', () => {
    const model=new ResourceCatalogReadModel(db);
    model.rebuildCreator(1); model.rebuildCreator(2);
    const other=generation(2), before=generation();
    const service=new ConfirmedWorkSortService(db);
    expect(service.apply(plan()).applied).toHaveLength(1);
    expect(Number(generation())).toBe(Number(before)+1); expect(generation(2)).toBe(other);
    model.rebuildCreator(1);
    const state=db.prepare('SELECT * FROM resource_catalog_state').all();
    expect(service.apply(plan()).unchanged).toHaveLength(1);
    expect(db.prepare('SELECT * FROM resource_catalog_state').all()).toEqual(state);
    db.exec("UPDATE posts SET sort_timestamp=1002 WHERE id=1; UPDATE archive_catalog_works SET display_title='Refreshed' WHERE id=1");
    model.rebuildCreator(1);
    expect(repo.listVisibleWorks(1,1,24)[0]).toMatchObject({id:1,sortTimestamp:9000.25});
    expect(db.prepare('SELECT sort_timestamp FROM resource_catalog_rows WHERE work_id=1').get()!.sort_timestamp).toBe(9000.25);
  });

  it('rejects changed primary, non-confirmed inputs, invalid timestamps and conflicting replay transactionally', () => {
    const service=new ConfirmedWorkSortService(db);
    expect(()=>service.apply({...plan(),confirmed:false})).toThrow();
    expect(()=>service.apply({...plan(),decisions:[{...plan().decisions[0],adoptedTimestamp:NaN}]})).toThrow();
    expect(()=>service.apply({...plan(),decisions:[{...plan().decisions[0],primaryPostId:2}]})).toThrow(/identity/);
    const before=generation();
    expect(()=>service.apply({...plan(),decisions:[plan().decisions[0],{...plan().decisions[0],decisionKey:'second',workId:2}]})).toThrow();
    expect(generation()).toBe(before);
    service.apply(plan());
    expect(()=>service.apply({...plan(),decisions:[{...plan().decisions[0],adoptedTimestamp:9001}]})).toThrow(/different/);
    expect(()=>service.apply({...plan(),decisions:[{...plan().decisions[0],decisionKey:'second'}]})).toThrow(/already/);
  });

  it('keeps evidence after explicit revocation, restores fallback and refuses resurrecting revoked keys', () => {
    const service=new ConfirmedWorkSortService(db); service.apply(plan());
    const old=db.prepare('SELECT evidence_json FROM archive_catalog_work_sort_confirmations').get();
    const before=generation();
    db.exec("UPDATE archive_catalog_work_sort_confirmations SET state='revoked',revoked_at='now'");
    expect(Number(generation())).toBe(Number(before)+1);
    expect(repo.effectiveSortTimestamp(1)).toBe(1001);
    expect(new ResourceCatalogBuilder(db).generate(1).page.items.find(row=>row.workId===1)!.sortTimestamp).toBe(1001);
    expect(db.prepare('SELECT evidence_json FROM archive_catalog_work_sort_confirmations').get()).toEqual(old);
    expect(()=>service.apply(plan())).toThrow(/state/);
  });

  it('fresh and incremental migration are identical, preserve facts and repeat safely', () => {
    const migration=fs.readFileSync(new URL('../db/migrations/000023_work_sort_confirmations.sql',import.meta.url),'utf8');
    const up=migration.split('-- migrate:down')[0]!.replace('-- migrate:up','').trim();
    expect(up.replaceAll('\r\n','\n')).toBe(workSortSchemaSql.trim().replaceAll('\r\n','\n'));
    const before=facts();
    db.exec(migration.split('-- migrate:down')[1]!);
    db.exec(up); db.exec(up);
    expect(facts()).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects legacy path ambiguity with another Work instead of publishing disagreeing projections', () => {
    db.exec(`UPDATE archive_catalog_works SET primary_local_work_id=1 WHERE id=1;
      UPDATE archive_catalog_local_works SET post_id=1 WHERE id=1;
      UPDATE archive_catalog_local_works SET relative_path='/Work1' WHERE id=2;`);
    const before=generation();
    expect(()=>new ConfirmedWorkSortService(db).apply(plan())).toThrow(/ambiguous/);
    expect(generation()).toBe(before);
    expect(db.prepare('SELECT * FROM archive_catalog_work_sort_confirmations').all()).toEqual([]);
  });

  it('keeps an accepted source satisfied and staged task history unchanged after timestamp correction', () => {
    const localPath=path.join(root,'accepted'); fs.mkdirSync(localPath);
    db.prepare('UPDATE archive_catalog_local_works SET post_id=1,absolute_path=? WHERE id=1').run(localPath);
    db.exec(`INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at)
        VALUES(1,1,'synthetic','set','Set','now');
      INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order,source_title,first_seen_at,last_seen_at)
        VALUES(1,1,1,'synthetic','1',1,'Source title','now','now');
      INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,reason,payload_json,created_at)
        VALUES('identity','manual',1,1,'Confirmed identity','{}','now');
      INSERT INTO archive_catalog_download_tasks(source_work_id,provider,target_root,target_relative_directory,target_filename,status,claimed_by,attempt_count)
        VALUES(1,'baidu','root','One','one.7z','staged','historical-worker',2);`);
    const task=Number(db.prepare('SELECT id FROM archive_catalog_download_tasks').get()!.id);
    new ArchiveLocalFulfillmentService(db).accept({decisionKey:'accepted',sourceWorkId:1,localWorkId:1,taskIds:[task],reason:'Accepted available version'});
    const read=()=>db.prepare(`SELECT ${fulfillmentValidSql('s')} AS satisfied,${sourceNeedsAcquisitionSql('s')} AS needed FROM archive_catalog_source_works s WHERE id=1`).get();
    expect(read()).toEqual({satisfied:1,needed:0});
    const before=facts();
    new ConfirmedWorkSortService(db).apply(plan());
    expect(read()).toEqual({satisfied:1,needed:0});
    expect(facts()).toEqual(before);
  });

  it('persists across reopening and does not trigger generation on read or schema repeat', () => {
    new ConfirmedWorkSortService(db).apply(plan());
    const before=generation();
    const file=String(db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')!.file);
    const reader=new DatabaseSync(file,{readOnly:true});
    try {
      expect(new ResourceCatalogBuilder(reader).generate(1).page.items.find(row=>row.workId===1)!.sortTimestamp).toBe(9000.25);
    } finally { reader.close(); }
    db.exec(workSortSchemaSql);
    expect(generation()).toBe(before);
  });
});
