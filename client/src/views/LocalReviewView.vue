<template>
  <section class="review-page">
    <header><h2>{{ eligibility?.title || session?.title || '具体未完成项' }} · 查看并处理</h2><p>{{ target?.kind === 'stage3' ? 'Costuan入库原任务审核' : '本地目录接纳原计划审核' }}。{{ continuationScope }}</p><RouterLink :to="backTo">返回原工作区</RouterLink></header>
    <AdmissionErrorNotice :error="error" /><p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!eligibility&&!session&&!error" role="status">正在读取本项审核条件…</p><p v-if="pending && !previewNeedsRefresh" class="warning" role="status">提交回执未确认，原请求与文件选择已冻结；请核对并重试原提交。</p>
    <section v-if="eligibility && !eligibility.eligible && !session" class="panel"><h2>当前不能使用此审核入口</h2><p>{{ eligibility.reason }}</p><p>保留原状态与文件；这里不提供通用放行，也不会转换任务类型。</p></section>
    <section v-if="eligibility?.eligible && !session" class="panel"><h2>读取这项的审核证据</h2><p>仅检查当前未完成项，不扫描整个等待区。大型图集或原包校验需要时间；检查会保存本项审核预览，不移动、回收或接纳文件。</p><button class="primary" :disabled="busy" data-test="review-inspect" @click="inspect">{{ busy ? '正在提交检查…' : '生成本项审核预览' }}</button></section>
    <section v-if="session" class="panel"><div class="heading"><h2>{{ statusLabel(session.status) }}</h2><button :disabled="busy" @click="refresh()">读取最新状态</button></div><p v-if="!session.error">{{ session.message || session.phase }}</p><p>{{ session.totalFiles }} 个文件 · {{ session.issueCount }} 个需要查看的项目<span v-if="session.fileActionCount"> · 已处理 {{ session.completedFileActions }} / {{ session.fileActionCount }} 个明确文件处置</span></p><p v-if="active" role="status">后台继续，关闭页面不取消。重新打开会读取此项原会话，不自动重跑其他任务。</p><AdmissionErrorNotice :error="session.error" /><p v-if="session.result">{{ session.result.message }}</p><details><summary>技术详情</summary><pre>{{ session.target }}
会话 {{ session.sessionId }}
阶段 {{ session.phase }}
确认状态 {{ session.confirmed }}</pre></details></section>
    <p v-if="session?.continuation && target?.kind==='admission'" class="hint" data-test="review-continuation">原计划共 {{ session.continuation.totalItems }} 项，已完成 {{ session.continuation.completedItems }} 项，待继续 {{ session.continuation.pendingItems }} 项（包含当前项）；已完成项不重跑。</p>
    <section v-if="previewNeedsRefresh" class="panel warning" role="status"><h2>审核预览需要重新检查</h2><p>旧预览不能提交。请按当前规则重新检查，再逐文件确认；成功刷新后会清空本地尚未提交的选择。</p><button data-test="review-refresh" :disabled="busy || filesLoading || session?.status!=='ready' || session.confirmed" @click="refreshPreview">{{ busy ? '正在重新检查…' : '按当前规则重新检查' }}</button></section>
    <section v-if="session?.result?.summary" class="panel" aria-label="实际媒体与保留文件结果">
      <h2>实际展示与保留结果</h2>
      <p>图库展示：{{ session.result.summary.images }} 张图片 · {{ session.result.summary.videos }} 个视频。</p>
      <p>另行保留：{{ session.result.summary.retainedOriginals }} 个未支持原件 · {{ session.result.summary.retainedAttachments }} 个附件；可恢复移出 {{ session.result.summary.quarantined }} 个明确文件。</p>
      <p>保留原件和附件不计入上述展示媒体；未支持原件不作为图片展示，也不表示文件已修复。原件在图集的 _未支持格式原件 目录内，删除整作品时会随作品永久删除。</p>
    </section>
    <section v-if="session && !['preparing'].includes(session.status)" class="panel" aria-label="具体文件审核">
      <h2>具体文件与处理选择</h2><p>可解码 WebP 按正常图片处理，无需逐个批准。保留原件 / PDF 不计入普通图片数；暂缓或未选项不会被自动删除。图集仍须有正常可展示的图片或视频。保留原件放入图集的 _未支持格式原件，不修复文件；删除整作品时也会永久删除这些原件。</p>
      <div class="actions"><label class="check"><input v-model="issuesOnly" type="checkbox" :disabled="filesLoading || busy" />只查看需要处理的文件</label><span>本次已选择 {{ Object.keys(choices).length }} 个文件，其他保持</span></div>
      <p v-if="filesLoading" role="status">正在读取这一页文件…</p><AdmissionErrorNotice v-else-if="filesError" :error="filesError" message="文件清单读取失败；不能据此认定没有需处理文件。"><button :disabled="busy" @click="loadFiles(files?.page??1)">重新读取文件清单</button></AdmissionErrorNotice><p v-else-if="files&&!files.items.length" class="hint">{{ issuesOnly ? '当前筛选没有需要处理的文件；可取消筛选查看本项全部文件。' : '本项未返回文件记录，请先核对原任务状态。' }}</p><p v-else-if="!files" class="hint">文件清单尚未读取。</p>
      <table v-if="files?.items.length"><thead><tr><th>相对文件 / 大小</th><th>问题及显示影响</th><th>本次选择</th></tr></thead><tbody><tr v-for="file in files.items" :key="file.relativePath"><td class="file-name">{{ file.relativePath }}<small>{{ size(file.size) }} · {{ kindLabel(file.kind) }}</small></td><td>{{ issueLabel(file.issue) }}<small v-if="file.message">{{ file.message }}</small><small v-if="file.preservedAt">已可恢复保留：{{ file.preservedAt }} · {{ file.actionState }}</small><small v-if="file.issue==='pixel_limit'||file.issue==='decode_failed'">保留原件后不作为普通图片展示，不降低解码上限；无法解码不等于已经确认损坏。</small><small v-if="file.issue==='attachment'">附件保留，不计入图片数，不转成图片。</small><small v-if="file.issue==='unsupported'">现有规则不支持自动处置，保留待核对。</small></td><td><label v-if="file.allowedActions.length">处置<select :value="choices[file.relativePath]?.action || ''" :disabled="busy || session.confirmed || !!pending || previewNeedsRefresh" @change="choose(file,$event)"><option value="">暂缓 / 原样保留</option><option v-for="action in file.allowedActions" :key="action" :value="action">{{ actionLabel(action) }}</option></select></label><span v-else>无需确认 / 暂无可用处理</span><label v-if="choices[file.relativePath]?.action==='quarantine'">明确移出原因<select v-model="choices[file.relativePath].reason" :disabled="busy || session.confirmed || !!pending || previewNeedsRefresh"><option value="advertisement">已确认广告</option><option value="damaged">已确认损坏文件</option></select></label></td></tr></tbody></table>
      <div v-if="files&&files.total>0" class="actions"><button :disabled="busy || filesLoading || files.page<=1" @click="loadFiles(files.page-1)">上一页文件</button><span>第 {{ files.page }} 页 · 共 {{ files.total }} 个文件</span><button :disabled="busy || filesLoading || files.page*files.limit>=files.total" @click="loadFiles(files.page+1)">下一页文件</button></div>
      <template v-if="!session.confirmed && session.status==='ready'"><label>本次审核备注（可选）<textarea v-model="note" maxlength="2000" :disabled="busy || !!pending || previewNeedsRefresh" placeholder="记录此次具体选择，不自动声称检查过其他文件" /></label><p v-if="busy||filesLoading||filesError||!files" class="action-reason">{{ busy ? '正在处理当前请求。' : filesLoading ? '文件清单正在读取，请稍候。' : filesError ? '先重新读取文件清单，保留原选择。' : '请先读取本项文件清单。' }}</p><div class="actions"><button @click="showConfirm=true" :disabled="busy||filesLoading||!!filesError||!files||previewNeedsRefresh" class="primary" data-test="review-confirm">{{ pending ? '核对并重试原提交' : '查看文件处置确认' }}</button><RouterLink :to="backTo">暂缓，保留原任务</RouterLink></div></template>
      <button v-if=" ['failed','interrupted'].includes(session.status)" class="primary" :disabled="busy" @click="showRetry=true">查看并重试原处置与恢复</button>
    </section>
    <div v-if="showConfirm" class="overlay"><section class="dialog" role="dialog" v-admission-dialog="{ close: () => showConfirm = false, locked: busy }" aria-modal="true" aria-label="确认文件处理"><h2>确认这一项的精确文件处理</h2><AdmissionErrorNotice :error="error" /><ul><li v-for="choice in Object.values(choices)" :key="choice.relativePath"><strong>{{ choice.relativePath }}</strong><span>{{ actionLabel(choice.action) }} · {{ reasonLabel(choice.reason) }}</span></li></ul><p>{{ continuationScope }}</p><p v-if="session?.continuation && target?.kind==='admission'">原计划共 {{ session.continuation.totalItems }} 项，已完成 {{ session.continuation.completedItems }} 项，待继续 {{ session.continuation.pendingItems }} 项（包含当前项）。</p><p>本次文件处置不永久删除。保留原件不作为图片展示，不修复文件；原件位于图集的 _未支持格式原件，删除整作品时会随作品永久删除。</p><label class="check"><input v-model="confirmChecked" type="checkbox" />{{ target?.kind==='admission' ? '确认以上文件与处理方式，并继续整个原计划的待完成项' : '确认以上文件与处理方式，并继续原 Job' }}</label><label v-if="quarantineCount" class="check warning"><input v-model="quarantineChecked" type="checkbox" />另行批准 {{ quarantineCount }} 个明确文件可恢复移出；已确认其为所选广告 / 损坏文件</label><p v-if="confirmBlockReason" class="action-reason">{{ confirmBlockReason }}</p><div class="actions"><button :disabled="busy" @click="showConfirm=false">返回核对</button><button class="primary" data-test="review-execute" :disabled="busy || previewNeedsRefresh || session?.status!=='ready' || session.confirmed || !confirmChecked || (quarantineCount>0&&!quarantineChecked)" @click="execute">{{ pending ? '重试原请求' : '确认处置并后台继续' }}</button></div></section></div>
    <div v-if="showRetry" class="overlay"><section class="dialog" role="dialog" v-admission-dialog="{ close: () => showRetry = false, locked: busy }" aria-modal="true" aria-label="重试原审核"><h2>继续原审核操作</h2><p>服务端核对已经成功移出的文件与实际记录，再继续未完成步骤。{{ continuationScope }}</p><div class="actions"><button :disabled="busy" @click="showRetry=false">取消</button><button :disabled="busy" @click="retry">确认重试这个原操作</button></div></section></div>
  </section>
</template>
<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import AdmissionErrorNotice from '../components/AdmissionErrorNotice.vue';
import { vAdmissionDialog } from '../utils/admission-dialog';
import { useAdmissionRoute } from '../utils/admission-route';
import * as api from '../api/local-review';
import { RequestError } from '../api/http';
import type { LocalReviewAction, LocalReviewChoice, LocalReviewEligibility, LocalReviewExecuteInput, LocalReviewFile, LocalReviewFiles, LocalReviewReason, LocalReviewSession, LocalReviewTarget } from '../api/local-review';
const {route,current:routeCurrent,router}=useAdmissionRoute('local-review', route=>JSON.stringify([route.query.kind,route.query.creatorId,route.query.jobId,route.query.planId,route.query.itemKey]));
const creatorId=computed(()=>Number(route.query.creatorId));
const target=computed<LocalReviewTarget|null>(()=>route.query.kind==='stage3'&&Number(route.query.jobId)>0?{kind:'stage3',jobId:Number(route.query.jobId)}:route.query.kind==='admission'&&typeof route.query.planId==='string'&&typeof route.query.itemKey==='string'?{kind:'admission',planId:route.query.planId,itemKey:route.query.itemKey}:null);
const backTo=computed(()=>target.value?.kind==='admission'
  ? typeof route.query.collection==='string'
    ? {name:'local-admission-workspace',query:{collection:route.query.collection}}
    : {name:'local-admission',params:{creatorId:creatorId.value},query:{batch:target.value.planId}}
  : {name:'costuan-admission',query:{workspace:'ingest',jobId:route.query.jobId,creatorId:route.query.creatorId}});
const eligibility=ref<LocalReviewEligibility|null>(null),session=ref<LocalReviewSession|null>(null),files=ref<LocalReviewFiles|null>(null),choices=reactive<Record<string,LocalReviewChoice>>({}),busy=ref(false),filesLoading=ref(false),error=ref(''),notice=ref(''),note=ref(''),issuesOnly=ref(true),showConfirm=ref(false),confirmChecked=ref(false),quarantineChecked=ref(false),showRetry=ref(false),pending=ref<LocalReviewExecuteInput|null>(null);
const filesError=ref('');
const previewNeedsRefresh=computed(()=>session.value?.previewNeedsRefresh===true);
const continuationScope=computed(()=>target.value?.kind==='admission'?'文件处置只针对本项所选文件；完成后继续整个原计划的待完成项，已完成项不重跑。':'文件处置只针对本项所选文件；完成后继续原 Job。');
const confirmBlockReason=computed(()=>previewNeedsRefresh.value?'旧预览不能提交，请按当前规则重新检查。':busy.value?'正在提交当前请求，请勿重复操作。':!confirmChecked.value?'请核对并确认以上具体文件与处理方式。':quarantineCount.value&&!quarantineChecked.value?'请另行批准列出的明确文件可恢复移出。':'');
let generation=0,timer:ReturnType<typeof setTimeout>|undefined,failures=0,disposed=false,pageActive=true,wasDeactivated=false;
const active=computed(()=>!!session.value&&['preparing','submitted','running'].includes(session.value.status));
const quarantineCount=computed(()=>Object.values(choices).filter(choice=>choice.action==='quarantine').length);
const statusLabel=(status:LocalReviewSession['status'])=>({preparing:'正在检查本项',ready:'审核预览 · 未执行',submitted:'已提交',running:'正在处理并恢复',interrupted:'中断 · 可继续原操作',completed:'原任务处理完成',failed:'处理失败 · 保留现场'}[status]);
const issueLabel=(issue:LocalReviewFile['issue'])=>issue?({pixel_limit:'超出像素安全限制',decode_failed:'当前无法解码',attachment:'保留附件',damaged:'文件损坏 / 校验失败',advertisement_candidate:'可能是广告，尚未批准',unsupported:'未支持的文件类型'}[issue]):'正常文件';
const kindLabel=(kind:LocalReviewFile['kind'])=>({image:'图片',video:'视频',attachment:'附件',other:'其他'}[kind]);
const actionLabel=(action:LocalReviewAction)=>({retain_original:'保留原文件，不作为图片展示',retain_attachment:'保留附件，不计入图片',quarantine:'可恢复移出此文件'}[action]);
const reasonLabel=(reason:LocalReviewReason)=>({pixel_limit:'像素限制',decode_failed:'当前无法解码',attachment:'附件',damaged:'确认损坏',advertisement:'确认广告'}[reason]);
const size=(value:number)=>value>=1024**2?`${(value/1024**2).toFixed(2)} MiB`:`${value} B`;
function choose(file:LocalReviewFile,event:Event){const value=(event.target as HTMLSelectElement).value;if(!value){delete choices[file.relativePath];return;}if(!file.allowedActions.some(action=>action===value))return;const action=value as LocalReviewAction;choices[file.relativePath]={relativePath:file.relativePath,action,reason:action==='retain_original'?(file.issue==='decode_failed'?'decode_failed':'pixel_limit'):action==='retain_attachment'?'attachment':file.issue==='advertisement_candidate'?'advertisement':'damaged'};}
const key=(suffix:string)=>`cosgallery:review:${creatorId.value}:${JSON.stringify(target.value)}:${suffix}`;
function requestKey(suffix:string){try{const value=localStorage.getItem(key(suffix))||crypto.randomUUID();localStorage.setItem(key(suffix),value);return value;}catch{return crypto.randomUUID();}}
function savePending(value:LocalReviewExecuteInput|null){pending.value=value;try{if(value)localStorage.setItem(key('pending'),JSON.stringify(value));else {localStorage.removeItem(key('pending'));localStorage.removeItem(key('execute'));};}catch{notice.value='浏览器不能保留重试凭据，请留在此页确认回执；服务端审核会话仍会保存。';}}
function restorePending(){try{const value:unknown=JSON.parse(localStorage.getItem(key('pending'))||'null');if(!value||typeof value!=='object'||!('requestKey'in value)||typeof value.requestKey!=='string'||!('choices'in value)||!Array.isArray(value.choices)||!('note'in value)||typeof value.note!=='string')return;const restored:LocalReviewChoice[]=[];for(const choice of value.choices){if(!choice||typeof choice!=='object'||typeof choice.relativePath!=='string'||!['retain_original','retain_attachment','quarantine'].includes(choice.action)||!['pixel_limit','decode_failed','attachment','damaged','advertisement'].includes(choice.reason))return;restored.push(choice as LocalReviewChoice);}pending.value={requestKey:value.requestKey,confirmed:true,note:value.note,choices:restored,quarantineConfirmed:'quarantineConfirmed'in value&&value.quarantineConfirmed===true};for(const choice of restored)choices[choice.relativePath]=choice;note.value=value.note;}catch{/* Invalid local retry data never authorizes an operation. */}}
function stopPoll(){if(timer)clearTimeout(timer);timer=undefined;}
function schedule(){stopPoll();if(!active.value||disposed||!pageActive||!routeCurrent.value||failures>=3)return;timer=setTimeout(()=>void refresh(true),2500);}
async function loadFiles(page=1){if(!session.value)return;filesLoading.value=true;filesError.value='';const current=generation;try{const result=await api.fetchLocalReviewFiles(session.value.sessionId,page,issuesOnly.value);if(current===generation&&!disposed)files.value=result;}catch(cause){if(current===generation){filesError.value=cause instanceof Error?cause.message:'文件列表读取失败';error.value=filesError.value;}}finally{if(current===generation)filesLoading.value=false;}}
function clearUnsubmittedChoices(){savePending(null);for(const path of Object.keys(choices))delete choices[path];confirmChecked.value=false;quarantineChecked.value=false;note.value='';showConfirm.value=false;}
function reconcileRefreshedPreview(result:LocalReviewSession){
  let requested=false;try{requested=!!localStorage.getItem(key('refresh'));}catch{/* A live snapshot can still establish a changed preview. */}
  if(!result.confirmed&&!result.previewNeedsRefresh&&(previewNeedsRefresh.value||requested)){
    clearUnsubmittedChoices();files.value=null;filesError.value='';
    try{localStorage.removeItem(key('refresh'));}catch{/* Updated server state remains authoritative. */}
  }
}
async function setSession(id:string){const current=generation;const result=await api.fetchLocalReviewSession(id);if(current!==generation||disposed)return;if(result.creatorId!==creatorId.value)throw new Error('审核会话不属于当前博主');if(!target.value||JSON.stringify(result.target)!==JSON.stringify(target.value))throw new Error('审核会话不属于当前选择的任务');reconcileRefreshedPreview(result);session.value=result;if(result.confirmed){savePending(null);for(const choice of result.choices)choices[choice.relativePath]=choice;}else restorePending();await router.replace({query:{...route.query,session:id},hash:route.hash});if(result.status!=='preparing')await loadFiles();schedule();}
async function inspect(){
  if(!target.value||busy.value)return;const current=generation;busy.value=true;error.value='';
  try{const result=await api.createLocalReviewSession(target.value,creatorId.value,requestKey('inspect'));if(current!==generation||disposed)return;await setSession(result.sessionId);}
  catch(cause){if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'检查提交失败';}
  finally{if(current===generation&&!disposed)busy.value=false;}
}
async function refresh(poll=false){if(!session.value)return;const current=generation,old=session.value.status;try{const result=await api.fetchLocalReviewSession(session.value.sessionId);if(current!==generation||disposed)return;reconcileRefreshedPreview(result);session.value=result;failures=0;if(result.confirmed)savePending(null);if((old!==result.status||!files.value)&&result.status!=='preparing')await loadFiles();schedule();}catch(cause){failures++;if(!poll||failures>=3)error.value=cause instanceof Error?cause.message:'状态读取失败';schedule();}}
async function refreshPreview(){
  if(!session.value||busy.value||filesLoading.value||session.value.confirmed||session.value.status!=='ready'||!previewNeedsRefresh.value)return;
  const current=generation,id=session.value.sessionId,refreshKey=key('refresh');busy.value=true;error.value='';showConfirm.value=false;stopPoll();
  try{
    const result=await api.refreshLocalReviewSession(id,requestKey('refresh'));
    if(current!==generation||disposed)return;
    try{localStorage.removeItem(refreshKey);}catch{/* Server receipt is authoritative. */}
    clearUnsubmittedChoices();files.value=null;filesError.value='';
    session.value=result;failures=0;if(result.status!=='preparing')await loadFiles();schedule();
  }catch(cause){
    if(current!==generation||disposed)return;
    if(cause instanceof RequestError&&[400,403,404,409,413,422].includes(cause.status)){try{localStorage.removeItem(refreshKey);}catch{/* Definitive rejection permits a new explicit check. */}}
    error.value=cause instanceof Error?cause.message:'重新检查回执未确认，请读取最新状态核对；旧预览不能提交。';
  }finally{if(current===generation&&!disposed)busy.value=false;}
}
async function execute(){
  if(!session.value||busy.value||previewNeedsRefresh.value||session.value.status!=='ready'||session.value.confirmed)return;const current=generation,id=session.value.sessionId;busy.value=true;error.value='';
  try{
    const input=pending.value??{requestKey:requestKey('execute'),confirmed:true as const,note:note.value.trim()||'用户在网页逐项选择并集中确认本项处理',choices:Object.values(choices),quarantineConfirmed:quarantineCount.value>0};
    savePending(input);await api.executeLocalReview(id,input);if(current!==generation||disposed)return;
    savePending(null);showConfirm.value=false;await refresh();
  }catch(cause){
    if(current!==generation||disposed)return;
    error.value=cause instanceof RequestError&&cause.status===413?'本项确认内容超过上限，服务端未接受。请暂缓此项并核对文件范围；不会自动拆分或执行。':cause instanceof Error?cause.message:'处理回执未确认';
    if(cause instanceof RequestError&&[400,403,404,409,413,422].includes(cause.status))savePending(null);
  }finally{if(current===generation&&!disposed)busy.value=false;}
}
async function retry(){
  if(!session.value||busy.value)return;const current=generation,id=session.value.sessionId,retryKey=key('retry');busy.value=true;error.value='';
  try{
    await api.retryLocalReview(id,requestKey('retry'));try{localStorage.removeItem(retryKey);}catch{/* Acknowledged operation is durable on the server. */}
    if(current!==generation||disposed)return;showRetry.value=false;failures=0;await refresh();
  }catch(cause){
    if(cause instanceof RequestError&&[400,403,404,409,413,422].includes(cause.status)){try{localStorage.removeItem(retryKey);}catch{/* Definitive rejection is not a pending receipt. */}}
    if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'原操作重试失败';
  }finally{if(current===generation&&!disposed)busy.value=false;}
}
watch(issuesOnly,()=>void loadFiles());
onDeactivated(()=>{pageActive=false;wasDeactivated=true;stopPoll();});
onActivated(()=>{pageActive=true;if(wasDeactivated&&routeCurrent.value&&active.value&&!busy.value)void refresh(true);});
watch(()=>JSON.stringify([route.query.kind,route.query.creatorId,route.query.jobId,route.query.planId,route.query.itemKey]),async()=>{const current=++generation;stopPoll();session.value=null;files.value=null;filesError.value='';eligibility.value=null;pending.value=null;busy.value=false;showConfirm.value=false;showRetry.value=false;error.value='';for(const key of Object.keys(choices))delete choices[key];if(!target.value||!Number.isSafeInteger(creatorId.value)||creatorId.value<=0){error.value='请从具体未完成项的“查看并处理”进入，不接受任意文件路径。';return;}try{const result=await api.fetchLocalReviewTarget(target.value,creatorId.value);if(current!==generation||disposed)return;eligibility.value=result;const id=typeof route.query.session==='string'?route.query.session:result.sessionId;if(id)await setSession(id);}catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'审核条件读取失败';}},{immediate:true});
onBeforeUnmount(()=>{disposed=true;generation++;stopPoll();});
</script>
<style scoped>
.action-reason,.hint{font-size:.83rem;line-height:1.6;color:var(--muted,#667085);max-width:85ch}.panel>p,header>p{max-width:85ch}table td{scroll-margin-bottom:4rem}
.review-page{width:100%;min-width:0;padding:0 0 2rem}header{margin-bottom:1.5rem}.eyebrow{font-size:.7rem;letter-spacing:.18em;opacity:.6}h1{font-size:1.7rem}h2{font-size:1.15rem}.panel{border:1px solid #8883;border-radius:1rem;padding:1.4rem;margin:1rem 0;background:var(--surface,#fff)}button,input,select,textarea{font:inherit;padding:.6rem .8rem;border:1px solid #8885;border-radius:.6rem;color:inherit;background:var(--bg,#fafafa)}button:disabled{opacity:.45}button{cursor:pointer}.primary{background:var(--accent,#7764b0);color:white}.actions,.heading{display:flex;gap:.7rem;align-items:center;flex-wrap:wrap}.heading{justify-content:space-between}label{display:grid;gap:.4rem;margin:.65rem 0}.check{display:flex;gap:.55rem;align-items:flex-start}.check input{margin-top:.35rem}table{width:100%;border-collapse:collapse;font-size:.86rem}th,td{text-align:left;padding:.8rem;border-bottom:1px solid #8883;vertical-align:top}small{display:block;font-size:.78rem;opacity:.75;line-height:1.6}.file-name{overflow-wrap:anywhere;max-width:28rem}.error{color:#bb2938}.warning{color:#916014;background:#eeaa1110;padding:.6rem;border-radius:.5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.75rem}summary{cursor:pointer}a{color:var(--accent,#7764b0)}.overlay{position:fixed;inset:0;z-index:100;background:#0007;display:flex;align-items:center;justify-content:center;padding:1rem}.dialog{background:var(--surface,#fff);border-radius:1rem;padding:1.5rem;max-width:55rem;width:100%;max-height:90vh;overflow:auto}.dialog ul{padding:0;list-style:none;max-height:45vh;overflow:auto}.dialog li{display:grid;gap:.3rem;overflow-wrap:anywhere;padding:.7rem 0;border-bottom:1px solid #8883}@media(max-width:700px){.review-page{padding:0 0 2rem}.panel{padding:.75rem}th,td{padding:.45rem}.file-name{max-width:12rem}}
</style>
