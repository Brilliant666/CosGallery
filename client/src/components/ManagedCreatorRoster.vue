<template>
  <section class="roster" aria-label="博主库">
    <header class="roster-heading">
      <div><h2>博主库</h2><p>统一维护博主 ID、名称与分类。来源平台只补充作品信息。</p></div>
      <button type="button" class="primary" @click="openNew">新增博主</button>
    </header>
    <form class="roster-filters" @submit.prevent="search" @change="onFilterChange">
      <label class="search">搜索名称或别名<input :value="filters.query" type="search" placeholder="名称或别名" @input="onQueryInput" @compositionstart="startComposition" @compositionend="endComposition" @keydown.enter="onEnter" /></label>
      <label>偏好<select v-model="filters.preference"><option value="">全部偏好</option><option value="liked">喜欢</option><option value="kept">保留</option><option value="unset">未设置</option></select></label>
      <label>分级<select v-model="filters.rating"><option value="">全部分级</option><option>R15</option><option>R18</option><option value="unclassified">待分类</option></select></label>
      <label>状态<select v-model="filters.active"><option value="active">启用</option><option value="inactive">停用</option><option value="all">全部状态</option></select></label>
      <label>本地作品<select v-model="filters.hasLocal"><option value="">全部</option><option value="yes">有本地作品</option><option value="no">无本地作品</option></select></label>
      <label>来源记录<select v-model="filters.hasSource"><option value="">全部</option><option value="yes">有来源记录</option><option value="no">无来源记录</option></select></label>
      <label>作品对账<select v-model="filters.state"><option value="">全部</option><option value="missing">有缺失作品</option><option value="no-local">无本地作品</option><option value="complete">已完整关联</option><option value="no-source">无来源作品</option><option value="unresolved">待核查</option></select></label>
      <button type="button" @click="resetFilters">重置筛选</button>
    </form>
    <p v-if="error && !dialogOpen" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="creator-cards" aria-label="博主账本列表">
      <article v-for="creator in payload?.items" :key="creator.id" class="creator-card">
        <div class="card-identity">
          <div class="card-name"><strong>{{ creator.name }}</strong><span class="badge" :class="creator.preference">{{ preferenceLabel(creator.preference) }}</span><span class="badge rating" :class="creator.rating">{{ creator.rating ?? '待分类' }}</span><small v-if="!creator.isActive">已停用</small></div>
          <p>{{ creator.sourceCollections }} 个资源合集 · {{ ledgerStatus(creator) }}</p>
        </div>
        <div class="card-metric"><small>平台作品</small><strong>{{ creator.remoteWorks }}</strong></div>
        <div class="card-metric"><small>本地作品</small><strong>{{ creator.localWorks }}</strong></div>
        <div class="card-metric"><small>已关联</small><strong>{{ creator.matchedWorks }}</strong></div>
        <div class="card-metric" :class="{missing:creator.missingWorks > 0}"><small>待收录</small><strong>{{ creator.missingWorks }}</strong></div>
        <div class="card-actions"><button type="button" @click="openCreator(creator.id, 'ledger')">查看账本</button><button type="button" :aria-label="`管理 ${creator.name}`" @click="openCreator(creator.id)">管理资料</button></div>
      </article>
    </div>
    <p v-if="payload && !payload.items.length">没有符合条件的博主。</p>
    <footer class="roster-paging">
      <button :disabled="page <= 1 || loading" @click="goPage(page - 1)">上一页</button>
      <span>第 {{ page }} 页 · 筛选结果 {{ payload?.total ?? 0 }} 位 · 每页 50 位</span>
      <button :disabled="!payload?.hasMore || loading" @click="goPage(page + 1)">下一页</button>
    </footer>

    <dialog ref="dialog" class="roster-dialog" aria-labelledby="roster-dialog-title" @close="dialogOpen = false" @cancel="cancelDialog">
      <div class="roster-heading"><h2 id="roster-dialog-title">{{ detail ? `${dialogMode === 'ledger' ? '账本' : '管理'} ${detail.name}` : '新增博主' }}</h2><button :disabled="busy" @click="closeDialog">关闭</button></div>
      <p v-if="detail" class="hint">稳定 ID #{{ detail.id }} · {{ detail.isActive ? '启用' : '停用' }} · 改名不移动本地目录</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <aside v-if="candidates.length" class="collision">
        <p>可能是已有博主，请先核对：</p>
        <button v-for="candidate in candidates" :key="candidate.id" :disabled="busy" @click="openCreator(candidate.id)">#{{ candidate.id }} {{ candidate.name }}</button>
        <label><input v-model="draft.confirmDistinct" type="checkbox" />我已核对，这是不同的人，允许同名</label>
      </aside>
      <form v-if="dialogMode === 'manage'" class="roster-edit" @submit.prevent="save">
        <label>主名称<input v-model="draft.name" required maxlength="255" :disabled="busy" /></label>
        <label>偏好<select v-model="draft.preference" :disabled="busy"><option :value="null">未设置</option><option value="liked">喜欢</option><option value="kept">保留</option></select></label>
        <label>博主分级<select v-model="draft.rating" :disabled="busy"><option :value="null">待分类</option><option>R15</option><option>R18</option></select></label>
        <button class="primary" :disabled="busy">{{ busy ? '正在保存…' : detail ? '保存博主' : '创建博主' }}</button>
      </form>
      <template v-if="detail">
        <section aria-label="作品账本"><h3>作品账本</h3>
          <p>本地 {{ detail.localWorks }} 套 · 来源 {{ detail.remoteWorks }} 套 · 已关联 {{ detail.matchedWorks }} 套 · 已知缺失 {{ detail.missingWorks }} 套 · 待核查 {{ detail.unresolvedLocalWorks }} 套</p>
          <p class="hint">来源与本地账本的比较结果；查看详情不会检查来源、规划任务或扫描文件。</p>
          <details class="ledger-detail"><summary>来源合集 · {{ detail.collections.length }} 个</summary>
            <p v-if="!detail.collections.length" class="hint">尚未接入资源平台合集。</p>
            <ul class="source-list"><li v-for="collection in detail.collections" :key="collection.id">
              <strong>{{ collection.title }}</strong><small>{{ sourceLabel(collection.source) }} · {{ collection.sourceCollectionId }} · 平台标注 {{ collection.declaredWorkCount ?? '未知' }} 套</small>
              <small>来源记录：{{ formatTime(collection.observedAt) }}</small>
              <a v-if="safeSourceUrl(collection.url)" :href="collection.url!" target="_blank" rel="noopener noreferrer">打开来源</a>
              <p v-for="(delivery, index) in collection.deliveries" :key="index" class="hint">{{ delivery.provider === 'baidu' ? '百度网盘' : delivery.provider }} · {{ delivery.type }} · {{ delivery.status ?? '状态未知' }}<template v-if="delivery.sourceFolderName"> · 来源目录 {{ delivery.sourceFolderName }}</template><template v-if="delivery.destinationPath"> · {{ delivery.destinationPath }}</template><template v-if="delivery.transferredAt"> · {{ formatTime(delivery.transferredAt) }}</template></p>
            </li></ul>
          </details>
          <details class="ledger-detail"><summary>待收录作品 · {{ detail.missing.length }} 套</summary>
            <p v-if="!detail.missing.length" class="hint">{{ detail.remoteWorks === 0 ? '尚无来源作品可供比较，不能据此判断已收录完整。' : '当前账本没有已知缺失作品。' }}</p>
            <template v-else><p class="hint">仅规划此博主的缺失作品任务，不执行网盘或本地入库。</p><button type="button" :disabled="busy || !detail.isActive" @click="requestDownloadPlan">只生成此博主任务</button></template>
            <ul class="source-list"><li v-for="work in detail.missing" :key="work.workId"><strong>{{ work.sourceOrderLabel ?? (work.sourceOrder === null ? '未编号' : `NO.${work.sourceOrder}`) }} · {{ work.title }}</strong><small>{{ sourceLabel(work.source) }} · 合集 {{ work.sourceCollectionId }}</small></li></ul>
          </details>
          <details class="ledger-detail"><summary>待核查本地作品 · {{ detail.unresolved.length }} 套</summary>
            <p v-if="!detail.unresolved.length" class="hint">当前没有待核查本地作品。</p>
            <ul class="source-list"><li v-for="(folder, index) in detail.unresolved" :key="`${folder.relativePath}:${index}`"><strong>{{ folder.folderName }}</strong><small>{{ folder.relativePath }} · {{ folder.status === 'ambiguous' ? '匹配存在歧义' : '尚未匹配' }} · 解析编号 {{ folder.parsedSourceOrder ?? '未知' }}</small></li></ul>
          </details>
        </section>
        <template v-if="dialogMode === 'manage'">
        <section><h3>Stage 1 检查来源与补齐缺失</h3><FirstCollectionSelector :creator="detail" :disabled="busy || !detail.isActive" @planned="handleSourcePlanned" /></section>
        <section><h3>别名</h3>
          <p v-if="!visibleAliases.length" class="hint">暂无其他别名。</p>
          <ul class="alias-list"><li v-for="alias in visibleAliases" :key="alias.id"><span>{{ alias.alias }} <small>{{ sourceLabel(alias.source) }}</small></span>
            <button v-if="alias.editable" :disabled="busy" @click="removeAlias(alias.id)">删除别名</button><small v-else>只读</small></li></ul>
          <form class="inline-form" @submit.prevent="addAlias"><label>新增手工别名<input v-model="aliasDraft" required maxlength="255" :disabled="busy" /></label><button :disabled="busy">添加别名</button></form>
        </section>
        <section><h3>作品来源（只读）</h3><p v-if="!visibleSources.length">暂无作品来源，可在后续显式规划时关联资源平台。</p>
          <ul class="source-list current-sources"><li v-for="source in visibleSources" :key="`${source.source}:${source.sourceCreatorId}`">
            <strong>{{ sourceLabel(source.source) }}</strong> · {{ source.displayName }}<small>{{ source.sourceCreatorId }}</small>
            <a v-if="safeSourceUrl(source.url)" :href="source.url!" target="_blank" rel="noopener noreferrer">查看来源</a>
          </li></ul>
        </section>
        <section><h3>本地目录关联</h3><p class="hint">仅保存 ID 关联，不重命名目录、不扫描、不生成任务。</p>
          <ul class="alias-list"><li v-for="folder in detail.localFolders" :key="folder.id"><span>#{{ folder.id }} {{ folder.folderPath }} · {{ folder.workCount }} 套 <small>{{ folder.matchStatus }} / {{ folder.matchMethod ?? '未关联' }}</small></span><button :disabled="busy" @click="pendingAction = { kind: 'unlink', folderId: folder.id }">解除关联</button></li></ul>
          <form class="inline-form" @submit.prevent="linkFolder"><label>未关联目录<select v-model="folderDraft" :disabled="busy"><option :value="null">选择本地目录</option><option v-for="folder in detail.unlinkedLocalFolders" :key="folder.id" :value="folder.id">#{{ folder.id }} {{ folder.folderPath }}</option></select></label><button :disabled="busy || folderDraft === null">关联目录</button></form>
        </section>
        <section><h3>首选入库目录</h3>
          <p class="hint">只保存目录桥接 ID；不移动文件、不扫描、不创建任务。多个目录未选择时，新任务会关闭式等待确认。</p>
          <p v-if="ingestDestination" :class="{ error: ['selection-required','preferred-unavailable','linked-folders-unavailable'].includes(ingestDestination.mode) }">
            {{ ingestDestination.message }}<template v-if="ingestDestination.resolvedCreatorDirectory">：{{ ingestDestination.resolvedCreatorDirectory }}</template>
          </p>
          <form v-if="ingestDestination" class="inline-form" @submit.prevent="saveIngestDestination">
            <label>首选入库目录
              <select v-model="preferredFolderDraft" :disabled="busy">
                <option :value="null">不显式选择（使用实际回退规则）</option>
                <option v-for="folder in ingestDestination.candidates" :key="folder.localCreatorFolderId" :value="folder.localCreatorFolderId" :disabled="!folder.valid">
                  桥接 #{{ folder.localCreatorFolderId }} · {{ folder.absolutePath }} · {{ folder.workCount }} 套{{ folder.valid ? '' : ` · ${folder.unavailableReason}` }}
                </option>
              </select>
            </label>
            <button :disabled="busy || preferredFolderDraft === ingestDestination.preferredLocalCreatorFolderId">保存目录选择</button>
          </form>
        </section>
        <section class="state-controls"><h3>{{ detail.isActive ? '停用博主' : '恢复博主' }}</h3>
          <p>来源 {{ detail.impact.sources }} · 合集 {{ detail.impact.collections }} · 平台作品 {{ detail.impact.remoteWorks }} · 本地作品 {{ detail.impact.localWorks }} · 未完成下载任务 {{ detail.impact.unfinishedDownloadTasks }}</p>
          <p class="hint">停用仅影响未来任务规划及默认展示；既有作品、任务和关系保留。恢复也不会自动生成任务。</p>
          <button :disabled="busy" @click="pendingAction = { kind: 'state' }">{{ detail.isActive ? '停用' : '恢复' }}</button>
        </section>
        <aside v-if="pendingAction" class="collision" role="group" aria-label="确认变更">
          <p>{{ pendingAction.kind === 'unlink' ? '确认解除此目录与博主的关联？文件和已有作品关系不会删除。' : `确认${detail.isActive ? '停用' : '恢复'}博主？不会修改既有任务。` }}</p>
          <button class="primary" :disabled="busy" @click="confirmAction">确认变更</button><button :disabled="busy" @click="pendingAction = null">取消</button>
        </aside>
        </template>
      </template>
    </dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import FirstCollectionSelector from './FirstCollectionSelector.vue';
import { fetchArchiveCatalog, fetchArchiveCatalogCreator } from '../api/gallery';
import { RequestError } from '../api/http';
import * as api from '../api/managed-creators';
import type { ArchiveCatalogCreatorDetail, ArchiveCatalogCreatorsPayload, ArchiveCatalogPreference, ArchiveCatalogState, ContentRating, LocalIngestDestinationPreference } from '../types/api';

const emit = defineEmits<{ changed: []; sourcePlanned: [creatorIds: number[]]; 'plan-downloads': [creatorId: number] }>();
const payload = ref<ArchiveCatalogCreatorsPayload | null>(null);
const detail = ref<ArchiveCatalogCreatorDetail | null>(null);
const filters = reactive({ query:'', preference:'' as ''|'liked'|'kept'|'unset', rating:'' as ''|ContentRating|'unclassified', active:'active' as 'active'|'inactive'|'all', hasLocal:'' as ''|'yes'|'no', hasSource:'' as ''|'yes'|'no', state:'' as ''|ArchiveCatalogState });
const page = ref(1), loading = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const dialogMode = ref<'ledger'|'manage'>('manage');
const ledgerStatus = (creator: {remoteWorks:number;localWorks:number;missingWorks:number;unresolvedLocalWorks:number}) => creator.unresolvedLocalWorks > 0 ? '待核查' : creator.remoteWorks === 0 ? '尚未接入资源' : creator.localWorks === 0 ? '尚未入库' : creator.missingWorks > 0 ? `有 ${creator.missingWorks} 套待收录` : '已完整关联';
const dialog = ref<HTMLDialogElement | null>(null), dialogOpen = ref(false);
const draft = reactive<api.ManagedCreatorInput>({ name:'', preference:null, rating:null, confirmDistinct:false });
const aliasDraft = ref(''), folderDraft = ref<number|null>(null);
const ingestDestination = ref<LocalIngestDestinationPreference | null>(null);
const preferredFolderDraft = ref<number | null>(null);
const candidates = ref<Array<{id:number;name:string}>>([]);
const pendingAction = ref<{kind:'state'}|{kind:'unlink';folderId:number}|null>(null);
let loadGeneration = 0;
let queryTimer: ReturnType<typeof setTimeout> | undefined;
let composing = false;
let disposed = false;
let requestKey: string | null = null;
let appliedFilterKey: string | null = null;
const preferenceLabel = (value:ArchiveCatalogPreference|null) => value === 'liked' ? '喜欢' : value === 'kept' ? '保留' : '未设置';
const sourceLabel = (source:string) => ({hentaiclub:'历史名称',costuan:'作品来源 · Costuan',manual:'手工', 'manual-history':'历史名称'}[source] ?? source);
// Presentation only: keep the complete detail object for identity matching and actions.
const visibleAliases = computed(() => detail.value?.aliases.filter(alias => alias.editable || alias.alias !== detail.value?.name) ?? []);
const visibleSources = computed(() => detail.value?.sources.filter(source => source.source !== 'hentaiclub' && source.source !== 'manual-history') ?? []);
const safeSourceUrl = (value:string|null) => !!value && /^https?:\/\//iu.test(value);
const formatTime = (value:string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {hour12:false}); };
function requestDownloadPlan() { if (!detail.value || busy.value || !detail.value.isActive) return; const id = detail.value.id; closeDialog(); emit('plan-downloads', id); }
function showError(reason:unknown) {
  error.value = reason instanceof Error ? reason.message : '操作失败';
  const data = reason instanceof RequestError ? reason.payload as {candidates?:Array<{id:number;name:string}>}|undefined : undefined;
  candidates.value = data?.candidates ?? [];
}
async function load(force = true) {
  if (disposed) return;
  const filterKey = JSON.stringify(filters);
  const params = {page:page.value,limit:50,query:filters.query,active:filters.active,
    preference:filters.preference||undefined,rating:filters.rating||undefined,hasLocal:filters.hasLocal||undefined,hasSource:filters.hasSource||undefined,state:filters.state||undefined};
  const key = JSON.stringify(params);
  if (!force && requestKey === key) return;
  requestKey = key;
  const generation = ++loadGeneration;
  loading.value = true;
  try {
    const result = await fetchArchiveCatalog(params);
    if (generation === loadGeneration) { payload.value = result; appliedFilterKey = filterKey; }
  } catch (reason) { if (generation === loadGeneration) { requestKey = null; showError(reason); } }
  finally { if (generation === loadGeneration) loading.value = false; }
}
function clearQueryTimer() { clearTimeout(queryTimer); queryTimer = undefined; }
function onFilterChange(event: Event) {
  if (event.target instanceof HTMLSelectElement) void search();
}
function invalidateLoad() { ++loadGeneration; requestKey = null; loading.value = false; }
async function search() {
  clearQueryTimer();
  if (composing) return;
  page.value = 1; error.value = ''; await load(false);
}
function scheduleQuery() {
  clearQueryTimer();
  invalidateLoad();
  if (composing) return;
  if (!filters.query) { void search(); return; }
  queryTimer = setTimeout(() => { void search(); }, 300);
}
function onQueryInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (value === filters.query) return;
  filters.query = value;
  scheduleQuery();
}
function startComposition() { composing = true; clearQueryTimer(); invalidateLoad(); }
function endComposition(event: CompositionEvent) {
  composing = false;
  filters.query = (event.target as HTMLInputElement).value;
  scheduleQuery();
}
function onEnter(event: KeyboardEvent) {
  event.preventDefault();
  if (!event.isComposing && !composing) void search();
}
function resetFilters() {
  composing = false;
  Object.assign(filters, {query:'',preference:'',rating:'',active:'active',hasLocal:'',hasSource:'',state:''});
  void search();
}
async function handleSourcePlanned(creatorIds: number[]) {
  emit('sourcePlanned', creatorIds);
  await load();
}
async function goPage(value:number) {
  if (JSON.stringify(filters) !== appliedFilterKey) { await search(); return; }
  clearQueryTimer(); page.value = value; await load(false);
}
function showDialog() { if (!dialog.value?.open) dialog.value?.showModal(); dialogOpen.value = true; }
function closeDialog() { if (!busy.value) { dialog.value?.close(); dialogOpen.value = false; } }
function cancelDialog(event:Event) { if (busy.value) event.preventDefault(); }
function setDetail(value:ArchiveCatalogCreatorDetail) {
  detail.value = value;
  Object.assign(draft,{name:value.name,preference:value.preference,rating:value.rating,confirmDistinct:false});
  candidates.value = []; pendingAction.value = null;
}
function openNew() {
  dialogMode.value = 'manage';
  detail.value = null; ingestDestination.value = null; preferredFolderDraft.value = null; error.value = ''; candidates.value = []; notice.value = '';
  Object.assign(draft,{name:'',preference:null,rating:null,confirmDistinct:false});
  showDialog();
}
async function openCreator(id:number, mode:'ledger'|'manage' = 'manage') {
  if (busy.value) return;
  error.value = ''; candidates.value = []; pendingAction.value = null; aliasDraft.value = ''; folderDraft.value = null;
  try {
    const [creator, destination] = await Promise.all([fetchArchiveCatalogCreator(id), api.fetchIngestDestination(id)]);
    dialogMode.value = mode;
    setDetail(creator);
    ingestDestination.value = destination;
    preferredFolderDraft.value = destination.preferredLocalCreatorFolderId;
    showDialog();
  } catch (reason) { showError(reason); }
}
async function refreshIngestDestination() {
  if (!detail.value) return;
  const destination = await api.fetchIngestDestination(detail.value.id);
  ingestDestination.value = destination;
  preferredFolderDraft.value = destination.preferredLocalCreatorFolderId;
}
async function mutation(action:()=>Promise<ArchiveCatalogCreatorDetail|void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await action();
    if (result) setDetail(result);
    if (detail.value) await refreshIngestDestination();
    await load(); emit('changed'); notice.value = '博主元数据已保存；未执行扫描或任务规划。';
  } catch (reason) { showError(reason); }
  finally { busy.value = false; }
}
async function save() { await mutation(() => detail.value ? api.updateManagedCreator(detail.value.id,{...draft}) : api.createManagedCreator({...draft})); }
async function addAlias() { if (detail.value) await mutation(async () => { const result = await api.addManagedAlias(detail.value!.id,aliasDraft.value,draft.confirmDistinct); aliasDraft.value = ''; return result; }); }
async function removeAlias(id:string) { if (detail.value) await mutation(() => api.deleteManagedAlias(detail.value!.id,id)); }
async function linkFolder() { if (detail.value && folderDraft.value !== null) await mutation(async () => { const result = await api.linkManagedFolder(folderDraft.value!,detail.value!.id); folderDraft.value = null; return result; }); }
async function saveIngestDestination() {
  if (!detail.value || !ingestDestination.value) return;
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    ingestDestination.value = await api.setIngestDestination(
      detail.value.id,
      typeof preferredFolderDraft.value === 'number' ? preferredFolderDraft.value : null
    );
    preferredFolderDraft.value = ingestDestination.value.preferredLocalCreatorFolderId;
    await load();
    emit('changed');
    notice.value = '首选入库目录已保存；未移动文件、扫描或创建任务。';
  } catch (reason) { showError(reason); }
  finally { busy.value = false; }
}
async function confirmAction() {
  const action = pendingAction.value;
  if (!detail.value || !action) return;
  await mutation(async () => {
    if (action.kind === 'state') return api.setManagedCreatorActive(detail.value!.id,!detail.value!.isActive);
    await api.unlinkManagedFolder(action.folderId);
    return fetchArchiveCatalogCreator(detail.value!.id);
  });
}
// Refresh only the visible list. Keep its filters/page and any open management
// draft intact when another workspace finishes an ingest operation.
defineExpose({ refresh: () => load() });
onMounted(() => { void load(); });
onBeforeUnmount(() => { disposed = true; clearQueryTimer(); invalidateLoad(); });
</script>

<style scoped>
.roster{margin-bottom:1.5rem;padding:1.25rem;border:1px solid var(--border);border-radius:1rem;background:var(--surface)}
h2,h3,p{margin:0} h2{font-size:1.2rem;font-weight:650} h3{font-size:1rem;font-weight:600;margin-bottom:.65rem} p{line-height:1.6}
.roster-heading{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1rem}.roster-heading p,.hint,small{color:var(--muted);font-size:.8rem}
.roster-counts{display:flex;flex-wrap:wrap;gap:.65rem 1.4rem;margin-bottom:1rem;font-size:.8rem}.roster-filters{display:flex;flex-wrap:wrap;align-items:end;gap:.6rem;margin-bottom:1rem}
label{display:grid;gap:.3rem;font-size:.8rem}input,select,button{font:inherit}input:not([type=checkbox]),select{min-width:0;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:.5rem;padding:.6rem;width:100%}
.search{flex:1 1 13rem}button{border:1px solid var(--border);border-radius:.5rem;background:var(--surface);color:var(--text);padding:.55rem .85rem;cursor:pointer;white-space:nowrap}button.primary{background:var(--accent);color:white;border-color:var(--accent)}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.roster-paging{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:1rem;margin-top:1rem;font-size:.8rem}
.roster-dialog{margin:auto;width:min(48rem,calc(100vw - 2rem));max-height:90vh;overflow:auto;padding:1.4rem;border:1px solid var(--border);border-radius:1rem;background:var(--surface);color:var(--text)}.roster-dialog::backdrop{background:#0007}.roster-dialog section{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border)}
.roster-edit{display:grid;grid-template-columns:2fr 1fr 1fr;gap:.8rem;margin-top:1rem;align-items:end}.roster-edit button{grid-column:1/-1}.alias-list,.source-list{list-style:none;padding:0;margin:0;display:grid;gap:.6rem}.alias-list li{display:flex;align-items:center;justify-content:space-between;gap:1rem;overflow-wrap:anywhere}.source-list small{display:block;overflow-wrap:anywhere}a{color:var(--accent)}
.inline-form{display:flex;align-items:end;gap:.6rem;margin-top:1rem}.inline-form label{flex:1}.error{background:#fee2e2;color:#991b1b;padding:.7rem;border-radius:.5rem;margin:.7rem 0}.collision{background:var(--bg);border:1px solid var(--border);padding:1rem;margin:1rem 0;border-radius:.5rem}.collision button{margin:.4rem .4rem .4rem 0}.collision label{display:flex;align-items:center}.state-controls p{font-size:.85rem;margin-bottom:.65rem}
.ledger-detail{margin-top:.8rem;padding:.7rem;border:1px solid var(--border);border-radius:.5rem;overflow-wrap:anywhere}.ledger-detail summary{cursor:pointer;font-weight:600}.ledger-detail .source-list{margin-top:.7rem}.ledger-detail li{padding:.5rem 0;border-bottom:1px solid var(--border)}
@media(max-width:640px){.roster{padding:.8rem}.roster-edit{grid-template-columns:1fr}.roster-heading{align-items:start}.roster-dialog{padding:1rem}.roster-filters label{flex:1 1 8rem}.roster-filters .search{flex-basis:100%}}
.creator-cards{display:grid;gap:1rem;margin-top:1.2rem}.creator-card{display:grid;grid-template-columns:minmax(15rem,2.5fr) repeat(4,minmax(4rem,.65fr)) auto;align-items:center;gap:1rem;padding:1.3rem;border:1px solid var(--border);border-radius:1rem;background:var(--surface);box-shadow:0 2px 3px #00000012}.card-name{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}.card-identity p{margin:.5rem 0 0;color:var(--muted);font-size:.8rem}.badge{border-radius:1rem;background:var(--bg);padding:.2rem .5rem;font-size:.7rem;font-weight:700}.badge.liked{background:#fee2e2;color:#dc2626}.badge.kept{background:#fef3c7;color:#92400e}.badge.rating{background:#6b7280;color:white}.badge.R15{background:#55718f}.badge.R18{background:#b72d45}.card-metric small{display:block;color:var(--muted);font-size:.75rem}.card-metric strong{display:block;margin-top:.3rem;font-size:1.15rem}.card-metric.missing strong{color:#d97706}.card-actions{display:flex;flex-wrap:wrap;gap:.5rem}.card-identity{min-width:0;overflow-wrap:anywhere}
@media(max-width:1100px){.creator-card{grid-template-columns:repeat(4,minmax(0,1fr))}.card-identity{grid-column:1/-1}.card-actions{grid-column:1/-1;justify-content:flex-end}}
</style>
