import {DatabaseSync} from 'node:sqlite';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {admissionItemIdentity,assertNoLaterAdmissionCompletion,laterAdmissionCompletions} from '../src/services/local-admission-later-completion.js';

describe('historical admission current disposition is a scoped read model',()=>{
  let db:DatabaseSync;
  beforeEach(()=>{db=new DatabaseSync(':memory:');db.exec(`
    CREATE TABLE local_admission_web_batches(id TEXT PRIMARY KEY,creator_id INTEGER,input_root TEXT,created_at TEXT,updated_at TEXT,state TEXT,confirmed_json TEXT);
    CREATE INDEX idx_admission_web_creator ON local_admission_web_batches(creator_id,created_at DESC);
    CREATE TABLE local_admission_web_items(batch_id TEXT,item_key TEXT,summary_json TEXT,position INTEGER,action TEXT DEFAULT 'defer',PRIMARY KEY(batch_id,item_key));
    CREATE TABLE archive_local_admission_items(plan_id TEXT,item_key TEXT,state TEXT,work_id INTEGER,local_work_id INTEGER,PRIMARY KEY(plan_id,item_key));
    CREATE TABLE archive_catalog_local_works(id INTEGER PRIMARY KEY,work_id INTEGER,absolute_path TEXT,post_id INTEGER);
    CREATE TABLE archive_catalog_works(id INTEGER PRIMARY KEY,creator_id INTEGER);
    CREATE TABLE local_admission_web_collection_batches(batch_id TEXT PRIMARY KEY,collection_id TEXT);
  `);});
  afterEach(()=>{db.close();});
  const input='/synthetic/wait/creator',target='/synthetic/gallery/creator';
  function batch(id:string,date:string,root=input,creatorId=1){db.prepare('INSERT INTO local_admission_web_batches VALUES(?,?,?,?,?,?,?)').run(id,creatorId,root,date,date,'draft',null);}
  function item(batchId:string,key:string,relative:string,checkpoint?:string){db.prepare('INSERT INTO local_admission_web_items(batch_id,item_key,summary_json,position) VALUES(?,?,?,0)').run(batchId,key,JSON.stringify({sourceRelativePath:relative,targetPath:`${target}/${relative}`}));
    if(checkpoint)db.prepare('INSERT INTO archive_local_admission_items VALUES(?,?,?,NULL,NULL)').run(batchId,key,checkpoint);}
  function complete(batchId:string,key:string,relative:string,workId=1,creatorId=1){item(batchId,key,relative);
    db.prepare('INSERT OR IGNORE INTO archive_catalog_works VALUES(?,?)').run(workId,creatorId);
    db.prepare('INSERT INTO archive_catalog_local_works VALUES(?,?,?,?)').run(workId,workId,`${target}/${relative}`,workId);
    db.prepare("INSERT INTO archive_local_admission_items VALUES(?,?,'completed',?,?)").run(batchId,key,workId,workId);
    db.prepare("UPDATE local_admission_web_batches SET state='completed',confirmed_json='{}' WHERE id=?").run(batchId);}
  it('reports partial coverage without rewriting planned/deferred history, with batch completion time',()=>{
    batch('old','2026-01-01');item('old','a','one','planned');item('old','b','unresolved-container');item('old','skip','explicit-skip');
    db.prepare("UPDATE local_admission_web_items SET action='skip' WHERE item_key='skip'").run();
    batch('next','2026-01-02');complete('next','c','one');db.prepare('INSERT INTO local_admission_web_collection_batches VALUES(?,?)').run('next','collection-next');
    const before=db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=?').all('old');
    const result=laterAdmissionCompletions(db,['old']);
    expect(result.get(admissionItemIdentity('old','a'))).toEqual({status:'completed_later',batchId:'next',collectionId:'collection-next',planId:'next',itemKey:'c',workId:1,localWorkId:1,postId:1,
      completedAt:'2026-01-02',completionTimeBasis:'batch_completed',evidence:'exact_directory_scope'});
    expect(result.get(admissionItemIdentity('old','b'))).toEqual({status:'unresolved'});
    expect(result.has(admissionItemIdentity('old','skip'))).toBe(false);
    expect(()=>assertNoLaterAdmissionCompletion(db,'old',['a'])).toThrow('后续批次完成');
    expect(()=>assertNoLaterAdmissionCompletion(db,'old',['b'])).not.toThrow();
    expect(db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=?').all('old')).toEqual(before);
  });
  it('does not change traditional admission on older databases without web tables',()=>{
    const legacy=new DatabaseSync(':memory:');
    try{expect(laterAdmissionCompletions(legacy,['legacy-plan']).size).toBe(0);expect(()=>assertNoLaterAdmissionCompletion(legacy,'legacy-plan')).not.toThrow();}
    finally{legacy.close();}
  });
  it('does not mistake same names, other creators/roots or earlier completions for coverage',()=>{
    batch('old','2026-01-03');item('old','a','same-name');
    batch('earlier','2026-01-02');complete('earlier','early','same-name');
    batch('other-root','2026-01-04','/synthetic/other-wait');complete('other-root','root','same-name',2);
    batch('other-creator','2026-01-04',input,2);complete('other-creator','creator','same-name',3,2);
    expect(laterAdmissionCompletions(db,['old']).size).toBe(0);
    expect(()=>assertNoLaterAdmissionCompletion(db,'old')).not.toThrow();
    // A genuinely new independently selected range after completion remains legal.
    batch('new-copy','2026-01-05');item('new-copy','new','same-name');
    expect(laterAdmissionCompletions(db,['new-copy']).size).toBe(0);
  });
  it('requires the completed checkpoint and matching Work/LocalWork/target; moved work is never superseded',()=>{
    batch('old','2026-01-01');item('old','a','same');item('old','moved','moved','files_verified');
    batch('next','2026-01-02');complete('next','b','same');complete('next','c','moved',2);
    expect(laterAdmissionCompletions(db,['old']).has(admissionItemIdentity('old','moved'))).toBe(false);
    db.prepare("UPDATE archive_catalog_local_works SET absolute_path='/another-target' WHERE id=1").run();
    expect(laterAdmissionCompletions(db,['old']).get(admissionItemIdentity('old','a'))).not.toMatchObject({status:'completed_later'});
    db.prepare('UPDATE archive_catalog_local_works SET absolute_path=?,work_id=99 WHERE id=1').run(`${target}/same`);
    expect(laterAdmissionCompletions(db,['old']).get(admissionItemIdentity('old','a'))).not.toMatchObject({status:'completed_later'});
  });
  it('ambiguous distinct completed identities stay unresolved; partial batch does not invent a completion time',()=>{
    batch('old','2026-01-01');item('old','a','same');
    batch('next','2026-01-02');complete('next','b','same');
    db.prepare("UPDATE local_admission_web_batches SET state='failed' WHERE id='next'").run();
    expect(laterAdmissionCompletions(db,['old']).get(admissionItemIdentity('old','a'))).toMatchObject({status:'completed_later',completedAt:null,completionTimeBasis:'unavailable'});
    batch('duplicate','2026-01-03');complete('duplicate','c','same',2);
    expect(laterAdmissionCompletions(db,['old']).get(admissionItemIdentity('old','a'))).toEqual({status:'unresolved'});
  });
  it('uses a fixed number of scoped queries and the creator index without media or manifests',()=>{
    batch('old','2026-01-01');batch('next','2026-01-02');
    for(let n=0;n<100;n++){item('old',`old-${n}`,`scope-${n}`);complete('next',`next-${n}`,`scope-${n}`,n+1);}
    const spy=vi.spyOn(db,'prepare');expect(laterAdmissionCompletions(db,['old']).size).toBe(100);
    const statements=spy.mock.calls.map(args=>String(args[0]));expect(statements).toHaveLength(3);
    expect(statements.join('\n')).not.toMatch(/\bimages\b|manifest_json|payload_json|preview_json/);
    spy.mockRestore();
    const candidateSql=statements.find(sql=>sql.includes('WITH scope'))!;
    const plan=db.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`).all(JSON.stringify([{batch_id:'old',creator_id:1,input_root:input,created_at:'2026-01-01',item_key:'old-0',relative:'scope-0',target:`${target}/scope-0`}]));
    expect(plan.map(row=>String(row.detail)).join('\n')).toMatch(/SEARCH b USING INDEX idx_admission_web_creator \(creator_id=\? AND created_at>\?\)/);
  });
});
