import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { sourceEvidenceSchemaSql } from '../src/db/source-evidence-schema.js';
import { SourceEvidenceService } from '../src/services/source-evidence-service.js';
import { ArchiveMetadataTaskService } from '../src/services/archive-metadata-task-service.js';

describe('source evidence persists independently from precise catalog and admission',()=>{
  let db:DatabaseSync,service:SourceEvidenceService;
  const record=(overrides:Record<string,unknown>={})=>({platform:'costuan',pageUrl:'https://www.costuan.com/100.html',
    pageTitle:'Evidence COS写真图片包合集[3套][持续更新]',method:'manual',rawDirectoryText:'NO.001 One\nNO.018-NO.026 Collection\nUnexplained extra',
    observedAt:'2026-09-01T00:00:00.000Z',...overrides});
  const create=(requestId='first',overrides:Record<string,unknown>={})=>service.save({creatorId:1,requestId,record:record(overrides)});
  const confirm=(observationId:number)=>service.confirmIdentity(observationId,{creatorId:1,requestId:`confirm-${observationId}`,reason:'user identified this page',expectedRevision:0});
  const table=(name:string)=>db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all();
  const business=()=>['archive_catalog_works','archive_catalog_source_works','archive_catalog_collections','archive_catalog_local_works',
    'archive_catalog_local_fulfillments','archive_catalog_metadata_tasks','archive_catalog_download_tasks','resource_catalog_state'].map(table);
  beforeEach(()=>{
    db=new DatabaseSync(':memory:');db.exec(schemaSql);service=new SourceEvidenceService(db);
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'Evidence','evidence','manual','one'),(2,'Different','different','manual','two');
      INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(11,1,'One'),(12,1,'Other'),(21,2,'Foreign');`);
  });
  afterEach(()=>db.close());

  it('keeps raw and partial parsing; range does not expand or manufacture Works/tasks/files',()=>{
    const before=business(),item=create();
    expect(item).toMatchObject({identityState:'candidate',completeness:'partial',rawDirectoryText:record().rawDirectoryText});
    expect(item.parsedEntries).toMatchObject([{key:'line-1',state:'candidate',title:'One'},
      {key:'line-2',state:'range',range:{first:18,last:26,count:9}},{key:'line-3',state:'unknown'}]);
    expect(item).not.toHaveProperty('requiredFilenames');
    expect(business()).toEqual(before);
  });
  it('confirms page identity from exact canonical title and checked article tags without row-name/count rules',()=>{
    const item=create('tagged',{identityEvidence:{version:1,pageUrl:'https://www.costuan.com/100.html',
      creatorTags:[{name:'Evidence',url:'https://www.costuan.com/tag/5'}]}});
    expect(item).toMatchObject({identityState:'confirmed',creatorId:1,completeness:'partial'});
    expect(create('later',{rawDirectoryText:'unknown'})).toMatchObject({identityState:'confirmed'});
    expect(table('archive_catalog_collections')).toEqual([]);
  });
  it('manually confirms a concrete unknown-platform page and persists decision across service instances',()=>{
    const item=create('manual',{platform:'ecytt',pageUrl:'https://example.test/entry',rawDirectoryText:''});
    expect(item).toMatchObject({platform:'ecytt',completeness:'unknown',identityState:'candidate',parsedEntries:[]});
    expect(confirm(item.id)).toMatchObject({identityState:'confirmed',identityRevision:1});
    expect(new SourceEvidenceService(db).get(item.id).creatorId).toBe(1);
    expect(create('new-observation',{platform:'ecytt',pageUrl:'https://example.test/entry',rawDirectoryText:'无编号新资料'}).identityState).toBe('confirmed');
    expect(table('source_evidence_identity_decisions')).toHaveLength(1);
    expect(table('archive_catalog_creator_aliases')).toEqual([]);
  });
  it('conflicts never change an existing page identity or confirm a client-selected creator',()=>{
    const item=create();confirm(item.id);
    const conflict=service.save({creatorId:2,requestId:'other',record:record()});
    expect(conflict.identityState).toBe('conflict');
    expect(()=>service.confirmIdentity(conflict.id,{creatorId:2,requestId:'force',reason:'force',expectedRevision:1})).toThrow(/冲突/);
    expect(service.get(item.id).creatorId).toBe(1);
    const contradiction=create('contradiction',{pageTitle:'Different COS写真图片包合集[1套][持续更新]'});
    expect(contradiction.identityState).toBe('conflict');
    expect(()=>service.assertAdmissionReference(contradiction.id,1)).toThrow();
    expect(create('row-contradiction',{rawDirectoryText:'Different NO.001 One'}).identityState).toBe('conflict');
  });
  it('recognizes conflicting existing collections without changing them, even when inactive',()=>{
    db.exec(`INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at,is_active)
      VALUES(2,'costuan','100','Old','before',0);`);
    const before=business();
    expect(create().identityState).toBe('conflict');
    expect(business()).toEqual(before);
  });
  it('idempotent submission reuses exact observation; changed or late request cannot overwrite confirmation',()=>{
    const item=create();confirm(item.id);
    expect(create().id).toBe(item.id);
    expect(create().identityState).toBe('confirmed');
    expect(()=>create('first',{rawDirectoryText:'changed'})).toThrow(/请求ID/);
    expect(table('source_evidence_observations')).toHaveLength(1);
    const later=create('later',{rawDirectoryText:'only one'});
    expect(service.get(item.id).rawDirectoryText).toBe(record().rawDirectoryText);
    expect(later.completeness).toBe('partial');
  });
  it('redacts secrets but preserves other plain text and handles confirmed-request replay',()=>{
    const item=create('safe',{rawDirectoryText:'NO.001 One\n提取码: abcd\nCookie: a=123; b=456\nBDUSS=private-session\nSTOKEN=private-token\npasscode: private-code',
      resourceEntries:[{label:'resource',url:'https://example.test/path?foo=bar&pwd=secret&BDUSS=private-session#sensitive'}]});
    expect(JSON.stringify(item)).not.toMatch(/abcd|a=123|b=456|pwd=secret|#sensitive|private-session|private-token|private-code/);
    expect(item.rawDirectoryText).toContain('NO.001 One');
    expect(item.resourceEntries[0].url).toBe('https://example.test/path?foo=bar');
    const input={creatorId:1,requestId:'safe-confirm',expectedRevision:0,reason:'原文 password: secret'};
    expect(service.confirmIdentity(item.id,input).identityState).toBe('confirmed');
    expect(service.confirmIdentity(item.id,input).identityState).toBe('confirmed');
    for(const rawDirectoryText of ['<body>private</body>','x'.repeat(200001),'\n'.repeat(5001)])expect(()=>create('bad',{rawDirectoryText})).toThrow();
    expect(()=>create('bad-url',{pageUrl:'javascript:alert(1)'})).toThrow();
  });
  it('marks overlapping and malformed ranges for review without silently selecting first number',()=>{
    const item=create('overlap',{rawDirectoryText:'NO.018-NO.026 Combo\nNO.020 Inside\nNO.028-NO. Missing'});
    expect(item.parsedEntries.map(entry=>entry.state)).toEqual(['conflict','conflict','conflict']);
    confirm(item.id);
    expect(()=>service.mapEntry({observationId:item.id,creatorId:1,entryKey:'line-1',workId:11,key:'bad',reason:'bad'})).toThrow(/冲突/);
  });
  it('batch provenance is idempotent, does not alter existing Work IDs or satisfy any task',()=>{
    const item=create();confirm(item.id);const before=business();
    const input={observationId:item.id,creatorId:1,workId:11,key:'admission-plan-item',planId:'original-plan',itemKey:'one',reason:'manually prepared'};
    const first=service.linkAdmission(input);
    expect(service.linkAdmission({reason:input.reason,...input}).id).toBe(first.id);
    expect(()=>service.linkAdmission({...input,workId:12})).toThrow(/关联键/);
    expect(service.get(item.id).links).toHaveLength(1);
    expect(business()).toEqual(before);
    expect(()=>service.linkAdmission({...input,key:'foreign',workId:21})).toThrow(/其他博主/);
  });
  it('range can explicitly describe multiple Works without covering the whole collection',()=>{
    const item=create();confirm(item.id);const before=business();
    for(const workId of [11,12])service.mapEntry({observationId:item.id,creatorId:1,entryKey:'line-2',workId,key:`range-${workId}`,reason:'one prepared part'});
    expect(service.get(item.id)).toMatchObject({completeness:'partial',entryMappings:[{workId:11},{workId:12}]});
    expect(business()).toEqual(before);
  });
  it('exact source mapping checks existing Work even if sourceWorkId omitted, and across observations',()=>{
    db.exec(`INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at)
      VALUES(100,1,'costuan','100','Existing','before');
      INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order_label,source_title,first_seen_at,last_seen_at)
      VALUES(30,11,100,'costuan','NO.001','NO.001','One','before','before');`);
    db.exec(`INSERT INTO archive_catalog_download_tasks(source_work_id,provider,status,claimed_by,claimed_at,target_root,target_relative_directory,target_filename)
      VALUES(30,'baidu','claimed','active-worker','before','synthetic','Evidence','001.7z');`);
    const taskHistory=table('archive_catalog_download_tasks');
    const item=create();
    expect(()=>service.mapEntry({observationId:item.id,creatorId:1,entryKey:'line-1',workId:12,key:'bypass',reason:'not allowed'})).toThrow(/权威对应/);
    const mapped=service.mapEntry({observationId:item.id,creatorId:1,entryKey:'line-1',workId:11,sourceWorkId:30,key:'precise',reason:'confirmed'});
    expect(mapped.identityDecisionId).toEqual(expect.any(Number));
    expect(table('archive_catalog_local_fulfillments')).toEqual([]);
    expect(table('archive_catalog_download_tasks')).toEqual(taskHistory);
    expect(()=>service.mapEntry({observationId:item.id,creatorId:1,entryKey:'line-2',workId:11,sourceWorkId:30,key:'out-of-range',reason:'wrong number'})).toThrow(/范围/);
    const third=create('wrong-number',{rawDirectoryText:'NO.003 Third'});
    expect(()=>service.mapEntry({observationId:third.id,creatorId:1,entryKey:'line-1',workId:11,sourceWorkId:30,key:'same-page-wrong',reason:'same page is insufficient'})).toThrow(/编号/);
    const first=create('new-order',{rawDirectoryText:'NO.002 Two'});
    service.mapEntry({observationId:first.id,creatorId:1,entryKey:'line-1',workId:11,key:'known-two',reason:'confirmed'});
    const next=create('newer-order',{rawDirectoryText:'\nNO.002 Two refreshed'});
    expect(()=>service.mapEntry({observationId:next.id,creatorId:1,entryKey:'line-2',workId:12,key:'late-two',reason:'bad'})).toThrow(/先前观察/);
  });
  it('changed title or missing entries never updates existing complete source or local satisfaction',()=>{
    db.exec(`INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,raw_directory_text,observed_at)
      VALUES(100,1,'costuan','100','Complete title','complete original','before');
      INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at)
      VALUES(30,11,100,'costuan','NO.001','One','before','before');`);
    const before=business();
    create('partial',{rawDirectoryText:'No reliable entries',pageTitle:'Changed title'});
    expect(business()).toEqual(before);
  });
  it('same read remains readonly, list page index scopes observations without catalog regeneration',()=>{
    for(let n=0;n<4;n++)create(`page-${n}`);
    const changes=db.prepare('SELECT total_changes() n').get();
    expect(service.list({creatorId:1,page:2,limit:2})).toMatchObject({total:4,page:2,limit:2});
    expect(service.list({creatorId:2}).total).toBe(0);
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(changes);
    expect(db.prepare('EXPLAIN QUERY PLAN SELECT id FROM source_evidence_observations WHERE candidate_creator_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(1,20,0).map(row=>row.detail).join(' ')).toContain('idx_source_evidence_creator');
  });
  it('metadata bridge receipt keeps claim/round untouched, rejects foreign worker and old attempt',()=>{
    const metadata=new ArchiveMetadataTaskService(db);
    const planned=metadata.planSelected({creatorIds:[1],requestId:'round'});
    const task=metadata.claim({workerId:'worker',taskIds:planned.taskIds,rounds:planned.items.map(item=>({taskId:item.task!.id,checkRoundId:item.task!.checkRoundId!}))})[0];
    const input={id:task.id,workerId:'worker',expectedAttempt:task.attemptCount,canonicalCreatorId:1,requestId:'receipt',record:record({method:'plugin'})};
    const before=business();
    const first=metadata.recordSourceEvidence(input);
    expect(metadata.recordSourceEvidence(input).observation.id).toBe(first.observation.id);
    expect(business()).toEqual(before);
    for(const change of [{workerId:'other'},{expectedAttempt:999},{canonicalCreatorId:2}])expect(()=>metadata.recordSourceEvidence({...input,...change})).toThrow();
    metadata.report({id:task.id,workerId:'worker',expectedAttempt:task.attemptCount,status:'failed',error:'資料已記錄，精確補缺待確認'});
    expect(()=>metadata.recordSourceEvidence(input)).toThrow();
    expect(table('archive_catalog_works')).toHaveLength(3);
    expect(table('archive_catalog_download_tasks')).toHaveLength(0);
  });
  it('rolling back observation or link transaction leaves no partial provenance',()=>{
    db.exec('BEGIN');create();db.exec('ROLLBACK');
    expect(table('source_evidence_pages')).toEqual([]);
    const item=create();confirm(item.id);
    db.exec('BEGIN');service.linkAdmission({observationId:item.id,creatorId:1,workId:11,key:'rollback',reason:'prepared'});db.exec('ROLLBACK');
    expect(service.get(item.id).links).toEqual([]);
  });
  it('000024 fresh/upgrade/repeat preserve business rows and schema parity',()=>{
    const migration=fs.readFileSync(new URL('../db/migrations/000024_source_evidence.sql',import.meta.url),'utf8');
    const [up,down]=migration.split('-- migrate:down');
    const before=business();
    db.exec(down);db.exec(up);db.exec(up);
    expect(business()).toEqual(before);
    const item=create();confirm(item.id);db.exec(up);
    expect(service.get(item.id).identityState).toBe('confirmed');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA quick_check').get()).toEqual({quick_check:'ok'});
    expect(up.replace('-- migrate:up','').trim()).toBe(sourceEvidenceSchemaSql.trim());
  });
});
