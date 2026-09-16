// Isolated real production-entry startup and GET benchmark. No production defaults.
// node this-file CODE_ROOT ISOLATED_DATA_ROOT PORT before|after OUTPUT.json
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const [codeArg,dataArg,portArg,phase,outArg]=process.argv.slice(2);
const creatorId=Number(process.env.PERF_CREATOR_ID??1);
assert(Number.isSafeInteger(creatorId)&&creatorId>0);
const code=fs.realpathSync(codeArg),data=fs.realpathSync(dataArg),port=Number(portArg),out=path.resolve(outArg);
assert(['before','after'].includes(phase));assert(port>=4400&&port<4900);
assert(fs.existsSync(path.join(data,'.isolated-gallery-perf')));
assert(!fs.existsSync(path.join(code,'.env')));
const paths={DATA_ROOT:data,DB_DIR:path.join(data,'db'),GALLERY_ROOT:path.join(data,'gallery'),THUMBNAILS_DIR:path.join(data,'thumbnails'),PREVIEWS_DIR:path.join(data,'previews')};
for(const p of Object.values(paths))assert(p===data||p.startsWith(data+path.sep));
const env={...process.env,...paths,NODE_ENV:'production',SERVER_HOST:'127.0.0.1',SERVER_PORT:String(port),COS_GALLERY_MODE:'true',DERIVATIVE_MODE:'lazy',LOCAL_INGEST_STARTUP_SCAN:'false'};
delete env.VITEST;delete env.DATABASE_URL;
const httpOnly=process.argv.includes('--http-only');
const report=httpOnly?JSON.parse(fs.readFileSync(out,'utf8')):{phase,node:process.version,code,paths,port,startups:[],http:[]};
if(httpOnly){report.previousHarnessFailure=report.failure;delete report.failure;}
let child;
const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
const probe=new URL('./startup-check-probe.mjs',import.meta.url).href;
async function stop(){if(!child)return;const c=child;child=null;await new Promise(resolve=>{c.once('exit',resolve);if(c.exitCode!==null)resolve();else c.kill();});}
async function start(iteration){
  const t=performance.now();let logs='';
  child=spawn(process.execPath,['--import',probe,path.join(code,'server/dist/index.js')],{cwd:code,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const c=child;c.stdout.on('data',s=>{logs+=s;});c.stderr.on('data',s=>{logs+=s;});
  const deadline=Date.now()+120000;
  while(!logs.includes('Local ingest startup compensation scan skipped')){
    if(c.exitCode!==null)throw Error('Isolated startup exited: '+logs);
    if(Date.now()>deadline)throw Error('Isolated startup timed out: '+logs);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(logs.includes('Startup scan skipped'),'Unexpected scan; isolated fixture must already have matching root');
  const response=await fetch(`http://127.0.0.1:${port}/api/health`);assert(response.ok);assert((await response.json()).ok);
  const item={iteration,warmup:iteration<=0,readyMs:performance.now()-t,pid:c.pid,logs};if(iteration>=0)report.startups.push(item);save();
  console.log(JSON.stringify({event:'startup-measured',phase,iteration,readyMs:item.readyMs,pid:c.pid}));
}
const endpoints=[
 '/api/admin/archive-catalog?page=1&limit=50&active=active&hasSource=no-unchecked',
 '/api/admin/archive-catalog/creator-sync/metadata-creators?page=1&limit=50',
 '/api/admin/archive-catalog/creator-sync/metadata-creators?page=2&limit=50&status=no_task',
 '/api/admin/archive-catalog/creator-sync/stats',
 '/api/admin/archive-catalog/download-creators?page=1&limit=50&sort=recent',
 '/api/admin/archive-catalog/download-creators?page=1&limit=50&sort=recent&status=staged',
 `/api/admin/archive-catalog/download-task-page?page=1&limit=50&creatorId=${creatorId}`,
 '/api/admin/local-ingest/operation'
];
try{
  if(httpOnly)await start(-1);
  else for(let i=0;i<4;i++){await start(i);if(i<3)await stop();}
  console.log(JSON.stringify({event:'ready-for-http',port,phase}));
  for(const url of endpoints){
    if(httpOnly&&report.http.some(row=>row.url===url))continue;
    // Stable slow baseline: one bounded sample only, never repeated pressure.
    for(let i=0;i<(phase==='before'?1:4);i++){
      const t=performance.now();const response=await fetch(`http://127.0.0.1:${port}${url}`,{signal:AbortSignal.timeout(180000)});const body=await response.text();
      assert.equal(response.status,200,url);const item={url,iteration:i,warmup:phase==='after'&&i===0,ms:performance.now()-t,bytes:Buffer.byteLength(body),body:JSON.parse(body)};report.http.push(item);save();console.log(JSON.stringify({event:'http-measured',phase,url,iteration:i,ms:item.ms,bytes:item.bytes}));
    }
  }
  console.log(JSON.stringify({event:'ready-for-browser',phase,port,pid:child.pid}));
  process.stdin.setEncoding('utf8');await new Promise(resolve=>process.stdin.on('data',s=>{if(s.trim()==='stop')resolve();}));
}catch(error){report.failure=String(error.stack??error);console.error(report.failure);process.exitCode=1;}
finally{save();await stop();}
