// Paired SQL / service / HTTP measurements against the isolated production builds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
const [codeArg, evidenceArg, label, url] = process.argv.slice(2);
const codeRoot = fs.realpathSync(codeArg), evidence = fs.realpathSync(evidenceArg);
assert(['before', 'after'].includes(label));
assert(/^http:\/\/127\.0\.0\.1:4[4-8]\d{2}$/.test(url));
const root = path.join(evidence, label);
assert(fs.existsSync(path.join(root, '.isolated-gallery-perf')));
assert(!fs.existsSync(path.join(codeRoot, '.env')));
Object.assign(process.env, { NODE_ENV: 'production', COS_GALLERY_MODE: 'true', DERIVATIVE_MODE: 'lazy', IMAGE_DETAIL_SOURCE: 'preview',
  DATA_ROOT: root, DB_DIR: path.join(root,'db'), GALLERY_ROOT: path.join(root,'gallery'),
  THUMBNAILS_DIR: path.join(root,'thumbnails'), PREVIEWS_DIR: path.join(root,'previews'), LOCAL_INGEST_STARTUP_SCAN: 'false' });
delete process.env.VITEST;
const read = name => JSON.parse(fs.readFileSync(path.join(evidence,name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(evidence,name),JSON.stringify(value,null,2));
const samples = read('samples.json');
const stats = values => { const sorted = [...values].sort((a,b)=>a-b); return { median: sorted[Math.floor(sorted.length/2)], min: sorted[0], max: sorted.at(-1), samples: values }; };
const measure = fn => { fn(); const times=[]; let result; for(let n=0;n<5;n++){const t=performance.now(); result=fn(); times.push(performance.now()-t);} return { ms:stats(times),result }; };
const db = new DatabaseSync(path.join(root,'db/gallery.sqlite'), {readOnly:true});
db.exec('PRAGMA query_only=ON');
const report = { node:process.version, rows:db.prepare('SELECT count(*) n FROM images').get().n, sql:[], service:[], http:[] };
for(const col of ['thumbnail_path','preview_path']) {
  const sql=`SELECT * FROM images WHERE ${col} = ?`, stmt=db.prepare(sql);
  for(const name of ['old','recent','missing']) {
    const value=name==='missing'?'__benchmark_missing__.webp':samples.sql[name][col];
    const result=measure(()=>stmt.get(value));
    report.sql.push({col,name,id:result.result?.id??null,ms:result.ms,plan:db.prepare('EXPLAIN QUERY PLAN '+sql).all(value)});
  }
}
db.close();
const load = rel => import(pathToFileURL(path.join(codeRoot,'server/dist',rel)).href);
const {appConfig}=await load('config/env.js');
assert.equal(appConfig.databasePath,path.join(root,'db/gallery.sqlite'));
const {galleryService}=await load('services/gallery-service.js');
const {canonicalCreatorGalleryRepository}=await load('db/repositories.js');
const {databaseManager}=await load('db/database.js');
for(const name of ['ordinary','multi']) {
  const id=samples[name].creatorId;
  const repo=measure(()=>canonicalCreatorGalleryRepository.listVisibleWorks(id,1,24));
  const service=measure(()=>galleryService.getCanonicalCreatorWorks(id,1,24));
  report.service.push({name,repositoryMs:repo.ms,serviceIncludingRepositoryMs:service.ms,
    count:service.result.items.length,nestedMedia:service.result.items.reduce((n,i)=>n+(i.mediaItems?.length??0),0),
    rawJsonBytes:Buffer.byteLength(JSON.stringify(service.result))});
  write(`${label}-${name}-page.json`,service.result);
}
// Pure service timing above does not overlap HTTP timing below.
databaseManager.close();
for(const [name, route] of [
  ...['ordinary','multi'].map(n=>[n,`/api/cos-gallery/creators/${samples[n].creatorId}/works?page=1&limit=24`]),
  ...['old','recent'].flatMap(n=>[['thumbnail_path','thumbnails'],['preview_path','previews']].map(([col,prefix])=>[`${n}-${prefix}`,`/${prefix}/${samples.sql[n][col]}?v=benchmark-stable`]))
]) {
  const raw=[];
  for(let n=0;n<6;n++) {
    const start=performance.now(), response=await fetch(url+route,{cache:'no-store'}), headersAt=performance.now();
    const bytes=await response.arrayBuffer(),end=performance.now(); assert.equal(response.status,200,route);
    if(n) raw.push({waiting:headersAt-start,total:end-start,bytes:bytes.byteLength,encoding:response.headers.get('content-encoding'),cache:response.headers.get('cache-control')});
  }
  report.http.push({name,waitingMs:stats(raw.map(x=>x.waiting)),totalMs:stats(raw.map(x=>x.total)),bodyBytes:raw[0].bytes,encoding:raw[0].encoding,cacheControl:raw[0].cache});
}
write(`${label}-measurements.json`,report);
console.log(JSON.stringify(report,null,2));
