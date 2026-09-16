#!/usr/bin/env node
/**
 * Isolated, GET-only catalog startup and interaction acceptance.
 * BROWSER_NODE_MODULES=/absolute/node_modules node scripts/perf/catalog-browser.mjs
 *   --url=http://127.0.0.1:PORT --phase=before|after --config=IGNORED.json --out=IGNORED.json
 * Config: { isolatedDataRoot, thumbnailDir?, previewDir?, stage2CreatorId?, ingestCreatorId? }.
 * Cache roots must be descendants of isolatedDataRoot in this worktree's ignored data/.mocks.
 * Before: one bounded page-combination run, never repeat an established slow timeout.
 * After: one warmup + three measured starts, then one read-only interaction sequence.
 * No private IDs, paths or fixture content belong in this tracked script.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at=arg.indexOf('='); return at<0?[arg.slice(2),true]:[arg.slice(2,at),arg.slice(at+1)]; }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const origin = new URL(String(args.url));
assert(origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)&&origin.port&&origin.port!=='4141','Use an isolated localhost port, never production 4141');
assert(origin.pathname==='/'&&!origin.search&&!origin.hash&&!origin.username&&!origin.password);
assert(['before','after'].includes(args.phase));
const configFile=path.resolve(root,String(args.config)), outFile=path.resolve(root,String(args.out));
for(const file of [configFile,outFile])execFileSync('git',['check-ignore','--quiet','--',file],{cwd:root,stdio:'pipe'});
const config=JSON.parse(await readFile(configFile,'utf8'));
const isolatedRoot=path.resolve(String(config.isolatedDataRoot));
const within=(parent,file)=>file.startsWith(parent+path.sep);
assert(['data','.mocks'].some(dir=>within(path.resolve(root,dir),isolatedRoot)),'Explicit isolated data subtree in this worktree required');
assert(!/^g:/i.test(isolatedRoot),'Do not access the production media volume');
const cacheRoots=Object.fromEntries(['thumbnails','previews'].map(kind=>{
  const value=config[kind==='thumbnails'?'thumbnailDir':'previewDir'];
  const directory=value?path.resolve(value):null;
  assert(!directory||within(isolatedRoot,directory),'Cache root must remain inside the isolated fixture');
  return [kind,directory];
}));
const timeout=Number(args.timeout??45000), iterations=Number(args.iterations??3);
assert(Number.isFinite(timeout)&&timeout>=1000&&timeout<=60000);
assert(Number.isInteger(iterations)&&iterations>=3&&iterations<=10);
const requireBrowser=createRequire(path.join(process.env.BROWSER_NODE_MODULES??path.join(root,'node_modules'),'__catalog_browser__.cjs'));
const {chromium}=requireBrowser('playwright');
const result={schemaVersion:1,phase:args.phase,origin:origin.origin,startedAt:new Date().toISOString(),viewport:{width:1440,height:1000},
  conditions:{cache:'Only existing isolated derivatives allowed; originals, external URLs and all non-GET requests blocked.',httpCache:'Playwright routing disables HTTP cache equally for both versions.',uiMilestones:'DOM insertion readiness, including hidden workspaces; not a browser contentful-paint metric.',before:'One bounded page-combination attempt only.',after:`One warmup plus ${iterations} measured starts; interactions once.`,timeoutMs:timeout},runs:[],interactions:[],failures:[]};
const browser=await chromium.launch({headless:!args.headed});
result.browserVersion=browser.version();
const catalogPath='/api/admin/archive-catalog';
const endpoints={roster:catalogPath,metadata:catalogPath+'/creator-sync/metadata-creators',stage2:catalogPath+'/download-creators',settings:'/api/admin/local-ingest/settings',jobs:'/api/admin/local-ingest/jobs',operation:'/api/admin/local-ingest/operation'};
function brief(payload){
  if(!payload||typeof payload!=='object')return null;
  const output={};
  for(const key of ['total','page','limit','hasMore','taskTotal','state'])if(key in payload)output[key]=payload[key];
  if(payload.summary)output.summary=payload.summary;
  if(Array.isArray(payload.items))output.items=payload.items.map(item=>({id:item.id??item.creatorId,creatorId:item.creatorId,status:item.status,metadataStatus:item.metadataTask?.status??null,metadataTaskId:item.metadataTask?.id??null,localWorks:item.localWorks,sourceWorks:item.sourceWorks,sourceCollections:item.sourceCollections,missingWorks:item.missingWorks,total:item.total,acquisitionState:item.acquisitionState}));
  if(Array.isArray(payload.creators))output.creators=payload.creators.map(item=>({creatorId:item.creatorId,total:item.total,pending:item.pending,running:item.running}));
  return output;
}
async function createSession(){
  const context=await browser.newContext({viewport:result.viewport,locale:'zh-CN',timezoneId:'Asia/Shanghai',reducedMotion:'reduce',serviceWorkers:'block'});
  const session={context,page:null,requests:[],responses:[],blocked:[],errors:[],pendingBodies:[],started:performance.now()};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());let reason=null;
    if(url.origin!==origin.origin)reason='external';
    else if(request.method()!=='GET')reason='non-get';
    else if(/^\/(?:api\/)?(?:media|originals|videos)\//.test(url.pathname))reason='original-media';
    const match=url.pathname.match(/^\/(thumbnails|previews)\/(.+)$/);
    if(!reason&&match){
      const directory=cacheRoots[match[1]],file=directory?path.resolve(directory,decodeURIComponent(match[2])):null;
      if(!file||!within(directory,file)||!await stat(file).then(s=>s.isFile()).catch(()=>false))reason='missing-isolated-derivative';
    }
    if(reason){session.blocked.push({path:url.pathname,reason});await route.abort('blockedbyclient');}else await route.continue();
  });
  await context.addInitScript(()=>{
    performance.setResourceTimingBufferSize(10000);
    const state={rosterMs:null,sourceMs:null,stage2Ms:null,settingsMs:null};
    window.__catalogPaint=state;
    const ready=()=>{
      const selectors={rosterMs:'.creator-cards .creator-card',sourceMs:'[data-test="metadata-pagination"]',stage2Ms:'[data-test="stage2-totals"]',settingsMs:'[data-test="local-ingest-inbox-root"]'};
      for(const [key,selector]of Object.entries(selectors))if(state[key]===null&&document.querySelector(selector))state[key]=performance.now();
    };
    new MutationObserver(ready).observe(document,{childList:true,subtree:true});ready();
  });
  const page=await context.newPage();session.page=page;page.setDefaultTimeout(timeout);
  page.on('request',request=>{
    const url=new URL(request.url());if(url.origin===origin.origin)session.requests.push({path:url.pathname+url.search,method:request.method(),atMs:performance.now()-session.started});
  });
  page.on('response',response=>{
    const url=new URL(response.url());if(url.origin!==origin.origin)return;
    const task=(async()=>{
      const record={path:url.pathname+url.search,status:response.status(),atMs:performance.now()-session.started};
      if(url.pathname.startsWith('/api/')){
        const bytes=await response.body();record.bodyBytes=bytes.length;
        // Never serialize settings, bridge tokens, private paths or full source titles.
        if(!/(?:settings|bridge-token)$/.test(url.pathname))try{record.payload=brief(JSON.parse(bytes.toString('utf8')));}catch{}
      }
      record.completedMs=performance.now()-session.started;session.responses.push(record);
      if(response.status()>=400)session.errors.push({path:url.pathname,status:response.status()});
    })().catch(error=>session.errors.push({path:url.pathname,error:error.message}));
    session.pendingBodies.push(task);
  });
  page.on('pageerror',error=>session.errors.push({error:error.message}));
  return session;
}
async function waitForInitial(session){
  const deadline=performance.now()+timeout;
  for(;;){
    const rows=session.responses;
    const has=(pathname,test=()=>true)=>rows.some(row=>{const u=new URL(row.path,origin);return u.pathname===pathname&&row.status===200&&test(u);});
    if(has(endpoints.roster,u=>u.searchParams.get('limit')==='50')&&has(endpoints.roster,u=>u.searchParams.get('limit')==='1')&&has(endpoints.metadata)&&has(endpoints.stage2)&&has(endpoints.settings)&&has(endpoints.jobs)&&has(endpoints.operation))return;
    if(performance.now()>deadline)throw new Error('Initial catalog combination did not complete within the bounded timeout; no repeat attempted');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
async function snapshot(session){
  const {page}=session;
  return page.evaluate(()=>({paint:window.__catalogPaint,resources:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/api/')).map(e=>({path:new URL(e.name).pathname+new URL(e.name).search,durationMs:e.duration,waitMs:e.responseStart-e.requestStart,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize})),workspace:document.querySelector('[aria-pressed="true"][data-test^="workspace-"]')?.getAttribute('data-test'),rosterCards:document.querySelectorAll('.creator-cards .creator-card').length,metadataRows:document.querySelectorAll('[data-test="metadata-creators"] tbody tr').length,stage2Groups:document.querySelectorAll('[data-test="stage2-creators"] > article').length}));
}
async function readAction(session,name,action,predicate){
  const start=performance.now(),{page}=session;
  const waiting=page.waitForResponse(response=>{const u=new URL(response.url());return u.origin===origin.origin&&predicate(u);},{timeout});
  await action();const response=await waiting;assert.equal(response.status(),200,name);
  const payload=await response.json();
  result.interactions.push({name,completeMs:performance.now()-start,payload:brief(payload)});
  return payload;
}
async function interact(session){
  const {page}=session;
  const roster=page.locator('section[aria-label="博主库"]');
  const next=roster.getByRole('button',{name:'下一页',exact:true});
  if(await next.isEnabled()){
    await readAction(session,'roster-next',()=>next.click(),u=>u.pathname===catalogPath&&u.searchParams.get('page')==='2');
    await page.waitForFunction(()=>document.querySelector('.roster-paging')?.textContent.includes('第 2 页'));
    await page.waitForFunction(()=>{const rect=document.querySelector('.creator-cards').getBoundingClientRect();return rect.top>=-5&&rect.top<innerHeight;});
  }
  const sourceFilter=roster.locator('.roster-filters label').filter({hasText:'来源记录'}).locator('select');
  for(const value of ['no-unchecked','no-not-found','yes']){
    await readAction(session,`roster-source-${value}`,()=>sourceFilter.selectOption(value),u=>u.pathname===catalogPath&&u.searchParams.get('hasSource')===value);
  }
  await page.locator('[data-test="workspace-source"]').click();
  const source=page.locator('section[aria-label="博主元数据采集队列"]');
  await source.locator('[data-test="metadata-pagination"]').waitFor();
  const noTaskRows=await source.locator('tbody tr').filter({hasText:'无检查记录'}).count();
  const rowCount=await source.locator('tbody tr').count();
  const initial=session.responses.find(r=>new URL(r.path,origin).pathname===endpoints.metadata)?.payload;
  assert.equal(noTaskRows,initial?.items?.filter(item=>item.metadataTaskId===null).length??0,'Source null-task rows must display no-task without fabricated task state');
  result.interactions.push({name:'source-no-task-ui',rowCount,noTaskRows,passed:true});
  const sourceNext=source.locator('[data-test="metadata-next"]');
  if(await sourceNext.isEnabled())await readAction(session,'source-next',()=>sourceNext.click(),u=>u.pathname===endpoints.metadata&&u.searchParams.get('page')==='2');
  // The dedicated status is a read API filter, not an invented UI control.
  const noTaskResponse=await page.request.get(new URL(endpoints.metadata+'?page=1&limit=20&enabled=all&status=no_task',origin).href,{timeout});
  assert.equal(noTaskResponse.status(),200);const noTask=await noTaskResponse.json();
  assert(noTask.items.every(item=>item.metadataTask===null));
  result.interactions.push({name:'source-no-task-api',payload:brief(noTask),passed:true});
  if(noTask.total>0){
    // A zero-match first page is not evidence that a null-task row renders.
    let rendered=await source.locator('tbody tr').filter({hasText:'无检查记录'}).count();
    const maxPages=Math.ceil((initial?.total??0)/20);
    for(let attempt=0;!rendered&&attempt<maxPages&&await sourceNext.isEnabled();attempt++){
      const payload=await readAction(session,'source-find-no-task-page',()=>sourceNext.click(),u=>u.pathname===endpoints.metadata);
      await page.waitForFunction(n=>document.querySelector('[data-test="metadata-pagination"]')?.textContent.includes(`第 ${n} /`),payload.page);
      rendered=await source.locator('tbody tr').filter({hasText:'无检查记录'}).count();
    }
    assert(rendered>0,'An actual no-task row must be rendered when such records exist');
    result.interactions.push({name:'source-no-task-rendered',noTaskRows:rendered,passed:true});
  }
  const detail=source.locator('details summary').filter({hasText:/来源详情|检查详情/}).first();
  if(await detail.count()){await detail.click();await detail.click();}
  const reuse=source.getByText('本地作品与来源关联说明（只读）',{exact:true});
  await readAction(session,'source-reuse-read',()=>reuse.click(),u=>u.pathname.endsWith('/creator-sync/source-reuse'));
  await page.locator('[data-test="workspace-staging"]').click();
  const staging=page.locator('section[aria-label="缺失作品下载队列"]');
  await staging.locator('[data-test="stage2-totals"]').waitFor();
  const group=config.stage2CreatorId?staging.locator(`[data-creator-id="${config.stage2CreatorId}"] [data-test="toggle-stage2-creator"]`):staging.locator('[data-test="toggle-stage2-creator"]').first();
  if(await group.count()){
    const tasks=await readAction(session,'stage2-expand',()=>group.click(),u=>u.pathname.endsWith('/download-task-page'));
    await page.waitForFunction(n=>document.querySelectorAll('[data-test="stage2-task"]').length===n,tasks.items.length);
    const detailNext=staging.getByRole('button',{name:'下一页明细',exact:true});
    if(await detailNext.isEnabled())await readAction(session,'stage2-next-detail',()=>detailNext.click(),u=>u.pathname.endsWith('/download-task-page')&&u.searchParams.get('page')==='2');
    await group.click();
    const groupNext=staging.locator('[data-test="stage2-creators-next"]');
    if(await groupNext.isEnabled())await readAction(session,'stage2-next-creator',()=>groupNext.click(),u=>u.pathname===endpoints.stage2&&u.searchParams.get('page')==='2');
  }
  await staging.locator('label').filter({hasText:'任务状态'}).locator('select').selectOption('staged');
  await readAction(session,'stage2-status-filter',()=>staging.getByRole('button',{name:'筛选（只读）',exact:true}).click(),u=>u.pathname===endpoints.stage2&&u.searchParams.get('status')==='staged');
  await page.locator('[data-test="workspace-ingest"]').click();
  const ingest=page.locator('section[aria-label="本地入库"]'),settings=ingest.locator('[data-test="ingest-settings"]');
  assert.equal(await settings.getAttribute('open'),null);
  await settings.locator('summary').click();assert.notEqual(await settings.getAttribute('open'),null);
  await settings.locator('summary').click();assert.equal(await settings.getAttribute('open'),null);
  const ingestGroups=ingest.locator('[data-test="local-ingest-creators"] > article > button');
  let ingestIndex=0;
  if(config.ingestCreatorId){
    const dashboard=session.responses.find(row=>new URL(row.path,origin).pathname===endpoints.jobs)?.payload;
    ingestIndex=dashboard?.creators?.findIndex(item=>item.creatorId===config.ingestCreatorId)??-1;
    assert(ingestIndex>=0,'Requested ingest fixture creator must exist in the read dashboard');
  }
  const group3=ingestGroups.nth(ingestIndex);
  if(await group3.count()){
    assert.equal(await group3.getAttribute('aria-expanded'),'false');
    await readAction(session,'stage3-expand',()=>group3.click(),u=>u.pathname===endpoints.jobs&&u.searchParams.has('creatorId'));
    assert.equal(await group3.getAttribute('aria-expanded'),'true');
    await readAction(session,'stage3-collapse',()=>group3.click(),u=>u.pathname===endpoints.jobs&&!u.searchParams.has('creatorId'));
    assert.equal(await group3.getAttribute('aria-expanded'),'false');
  }
  result.interactions.push({name:'stage3-settings-and-fold',passed:true});
  assert(!session.blocked.some(row=>['non-get','original-media'].includes(row.reason)));
  assert.deepEqual(session.errors,[]);
}
const med=values=>{const a=values.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?{n:a.length,median:a[Math.floor(a.length/2)],min:a[0],max:a.at(-1)}:null;};
try{
  const count=args.phase==='before'?1:iterations+1;
  for(let iteration=0;iteration<count;iteration++){
    const session=await createSession();session.started=performance.now();
    const run={iteration,warmup:args.phase==='after'&&iteration===0};
    try{
      await session.page.goto(new URL('/archive-catalog',origin).href,{waitUntil:'domcontentloaded',timeout});
      await waitForInitial(session);run.combinationCompleteMs=performance.now()-session.started;
      await session.page.waitForFunction(()=>window.__catalogPaint.rosterMs!==null&&window.__catalogPaint.sourceMs!==null&&window.__catalogPaint.stage2Ms!==null);
      run.snapshot=await snapshot(session);run.passed=true;
      if(args.phase==='after'&&iteration===count-1&&!args['startup-only'])await interact(session);
    }catch(error){run.error=String(error.stack??error);run.snapshot=await snapshot(session).catch(()=>null);result.failures.push({iteration,error:error.message});}
    finally{
      run.requests=session.requests;run.responses=session.responses;run.blocked=session.blocked;run.errors=session.errors;
      const finished=new Set(session.responses.map(row=>row.path));run.pendingRequests=session.requests.filter(row=>row.path.startsWith('/api/')&&!finished.has(row.path));
      result.runs.push(run);await session.context.close();
      await mkdir(path.dirname(outFile),{recursive:true});await writeFile(outFile,JSON.stringify(result,null,2)+'\n');
    }
    console.log(JSON.stringify({iteration,warmup:run.warmup,completeMs:run.combinationCompleteMs,paint:run.snapshot?.paint,error:run.error?.split('\n')[0],pending:run.pendingRequests.map(row=>row.path)}));
    if(run.error)break;
  }
  const measured=result.runs.filter(run=>!run.warmup&&run.passed);
  result.summary={combinationCompleteMs:med(measured.map(run=>run.combinationCompleteMs)),...Object.fromEntries(['rosterMs','sourceMs','stage2Ms','settingsMs'].map(key=>[key,med(measured.map(run=>run.snapshot?.paint[key]))]))};
  result.passed=result.failures.length===0;
}finally{await browser.close();result.completedAt=new Date().toISOString();await writeFile(outFile,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({output:outFile,passed:result.passed,summary:result.summary,interactionCount:result.interactions.length}));
if(!result.passed)process.exitCode=1;
