import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';
import { ResourceCatalogReadModel } from '../src/services/resource-catalog-read-model.js';
import { LOCAL_ADMISSION_LOCK_KEY } from '../src/services/local-admission-lock.js';

describe('global controlled creator deletion', () => {
  let db: DatabaseSync, service: ManagedCreatorService, id: number;
  beforeEach(() => {
    db = new DatabaseSync(':memory:'); db.exec(schemaSql);
    service = new ManagedCreatorService(db);
    id = service.create({ name: 'Mistaken Creator', aliases: ['Other spelling'] }).id;
    service.setActive(id, false, { confirm: true });
  });
  afterEach(() => db.close());
  const confirm = () => ({ confirm: true, confirmationToken: service.deletionPreview(id).confirmationToken });
  const retained = () => expect(db.prepare('SELECT id FROM archive_catalog_creators WHERE id=?').get(id)).toBeTruthy();
  const setting = (key: string, value: unknown) => db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value));

  const sourceOnly = () => {
    db.prepare("UPDATE archive_catalog_creators SET seed_source='hentaiclub' WHERE id=?").run(id);
    db.prepare("UPDATE archive_catalog_creator_aliases SET source='hentaiclub' WHERE creator_id=?").run(id);
    db.prepare(`INSERT INTO archive_catalog_creator_sources(creator_id,source,source_creator_id,source_display_name,metadata_json,first_seen_at,last_seen_at)
      VALUES(?,'fixture','source','Source name',?,'fixed','fixed')`).run(id, JSON.stringify({ creatorId: id }));
    const collection = Number(db.prepare(`INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at)
      VALUES(?,'fixture','collection','Source collection','fixed')`).run(id).lastInsertRowid);
    const work = Number(db.prepare("INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'Source work')").run(id).lastInsertRowid);
    const sourceWork = Number(db.prepare(`INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at)
      VALUES(?,?,'fixture','work','Source work','fixed','fixed')`).run(work, collection).lastInsertRowid);
    return { collection, work, sourceWork };
  };

  it('deletes a seeded source-only identity with exact scope, immutable detached evidence and reusable names', () => {
    const fixture = sourceOnly();
    const preview = service.deletionPreview(id);
    expect(preview).toMatchObject({ eligible: true, removableAliases: 2, removalScope: [
      { kind: 'aliases', count: 2 }, { kind: 'sources', count: 1 }, { kind: 'collections', count: 1 },
      { kind: 'sourceWorks', count: 1 }, { kind: 'works', count: 1 }
    ] });
    service.deleteUnusedManualCreator(id, confirm());
    const audit = db.prepare('SELECT * FROM creator_deletion_audits').get()!;
    expect(audit.creator_id).toBe(id);
    expect(JSON.parse(String(audit.scope_json))).toEqual(preview.removalScope);
    const snapshot = JSON.parse(String(audit.snapshot_json));
    expect(snapshot.archive_catalog_creator_sources[0].source_creator_id).toBe('source');
    expect(snapshot.archive_catalog_source_works[0].id).toBe(fixture.sourceWork);
    expect(db.prepare('SELECT * FROM archive_catalog_works').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM archive_catalog_collections').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM archive_catalog_source_works').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM archive_catalog_creator_sources').all()).toEqual([]);
    expect(() => db.exec('DELETE FROM creator_deletion_audits')).toThrow('immutable');
    expect(() => db.exec("UPDATE creator_deletion_audits SET canonical_name='changed'")).toThrow('immutable');
    const migration = fs.readFileSync(new URL('../db/migrations/000029_creator_deletion_audit.sql', import.meta.url), 'utf8');
    db.exec(migration.split('-- migrate:down')[1]);
    expect(db.prepare('SELECT * FROM creator_deletion_audits').get()).toEqual(audit);
    expect(() => db.exec('DELETE FROM creator_deletion_audits')).toThrow('immutable');
    const replacement = service.create({ name: 'Mistaken Creator', aliases: ['Other spelling'] });
    service.setActive(replacement.id, false, { confirm: true });
    expect(service.deletionPreview(replacement.id).eligible).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each(['source', 'collection', 'sourceWork', 'work', 'new source'])('invalidates a preview when %s content changes', kind => {
    const f = sourceOnly(), before = confirm();
    if (kind === 'source') db.prepare("UPDATE archive_catalog_creator_sources SET source_url='changed' WHERE creator_id=?").run(id);
    if (kind === 'collection') db.prepare("UPDATE archive_catalog_collections SET title='changed' WHERE id=?").run(f.collection);
    if (kind === 'sourceWork') db.prepare("UPDATE archive_catalog_source_works SET source_title='changed' WHERE id=?").run(f.sourceWork);
    if (kind === 'work') db.prepare("UPDATE archive_catalog_works SET display_title='changed' WHERE id=?").run(f.work);
    if (kind === 'new source') db.prepare(`INSERT INTO archive_catalog_creator_sources(creator_id,source,source_creator_id,source_display_name,first_seen_at,last_seen_at)
      VALUES(?,'new','new','New source','fixed','fixed')`).run(id);
    expect(service.deletionPreview(id).eligible).toBe(true);
    expect(() => service.deleteUnusedManualCreator(id, before)).toThrow('重新检查');
    retained();
  });

  it('blocks an inactive local copy even when owned by another folder and hidden from available counts', () => {
    const f = sourceOnly(), other = service.create({ name: 'Other folder owner' }).id;
    const folder = Number(db.prepare(`INSERT INTO archive_catalog_local_creator_folders(creator_id,root_path,relative_path,absolute_path,folder_name,match_status,is_active,scanned_at)
      VALUES(?,'fixture','fixture','fixture','fixture','matched',0,'fixed')`).run(other).lastInsertRowid);
    db.prepare(`INSERT INTO archive_catalog_local_works(local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,match_status,is_active,scanned_at)
      VALUES(?,?,'fixture','fixture','fixture','matched',0,'fixed')`).run(folder, f.work);
    expect(service.deletionPreview(id).blockers.map(b => b.code)).toContain('REFERENCE:archive_catalog_local_works');
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('不能删除'); retained();
  });

  it.each(['download', 'delivery', 'trashed work', 'external collection', 'foreign work', 'unknown dependent', 'soft dependent', 'JSON dependent'])
    ('blocks %s references to the complete source-only deletion scope', kind => {
      const f = sourceOnly();
      if (kind === 'download') db.prepare(`INSERT INTO archive_catalog_download_tasks(source_work_id,provider,status,target_root,target_relative_directory,target_filename)
        VALUES(?,'baidu','pending','fixture','fixture','fixture')`).run(f.sourceWork);
      if (kind === 'delivery') db.prepare(`INSERT INTO archive_catalog_deliveries(collection_id,provider,delivery_key,delivery_type,first_seen_at,last_seen_at)
        VALUES(?,'fixture','key','transfer','fixed','fixed')`).run(f.collection);
      if (kind === 'trashed work') {
        db.prepare(`INSERT INTO removal_operations(operation_id,kind,target_id,mode,state,payload_json,created_at,updated_at)
          VALUES('trash','work',?,'trash','completed','{}','fixed','fixed')`).run(f.work);
        db.prepare(`INSERT INTO work_removals(work_id,state,operation_id,snapshot_json,created_at) VALUES(?,'trashed','trash','{}','fixed')`).run(f.work);
      }
      if (kind === 'external collection' || kind === 'foreign work') {
        const other = service.create({ name: 'Other owner' }).id;
        if (kind === 'foreign work') db.prepare('UPDATE archive_catalog_works SET creator_id=? WHERE id=?').run(other, f.work);
        else db.prepare('UPDATE archive_catalog_collections SET creator_id=? WHERE id=?').run(other, f.collection);
      }
      if (kind === 'unknown dependent') {
        db.exec('CREATE TABLE custom_history(ref INTEGER REFERENCES archive_catalog_source_works(id) ON DELETE CASCADE)');
        db.prepare('INSERT INTO custom_history VALUES(?)').run(f.sourceWork);
      }
      if (kind === 'soft dependent') {
        db.exec('CREATE TABLE custom_history(work_id INTEGER)');
        db.prepare('INSERT INTO custom_history VALUES(?)').run(f.work);
      }
      if (kind === 'JSON dependent') setting('archive.plan', { workId: f.work });
      expect(service.deletionPreview(id).eligible).toBe(false);
      expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('不能删除'); retained();
    });

  it('rolls back the full source whitelist and new audit on a late failure', () => {
    sourceOnly();
    db.exec("CREATE TRIGGER fail_publication BEFORE UPDATE ON resource_catalog_meta BEGIN SELECT RAISE(ABORT,'late failure'); END");
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('late failure');
    retained();
    for (const table of ['archive_catalog_creator_sources', 'archive_catalog_collections', 'archive_catalog_works', 'archive_catalog_source_works'])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM creator_deletion_audits').get()?.n).toBe(0);
  });

  it('does not confuse another collection external source work ID with a removable SourceWork ID', () => {
    const f = sourceOnly(), other = service.create({ name: 'External owner' }).id;
    const collection = Number(db.prepare(`INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at)
      VALUES(?,'external','external','External collection','fixed')`).run(other).lastInsertRowid);
    const work = Number(db.prepare("INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'External work')").run(other).lastInsertRowid);
    db.prepare(`INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at)
      VALUES(?,?,'external',?,'External work','fixed','fixed')`).run(work, collection, String(f.sourceWork));
    expect(service.deletionPreview(id).eligible).toBe(true);
    service.deleteUnusedManualCreator(id, confirm());
    expect(db.prepare('SELECT work_id FROM archive_catalog_source_works').get()?.work_id).toBe(work);
  });

  it('deletes only an unused manual inactive identity and own aliases, atomically clearing derived state', () => {
    const original = service.create({ name: 'Original', rating: 'R18', preference: 'kept' });
    expect(() => service.addAlias(original.id, { alias: 'Mistaken Creator' })).toThrow('名称或别名');
    service.update(id, { name: 'Corrected mistake' }); // own manual-history aliases are allowed.
    const model = new ResourceCatalogReadModel(db);
    const stalePrepared = model.prepare(id);
    const beforeOriginal = db.prepare('SELECT * FROM archive_catalog_creators WHERE id=?').get(original.id);
    const publication = Number(db.prepare('SELECT publication FROM resource_catalog_meta').get()?.publication);
    expect(service.deletionPreview(id)).toMatchObject({ eligible: true, removableAliases: 3, blockers: [] });
    expect(service.deleteUnusedManualCreator(id, confirm())).toEqual({ deleted: true, creatorId: id });
    expect(db.prepare('SELECT * FROM archive_catalog_creators WHERE id=?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM archive_catalog_creator_aliases WHERE creator_id=?').all(id)).toEqual([]);
    expect(db.prepare('SELECT * FROM resource_catalog_state WHERE creator_id=?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT publication FROM resource_catalog_meta').get()?.publication).toBe(publication + 1);
    expect(model.publish(stalePrepared)).toBe(false);
    expect(db.prepare('SELECT * FROM archive_catalog_creators WHERE id=?').get(original.id)).toEqual(beforeOriginal);
    expect(service.addAlias(original.id, { alias: 'Mistaken Creator' }).aliases.some(a => a.alias === 'Mistaken Creator')).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('requires explicit preview confirmation; refuses active and missing creators', () => {
    expect(() => service.deleteUnusedManualCreator(id, { confirm: true })).toThrow();
    expect(() => service.deleteUnusedManualCreator(id, { ...confirm(), confirm: false })).toThrow();
    expect(() => service.deleteUnusedManualCreator(id, { confirm: true, confirmationToken: '0'.repeat(64) })).toThrow('重新检查');
    const token = confirm(); service.update(id, { preference: 'kept' });
    expect(() => service.deleteUnusedManualCreator(id, token)).toThrow('重新检查');
    service.setActive(id, true, { confirm: true });
    expect(service.deletionPreview(id).blockers.map(b => b.code)).toContain('ACTIVE');
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('先停用');
    service.setActive(id, false, { confirm: true });
    db.prepare("UPDATE archive_catalog_creators SET seed_source='seed' WHERE id=?").run(id);
    expect(service.deletionPreview(id).eligible).toBe(true);
    expect(() => service.deletionPreview(99999)).toThrow('不存在'); retained();
  });

  const references: Array<[string, string]> = [
    ['work', "INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'Work')"],
    ['inactive local folder', "INSERT INTO archive_catalog_local_creator_folders(creator_id,root_path,relative_path,absolute_path,folder_name,match_status,is_active,scanned_at) VALUES(?,'fixture','fixture','fixture','fixture','matched',0,'fixed')"],
    ['historical metadata task', "INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status) VALUES(?,'fixture','cancelled')"],
    ['completed ingest job', "INSERT INTO local_ingest_jobs(creator_id,source_archive_path,source_archive_name,source_archive_size,source_archive_mtime,source_archive_sha256,status) VALUES(?,'fixture','fixture',1,1,'fixture','ingested')"],
    ['file observation', "INSERT INTO local_ingest_file_observations(creator_id,source_archive_path,source_archive_name,observed_size,observed_mtime,stable_since,last_observed_at) VALUES(?,'fixture','fixture',1,1,'fixed','fixed')"],
    ['web draft', "INSERT INTO local_admission_web_batches(creator_id,id,input_root,state,created_at,updated_at,context_json) VALUES(?,'fixture','fixture','draft','fixed','fixed','{}')"],
    ['web review', "INSERT INTO local_review_web_sessions(creator_id,id,target_key,target_json,request_key,status,created_at,updated_at) VALUES(?,'fixture','fixture','{}','fixture','completed','fixed','fixed')"],
    ['evidence page', "INSERT INTO source_evidence_pages(creator_id,platform,page_key,created_at) VALUES(?,'fixture','fixture','fixed')"]
  ];
  it.each(references)('refuses %s without cascading or changing history', (_label, sql) => {
    const oldConfirmation = confirm(); db.prepare(sql).run(id);
    expect(service.deletionPreview(id).eligible).toBe(false);
    expect(() => service.deleteUnusedManualCreator(id, oldConfirmation)).toThrow('不能删除');
    retained(); expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_creator_aliases WHERE creator_id=?').get(id)?.n).toBe(2);
  });

  it.each(['candidate_creator_id', 'creator_id'])('discovers additional FK/soft %s refs instead of cascading', column => {
    db.exec(`CREATE TABLE additional_history(${column} INTEGER REFERENCES archive_catalog_creators(id) ON DELETE CASCADE)`);
    db.prepare(`INSERT INTO additional_history VALUES(?)`).run(id);
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('additional_history'); retained();
  });

  it.each([
    (id: number) => ({ creatorId: id }), (id: number) => ({ creatorIds: [id] }),
    (id: number) => ({ prior: { creator_id: String(id) } }), (id: number) => ({ creator: { id } }),
    (id: number) => ({ historicalJson: JSON.stringify({ candidateCreatorId: id }) }),
    () => ({ unmatchedCreators: ['Other spelling'] }), () => ({ creatorName: 'Mistaken Creator' })
  ])('refuses structured historical identity evidence %#', evidence => {
    db.prepare("INSERT INTO archive_local_admission_plans(plan_id,content_hash,payload_json) VALUES('fixture','fixture',?)").run(JSON.stringify(evidence(id)));
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('原接纳计划'); retained();
  });

  it('does not confuse external IDs, unrelated names/numbers or bracketed media titles with creator identity', () => {
    const other = service.create({ name: 'Unrelated' });
    db.prepare("INSERT INTO archive_catalog_creator_sources(creator_id,source,source_creator_id,source_display_name,metadata_json,first_seen_at,last_seen_at) VALUES(?,'fixture',?,'Fixture',?,'fixed','fixed')")
      .run(other.id, String(id), JSON.stringify({ sourceCreatorId: String(id), workId: id, title: '[Studio] Album' }));
    setting('sample.snapshot', { folderId: id, name: 'Mistaken Creator', creatorId: other.id });
    expect(service.deletionPreview(id).eligible).toBe(true);
  });

  it.each(['local_ingest.allowlist', 'archive.costuan-directory-review', 'metadata-receipt', 'execution-lock'])('refuses referenced setting %s', kind => {
    if (kind === 'local_ingest.allowlist') setting(kind, ['Other spelling']);
    else if (kind === 'archive.costuan-directory-review') setting(`${kind}.${id}`, { decision: 'confirmed' });
    else if (kind === 'metadata-receipt') setting('archive.metadata-check.request.fixture', { creatorIds: [id] });
    else setting(LOCAL_ADMISSION_LOCK_KEY, { pid: process.pid, token: 'fixture', kind: 'admission' });
    expect(service.deletionPreview(id).eligible).toBe(false);
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('不能删除'); retained();
  });

  it('fails closed on uninspectable persisted evidence but allows source aliases', () => {
    db.prepare("INSERT INTO archive_local_admission_plans(plan_id,content_hash,payload_json) VALUES('fixture','fixture','broken')").run();
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('格式无法完整核对');
    db.exec('DELETE FROM archive_local_admission_plans');
    db.prepare("UPDATE archive_catalog_creator_aliases SET source='costuan' WHERE creator_id=?").run(id);
    expect(service.deletionPreview(id).eligible).toBe(true); retained();
  });

  it('distinguishes migration creator conflicts from folder IDs in the same receipt', () => {
    const key = 'managed_creators.migration_000016';
    setting(key, { conflicts: [], unresolved: [id], bridges: [{ candidates: [id] }] });
    expect(service.deletionPreview(id).eligible).toBe(true);
    db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(JSON.stringify({ conflicts: [id] }), key);
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('迁移冲突历史');
  });

  it.each(['broken', 'null', '42', '[]'])('fails closed on malformed critical historical receipt %s', raw => {
    db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run('archive.metadata-check.request.fixture', raw);
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('历史执行记录无法完整核对'); retained();
  });

  it.each(['observation', 'decision', 'admission link'])('refuses a source evidence %s referencing this identity', kind => {
    const other = service.create({ name: 'Evidence owner' }).id;
    const page = Number(db.prepare("INSERT INTO source_evidence_pages(platform,page_key,creator_id,created_at) VALUES('fixture','page',?,'fixed')").run(other).lastInsertRowid);
    const observation = Number(db.prepare(`INSERT INTO source_evidence_observations
      (page_id,candidate_creator_id,request_key,payload_hash,payload_json,identity_state,identity_reason,parsed_json,completeness,created_at)
      VALUES(?,?,'request','hash','{}','candidate','reason','{}','unknown','fixed')`).run(page, kind === 'observation' ? id : other).lastInsertRowid);
    if (kind === 'decision') db.prepare(`INSERT INTO source_evidence_identity_decisions(request_key,observation_id,creator_id,revision,reason,created_at)
      VALUES('decision',?,?,1,'reason','fixed')`).run(observation, id);
    if (kind === 'admission link') {
      const work = Number(db.prepare("INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'Other work')").run(other).lastInsertRowid);
      db.prepare(`INSERT INTO source_evidence_admission_links(link_key,observation_id,creator_id,work_id,reason,payload_hash,created_at)
        VALUES('link',?,?,?,'reason','hash','fixed')`).run(observation, id, work);
    }
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('来源'); retained();
  });

  it('does not commit a caller transaction and preserves its rollback scope', () => {
    const body = confirm(); db.exec('BEGIN IMMEDIATE');
    service.deleteUnusedManualCreator(id, body);
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK'); retained();
    expect(service.deletionPreview(id).eligible).toBe(true);
  });

  it('rolls back source scope, audit, aliases, creator and catalog on a late failure', () => {
    const fixture = sourceOnly();
    const sourceBefore = db.prepare('SELECT * FROM archive_catalog_source_works WHERE id=?').get(fixture.sourceWork);
    const before = db.prepare('SELECT * FROM resource_catalog_state WHERE creator_id=?').get(id);
    db.exec("CREATE TRIGGER fail_publication BEFORE UPDATE ON resource_catalog_meta BEGIN SELECT RAISE(ABORT,'test publication failure'); END");
    expect(() => service.deleteUnusedManualCreator(id, confirm())).toThrow('test publication failure');
    retained(); expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_creator_aliases WHERE creator_id=?').get(id)?.n).toBe(2);
    expect(db.prepare('SELECT * FROM resource_catalog_state WHERE creator_id=?').get(id)).toEqual(before);
    expect(db.prepare('SELECT * FROM archive_catalog_source_works WHERE id=?').get(fixture.sourceWork)).toEqual(sourceBefore);
    expect(db.prepare('SELECT id FROM archive_catalog_works WHERE id=?').get(fixture.work)).toBeTruthy();
    expect(db.prepare('SELECT id FROM archive_catalog_collections WHERE id=?').get(fixture.collection)).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) n FROM archive_catalog_creator_sources WHERE creator_id=?').get(id)?.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM creator_deletion_audits').get()?.n).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it('rechecks independent connection writes after preview and preserves the reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-delete-'));
    const filename = path.join(root, 'isolated.sqlite');
    const first = new DatabaseSync(filename), second = new DatabaseSync(filename);
    try {
      first.exec(schemaSql); second.exec('PRAGMA foreign_keys=ON');
      const firstService = new ManagedCreatorService(first);
      const target = firstService.create({ name: 'Concurrent' }).id;
      firstService.setActive(target, false, { confirm: true });
      const preview = firstService.deletionPreview(target);
      second.prepare("INSERT INTO archive_local_admission_plans(plan_id,content_hash,payload_json) VALUES('later','hash',?)").run(JSON.stringify({ creatorId: target }));
      expect(() => firstService.deleteUnusedManualCreator(target, { confirm: true, confirmationToken: preview.confirmationToken })).toThrow('原接纳计划');
      expect(second.prepare('SELECT id FROM archive_catalog_creators WHERE id=?').get(target)).toBeTruthy();
      expect(second.prepare('SELECT COUNT(*) AS n FROM archive_local_admission_plans').get()?.n).toBe(1);
    } finally { second.close(); first.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
