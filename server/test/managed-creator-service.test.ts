import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';
import { ArchiveCatalogQueryService } from '../src/services/archive-catalog-query-service.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';
import { ArchiveDownloadTaskService } from '../src/services/archive-download-task-service.js';
import { ArchiveMetadataTaskService } from '../src/services/archive-metadata-task-service.js';
import { LocalCreatorFolderBridgeService, normalizedAbsoluteCreatorPath } from '../src/services/local-creator-folder-bridge-service.js';
import { completeManagedCreatorMigration } from '../src/db/managed-creator-migration.js';

describe('managed creator canonical ownership', () => {
  let db:DatabaseSync, service:ManagedCreatorService, query:ArchiveCatalogQueryService;
  beforeEach(() => { db=new DatabaseSync(':memory:'); db.exec(schemaSql); service=new ManagedCreatorService(db,'G:/gallery'); query=new ArchiveCatalogQueryService(db); });
  afterEach(() => db.close());
  const rows=(table:string)=>JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const folder=(name:string,folderPath=name)=>Number(db.prepare('INSERT INTO folders(slug,name,folder_path) VALUES(?,?,?)').run(name,name,folderPath).lastInsertRowid);
  function local(creatorId:number,relative:string,absolute=`G:/gallery/${relative}`) {
    return Number(db.prepare(`INSERT INTO archive_catalog_local_creator_folders
      (creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(?,'G:/gallery',?,?,?,'matched','fixed')`)
      .run(creatorId,relative,absolute,relative).lastInsertRowid);
  }
  function importSource(creatorName:string,postId='source1') {
    return new ArchiveCatalogService(db).importCostuanRecord({creatorName,aliases:[],costuan:{postId,title:`${creatorName}合集`,works:[{order:1,sourceOrder:'NO.001',label:'Test work'}]},baidu:{sourceFolderName:'1',destinationPath:'test',status:'saved'}});
  }
  it('excludes seed provenance from displayed source counts but preserves historical identity and search', () => {
    const creator=service.create({name:'Alpha'});
    db.prepare(`INSERT INTO archive_catalog_creator_sources(creator_id,source,source_creator_id,source_display_name,first_seen_at,last_seen_at)
      VALUES(?,'hentaiclub','old-id','Alpha','fixed','fixed')`).run(creator.id);
    db.prepare(`INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(?,'Old Alpha','oldalpha','hentaiclub')`).run(creator.id);
    const before=rows('archive_catalog_creator_sources')+rows('archive_catalog_creator_aliases');
    expect(query.listCreators({page:1,limit:50,hasSource:'no'}).items.map(c=>c.id)).toContain(creator.id);
    expect(query.listCreators({page:1,limit:50,hasSource:'yes'}).total).toBe(0);
    expect(query.listCreators({page:1,limit:50,query:'Old Alpha'}).items[0]?.id).toBe(creator.id);
    expect(query.getCreatorDetail(creator.id)?.sources.some(s=>s.source==='hentaiclub')).toBe(true);
    expect(rows('archive_catalog_creator_sources')+rows('archive_catalog_creator_aliases')).toBe(before);
  });
  it('splits absent sources by current check state before pagination without changing history', () => {
    const untouched=service.create({name:'Unchecked'});
    const absent=service.create({name:'Not found'});
    const sourced=service.create({name:'With source'});
    importSource('With source');
    for (const id of [absent.id,sourced.id]) db.prepare(`INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status) VALUES(?,'costuan','not_found')`).run(id);
    for (const status of ['pending','claimed','failed','completed','cancelled']) {
      const creator=service.create({name:status});
      db.prepare(`INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status) VALUES(?,'costuan',?)`).run(creator.id,status);
    }
    const before=rows('archive_catalog_metadata_tasks')+rows('archive_catalog_creator_sources');
    expect(query.listCreators({page:1,limit:1,hasSource:'no-unchecked'}).items.map(c=>c.id)).toEqual([untouched.id]);
    expect(query.listCreators({page:1,limit:1,hasSource:'no-not-found'}).items.map(c=>c.id)).toEqual([absent.id]);
    expect(query.listCreators({page:2,limit:1,hasSource:'no-not-found'}).items).toEqual([]);
    expect(query.listCreators({page:1,limit:50,hasSource:'no'}).total).toBe(7);
    expect(query.listCreators({page:1,limit:50,hasSource:'yes'}).items.map(c=>c.id)).toEqual([sourced.id]);
    expect(rows('archive_catalog_metadata_tasks')+rows('archive_catalog_creator_sources')).toBe(before);
  });
  it('never stores collection title fragments as Costuan aliases while retaining real alternate names', () => {
    const creator=service.create({name:'菌烨tako'});
    const result=new ArchiveCatalogService(db).importCostuanRecord({creatorName:'菌烨tako',aliases:['菌烨tako写真图片包合集[42套][','菌烨'],costuan:{postId:'411',title:'菌烨tako写真图片包合集[42套][Cosplay][持续更新]',works:[{order:1,sourceOrder:'NO.001',label:'Test'}]},baidu:{sourceFolderName:'130',destinationPath:'test',status:'saved'}});
    expect(result.matchedCreators).toBe(1);
    const aliases=query.getCreatorDetail(creator.id)!.aliases.map(a=>a.alias);
    expect(aliases).toContain('菌烨');
    expect(aliases.some(a=>a.includes('合集'))).toBe(false);
  });
  it('creates stable manual IDs without files or tasks and persists nullable independent fields', () => {
    const creator=service.create({name:'  Ａlice  ',preference:'kept',rating:null});
    expect(creator).toMatchObject({name:'Alice',preference:'kept',rating:null,isActive:true,seedSource:'manual'});
    expect(creator.seedSourceCreatorId).toMatch(/^manual:[a-f0-9-]{36}$/);
    expect(creator.aliases).toHaveLength(0);
    for(const table of ['archive_catalog_download_tasks','archive_catalog_metadata_tasks','local_ingest_jobs','folders']) expect(rows(table)).toBe('[]');
    expect(service.update(creator.id,{preference:null,rating:'R18'})).toMatchObject({id:creator.id,preference:null,rating:'R18',seedSourceCreatorId:creator.seedSourceCreatorId});
  });
  it('rejects extra fields, blank names, invalid values and missing entities', () => {
    for (const input of [{name:' '},{name:'_'},{name:'A',rating:'R20'},{name:'A',preference:'disliked'},{name:'A',id:9}]) expect(()=>service.create(input)).toThrow();
    const creator=service.create({name:'A'});
    for(const input of [{},{isActive:false},{seedSource:'costuan'},{id:7},{rating:'r18'}]) expect(()=>service.update(creator.id,input)).toThrow();
    expect(()=>service.update(999,{rating:null})).toThrow('博主不存在');
  });
  it('requires explicit confirmation for colliding normalized names and aliases, never merges', () => {
    const a=service.create({name:'Alice-X',aliases:['ＡＬＩＣＥ y','alice_y']});
    expect(a.aliases).toHaveLength(1);
    expect(()=>service.create({name:'alice_x'})).toThrow('名称或别名');
    const b=service.create({name:'alice_x',confirmDistinct:true});
    expect(a.id).not.toBe(b.id);
    expect(()=>service.addAlias(b.id,{alias:'Alice y'})).toThrow('名称或别名');
    expect(query.listCreators({page:1,limit:50,query:'Alice y'}).total).toBe(1);
    expect(importSource('alice_x').unmatchedCreators).toEqual(['alice_x']);
  });
  it('preserves source and historical aliases on rename and allows only manual alias removal', () => {
    const creator=service.create({name:'Original'}); importSource('Original');
    const before=rows('archive_catalog_creator_sources');
    const result=service.update(creator.id,{name:'Renamed'});
    expect(result.aliases).toEqual(expect.arrayContaining([expect.objectContaining({alias:'Original',source:'manual-history',editable:false})]));
    expect(rows('archive_catalog_creator_sources')).toBe(before);
    expect(()=>service.deleteAlias(creator.id,result.aliases.find(a=>a.source==='costuan')!.id)).toThrow('只读');
    const added=service.addAlias(creator.id,{alias:'Temporary'});
    expect(service.deleteAlias(creator.id,added.aliases.find(a=>a.alias==='Temporary')!.id).aliases.some(a=>a.alias==='Temporary')).toBe(false);
    expect(query.listCreators({page:1,limit:50,query:'Original'}).items[0].id).toBe(creator.id);
  });
  it('searches, detects collisions and matches incoming sources through the canonical row without a manual alias', () => {
    const creator = service.create({ name: 'Canonical Person' });
    expect(db.prepare('SELECT alias FROM archive_catalog_creator_aliases WHERE creator_id=?').all(creator.id)).toEqual([]);
    expect(query.listCreators({ page: 1, limit: 50, query: 'Canonical Person' }).items.map(c => c.id)).toEqual([creator.id]);
    expect(() => service.create({ name: 'canonical_person' })).toThrow('名称或别名');
    const other = service.create({ name: 'Other person' });
    expect(() => service.addAlias(other.id, { alias: 'Canonical Person' })).toThrow('名称或别名');
    expect(importSource('Canonical Person')).toMatchObject({ matchedCreators: 1, addedWorks: 1 });
    expect(db.prepare('SELECT creator_id FROM archive_catalog_collections').get()?.creator_id).toBe(creator.id);
  });
  it.each(['alice-x', 'Alice_X'])('filters only exact canonical aliases during create and preserves the variant %s', variant => {
    const creator = service.create({ name: 'Alice-X', aliases: [' Ａlice-X ', variant] });
    expect(db.prepare('SELECT alias,source FROM archive_catalog_creator_aliases WHERE creator_id=?').all(creator.id))
      .toEqual([{ alias: variant, source: 'manual' }]);
    expect(() => service.addAlias(creator.id, { alias: ' Ａlice-X ' }))
      .toThrow(expect.objectContaining({ status: 400, code: 'ALIAS_EQUALS_CANONICAL_NAME' }));
  });
  it('allows an explicit case variant through addAlias and does not regenerate canonical aliases on rename', () => {
    const creator = service.create({ name: 'Original' });
    service.addAlias(creator.id, { alias: 'original' });
    service.addAlias(creator.id, { alias: 'Changed' });
    service.update(creator.id, { name: 'Changed' });
    expect(db.prepare('SELECT alias,source FROM archive_catalog_creator_aliases WHERE creator_id=? ORDER BY source,alias').all(creator.id))
      .toEqual([{ alias: 'original', source: 'manual' }, { alias: 'Original', source: 'manual-history' }]);
    service.update(creator.id, { name: 'Original' });
    expect(db.prepare("SELECT alias FROM archive_catalog_creator_aliases WHERE creator_id=? AND source='manual'").all(creator.id))
      .toEqual([{ alias: 'original' }]);
    expect(db.prepare("SELECT alias FROM archive_catalog_creator_aliases WHERE creator_id=? AND source='manual-history' ORDER BY alias").all(creator.id))
      .toEqual([{ alias: 'Changed' }, { alias: 'Original' }]);
  });
  it('pins Costuan collection/source identity after names change and never overwrites canonical fields', () => {
    const creator=service.create({name:'First',preference:'liked',rating:'R18'}); importSource('First');
    service.update(creator.id,{name:'Chosen',rating:null,preference:'kept'});
    service.create({name:'Platform Rename'});
    const before=rows('archive_catalog_creators');
    expect(importSource('Platform Rename')).toMatchObject({matchedCreators:1,addedWorks:0,updatedWorks:1});
    expect(rows('archive_catalog_creators')).toBe(before);
    expect(db.prepare('SELECT creator_id FROM archive_catalog_collections').get()).toEqual({creator_id:creator.id});
    expect(importSource('Unknown','unknown').unmatchedCreators).toEqual(['Unknown']);
    expect(query.listCreators({page:1,limit:50}).total).toBe(2);
  });
  it('preserves all existing task rows on deactivate, future planning and restore', () => {
    const creator=service.create({name:'A'});importSource('A');
    const downloads=new ArchiveDownloadTaskService(db);downloads.planMissing({targetRoot:'T:/inbox'});
    db.prepare(`INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status) VALUES(?,'costuan','pending')`).run(creator.id);
    const beforeTasks=rows('archive_catalog_download_tasks'),beforeMetadata=rows('archive_catalog_metadata_tasks');
    expect(()=>service.setActive(creator.id,false,{})).toThrow();
    service.setActive(creator.id,false,{confirm:true});
    expect(query.listCreators({page:1,limit:50}).total).toBe(0);
    expect(query.listCreators({page:1,limit:50,active:'inactive'}).total).toBe(1);
    expect(downloads.planMissing({targetRoot:'T:/inbox'}).created).toBe(0);
    expect(new ArchiveMetadataTaskService(db).planLocalOnly().created).toBe(0);
    service.setActive(creator.id,true,{confirm:true});
    expect(rows('archive_catalog_download_tasks')).toBe(beforeTasks);
    expect(rows('archive_catalog_metadata_tasks')).toBe(beforeMetadata);
    expect(rows('local_ingest_jobs')).toBe('[]');
  });
  it('bridges only full paths, with Windows normalization, no same-name fallback', () => {
    const c=service.create({name:'A'});const f=folder('Different title','A');local(c.id,'A','g:\\GALLERY\\A\\');
    const bridge=new LocalCreatorFolderBridgeService(db);
    expect(bridge.backfill('G:/gallery')[0]).toMatchObject({status:'exact',galleryFolderId:f});
    expect(normalizedAbsoluteCreatorPath('G:/gallery/dir/../A/')).toBe('g:/gallery/a');
    expect(normalizedAbsoluteCreatorPath('G:relative','G:/gallery')).toBeNull();
    expect(normalizedAbsoluteCreatorPath('relative')).toBeNull();
    folder('Same basename elsewhere','other/A');local(c.id,'missing','G:/gallery/missing/A');
    expect(bridge.backfill('G:/gallery')[1].status).toBe('missing');
    expect(bridge.backfill('G:/gallery')[0].galleryFolderId).toBe(f);
  });
  it('reports ambiguous and conflicting exact paths instead of overwriting', () => {
    const c=service.create({name:'A'});folder('A1','A');folder('A2','a');local(c.id,'A');
    expect(new LocalCreatorFolderBridgeService(db).backfill('G:/gallery')[0].status).toBe('ambiguous');
    db.exec('DELETE FROM folders WHERE slug=\'A2\'');local(c.id,'A-other','G:/gallery/A');
    expect(new LocalCreatorFolderBridgeService(db).backfill('G:/gallery').every(r=>r.status==='conflict')).toBe(true);
  });
  it('links multiple folders to one creator, unlinks without child deletion and enforces one owner', () => {
    const c=service.create({name:'A'}),b=service.create({name:'B'});const f=folder('Unknown'),f2=folder('Other');
    expect(()=>service.updateFolderRating(f,{contentRating:'R18'})).toThrow('先在博主库关联');
    service.linkFolder(f,{creatorId:c.id});service.linkFolder(f2,{creatorId:c.id});
    expect(query.getCreatorDetail(c.id)?.localFolders).toHaveLength(2);
    expect(()=>service.linkFolder(f,{creatorId:b.id})).toThrow('已关联');
    expect(service.updateFolderRating(f,{contentRating:'R18'}).rating).toBe('R18');
    service.unlinkFolder(f,{confirm:true});
    expect(query.getCreatorDetail(c.id)?.unlinkedLocalFolders.map(f=>f.id)).toContain(f);
    expect(db.prepare('SELECT count(*) AS count FROM folders').get()).toEqual({count:2});
    service.linkFolder(f,{creatorId:c.id});
    expect(rows('creator_rating_sources')).toBe('[]');
  });
  it('promotes only consistent legacy manual values and does not reapply after canonical edit', () => {
    const c=service.create({name:'A',rating:'R15'});const f=folder('A');local(c.id,'A');
    db.prepare(`INSERT INTO creator_rating_sources(folder_id,source,source_creator_id,source_display_name,rating,is_manual) VALUES(?,'manual','local','A','R18',1)`).run(f);
    expect(completeManagedCreatorMigration(db,'G:/gallery')).toMatchObject({completed:true,promotedCreators:1});
    expect(query.getCreatorDetail(c.id)?.rating).toBe('R18');service.update(c.id,{rating:null});
    completeManagedCreatorMigration(db,'G:/gallery');expect(query.getCreatorDetail(c.id)?.rating).toBeNull();
    expect(db.prepare('SELECT count(*) AS count FROM creator_rating_sources').get()).toEqual({count:1});
  });
  it('rejects out-of-root folder paths even when an existing catalog row matches', () => {
    const c = service.create({name:'A'});
    const f = folder('Outside','G:/elsewhere/A');
    local(c.id,'Outside','G:/elsewhere/A');
    expect(() => service.linkFolder(f,{creatorId:c.id})).toThrow('正式图库根目录内');
    expect(db.prepare('SELECT gallery_folder_id FROM archive_catalog_local_creator_folders').get()).toEqual({gallery_folder_id:null});
  });
  it('fails closed on conflicting legacy manual ratings and keeps unlinked legacy values', () => {
    const c=service.create({name:'A',rating:'R15'});const f=folder('A'),other=folder('No link');local(c.id,'A');
    for(const [source,rating] of [['one','R18'],['two','R15']]) db.prepare(`INSERT INTO creator_rating_sources(folder_id,source,source_creator_id,source_display_name,rating,is_manual) VALUES(?,?,'local','A',?,1)`).run(f,source,rating);
    db.prepare(`INSERT INTO creator_rating_sources(folder_id,source,source_creator_id,source_display_name,rating,is_manual) VALUES(?,'manual','local','B','R18',1)`).run(other);
    expect(()=>completeManagedCreatorMigration(db,'G:/gallery')).toThrow('MANAGED_CREATOR_MIGRATION_CONFLICT');
    expect(query.getCreatorDetail(c.id)?.rating).toBe('R15');expect(rows('creator_rating_sources')).not.toBe('[]');
  });
  it('supports all filters and bounded roster pages', () => {
    for(let i=0;i<53;i++)service.create({name:`A${i}`,preference:i%2?'liked':null,rating:i%2?'R18':null});
    expect(query.listCreators({page:1,limit:50}).items).toHaveLength(50);
    expect(query.listCreators({page:2,limit:50}).items).toHaveLength(3);
    expect(query.listCreators({page:1,limit:50,preference:'unset',rating:'unclassified',hasLocal:'no',hasSource:'no'}).total).toBe(27);
  });
  it('does not promote non-manual legacy ratings over canonical metadata', () => {
    const c=service.create({name:'A',rating:'R15'}), f=folder('A');local(c.id,'A');
    db.prepare(`INSERT INTO creator_rating_sources(folder_id,source,source_creator_id,source_display_name,rating,is_manual)
      VALUES(?,'old-platform','old','A','R18',0)`).run(f);
    expect(completeManagedCreatorMigration(db,'G:/gallery')).toMatchObject({completed:true,promotedCreators:0});
    expect(query.getCreatorDetail(c.id)?.rating).toBe('R15');
    expect(db.prepare('SELECT rating FROM creator_rating_sources').get()).toEqual({rating:'R18'});
  });
});
