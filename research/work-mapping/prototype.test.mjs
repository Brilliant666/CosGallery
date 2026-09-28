// Research only. Never accepts a production database or media root.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const schema = readFileSync(new URL('../../server/src/db/schema.ts', import.meta.url), 'utf8').split('`')[1];
const extensions = `
ALTER TABLE archive_catalog_works ADD COLUMN title_policy TEXT NOT NULL DEFAULT 'source';
ALTER TABLE archive_catalog_works ADD COLUMN primary_local_work_id INTEGER REFERENCES archive_catalog_local_works(id);
ALTER TABLE archive_catalog_local_works ADD COLUMN identity_policy TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE archive_catalog_local_works ADD COLUMN provenance_json TEXT;
CREATE TABLE research_decisions (
 id INTEGER PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
 local_id INTEGER REFERENCES archive_catalog_local_works(id),
 source_id INTEGER REFERENCES archive_catalog_source_works(id),
 work_id INTEGER REFERENCES archive_catalog_works(id), reason TEXT NOT NULL,
 evidence_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE research_observations (
 id INTEGER PRIMARY KEY, source_id INTEGER REFERENCES archive_catalog_source_works(id),
 snapshot_json TEXT NOT NULL);
CREATE TABLE research_local_posts (
 local_id INTEGER NOT NULL REFERENCES archive_catalog_local_works(id),
 post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id), PRIMARY KEY(local_id,post_id));
CREATE TABLE research_plans (
 request_key TEXT PRIMARY KEY, payload TEXT NOT NULL, phase TEXT NOT NULL,
 work_id INTEGER REFERENCES archive_catalog_works(id), local_id INTEGER REFERENCES archive_catalog_local_works(id));
CREATE TABLE research_fulfillments (
 request_key TEXT PRIMARY KEY, task_id INTEGER NOT NULL UNIQUE REFERENCES archive_catalog_download_tasks(id),
 local_id INTEGER NOT NULL REFERENCES archive_catalog_local_works(id),
 decision_id INTEGER NOT NULL REFERENCES research_decisions(id),
 method TEXT NOT NULL, prior_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
`;

class Pilot {
  constructor(file = ':memory:', initialize = true) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys=ON');
    if (!initialize) return;
    this.db.exec(schema); this.db.exec(extensions);
    this.db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(35,'Synthetic creator','synthetic','manual','35');
      INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'synthetic','Synthetic','synthetic');
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at,gallery_folder_id)
      VALUES(1,35,'synthetic','creator','synthetic/creator','creator','matched','fixture',1);
      INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at)
      VALUES(1,35,'costuan','fixture','Fixture','fixture'),(2,35,'other','fixture','Fixture','fixture');`);
  }
  one(sql,...v) { return this.db.prepare(sql).get(...v); }
  run(sql,...v) { return this.db.prepare(sql).run(...v); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r=fn(); this.db.exec('COMMIT'); return r; } catch(e) {this.db.exec('ROLLBACK');throw e;} }
  work(title) { return Number(this.run("INSERT INTO archive_catalog_works(creator_id,display_title,title_policy) VALUES(35,?,'manual')",title).lastInsertRowid); }
  local(key,name,workId=null,count=31,displayTitle=name) {
    const payload=JSON.stringify({name,workId,count,displayTitle});
    const prior=this.one('SELECT * FROM research_plans WHERE request_key=?',key);
    if(prior) { assert.equal(prior.payload,payload,'idempotency key payload changed'); return {work:prior.work_id,local:prior.local_id}; }
    return this.tx(()=>{
      const w=workId??this.work(displayTitle);
      const l=Number(this.run(`INSERT INTO archive_catalog_local_works
       (local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,image_count,match_status,match_method,scanned_at,identity_policy,provenance_json)
       VALUES(1,?,?,?,?,?,'matched','manual','fixture','manual',?)`,w,name,'synthetic/'+name,name,count,JSON.stringify({batch:'legacy-fixture',originalName:name,platform:null})).lastInsertRowid);
      this.run('UPDATE archive_catalog_works SET primary_local_work_id=COALESCE(primary_local_work_id,?) WHERE id=?',l,w);
      this.run("INSERT INTO research_plans VALUES(?,?,'registered',?,?)",key,payload,w,l);
      return {work:w,local:l};
    });
  }
  source(collection,externalId,title,order,confirmedWork=null) {
    const old=this.one('SELECT * FROM archive_catalog_source_works WHERE collection_id=? AND source_work_id=?',collection,externalId);
    if(old) {
      if(confirmedWork!==null && old.work_id!==confirmedWork) throw Error('existing Work merge requires separate review');
      return old.id;
    }
    // This argument represents explicit confirmation, never title similarity.
    const w=confirmedWork??this.work(title);
    const platform=collection===1?'costuan':'other';
    return Number(this.run(`INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_order,source_title,media_summary,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,'fixture','fixture')`,w,collection,platform,externalId,order,title,'30P').lastInsertRowid);
  }
  decision(key,kind,local,source,reason='user confirmation') {
    const payload=JSON.stringify({kind,local,source,reason});
    const old=this.one('SELECT * FROM research_decisions WHERE request_key=?',key);
    if(old) {assert.equal(old.evidence_json,payload);return old.id;}
    const l=this.one('SELECT * FROM archive_catalog_local_works WHERE id=?',local);
    const s=source===null?null:this.one('SELECT * FROM archive_catalog_source_works WHERE id=?',source);
    if(kind==='accept') assert.equal(l.work_id,s.work_id,'cannot accept a different Work');
    return Number(this.run('INSERT INTO research_decisions(request_key,kind,local_id,source_id,work_id,reason,evidence_json) VALUES(?,?,?,?,?,?,?)',key,kind,local,source,l.work_id,reason,payload).lastInsertRowid);
  }
  blocked(local,source) { return !!this.one("SELECT id FROM research_decisions WHERE local_id=? AND (source_id=? OR source_id IS NULL) AND kind='not_same' AND revoked=0",local,source); }
  revoke(id) { this.run('UPDATE research_decisions SET revoked=1 WHERE id=?',id); }
  rescan(local,newCount,numberCandidate) {
    const l=this.one('SELECT * FROM archive_catalog_local_works WHERE id=?',local);
    // Identity and discovery are separated. This prototype intentionally performs NO automatic linking.
    this.run('UPDATE archive_catalog_local_works SET image_count=? WHERE id=?',newCount,local);
    return {work:l.work_id,candidateIgnored:numberCandidate};
  }
  observe(source,title,order,active=1,identityCertain=true) {
    return this.tx(()=>{
      this.run('INSERT INTO research_observations(source_id,snapshot_json) VALUES(?,?)',source,JSON.stringify({title,order,active,identityCertain}));
      if(!identityCertain) return 'conflict';
      this.run('UPDATE archive_catalog_source_works SET source_title=?,source_order=?,is_active=? WHERE id=?',title,order,active,source);
      return 'observed';
    });
  }
  index(local) {
    const l=this.one('SELECT * FROM archive_catalog_local_works WHERE id=?',local);
    const old=this.one('SELECT post_id FROM research_local_posts WHERE local_id=?',local); if(old)return old.post_id;
    return this.tx(()=>{
      const post=Number(this.run("INSERT INTO posts(folder_id,source_path,sort_timestamp) VALUES(1,?,1)",l.absolute_path).lastInsertRowid);
      const image=Number(this.run(`INSERT INTO images(folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
       VALUES(1,'pixel.ppm','ppm',?,?,14,1,1,'image/x-portable-pixmap','synthetic',1,'fixture',1,'fixture','fixture')`,l.relative_path+'/pixel.ppm',l.absolute_path+'/pixel.ppm').lastInsertRowid);
      this.run('INSERT INTO post_items VALUES(?,?,1)',post,image);
      this.run('INSERT INTO research_local_posts VALUES(?,?)',local,post);return post;
    });
  }
  browse() { return this.db.prepare(`SELECT w.id work_id,p.id post_id,i.id image_id FROM archive_catalog_works w
    JOIN research_local_posts lp ON lp.local_id=w.primary_local_work_id JOIN posts p ON p.id=lp.post_id
    JOIN post_items pi ON pi.post_id=p.id JOIN images i ON i.id=pi.image_id`).all(); }
  need(source) { return !this.one("SELECT id FROM research_decisions WHERE source_id=? AND kind='accept' AND revoked=0",source); }
  task(source,status='staged',claim=null) {return Number(this.run(`INSERT INTO archive_catalog_download_tasks(source_work_id,provider,target_root,target_relative_directory,target_filename,status,claimed_by,attempt_count)
    VALUES(?,'baidu','fixture','creator','fixture.7z',?,?,1)`,source,status,claim).lastInsertRowid);}
  fulfill(key,task,decision) {
    return this.tx(()=>{
      const old=this.one('SELECT * FROM research_fulfillments WHERE request_key=?',key);
      if(old){assert.equal(old.task_id,task);assert.equal(old.decision_id,decision);return 'replayed';}
      const t=this.one('SELECT * FROM archive_catalog_download_tasks WHERE id=?',task);
      const d=this.one("SELECT * FROM research_decisions WHERE id=? AND kind='accept' AND revoked=0",decision);
      assert.ok(d);assert.equal(d.source_id,t.source_work_id);
      // Conservative: even a staged row with retained claim fields requires a supported release first.
      if(t.claimed_by!==null || t.claimed_at!==null || !['pending','failed','staged','downloaded'].includes(t.status)) return 'blocked';
      const l=this.one('SELECT * FROM archive_catalog_local_works WHERE id=?',d.local_id);
      const s=this.one('SELECT * FROM archive_catalog_source_works WHERE id=?',d.source_id);
      assert.equal(l.work_id,s.work_id);assert.equal(l.is_active,1);
      this.run("INSERT INTO research_fulfillments VALUES(?,?,?,?, 'historical_local',?,0)",key,task,l.id,decision,JSON.stringify(t));
      // Fulfillment is an overlay, NOT a fabricated execution-state transition.
      // Production planners must exclude active fulfillment records explicitly.
      return 'fulfilled';
    });
  }
}

test('K same display title permits distinct actual sets; local-first optional source acceptance',()=>{
 const p=new Pilot();
 const directories=['Unknown NO032 Blue Costume','Other VOL009 Blue Costume'];
 // Candidate display extraction has no writes and does not rename either directory.
 const candidates=directories.map(name=>({name,displayTitle:'Blue Costume'}));
 assert.equal(p.one('SELECT count(*) n FROM archive_catalog_works').n,0);
 // User confirms distinct actual sets despite same theme, title and count.
 const copies=candidates.map((d,i)=>p.local('k'+i,d.name,null,31,d.displayTitle));
 assert.notEqual(copies[0].work,copies[1].work);
 assert.deepEqual(p.db.prepare('SELECT display_title FROM archive_catalog_works ORDER BY id').all().map(w=>w.display_title),['Blue Costume','Blue Costume']);
 assert.deepEqual(p.db.prepare('SELECT folder_name FROM archive_catalog_local_works ORDER BY id').all().map(w=>w.folder_name),directories);
 for(const copy of copies)p.index(copy.local);
 assert.equal(p.browse().length,2);
 const source=p.source(1,'confirmed-entry','Different platform title',30,copies[0].work);
 assert.equal(p.need(source),true);
 p.decision('k-accept','accept',copies[0].local,source,'user confirms same set and accepts local 31P; not byte equality');
 assert.equal(p.need(source),false);
 assert.equal(p.one('SELECT count(*) n FROM archive_catalog_works').n,2);
 assert.equal(p.one('SELECT count(*) n FROM archive_catalog_download_tasks').n,0);
 assert.equal(p.one('SELECT image_count FROM archive_catalog_local_works WHERE id=?',copies[0].local).image_count,31);
 assert.equal(p.one('SELECT media_summary FROM archive_catalog_source_works WHERE id=?',source).media_summary,'30P');
 p.db.close();
});

test('A local first, no invented source or job; browse joins preserve media IDs',()=>{
 const p=new Pilot(),x=p.local('a','local-only');const post=p.index(x.local);
 assert.equal(p.browse()[0].post_id,post);assert.equal(p.one('SELECT count(*) n FROM archive_catalog_source_works').n,0);
 assert.equal(p.one('SELECT count(*) n FROM local_ingest_jobs').n,0);p.db.close();
});
test('B explicit NO032 -> source NO030 survives rescan and restart',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'mapping-b-')),'test.sqlite');let p=new Pilot(file);
 const s=p.source(1,'stable-30','Nurse',30),w=p.one('SELECT work_id FROM archive_catalog_source_works WHERE id=?',s).work_id;
 const l=p.local('b','NO032 Nurse',w);p.rescan(l.local,36,32);p.db.close();p=new Pilot(file,false);
 assert.equal(p.rescan(l.local,36,32).work,w);p.db.close();
});
test('C user same-work decision permits differing hashes, two copies, one primary',()=>{
 const p=new Pilot(),a=p.local('c1','NO029'),b=p.local('c2','NO030',a.work);
 assert.notEqual(createHash('sha256').update('version-a').digest('hex'),createHash('sha256').update('version-b').digest('hex'));
 p.decision('same','same_work',b.local,null,'user says same work; bytes differ');p.index(a.local);p.index(b.local);
 assert.equal(p.browse().length,1);assert.equal(p.one('SELECT count(*) n FROM posts').n,2);
 p.run('UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=?',b.local,a.work);assert.equal(p.browse().length,1);p.db.close();
});
test('D two platforms explicitly share Work; accepted existing copy avoids demand',()=>{
 const p=new Pilot(),l=p.local('d','local');for(const c of [1,2]){const s=p.source(c,'stable','Title',1,l.work);p.decision('d'+c,'accept',l.local,s);assert.equal(p.need(s),false);}
 assert.equal(p.one('SELECT count(*) n FROM archive_catalog_works').n,1);p.db.close();
});
test('E equal title/count cannot auto merge; rejection persists and can be revoked',()=>{
 const p=new Pilot(),l=p.local('e','Same title',null,61),s=p.source(1,'e','Same title',1);
 const d=p.decision('reject','not_same',l.local,s,'different theme');p.rescan(l.local,61,s);
 assert.equal(p.blocked(l.local,s),true);assert.equal(p.one('SELECT count(*) n FROM archive_catalog_works').n,2);
 p.revoke(d);assert.equal(p.blocked(l.local,s),false);assert.equal(p.one('SELECT count(*) n FROM archive_catalog_works').n,2);p.db.close();
});
test('F declared 30P and actual 31P retained separately; explicit version acceptance',()=>{
 const p=new Pilot(),l=p.local('f','local',null,31),s=p.source(1,'f','Title',1,l.work);
 p.decision('accept-f','accept',l.local,s,'accept existing 31P version');assert.equal(p.need(s),false);
 assert.equal(p.one('SELECT media_summary FROM archive_catalog_source_works WHERE id=?',s).media_summary,'30P');
 assert.equal(p.one('SELECT image_count FROM archive_catalog_local_works WHERE id=?',l.local).image_count,31);p.db.close();
});
test('G both arrival orders reuse confirmed ID; existing Work merge is a conflict',()=>{
 const p=new Pilot(),s=p.source(1,'g','source-first',1),w=p.one('SELECT work_id FROM archive_catalog_source_works WHERE id=?',s).work_id;
 assert.equal(p.local('g1','later-local',w).work,w);const l=p.local('g2','local-first');p.source(2,'g2','later-source',2,l.work);
 assert.equal(p.one('SELECT count(*) n FROM archive_catalog_works').n,2);
 assert.throws(()=>p.source(1,'g','changed',1,l.work),/merge/);p.db.close();
});
test('H title/order/withdrawal never replaces manual Work or removes assets',()=>{
 const p=new Pilot(),l=p.local('h','User title'),s=p.source(1,'stable','Source title',30,l.work);const post=p.index(l.local);
 p.observe(s,'New title',88,0);p.rescan(l.local,31,88);
 assert.equal(p.one('SELECT display_title FROM archive_catalog_works WHERE id=?',l.work).display_title,'User title');
 assert.equal(p.observe(s,'Ambiguous reorder',99,1,false),'conflict');
 assert.equal(p.one('SELECT source_order FROM archive_catalog_source_works WHERE id=?',s).source_order,88);
 assert.equal(p.browse()[0].post_id,post);p.db.close();
});
test('I exact fulfillment preserves staged snapshot, download history and active claims',()=>{
 const p=new Pilot(),l=p.local('i','local');let selected;
 for(const [i,state,claim] of [[1,'staged',null],[2,'claimed','worker'],[3,'downloading','worker'],[4,'staged','retained-worker']]) {
  const s=p.source(1,'i'+i,'Title',i,l.work),d=p.decision('i'+i,'accept',l.local,s),t=p.task(s,state,claim);
  assert.equal(p.fulfill('finish'+i,t,d),i===1?'fulfilled':'blocked');if(i===1)selected=t;
 }
 assert.equal(p.one('SELECT count(*) n FROM research_fulfillments').n,1);
 const row=p.one('SELECT * FROM archive_catalog_download_tasks WHERE id=?',selected);assert.equal(row.status,'staged');assert.equal(row.attempt_count,1);assert.equal(row.download_id,null);assert.equal(row.completed_at,null);
 assert.equal(JSON.parse(p.one('SELECT prior_json FROM research_fulfillments').prior_json).status,'staged');p.db.close();
});
test('J replay preserves IDs; interrupted synthetic rename is detected before registration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mapping-j-')),src=join(dir,'before.ppm'),dst=join(dir,'after.ppm');
 writeFileSync(src,'P3\n1 1\n255\n0 0 0\n');const hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex'),expected=hash(src);
 // Filesystem is not a DB transaction: simulate interruption AFTER rename, BEFORE registration.
 renameSync(src,dst);assert.equal(existsSync(src),false);assert.equal(hash(dst),expected);
 const p=new Pilot(),a=p.local('j','synthetic-moved'),post=p.index(a.local);
 assert.deepEqual(p.local('j','synthetic-moved'),a);assert.equal(p.index(a.local),post);
 assert.throws(()=>p.local('j','different-payload'),/payload/);
 const s=p.source(1,'j','Title',1,a.work),d=p.decision('j-accept','accept',a.local,s),t=p.task(s);
 assert.equal(p.fulfill('j-finish',t,d),'fulfilled');assert.equal(p.fulfill('j-finish',t,d),'replayed');
 assert.equal(p.one('SELECT count(*) n FROM posts').n,1);assert.deepEqual(p.db.prepare('PRAGMA foreign_key_check').all(),[]);p.db.close();
});
