<template>
  <section class="admission-page">
    <div class="creator-context"><strong>{{ creatorName || '本地目录' }} · 本地导入</strong><RouterLink :to="{name:'local-admission-workspace'}">返回多博主选择</RouterLink></div>
    <ol class="steps" aria-label="入库步骤"><li :class="{current:!batch}" :aria-current="!batch ? 'step' : undefined">1 选择图集</li><li :class="{current:batch?.state==='draft'}" :aria-current="batch?.state==='draft' ? 'step' : undefined">2 检查并确认</li><li :class="{current:batch&&batch.state!=='draft'}" :aria-current="batch&&batch.state!=='draft' ? 'step' : undefined">3 入库结果</li></ol>
    <AdmissionErrorNotice :error="error" /><p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="pending" class="warning" role="status">执行回执尚未确认。原范围与选择已冻结，请查看并重试原提交，不要另建任务替代。</p>
    <div v-if="!batch&&attentionBatches.length" class="status-strip"><strong>已有批次需要查看</strong><button v-for="entry in attentionBatches" :key="entry.id" :disabled="busy" @click="openBatch(entry.id)">{{ time(entry.createdAt) }} · {{ stateLabel(entry.state) }}</button></div>
    <details class="recent task-tools"><summary>入库记录</summary><div class="section-heading"><h2>当前 / 最近导入批次</h2><button :disabled="busy||recentLoading" @click="loadRecent">刷新批次</button><button :disabled="busy || active" @click="startNew">选择新一批目录</button></div><p v-if="recentLoading">正在读取入库记录…</p><AdmissionErrorNotice v-else-if="recentError" :error="recentError" /><p v-else-if="recentRead&&!recent.length">还没有导入批次。</p><p v-else-if="!recentRead">入库记录尚未读取。</p><ul><li v-for="record in recent" :key="record.id"><button @click="openBatch(record.id)" :disabled="busy" :aria-pressed="batch?.id === record.id">{{ time(record.createdAt) }} · {{ record.totals.total }} 目录 · {{ stateLabel(record.state) }}</button></li></ul></details>
    <section v-if="!batch" class="panel" aria-label="选择本地目录">
      <h2>选择这次要入库的图集</h2>
      <p class="waiting-location">等待区：{{ settings ? (settings.waitingRoot || '未配置，请打开设置') : '尚未读取' }} <span v-if="directoryLoading"> · 正在读取…</span><span v-else-if="directoryError"> · 读取失败，保留上次资料</span><span v-else-if="directories"> · 已读取 {{ directories.items.length }} 个目录</span></p>
      <details :open="!!settings&&!settings.waitingRoot"><summary>等待区设置与目录规则</summary><p v-if="settings" class="hint">正式图库：{{ settings.galleryRoot }}</p><form @submit.prevent="saveRoot"><label>已解压等待区根目录<input v-model="waitingRoot" required placeholder="本机服务允许的等待区" /></label><button :disabled="busy">保存等待区</button></form><p class="hint">这里只配置等待区，不开放任意磁盘浏览。源与正式图库必须支持既有同卷移动。</p></details>
      <div class="actions"><button :disabled="busy" @click="browse()">返回等待区</button><strong>{{ parent || '选择本批博主文件夹' }}</strong><button :disabled="busy" @click="browse(parent || undefined)">刷新当前目录</button></div>
      <p v-if="directoryLoading" role="status">正在列出当前层级…</p>
      <template v-if="directories && !parent"><div class="directory-list"><button v-for="dir in directories.items" :key="dir.name" :disabled="busy || !dir.selectable" @click="browse(dir.name)"><strong>{{ dir.name }}</strong><small>{{ dir.matchesSelectedCreator ? '名称 / 已登记别名匹配当前博主' : dir.matchedCreatorIds.length ? '匹配其他规范身份，请核对；不会新建博主' : '名称未自动对应；将以本页规范博主预览' }}</small><small v-if="dir.reason">{{ dir.reason }}</small></button></div></template>
      <template v-else-if="directories&&directories.items.length"><div class="actions"><button :disabled="busy" @click="selectAll">全选当前可接纳目录</button><button :disabled="busy" @click="selectedNames = []">取消选择</button><span>已选 {{ selectedNames.length }} / {{ directories.items.length }} 个目录</span></div><div class="directory-list"><label v-for="dir in directories.items" :key="dir.name" class="directory-row"><input v-model="selectedNames" type="checkbox" :value="dir.name" :disabled="busy || !dir.selectable" /><span>{{ dir.name }}<small v-if="dir.reason">{{ dir.reason }}</small></span></label></div></template>
      <AdmissionErrorNotice v-if="directoryError" :error="directoryError" message="目录读取失败，当前未能确认目录范围，请重新读取。" /><p v-else-if="!directoryLoading&&directories&&!directories.items.length" class="empty-state">当前层级没有目录。请先在已配置等待区准备已解压的博主与作品目录，再刷新当前目录；只读取这一层，不递归扫描旧图库。</p>
      <details><summary>补充来源（可选）<span v-if="sourceEvidenceId"> · 已带入来源资料</span></summary><label>本批来源资料（可选）<select v-model="sourceEvidenceId" :disabled="busy"><option :value="null">无来源资料，本地先接纳</option><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.pageTitle || source.platform }} · {{ time(source.observedAt) }}</option></select></label><div v-if="sourceHasMore" class="actions"><button :disabled="busy" @click="loadSources(sourcePage + 1)">更多本博主资料</button></div><p class="hint">批次来源只说明文件出处，不代表精确作品对应或下载需求已满足。</p></details>
      <p class="hint">复制 / 解压完成后再检查。下一步盘点所选文件并保存预览草稿，最终确认前不执行入库。</p>
      <div v-if="directories?.items.length" class="stage-actions"><div><span>将检查 {{ selectedNames.length }} 个目录</span><p v-if="previewBlockReason" id="single-preview-reason" class="action-reason">{{ previewBlockReason }}</p></div><button class="primary" data-test="admission-preview" aria-describedby="single-preview-reason" :disabled="busy || directoryLoading || !!directoryError || !parent || !selectedNames.length" @click="preview">{{ busy ? '正在检查所选图集…' : '下一步：检查所选图集' }}</button></div>
    </section>
    <template v-if="batch">
      <section class="panel" aria-label="批次状态"><div class="section-heading"><h2>{{ stateLabel(batch.state) }}</h2><button :disabled="busy" @click="refreshBatch()">读取最新状态</button></div><p v-if="batch.state!=='draft'" data-test="admission-execution-totals">{{ admissionExecutionSummary(batch.totals, items) }}</p><p v-else>{{ batch.totals.selected }} 确认接纳 · {{ batch.totals.skipped }} 跳过 · {{ batch.totals.deferred }} 暂缓</p><AdmissionCurrentTotals :totals="batch.currentTotals" /><p v-if="active" role="status">服务端正在执行。关闭页面不会取消；稍后通过“最近导入批次”继续查看。{{ pollFailures ? '暂时无法刷新，可手动读取最新状态。' : '' }}</p><p v-if="queueNotice" role="status" data-test="admission-queue-notice">{{ queueNotice }}</p><AdmissionErrorNotice :error="batch.error" :message="batch.errorMessage"><AdmissionBlockingBatchLink :batch="batch" /></AdmissionErrorNotice><details><summary>技术详情</summary><dl><dt>批次</dt><dd>{{ batch.id }}</dd><dt>原计划</dt><dd>{{ batch.planId || '尚未确认' }}</dd><dt>更新时间</dt><dd>{{ batch.updatedAt }}</dd><dt>输入根目录</dt><dd>{{ batch.inputRoot }}</dd></dl></details></section>
      <section v-if="batch.state === 'draft'" class="panel" aria-label="预览与确认">
        <h2>先处理需要判断的图集，再查看入库确认</h2><p class="selection-summary">{{ selectedCount }} 个选择入库 · {{ deferredCount }} 个本次暂缓 · {{ skippedCount }} 个本次跳过</p><details class="hint"><summary>如何核对作品边界和对应关系</summary><p>候选不是已批准关系。单博主旧入口默认暂缓，可集中选择未发现候选的作品。复杂目录只按选中目录作为一套，不自动拆合；已有人工选择不会被自动更改。</p></details>
        <p v-if="items.some(item => item.suggestedAction)" class="hint">已保留未变化项目的上次选择，仍需本次确认。发生变化或无法复用的项目暂缓，不会自动执行。</p>
        <div class="actions"><button :disabled="draftLocked" @click="confirmNewGroup">选择未发现候选的作品</button><label>分组<select v-model="group"><option value="all">全部目录</option><option v-for="(label, key) in groups" :key="key" :value="key">{{ key }} · {{ label }}</option></select></label></div>
        <AdmissionAdsPicker :entries="entries" :locked="draftLocked" :recycle-ads="recycleAds" @change="adsChecked=false" />
        <p v-if="itemsLoading">正在读取预览摘要…</p>
        <details v-for="item in visibleItems" :key="item.key" class="review-row" :open="needsAttention(item)"><summary><strong>{{ item.sourceRelativePath }}</strong><span>{{ groups[item.group] }} · {{ actionLabels[actionFor(item).action] }}</span></summary><AdmissionItemEditor v-model="actions[item.key]" :item="item" :creator-id="creatorId" :peers="entries" :locked="draftLocked" :accept-existing-version="acceptExistingVersion" :recycle-ads="recycleAds" :selected-work="selectedWorks[item.key]" @select-work="selectedWorks[item.key]=$event" @change="adsChecked=false" /></details>
        <div class="actions"><button :disabled="page <= 1" @click="page--">上一页目录</button><span>共 {{ filteredItems.length }} 目录 · 第 {{ page }} / {{ Math.max(1, Math.ceil(filteredItems.length / pageSize)) }} 页</span><button :disabled="page * pageSize >= filteredItems.length" @click="page++">下一页目录</button></div>
        <AdmissionAcquisitionPolicy :retry="!!pending" />

        <div class="stage-actions"><div><span>{{ selectedCount }} 接纳 · {{ skippedCount }} 跳过 · {{ deferredCount }} 暂缓</span><p v-if="confirmationBlockReason" class="action-reason">{{ confirmationBlockReason }}</p></div><button class="primary" :disabled="busy || itemsLoading || !items.length || hasLaterCompletion" @click="showConfirmation = true">{{ pending ? '查看并重试原提交' : '查看入库确认' }}</button></div>
      </section>
      <section v-else class="panel" aria-label="执行结果"><div class="section-heading"><h2>{{ active ? '正在处理本批图集' : '本批入库结果' }}</h2><RouterLink v-if="batch.totals.completed" class="primary gallery-link" :to="{name:'canonical-creator',params:{creatorId}}">查看本博主图库</RouterLink></div><button v-if="items.some(item=>['completed','skipped','skip'].includes(item.state))" @click="showCompletedResults=!showCompletedResults">{{ showCompletedResults ? '收起已完成项目' : '查看已完成与跳过项目' }}</button><p class="hint">优先显示待处理与当前去向；完成项目可按需展开，无需再次核对。</p><table v-if="resultItems.length"><thead><tr><th>目录</th><th>实际阶段</th><th>结果 / 后续</th></tr></thead><tbody><tr v-for="item in resultItems" :key="item.key"><td><label v-if="isUnstarted(item)" class="check"><input v-model="repreviewKeys" type="checkbox" :value="item.key" />{{ item.sourceRelativePath }}</label><span v-else>{{ item.sourceRelativePath }}</span></td><td>{{ isAdmissionCompletedLater(item)?'原状态：':'' }}{{ admissionItemPhase(item) }}</td><td><AdmissionCurrentDisposition :disposition="item.currentDisposition" :creator-id="creatorId" /><AdmissionErrorNotice :error="item.lastError" :message="item.errorMessage" :issue="item.executionIssue" /><RouterLink v-if="!isAdmissionCompletedLater(item)&&!active && batch.planId && item.nextAction==='review_files'" :to="{name:'local-review',query:{kind:'admission',planId:batch.planId,itemKey:item.key,creatorId}}">核对文件处置</RouterLink><p v-if="!isAdmissionCompletedLater(item)&&!active&&item.nextActionReason" class="hint">{{ item.nextActionReason }}</p><RouterLink v-if="!isAdmissionCompletedLater(item)&&item.postId" :to="{name:'canonical-work-gallery',params:{creatorId,postId:item.postId}}">查看已入库图集</RouterLink><span v-if="!isAdmissionCompletedLater(item)&&['skipped','deferred','skip','defer'].includes(item.state)">等待区文件保留</span></td></tr></tbody></table><div class="actions"><button v-if="!hasLaterCompletion&&['interrupted','failed','needs_review'].includes(batch.state)" :disabled="busy" class="primary" @click="showResume = true">核对后重试原计划</button><button v-if="!active" :disabled="busy || !repreviewKeys.length" @click="repreview">对选中的 {{ repreviewKeys.length }} 个未开始目录重新预览</button></div><p class="hint">可勾选未开始的具体目录单独重新预览，其他项保留。已有移动 / 索引检查点的目录只能继续原计划；不能忽略文件差异。仅当当前阶段允许时显示“核对文件处置”入口。</p></section>
    </template>
    <div v-if="showConfirmation && batch" class="overlay"><section class="confirmation" role="dialog" v-admission-dialog="{ close: () => showConfirmation = false, locked: busy }" aria-modal="true" aria-label="确认本批接纳"><h2>确认本批实际操作</h2><AdmissionErrorNotice :error="error" /><p>{{ selectedCount }} 个目录接纳 · {{ skippedCount }} 跳过 · {{ deferredCount }} 暂缓。跳过 / 暂缓不删除文件。</p><div class="confirmation-list"><article v-for="item in items" :key="item.key"><strong>{{ item.sourceRelativePath }}</strong><span>{{ actionLabels[actionFor(item).action] }}<template v-if="selectedWorks[item.key]"> → {{ selectedWorks[item.key].title }}</template><template v-if="actionFor(item).sameAsKey"> → {{ items.find(other => other.key === actionFor(item).sameAsKey)?.sourceRelativePath }}</template></span><small v-if="isSelected(item)">{{ item.targetPath }}</small><small v-if="actionFor(item).primary">将此副本设为主副本</small><small v-for="ad in actionFor(item).approvedAds" :key="ad">{{ recycleAds?'广告送入Windows回收站：':'按原请求移至可恢复附件区：' }}{{ ad }}</small></article></div><AdmissionAcquisitionPolicy :retry="!!pending" /><p>按列出的目标移动接纳目录，原目录名与内部结构保持；具体广告按上方方式处理，其余文件保留。</p><label class="check"><input v-model="confirmChecked" type="checkbox" />确认上述目录范围、作品选择及跳过 / 暂缓项；当前文件没有继续写入</label><label v-if="adsCount" class="check warning"><input v-model="adsChecked" type="checkbox" />另行确认上面列出的 {{ adsCount }} 个附件是广告，{{ recycleAds?'允许送入Windows回收站':'沿用原请求移至可恢复附件区' }}，其余保留</label><p v-if="selectionError" class="error">{{ selectionError }}</p><p v-if="executeBlockReason" class="action-reason">{{ executeBlockReason }}</p><div class="actions"><button :disabled="busy" @click="showConfirmation=false">返回修改</button><button class="primary" data-test="admission-execute" :disabled="busy || !confirmChecked || (adsCount > 0 && !adsChecked) || !!selectionError" @click="execute">{{ busy ? '正在提交…' : pending ? '重试原请求' : `确认入库 ${selectedCount} 个目录` }}</button></div></section></div>
    <div v-if="showResume" class="overlay"><section class="confirmation" role="dialog" v-admission-dialog="{ close: () => showResume = false, locked: busy }" aria-modal="true" aria-label="继续原计划"><h2>重试原计划待审核与未完成项</h2><p>本次会重试原计划中待审核、等待依赖及尚未完成的接纳项，重新验证检查点、实际文件与活动任务。人工暂缓保持，已完成项不再移动；异常未解决时仍保留结果供核对。</p><div class="actions"><button :disabled="busy" @click="showResume=false">取消</button><button :disabled="busy||hasLaterCompletion" @click="resume">确认重试原计划</button></div></section></div>
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { vAdmissionDialog } from '../utils/admission-dialog';
import { admissionScopeQuery, useAdmissionRoute } from '../utils/admission-route';
import AdmissionItemEditor from '../components/AdmissionItemEditor.vue';
import AdmissionAcquisitionPolicy from '../components/AdmissionAcquisitionPolicy.vue';
import AdmissionAdsPicker from '../components/AdmissionAdsPicker.vue';
import AdmissionCurrentDisposition from '../components/AdmissionCurrentDisposition.vue';
import AdmissionCurrentTotals from '../components/AdmissionCurrentTotals.vue';
import AdmissionBlockingBatchLink from '../components/AdmissionBlockingBatchLink.vue';
import AdmissionErrorNotice from '../components/AdmissionErrorNotice.vue';
import { admissionExecutionSummary, admissionItemPhase, admissionQueueNotice } from '../utils/admission-execution-display';

import { admissionAction, admissionPayload, isAdmissionCompletedLater, isAdmissionSafeCandidate, validateAdmissionSelection } from '../utils/admission-ui';
import * as api from '../api/local-admission';
import { fetchSourceEvidence } from '../api/source-evidence';
import type { SourceEvidenceObservation } from '../api/source-evidence';
import { RequestError } from '../api/http';
import type { AdmissionAction, AdmissionActionKind, AdmissionBatch, AdmissionDirectories, AdmissionExecuteInput, AdmissionItem, AdmissionSettings, AdmissionState, AdmissionWork } from '../types/local-admission';
const { route, current: routeCurrent, router } = useAdmissionRoute('local-admission', route => String(route.params.creatorId));
const creatorId = computed(() => Number(route.params.creatorId));
const creatorName = ref(''), settings = ref<AdmissionSettings | null>(null), directories = ref<AdmissionDirectories | null>(null), waitingRoot = ref(''), parent = ref(''), selectedNames = ref<string[]>([]);
const sources = ref<SourceEvidenceObservation[]>([]), sourceEvidenceId = ref<number | null>(null), sourcePage = ref(1), sourceHasMore = ref(false);
const batch = ref<AdmissionBatch | null>(null), items = ref<AdmissionItem[]>([]), recent = ref<AdmissionBatch[]>([]), actions = reactive<Record<string, AdmissionAction>>({}), selectedWorks = reactive<Record<string, AdmissionWork>>({});
const busy = ref(false), directoryLoading = ref(false), itemsLoading = ref(false), error = ref(''), notice = ref(''), group = ref('all'), page = ref(1), pickerKey = ref<string | null>(null), acceptExistingVersion = computed(() => pending.value?.acceptExistingVersion ?? true), showConfirmation = ref(false), confirmChecked = ref(false), adsChecked = ref(false), showResume = ref(false);
const repreviewKeys = ref<string[]>([]), showCompletedResults=ref(false), recentLoading=ref(false),recentRead=ref(false),recentError=ref(''),directoryError=ref('');
let recentRequest=0;
const attentionBatches=computed(()=>recent.value.filter(entry=>['queued','running','interrupted'].includes(entry.state)).slice(0,3));
const previewBlockReason=computed(()=>busy.value?'正在处理当前请求，请稍候。':directoryLoading.value?'正在读取目录，请稍候。':directoryError.value?'目录读取失败，请刷新当前目录后继续。':!parent.value?'先选择本博主的等待区文件夹。':!selectedNames.value.length?'尚未选择作品目录。':'');
const confirmationBlockReason=computed(()=>busy.value?'正在处理当前请求。':itemsLoading.value?'正在读取预览摘要。':hasLaterCompletion.value?'旧范围有后续完成项，请查看后续结果。':!items.value.length?'当前没有已读取的预览目录。':'');
const executeBlockReason=computed(()=>busy.value?'正在提交，请勿重复操作。':selectionError.value||(!confirmChecked.value?'请核对并确认目录范围及作品选择。':adsCount.value&&!adsChecked.value?'请另行确认列出的具体广告处置。':''));
const needsAttention=(item:AdmissionItem)=>!!item.currentDisposition||item.group!=='A'||actionFor(item).action==='defer';
const resultItems=computed(()=>items.value.filter(item=>showCompletedResults.value||!!item.currentDisposition||!!item.lastError||!!item.executionIssue||!!(item.nextAction&&item.nextAction!=='none')||!['completed','skipped','skip'].includes(item.state)));
const isUnstarted = (item: AdmissionItem) => !isAdmissionCompletedLater(item)&&item.nextAction==='prepare_preview';
const pending = ref<AdmissionExecuteInput | null>(null), pollFailures = ref(0); let mutationToken = 0, directoryRequest = 0, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false, pageActive = true, wasDeactivated = false; const pageSize = 20;
const groups = { A: '新独立作品候选', B: '已有作品候选，待本次确认', C: '已有同套 / 额外副本待选', D: '冲突 / 需要确认' };
const actionLabels: Record<AdmissionActionKind,string> = { new: '新独立作品', existing:'复用已有作品', 'same-as':'与本批另一目录同套', skip:'跳过', defer:'暂缓' };
const stateLabel = (state: AdmissionState) => ({draft:'预览草稿 · 未执行',queued:'已提交',running:'运行中',completed:'已完成',needs_review:'待审核',interrupted:'已中断 · 可核对后继续',failed:'执行失败'}[state]);

const size = (bytes: number) => bytes >= 1024**3 ? `${(bytes/1024**3).toFixed(2)} GiB` : bytes >= 1024**2 ? `${(bytes/1024**2).toFixed(1)} MiB` : `${bytes} B`;
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12:false });
const active = computed(() => batch.value ? ['queued','running'].includes(batch.value.state) : false);
const queueNotice = computed(() => batch.value?.state!=='draft'&&batch.value ? admissionQueueNotice(active.value, items.value, [{...batch.value,items:items.value}]) : '');
const draftLocked = computed(() => busy.value || itemsLoading.value || !!pending.value || batch.value?.state !== 'draft');
const filteredItems = computed(() => items.value.filter(item => group.value === 'all' || item.group === group.value).sort((a,b)=>Number(needsAttention(b))-Number(needsAttention(a))));
const visibleItems = computed(() => filteredItems.value.slice((page.value-1)*pageSize,page.value*pageSize));
function actionFor(item: AdmissionItem): AdmissionAction { return actions[item.key] ?? { key:item.key,action:'defer',approvedAds:[],acceptSourceIds:[] }; }
const isSelected = (item: AdmissionItem) => !isAdmissionCompletedLater(item)&&['new','existing','same-as'].includes(actionFor(item).action);
const hasLaterCompletion = computed(()=>!!batch.value?.currentTotals?.completedLater||items.value.some(isAdmissionCompletedLater));
const actionableItems = computed(()=>items.value.filter(item=>!isAdmissionCompletedLater(item)));
const selectedCount = computed(() => items.value.filter(isSelected).length), skippedCount = computed(() => actionableItems.value.filter(item => actionFor(item).action==='skip').length), deferredCount = computed(() => actionableItems.value.filter(item => actionFor(item).action==='defer').length);
const adsCount = computed(() => items.value.reduce((sum,item) => sum+(isSelected(item) ? actionFor(item).approvedAds?.length ?? 0 : 0),0));
function initialAds(item: AdmissionItem): string[] {
  // Re-reading a draft, a historical suggestion or a retry never grants new approval.
  // Apply the shared web defaults only to a new admission selection; retain cancellations thereafter.
  return admissionAction(item,'new',actionFor(item)).approvedAds ?? [];
}
const entries = computed(()=>items.value.map(item=>({item,action:actionFor(item)})));
const selectionError = computed(()=>hasLaterCompletion.value?'本历史范围已有后续完成项目，不能执行原确认计划；请查看后续结果，其余范围重新核对。':validateAdmissionSelection(entries.value));
const recycleAds = computed(() => pending.value ? pending.value.advertisementDisposition === 'recycle_bin' : true);
const storageKey = (id: string) => `cosgallery:admission:pending:${id}`;
function rememberPending(value: AdmissionExecuteInput | null) { pending.value=value; if(!batch.value) return; try { if(value) localStorage.setItem(storageKey(batch.value.id),JSON.stringify(value)); else localStorage.removeItem(storageKey(batch.value.id)); } catch { notice.value='浏览器不能保存重试凭据，请保留本页直到确认服务端已接收；服务端批次和检查点仍会持久保留。'; } }
function restorePending() { pending.value=null; if(!batch.value) return; try { const raw=localStorage.getItem(storageKey(batch.value.id)); if(!raw) return; const parsed: unknown=JSON.parse(raw); if(!parsed||typeof parsed!=='object'||!('requestKey' in parsed)||typeof parsed.requestKey!=='string'||!('confirmed' in parsed)||parsed.confirmed!==true||!('actions' in parsed)||!Array.isArray(parsed.actions)||!('acceptExistingVersion' in parsed)||typeof parsed.acceptExistingVersion!=='boolean') return; const safeActions: AdmissionAction[]=[]; for(const value of parsed.actions) { if(!value||typeof value!=='object'||typeof value.key!=='string'||!['new','existing','same-as','skip','defer'].includes(value.action)) return; safeActions.push(value as AdmissionAction); } pending.value={requestKey:parsed.requestKey,confirmed:true,actions:safeActions,acceptExistingVersion:parsed.acceptExistingVersion,...('adsConfirmed' in parsed&&parsed.adsConfirmed===true?{adsConfirmed:true}:{}),...('advertisementDisposition' in parsed&&parsed.advertisementDisposition==='recycle_bin'?{advertisementDisposition:'recycle_bin'}:{})}; for(const action of safeActions) actions[action.key]=action; } catch { /* A malformed local retry copy cannot authorize execution. */ } }
function confirmNewGroup() { if(draftLocked.value)return; for(const item of items.value.filter(item=>isAdmissionSafeCandidate(item)&&actions[item.key]?.action==='defer')) actions[item.key]={key:item.key,action:'new',displayTitle:item.displayTitle,approvedAds:initialAds(item),acceptSourceIds:[],reason:'用户在确认页选择新独立作品'}; adsChecked.value=false; }
function stopPoll() { if(timer)clearTimeout(timer); timer=undefined; }
function schedulePoll() { stopPoll(); if(!active.value||disposed||!pageActive||!routeCurrent.value||pollFailures.value>=3)return; timer=setTimeout(()=>void refreshBatch(true),2500); }
async function loadItems(id: string, current = generation) {
  itemsLoading.value=true;
  try {
    const all: AdmissionItem[]=[];let next=1,total=Infinity;
    while(all.length<total) {
      const result=await api.fetchAdmissionItems(id,next++,100);
      if(current!==generation||disposed)return;
      all.push(...result.items);total=result.total;if(!result.items.length)break;
    }
    if(current!==generation||disposed)return;
    items.value=all;
    for(const item of all) {
      if(actions[item.key]) {
        if(batch.value?.state==='draft'&&!pending.value) {
          const allowed=new Set(item.ads.map(ad=>ad.relativePath));
          actions[item.key].approvedAds=(actions[item.key].approvedAds??[]).filter(relativePath=>allowed.has(relativePath));
        }
        continue;
      }
      const suggestion=batch.value?.state==='draft'?item.suggestedAction:undefined;
      const suggestedWork=suggestion?.action==='existing'?item.candidates.find(work=>work.workId===suggestion.workId):undefined;
      if(suggestion&&(suggestion.action!=='existing'||suggestedWork)) {
        actions[item.key]={...suggestion,key:item.key,displayTitle:suggestion.displayTitle??item.displayTitle,
          approvedAds:[...(suggestion.approvedAds??[])],acceptSourceIds:[...(suggestion.acceptSourceIds??[])]};
        if(suggestedWork)selectedWorks[item.key]=suggestedWork;
      } else actions[item.key]={key:item.key,action:'defer',displayTitle:item.displayTitle,approvedAds:[],acceptSourceIds:[],primary:false};
    }
  } finally {if(current===generation)itemsLoading.value=false;}
}
async function loadRecent() { const id=creatorId.value,request=++recentRequest;recentLoading.value=true;recentError.value='';try { const result=await api.fetchAdmissionBatches(id); if(!disposed&&request===recentRequest&&id===creatorId.value){recent.value=result.items;recentRead.value=true;} } catch(cause) { if(request===recentRequest&&!disposed)recentError.value=cause instanceof Error?cause.message:'入库记录读取失败'; } finally {if(request===recentRequest&&!disposed)recentLoading.value=false;} }
async function browse(next?: string) { if(busy.value)return; directoryLoading.value=true; directoryError.value=''; error.value=''; const current=generation, request=++directoryRequest; try { const result=await api.fetchAdmissionDirectories(creatorId.value,next); if(current!==generation||request!==directoryRequest||disposed)return; directories.value=result; creatorName.value=result.creator.name; parent.value=next??''; selectedNames.value=[];  } catch(cause) { if(current===generation&&request===directoryRequest){directoryError.value=cause instanceof Error?cause.message:'目录读取失败';error.value=directoryError.value;} } finally { if(current===generation&&request===directoryRequest)directoryLoading.value=false; } }
function selectAll() { selectedNames.value=directories.value?.items.filter(dir=>dir.selectable).map(dir=>dir.name)??[]; }
async function saveRoot() { busy.value=true; error.value=''; try { settings.value=await api.saveAdmissionSettings(waitingRoot.value); } catch(cause) { error.value=cause instanceof Error?cause.message:'等待区设置失败'; } finally { busy.value=false; } if(!error.value)await browse(); }
async function loadSources(next=1) { const current=generation,id=creatorId.value;try { const result=await fetchSourceEvidence(id,next);if(current!==generation||disposed)return; const confirmed=result.items.filter(source=>source.identityState==='confirmed'&&source.creatorId===creatorId.value); sources.value=next===1?confirmed:[...sources.value,...confirmed]; sourcePage.value=next; sourceHasMore.value=next*result.limit<result.total; } catch(cause) { if(current!==generation||disposed)return;notice.value=`可选来源资料暂时无法读取，可先本地接纳：${cause instanceof Error?cause.message:'网络错误'}`; } }
async function openBatch(id: string) { showCompletedResults.value=false;error.value=''; stopPoll(); const current=++generation;batch.value=null;items.value=[];directories.value=null;pending.value=null;page.value=1;group.value='all';confirmChecked.value=false;adsChecked.value=false; try { const result=await api.fetchAdmissionBatch(id); if(current!==generation||disposed)return; if(result.creatorId!==creatorId.value)throw new Error('批次不属于当前博主'); if(result.collectionId){await router.replace({name:'local-admission-workspace',query:admissionScopeQuery(route.query,{collection:result.collectionId}),hash:route.hash});return;}batch.value=result;repreviewKeys.value=[]; creatorName.value=result.creatorName; for(const key of Object.keys(actions))delete actions[key]; for(const key of Object.keys(selectedWorks))delete selectedWorks[key]; await loadItems(id,current); if(current!==generation||disposed)return;restorePending(); if(result.state!=='draft')rememberPending(null); await router.replace({query:admissionScopeQuery(route.query,{batch:id}),hash:typeof route.query.batch==='string'&&route.query.batch!==id?'':route.hash}); pollFailures.value=0;schedulePoll(); } catch(cause) { if(current===generation)error.value=cause instanceof Error?cause.message:'批次读取失败'; } }
async function refreshBatch(poll=false) { if(!batch.value)return; const id=batch.value.id,current=generation; try { const result=await api.fetchAdmissionBatch(id); if(current!==generation||disposed)return; const changed=batch.value.updatedAt!==result.updatedAt||batch.value.state!==result.state||JSON.stringify(batch.value.totals)!==JSON.stringify(result.totals)||JSON.stringify(batch.value.currentTotals)!==JSON.stringify(result.currentTotals);batch.value=result; pollFailures.value=0; if(result.state!=='draft')rememberPending(null); if(!poll||changed)await loadItems(id,current); schedulePoll(); } catch(cause) { if(current!==generation)return; pollFailures.value++; if(!poll||pollFailures.value>=3)error.value=cause instanceof Error?cause.message:'状态读取失败'; schedulePoll(); } }
async function preview() {
  if(busy.value)return; const token=++mutationToken; busy.value=true;error.value='';
  try {
    const result=await api.createAdmissionPreview({creatorId:creatorId.value,parent:parent.value,directories:[...selectedNames.value],acceptExistingVersion:acceptExistingVersion.value,...(sourceEvidenceId.value?{sourceEvidenceId:sourceEvidenceId.value}:{})});
    if(disposed||token!==mutationToken)return;
    await openBatch(result.id);if(!disposed&&token===mutationToken)await loadRecent();
  }catch(cause){if(!disposed&&token===mutationToken)error.value=cause instanceof Error?cause.message:'预览失败';}
  finally{if(!disposed&&token===mutationToken)busy.value=false;}
}
async function execute() {
  if(!batch.value||busy.value||hasLaterCompletion.value)return; const token=++mutationToken,id=batch.value.id;busy.value=true;error.value='';
  try {
    const input=pending.value??{requestKey:crypto.randomUUID(),confirmed:true as const,advertisementDisposition:'recycle_bin' as const,acceptExistingVersion:acceptExistingVersion.value,actions:admissionPayload(items.value.map(item=>({item,action:actionFor(item)})),acceptExistingVersion.value),...(adsCount.value?{adsConfirmed:true as const}:{})};
    rememberPending(input);const result=await api.executeAdmission(id,input);
    if(disposed||token!==mutationToken)return;
    batch.value=result;rememberPending(null);showConfirmation.value=false;await loadItems(id);schedulePoll();await loadRecent();
  }catch(cause){
    if(disposed||token!==mutationToken)return;
    error.value=cause instanceof RequestError&&cause.status===413?'本批确认内容超过上限，请分小批；服务端未接受本次执行。':cause instanceof Error?cause.message:'执行回执未确认';
    if(cause instanceof RequestError&&[400,403,404,409,413,422].includes(cause.status))rememberPending(null);
  }finally{if(!disposed&&token===mutationToken)busy.value=false;}
}
async function resume() {
  if(!batch.value||busy.value||hasLaterCompletion.value)return;const token=++mutationToken,id=batch.value.id,key=`${storageKey(id)}:resume`;busy.value=true;error.value='';
  let requestKey:string;
  try {requestKey=localStorage.getItem(key)||crypto.randomUUID();localStorage.setItem(key,requestKey);}catch{requestKey=crypto.randomUUID();}
  try {
    const result=await api.resumeAdmission(id,{requestKey,confirmed:true});
    try{localStorage.removeItem(key);}catch{/* The acknowledged receipt is also persisted server-side. */}
    if(disposed||token!==mutationToken)return;
    batch.value=result;showResume.value=false;pollFailures.value=0;schedulePoll();
  }catch(cause){
    if(cause instanceof RequestError&&[400,403,404,409,413,422].includes(cause.status)){try{localStorage.removeItem(key);}catch{/* No business write was accepted. */}}
    if(!disposed&&token===mutationToken)error.value=cause instanceof Error?cause.message:'继续失败';
  }finally{if(!disposed&&token===mutationToken)busy.value=false;}
}
async function repreview() {
  if(!batch.value||busy.value)return;const token=++mutationToken,id=batch.value.id;busy.value=true;error.value='';
  try {
    const keys=repreviewKeys.value.filter(key=>items.value.some(item=>item.key===key&&isUnstarted(item)));
    if(!keys.length)throw new Error('没有待重新预览的目录');
    const result=await api.repreviewAdmission(id,keys);
    if(disposed||token!==mutationToken)return;
    await openBatch(result.id);if(!disposed&&token===mutationToken)await loadRecent();
  }catch(cause){if(!disposed&&token===mutationToken)error.value=cause instanceof Error?cause.message:'重新预览失败';}
  finally{if(!disposed&&token===mutationToken)busy.value=false;}
}
async function startNew() { stopPoll();generation++;batch.value=null;items.value=[];pending.value=null;confirmChecked.value=false;adsChecked.value=false;showConfirmation.value=false;await router.replace({query:admissionScopeQuery(route.query),hash:''});await browse(); }
watch(group,()=>{page.value=1;});
onDeactivated(()=>{pageActive=false;wasDeactivated=true;stopPoll();});
onActivated(()=>{pageActive=true;if(wasDeactivated&&routeCurrent.value&&batch.value?.state!=='draft'&&!busy.value)void refreshBatch(true);});
watch(()=>route.query.batch,id=>{if(typeof id==='string'&&id!==batch.value?.id){mutationToken++;busy.value=false;void openBatch(id);}else if(id===undefined&&batch.value){mutationToken++;busy.value=false;void startNew();}});
watch(()=>route.params.creatorId,async()=>{
  const current=++generation;mutationToken++;stopPoll();busy.value=false;showConfirmation.value=false;showResume.value=false;
  batch.value=null;items.value=[];creatorName.value='';directories.value=null;parent.value='';selectedNames.value=[];
  recent.value=[];recentRead.value=false;recentError.value='';directoryError.value='';sources.value=[];sourcePage.value=1;sourceHasMore.value=false;pending.value=null;pickerKey.value=null;
  confirmChecked.value=false;adsChecked.value=false;error.value='';notice.value='';
  for(const key of Object.keys(actions))delete actions[key];
  for(const key of Object.keys(selectedWorks))delete selectedWorks[key];
  if(!Number.isSafeInteger(creatorId.value)||creatorId.value<=0){error.value='当前链接缺少有效的博主，请进入“博主入库 → 本地图集”重新选择博主与目录';return;}
  sourceEvidenceId.value=Number(route.query.sourceEvidenceId)>0?Number(route.query.sourceEvidenceId):null;
  try {
    const result=await api.fetchAdmissionSettings();if(current!==generation||disposed)return;
    settings.value=result;waitingRoot.value=result.waitingRoot;
    await Promise.all([loadRecent(),loadSources()]);if(current!==generation||disposed)return;
    const id=typeof route.query.batch==='string'?route.query.batch:'';
    if(id)await openBatch(id);else await browse();
  }catch(cause){if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'初始化失败';}
},{immediate:true});
onBeforeUnmount(()=>{disposed=true;mutationToken++;generation++;stopPoll();});
</script>

<style scoped>
.status-strip{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;border-left:3px solid var(--accent,#7764b0);padding:.7rem 1rem;margin:.6rem 0}.waiting-location,.selection-summary,.action-reason{font-size:.84rem;line-height:1.6;overflow-wrap:anywhere}.action-reason{color:var(--muted,#667085);margin:.4rem 0}.empty-state{padding:1rem 0}.review-row{border-top:1px solid #8883;padding:.7rem 0;scroll-margin-bottom:9rem}.review-row>summary{display:flex;justify-content:space-between;gap:.7rem;flex-wrap:wrap}.review-row>summary span{font-size:.8rem;opacity:.76}.gallery-link{display:inline-block;padding:.55rem .8rem;border-radius:.55rem;color:white}.directory-row{scroll-margin-bottom:9rem}.hint{max-width:85ch}form{max-width:55rem}
.batch-ads{border:1px solid #8883;border-radius:.85rem;padding:1rem;margin:1rem 0}.ad-summary-row{display:flex;align-items:center;justify-content:space-between;gap:.8rem;flex-wrap:wrap;border-top:1px solid #8883;padding:.45rem 0;overflow-wrap:anywhere}.ad-summary-row small{display:block}.ad-summary-row .actions{margin:.2rem 0}
.admission-page{width:100%;min-width:0;padding:0 0 2rem;color:var(--text,inherit)}.creator-context{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;font-size:.9rem;margin-bottom:.8rem}header,.section-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}header{margin-bottom:1.5rem}h1{font-size:1.8rem;margin:.3rem 0}h2{font-size:1.15rem;margin:0 0 .8rem}h3{font-size:1.03rem;margin:.6rem 0}.eyebrow{font-size:.7rem;letter-spacing:.18em;opacity:.65}.panel{background:var(--surface,#fff);border:1px solid #8883;border-radius:1.1rem;padding:1.35rem;margin-bottom:1.2rem}.actions,form{display:flex;flex-wrap:wrap;align-items:end;gap:.65rem;margin:.8rem 0}button,input,select{font:inherit;border:1px solid #8885;border-radius:.6rem;padding:.6rem .85rem;background:var(--bg,#fafafa);color:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:var(--accent-fill,var(--accent,#7764b0));color:white;border-color:transparent}.hint,small{font-size:.8rem;line-height:1.6;opacity:.76}.error{color:#bb2938;white-space:pre-wrap}.warning{color:#996211;background:#eeaa1110;padding:.6rem;border-radius:.5rem}label{display:grid;gap:.4rem;margin:.7rem 0}.check{display:flex;align-items:flex-start;gap:.6rem;line-height:1.65}.check input{margin-top:.35rem}.directory-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(20rem,1fr));gap:.6rem;margin:1rem 0}.directory-list button{text-align:left;display:grid;gap:.35rem}.directory-row{display:flex;align-items:center;border:1px solid #8883;padding:.7rem;margin:0;border-radius:.6rem;gap:.7rem}.directory-row small{display:block}.item-card{padding:1rem;border:1px solid #8883;border-radius:.85rem;margin:1rem 0}.badge{font-size:.73rem;opacity:.75}.path,dd{overflow-wrap:anywhere}.path{font-size:.83rem;opacity:.8}fieldset{border:0;padding:0;margin:0}.work-selection{display:flex;gap:.8rem;margin:.8rem 0}.work-selection img{width:3.5rem;aspect-ratio:2/3;object-fit:cover;border-radius:.3rem}.recent ul{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;padding:0}.recent button[aria-pressed=true]{border-color:#7764b0}dl{display:grid;grid-template-columns:8rem 1fr;gap:.5rem;font-size:.85rem}dd{margin:0}summary{cursor:pointer}details{margin:.8rem 0}table{width:100%;border-collapse:collapse;font-size:.85rem}th,td{text-align:left;padding:.7rem;border-bottom:1px solid #8883}td a{display:block;margin:.4rem 0}.overlay{position:fixed;inset:0;z-index:100;background:#0007;display:flex;align-items:center;justify-content:center;padding:1.2rem}.confirmation{background:var(--surface,#fff);padding:1.5rem;border-radius:1rem;max-width:60rem;width:100%;max-height:90vh;overflow:auto}.confirmation-list{max-height:40vh;overflow:auto}.confirmation-list article{display:grid;gap:.35rem;padding:.6rem 0;border-bottom:1px solid #8883;overflow-wrap:anywhere}a{color:var(--accent,#7764b0)}@media(max-width:600px){.admission-page{padding:0 0 2rem}.directory-list{grid-template-columns:1fr}dl{grid-template-columns:1fr}.panel{padding:1rem}}
@media(max-width:767.98px){.stage-actions{bottom:calc(var(--mobile-bottom-nav-height,3.55rem) + .6rem)}}
</style>
<style scoped>
.admission-page,.panel,.item-card,fieldset,.directory-list{min-width:0}.directory-row span,td{overflow-wrap:anywhere}table{table-layout:fixed}.work-selection div{min-width:0}.actions label{min-width:0;max-width:100%}input,select,textarea{max-width:100%}header a{white-space:nowrap}
</style>
<style scoped>
.steps{display:flex;list-style:none;padding:0;gap:1.5rem;flex-wrap:wrap;margin:0 0 1rem}.steps li{padding:.45rem 0;border-bottom:2px solid transparent;font-size:.9rem;color:var(--muted,#667085)}.steps .current{border-bottom-color:var(--accent,#7764b0);color:var(--text,inherit);font-weight:650}.stage-actions{position:sticky;bottom:.6rem;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:.7rem;background:var(--surface,#fff);border:1px solid #8883;box-shadow:0 .3rem 1.5rem #0001;padding:.8rem 1rem;border-radius:.8rem;margin-top:1.2rem}.stage-actions span{font-size:.8rem}.recent{font-size:.88rem;margin:.5rem 0 1rem}.recent>summary{font-weight:600;width:fit-content;padding:.35rem 0}.recent[open]{padding:1rem;background:var(--surface,#fff);border:1px solid var(--border,#ddd);border-radius:.85rem}.recent ul{max-height:12rem;overflow:auto}
</style>
