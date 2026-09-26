import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { CompanionReadService, COUNT_POLICY_VERSION } from '../src/services/companion-read-service.js';
import { ResourceCatalogReadModel } from '../src/services/resource-catalog-read-model.js';
import { CompanionGrantService } from '../src/services/companion-grant-service.js';

describe('Companion independent Work read contract (synthetic in-memory database)', () => {
  let db: DatabaseSync;
  let reader: CompanionReadService;
  let model: ResourceCatalogReadModel;
  let sequence: number;
  const publish = () => { for (const id of model.pending(100)) model.rebuildCreator(id); };
  const item = (overrides = {}) => ({ requestKey: 'one', site: 'costuan.com', pageType: 'resource', pageIdentifier: '/123.html', candidateNames: ['Alpha'], ...overrides });
  const add = (work = 1, creator = 1, media = true) => {
    const id = ++sequence;
    db.prepare('INSERT OR IGNORE INTO archive_catalog_works(id,creator_id,display_title) VALUES(?,?,?)').run(work, creator, `Work ${work}`);
    db.prepare('INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(?,?,?,?)').run(id, creator, `Creator${creator}/Copy${id}`, id);
    db.prepare(`INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(?,?,?,?,?,?,?,'matched','synthetic')`).run(id, creator, work, id, `Copy${id}`, `root/Creator${creator}/Copy${id}`, `Copy${id}`);
    if (media) {
      db.prepare(`INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
        VALUES(?,?,? ,'.jpg',?,?,100,10,10,'image/jpeg','synthetic',1,'synthetic',1,'thumb','preview')`).run(id, creator, `${id}.jpg`, `Creator${creator}/Copy${id}/${id}.jpg`, `root/Creator${creator}/Copy${id}/${id}.jpg`);
      db.prepare('INSERT INTO post_items(post_id,image_id,position) VALUES(?,?,1)').run(id, id);
    }
    return id;
  };
  beforeEach(() => {
    db = new DatabaseSync(':memory:'); db.exec(schemaSql);
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'Alpha','alpha','fixture','1'),(2,'Beta','beta','fixture','2');
      INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(1,'Alfa','alfa','manual');
      INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'alpha','Alpha','Creator1'),(2,'beta','Beta','Creator2');
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,1,'root','Creator1','root/Creator1','Creator1','matched','now'),(2,2,2,'root','Creator2','root/Creator2','Creator2','matched','now');`);
    reader = new CompanionReadService(db); model = new ResourceCatalogReadModel(db); sequence = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it('counts distinct authoritative Works, not copies, source-only rows, or empty indexes', () => {
    add(); add(); add(2); add(3,1,false);
    db.exec(`INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(4,1,'Source only');
      INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at) VALUES(1,1,'costuan','123','Synthetic','now');
      INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at) VALUES(4,1,'costuan','4','Only source','now','now');`);
    publish();
    expect(reader.summary(1)).toMatchObject({ creatorId:1, canonicalName:'Alpha', collectedWorkCount:2, countPolicyVersion:COUNT_POLICY_VERSION, readModel:{status:'ready',complete:true} });
    expect(reader.summary(2).collectedWorkCount).toBe(0);
  });
  it('counts a valid secondary when the designated primary is unavailable or deleted', () => {
    add(); add(); db.exec('UPDATE archive_catalog_works SET primary_local_work_id=1 WHERE id=1; UPDATE posts SET is_trashed=1 WHERE id=1'); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(1);
    db.exec('UPDATE posts SET is_trashed=1 WHERE id=2'); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(0);
  });
  it('bounds summary traversal to creator Works and Post media, not global visibility indexes', () => {
    add(); add(2, 2); publish();
    const prepare = vi.spyOn(db, 'prepare');
    expect(reader.summary(1).collectedWorkCount).toBe(1);
    const sql = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.startsWith('SELECT COUNT(DISTINCT w.id)'))!;
    expect(sql).toBeTruthy();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1).map(row => String(row.detail));
    expect(plan[0]).toMatch(/SEARCH w USING .*idx_archive_catalog_works_creator.*creator_id/);
    expect(plan.some(detail => /SEARCH l USING .*idx_archive_catalog_local_works_work.*work_id/.test(detail))).toBe(true);
    expect(plan.filter(detail => /SEARCH pi /.test(detail))).toHaveLength(2);
    expect(plan.filter(detail => /SEARCH pi /.test(detail)).every(detail => detail.includes('post_id=?'))).toBe(true);
    expect(plan.some(detail => /SEARCH i USING INTEGER PRIMARY KEY/.test(detail))).toBe(true);
    expect(plan.some(detail => /SEARCH p USING INTEGER PRIMARY KEY/.test(detail))).toBe(true);
    expect(plan.some(detail => /SEARCH legacy USING .*\(source_path=\?\)/.test(detail))).toBe(true);
    expect(plan.some(detail => /SCAN |idx_images_.*visible|idx_posts_.*listing/.test(detail))).toBe(false);
  });
  it('preserves exact legacy path fallback without admitting another folder or unmatched copy', () => {
    add(); db.exec('UPDATE archive_catalog_local_works SET post_id=NULL'); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(1);
    db.exec('UPDATE posts SET folder_id=2'); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(0);
    db.exec("UPDATE posts SET folder_id=1; UPDATE archive_catalog_local_works SET match_status='unmatched'"); publish();
    expect(reader.summary(1)).toMatchObject({ collectedWorkCount: null, readModel: { status: 'incomplete' } });
  });
  it('computes a creator summary once per batch snapshot but never reuses it across requests', () => {
    add(); publish();
    const summary = vi.spyOn(reader, 'summary');
    const batch = Array.from({ length: 50 }, (_, index) => item({ requestKey: `card-${index}` }));
    const results = reader.resolveBatch(batch);
    expect(results.every(result => result.collectedWorkCount === 1)).toBe(true);
    expect(summary).toHaveBeenCalledTimes(1);
    db.exec('UPDATE posts SET is_trashed=1'); publish();
    expect(reader.resolveBatch(batch).every(result => result.collectedWorkCount === 0)).toBe(true);
    expect(summary).toHaveBeenCalledTimes(2);
    reader.resolveBatch(batch, { includeSummary: false });
    expect(summary).toHaveBeenCalledTimes(2);
  });
  it.each(['is_deleted', 'is_trashed'])('excludes %s media even if a Post still exists', column => {
    add(); db.exec(`UPDATE images SET ${column}=1`); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(0);
  });
  it('counts unsorted authoritative Works with usable media without requiring NO or primary selection', () => {
    add(); add(); db.exec('UPDATE posts SET sort_timestamp=0'); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(1);
  });
  it('reports unmapped indexed media as incomplete, never invents a Work or a zero', () => {
    add(); db.exec('DELETE FROM archive_catalog_local_works; DELETE FROM archive_catalog_works'); publish();
    expect(reader.summary(1)).toMatchObject({ collectedWorkCount:null, readModel:{status:'incomplete'} });
  });
  it('excludes inactive copy/folder and unsupported-original media', () => {
    add(); db.exec('UPDATE archive_catalog_local_works SET is_active=0'); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(0);
    db.exec("UPDATE archive_catalog_local_works SET is_active=1; UPDATE images SET relative_path='Creator1/Copy1/_未支持格式原件/1.jpg'"); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(0);
    db.exec("UPDATE images SET relative_path='Creator1/Copy1/1.jpg'; UPDATE archive_catalog_local_creator_folders SET is_active=0 WHERE id=1"); publish();
    expect(reader.summary(1).collectedWorkCount).toBe(0);
  });
  it('returns null before publication or while stale, without publishing on read', () => {
    add(); expect(reader.summary(1)).toMatchObject({collectedWorkCount:null,readModel:{status:'uninitialized'},dataUpdatedAt:null});
    publish(); const before = reader.summary(1);
    db.exec("UPDATE archive_catalog_works SET display_title='Changed' WHERE id=1");
    const stale = reader.summary(1);
    expect(stale).toMatchObject({collectedWorkCount:null,readModel:{status:'updating'},dataUpdatedAt:before.dataUpdatedAt});
    expect(stale.dataVersion).not.toBe(before.dataVersion);
    db.exec("UPDATE resource_catalog_state SET last_error='secret path' WHERE creator_id=1");
    expect(reader.summary(1).readModel.status).toBe('failed');
    expect(JSON.stringify(reader.summary(1))).not.toContain('secret path');
  });
  it('returns null for future read-model rules', () => {
    publish(); db.exec('UPDATE resource_catalog_state SET rule_version=999 WHERE creator_id=1');
    expect(reader.summary(1)).toMatchObject({collectedWorkCount:null,readModel:{status:'reader_outdated'}});
  });
  it('uses canonical names and registered aliases but preserves collisions', () => {
    publish();
    expect(reader.resolveBatch([item({candidateNames:['Ａｌｆａ']})])[0]).toMatchObject({matchStatus:'matched',creator:{creatorId:1}});
    db.exec("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(2,'Alfa','alfa','manual')");
    expect(reader.resolveBatch([item({candidateNames:['Alfa']})])[0]).toMatchObject({matchStatus:'ambiguous',creator:null,collectedWorkCount:null});
  });
  it('uses confirmed collection ownership, but blocks source/name and cross-source conflicts', () => {
    publish(); db.exec("INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at) VALUES(1,1,'costuan','123','Synthetic','now')");
    expect(reader.resolveBatch([item({candidateNames:[]})])[0]).toMatchObject({matchStatus:'matched',matchedBy:'source_relation',creator:{creatorId:1}});
    expect(reader.resolveBatch([item({candidateNames:['Beta']})])[0]).toMatchObject({matchStatus:'conflict',creator:null,collectedWorkCount:null});
    db.exec("INSERT INTO archive_catalog_creator_sources(creator_id,source,source_creator_id,source_display_name,first_seen_at,last_seen_at) VALUES(2,'costuan','collection:123','Beta','now','now')");
    expect(reader.resolveBatch([item({candidateNames:[]})])[0]?.matchStatus).toBe('conflict');
  });
  it.each(['publisher','organization','multi_person','unknown'])('does not treat a %s as a resource person', pageType => {
    publish(); expect(reader.resolveBatch([item({pageType})])[0]).toMatchObject({matchStatus:'needs_confirmation',creator:null,collectedWorkCount:null});
  });
  it('supports exact existing source page relations on the other sites without fetching', () => {
    publish(); db.exec("INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,source_url,observed_at) VALUES(1,1,'manual','x','Synthetic','https://ecytt02.com/post/123/','now')");
    expect(reader.resolveBatch([item({site:'ecytt02.com',pageIdentifier:'/post/123',candidateNames:[]})])[0]).toMatchObject({matchedBy:'source_relation',creator:{creatorId:1}});
    expect(reader.resolveBatch([item({site:'sndiary02.com',pageIdentifier:'/post/123',candidateNames:[]})])[0]).toMatchObject({matchStatus:'unresolved',collectedWorkCount:null});
  });
  it('bounds the batch/search and reports partial invalid items without hiding valid outcomes', () => {
    publish(); expect(() => reader.resolveBatch(Array.from({length:51}, (_,i) => item({requestKey:String(i)})))).toThrow('1至50');
    expect(() => reader.resolveBatch([item(),item()])).toThrow('不能重复');
    const result = reader.resolveBatch([item(),null,item({requestKey:'three',pageIdentifier:'https://invalid.test/'})]);
    expect(result[0]?.matchStatus).toBe('matched'); expect(result[1]?.requestKey).toBeNull();
    expect(result[2]).toMatchObject({requestKey:'three',error:{code:'INVALID_RESOLVE_ITEM'},collectedWorkCount:null});
    expect(() => reader.search('',20)).toThrow(); expect(() => reader.search('a',31)).toThrow();
    expect(reader.search('a',1)).toMatchObject({items:[{creatorId:1,canonicalName:'Alpha'}],truncated:true});
  });
  it('invalidates identity/relation versions and supplies no private data or guessed timestamps', () => {
    publish(); const before = reader.summary(1); const lookup = reader.resolveBatch([item()])[0]!;
    db.exec("INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(1,'Another','another','manual')");
    expect(reader.summary(1).dataVersion).not.toBe(before.dataVersion); publish();
    db.exec("INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at) VALUES(1,1,'costuan','123','Synthetic','now')");
    expect(reader.resolveBatch([item()])[0]!.dataVersion).not.toBe(lookup.dataVersion);
    expect(Object.keys(reader.summary(1)).sort()).toEqual(['canonicalName','collectedWorkCount','countPolicyVersion','creatorId','dataUpdatedAt','dataVersion','queriedAt','readModel'].sort());
    expect(() => reader.summary(99)).toThrow('不存在');
  });
  it('all queries operate on query_only DB and leave every domain and derived table unchanged', () => {
    add(); publish(); const rebuild = vi.spyOn(ResourceCatalogReadModel.prototype,'rebuildCreator');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
    const snapshot = () => tables.map(table => [table,db.prepare(`SELECT * FROM "${table}"`).all()]);
    const before = snapshot(); const changes = db.prepare('SELECT total_changes() n').get()!.n;
    db.exec('PRAGMA query_only=ON');
    reader.summary(1); reader.search('al'); reader.resolveBatch([item(),item({requestKey:'unmatched',candidateNames:['No Match']})]);
    expect(db.prepare('SELECT total_changes() n').get()!.n).toBe(changes); expect(snapshot()).toEqual(before);
    expect(rebuild).not.toHaveBeenCalled();
  });
  it('identity-only resolve never reads a summary or exposes count changes in its revision', () => {
    add(); publish(); const summary = vi.spyOn(reader,'summary');
    const before = reader.resolveBatch([item()], {includeSummary:false});
    expect(before[0]).toMatchObject({collectedWorkCount:null,readModel:{status:'permission_denied'}});
    add(2); publish();
    const after = reader.resolveBatch([item()], {includeSummary:false});
    expect(summary).not.toHaveBeenCalled();
    expect(after[0]!.dataVersion).toBe(before[0]!.dataVersion);
  });

  it('keeps the same creator ID in two fresh instances in separate authorization/cache namespaces', () => {
    add(); publish();
    const other = new DatabaseSync(':memory:');
    try {
      other.exec(schemaSql);
      other.exec("INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'Other Instance Person','otherinstance','fixture','1')");
      new ResourceCatalogReadModel(other).rebuildCreator(1);
      const grantInput = { label:'Synthetic', extensionOrigin:`chrome-extension://${'a'.repeat(32)}`, scopes:['identity:read','summary:read'] };
      const firstGrants = new CompanionGrantService(db), otherGrants = new CompanionGrantService(other);
      const first = firstGrants.create(grantInput), second = otherGrants.create(grantInput);
      expect(reader.summary(1)).toMatchObject({creatorId:1,canonicalName:'Alpha',collectedWorkCount:1});
      expect(new CompanionReadService(other).summary(1)).toMatchObject({creatorId:1,canonicalName:'Other Instance Person',collectedWorkCount:0});
      expect(first.instanceId).not.toBe(second.instanceId);
      expect(() => otherGrants.authenticate(`Bearer ${first.token}`, grantInput.extensionOrigin)).toThrow();
    } finally { other.close(); }
  });
});
