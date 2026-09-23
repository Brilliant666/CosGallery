<template>
  <div class="first-collection">
    <button type="button" data-test="open-first-collection" :class="{ primary: !creator }" :disabled="disabled" @click="open">{{ creator ? '准备来源检查' : '选择博主，准备检查任务' }}</button>
    <dialog ref="dialog" aria-label="准备来源检查任务" @cancel="cancel" @close="onClose">
      <header><h2>准备来源检查任务</h2><button type="button" :disabled="busy" @click="close">{{ result ? '关闭' : '取消' }}</button></header>
      <p>选择博主 → 准备任务 → 复制范围到插件。网页只准备任务，实际网站检查由插件完成。</p>
      <div v-show="!result || preparingAnotherRound" data-test="creator-selection-panel">
      <form v-if="!creator" class="filters" @submit.prevent="search">
        <label>搜索规范名称或别名<input v-model="filters.q" type="search" /></label>
        <label>本地收录<select v-model="filters.local"><option value="all">全部</option><option value="present">已本地收录</option><option value="absent">尚未本地收录</option></select></label>
        <label>偏好<select v-model="filters.preference"><option value="all">全部</option><option value="liked">喜欢</option><option value="kept">保留</option><option value="unset">未设置</option></select></label>
        <details class="more-filters"><summary>更多筛选</summary><div class="filters">
        <label>状态<select v-model="filters.enabled"><option value="enabled">启用</option><option value="disabled">停用</option><option value="all">全部状态</option></select></label>
        <label>Costuan 来源<select v-model="filters.source"><option value="all">全部来源状态</option><option value="absent">尚无来源</option><option value="present">已有来源</option></select></label>
        <label>分级<select v-model="filters.rating"><option value="all">全部</option><option value="R15">R15</option><option value="R18">R18</option><option value="unclassified">待分类</option></select></label>
        </div></details>
        <button :disabled="loading || busy">筛选</button>
      </form>
      <p v-if="payload && !creator">同筛选规范博主 {{ payload.total }} 位；上次读取 {{ payload.readAt }}。已有来源也可明确发起新一轮检查。</p>
      <p v-if="stats && !creator">已本地收录 {{ stats.creators.withLocal }} 位 · 有有效来源 {{ stats.creators.withSource }} 位 · 本地作品 {{ stats.works.local }} 套 · 已知缺失 {{ stats.works.missing }} 套</p>
      <button v-if="!creator" type="button" data-test="refresh-sync-roster" :disabled="loading || busy" @click="load">刷新账本状态（只读）</button>
      <div v-if="!creator" class="table-scroll">
        <table><thead><tr><th>选择 / 规范 ID</th><th>博主 / 别名</th><th>偏好 / 分级</th><th>本地</th><th>Costuan 来源 / 任务</th></tr></thead>
          <tbody><tr v-for="item in payload?.items" :key="item.creatorId">
            <td><input type="checkbox" :aria-label="`选择 #${item.creatorId} ${item.creatorName}`" :checked="selected.has(item.creatorId)" :disabled="!item.isActive || busy || !!failedRequest" @change="toggle(item, ($event.target as HTMLInputElement).checked)" /> #{{ item.creatorId }}</td>
            <td>{{ item.creatorName }}<small>{{ item.aliases.join(' / ') }}</small></td>
            <td>{{ preferenceLabel(item.preference) }} / {{ item.rating ?? '待分类' }}<small v-if="!item.isActive">已停用，不能创建</small></td>
            <td>{{ item.localWorks }} 套</td>
            <td><CreatorSourceStatus :item="item" /></td>
          </tr></tbody>
        </table>
        <p v-if="payload && !payload.items.length">没有符合条件的博主。</p>
      </div>
      <p v-else>#{{ creator.id }} {{ creator.name }} · {{ creator.localWorks }} 套本地作品 · {{ preferenceLabel(creator.preference) }} / {{ creator.rating ?? '待分类' }}</p>
      <footer v-if="!creator" class="paging"><button :disabled="page <= 1 || loading || busy" @click="goPage(page - 1)">上一页</button><span>第 {{ payload?.page ?? page }} 页 / {{ payload ? Math.max(1, Math.ceil(payload.total / payload.limit)) : '—' }} 页 · {{ payload?.total ?? '—' }} 位</span><button :disabled="!payload?.hasMore || loading || busy" @click="goPage(page + 1)">下一页</button></footer>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="selection"><strong data-test="selected-count">已选 {{ selected.size }} 位</strong><span>{{ [...selected.values()].map(item => `#${item.id} ${item.name}`).join('、') }}</span></div>
      <p class="scope-note">仅准备以上已选博主；筛选与翻页不改变已选范围。本地数量来自已有账本，不表示刚检查过磁盘。</p>
      <p v-if="failedRequest">待确认的固定范围：{{ failedRequest.creatorIds.map(id => `#${id}`).join('、') }}。重试只确认这一范围，不使用新的选择。</p>
      <button v-if="!result || failedRequest" type="button" data-test="submit-first-collection" class="primary" :disabled="(!selected.size && !failedRequest) || busy" @click="submit">{{ busy ? '正在准备…' : failedRequest ? '重试确认原提交' : `准备 ${selected.size} 位博主的检查任务` }}</button>
      <details v-else :open="preparingAnotherRound" @toggle="preparingAnotherRound = ($event.target as HTMLDetailsElement).open"><summary>重新选择 / 准备另一轮</summary><p>上方可调整选择；准备另一轮会使用新的请求轮次，不会扩大已复制的范围。</p><button type="button" data-test="submit-first-collection" :disabled="!selected.size || busy" @click="submit">{{ busy ? '正在准备…' : '重新准备一轮任务' }}</button></details>
      <p v-if="!selected.size && !failedRequest && !result" data-test="prepare-disabled-reason" class="scope-note">先勾选至少一位启用的博主，再准备任务。</p>
      <section v-if="result" :aria-label="failedRequest ? '上次已确认任务结果' : '逐项任务结果'">
        <p v-if="failedRequest" role="status">下方仅保留上次已确认结果；当前这一轮回执尚未确认，请先重试原提交，不要复制上次范围替代。</p>
        <template v-if="!failedRequest && handoff.taskIds.length">
          <h3>下一步：到插件开始检查</h3>
          <p>{{ handoff.taskIds.length }} 项固定任务已准备。复制后粘贴到插件的固定任务范围导入入口，核对博主后在插件开始检查，再返回本页查看结果。</p>
          <button ref="copyButton" type="button" class="primary" data-test="copy-stage1-handoff" @click="copyHandoff">复制本次检查范围</button><p v-if="copyNotice" role="status">{{ copyNotice }}</p>
          <details><summary>查看固定范围与手动复制</summary><textarea data-test="stage1-handoff" aria-label="Stage 1 固定任务范围" readonly :value="JSON.stringify(handoff)" rows="3" /></details>
        </template>
        <h3>{{ failedRequest ? '上次已确认结果（非当前轮次）' : '逐项结果' }}</h3>
        <ul><li v-for="item in result.items" :key="item.creatorId">#{{ item.creatorId }} {{ item.creatorName }}：{{ resultLabel(item.result) }}<span v-if="item.task"> · 任务 #{{ item.task.id }} · {{ statusLabel(item.task.status) }}{{ item.task.claimedBy ? ` · ${item.task.claimedBy}` : '' }}</span><small v-if="item.task">{{ sourceStateLabel(item.task.sourceState) }}</small></li></ul>
        <p>{{ failedRequest ? '上次已确认的轮次' : '本次' }}仅建立或复用明确范围的检查任务，尚未访问 Costuan；此前有效来源继续保留。再次明确准备会创建新轮次，网络重试不会重复创建。旧插件不支持固定范围时需升级，不能改为全名单自动转存。</p>
      </section>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import CreatorSourceStatus from './CreatorSourceStatus.vue';
import { planFirstCollection, sourceStateLabel } from '../api/first-collection';
import type { FirstCollectionResult } from '../api/first-collection';
import { fetchCreatorSyncRoster, fetchCreatorSyncStats } from '../api/creator-sync';
import type { CreatorSyncFilters, CreatorSyncRow, CreatorSyncStats, SyncPage } from '../api/creator-sync';
import type { ArchiveCatalogCreator } from '../types/api';
import { RequestError } from '../api/http';
const props = withDefaults(defineProps<{ creator?: Pick<ArchiveCatalogCreator, 'id' | 'name' | 'isActive' | 'localWorks' | 'preference' | 'rating'>; disabled?: boolean; active?: boolean }>(), { active: true });
const emit = defineEmits<{ planned: [creatorIds: number[]] }>();
const dialog = ref<HTMLDialogElement | null>(null), busy = ref(false), loading = ref(false), error = ref(''), copyNotice = ref('');
const preparingAnotherRound = ref(false), copyButton = ref<HTMLButtonElement | null>(null);
const payload = ref<SyncPage<CreatorSyncRow> | null>(null), stats = ref<CreatorSyncStats | null>(null), page = ref(1), result = ref<FirstCollectionResult | null>(null);
const defaultFilters = (): CreatorSyncFilters => ({ q: '', enabled: 'enabled', local: 'all', source: 'all', preference: 'all', rating: 'all' });
const filters = reactive(defaultFilters());
const selected = ref(new Map<number, { id: number; name: string }>());
type PendingRequest = { id: string; creatorIds: number[] };
const requestStorageKey = `cosgallery:creator-sync:unconfirmed:${props.creator?.id ?? 'roster'}`;
function readPendingRequest(): PendingRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(requestStorageKey) ?? 'null');
    return value && typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value.id)
      && Array.isArray(value.creatorIds) && value.creatorIds.length > 0 && value.creatorIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)
      ? { id: value.id, creatorIds: [...new Set<number>(value.creatorIds)] } : null;
  } catch { return null; }
}
const failedRequest = ref<PendingRequest | null>(readPendingRequest());
function rememberRequest(value: PendingRequest | null) {
  if (value) sessionStorage.setItem(requestStorageKey, JSON.stringify(value));
  else sessionStorage.removeItem(requestStorageKey);
  failedRequest.value = value;
}
let generation = 0;
const statusLabel = (status: string) => ({ pending: '待采集', claimed: '已领取', completed: '元数据已接入', failed: '失败', not_found: '未找到合集', cancelled: '已取消' }[status] ?? status);
const preferenceLabel = (value: string | null) => value === 'liked' ? '喜欢' : value === 'kept' ? '保留' : '未设置';
const resultLabel = (value: string) => ({ created:'新建检查任务', reused:'复用检查任务', claimed:'已有执行者，未重复领取', replayed:'本次提交已经确认，未重复创建', source_ready:'服务端仍是旧版，尚未发起新检查，请升级', delivery_required:'元数据已接入，需确认完整网盘来源', retry_required:'服务端仍是旧版，未开始新检查', inactive:'博主已停用，未创建任务' }[value] ?? value);
const handoff = computed(() => {
  const allowed = new Set(result.value?.taskIds ?? []);
  const items = result.value?.items.filter(item => item.task && allowed.has(item.task.id)) ?? [];
  return { version: 1, type: 'costuan-stage1-scope', taskIds: items.map(item => item.task!.id), creatorIds: items.map(item => item.creatorId), names: items.map(item => item.creatorName), rounds: items.filter(item => item.task?.checkRoundId).map(item => ({ taskId: item.task!.id, checkRoundId: item.task!.checkRoundId! })) };
});
async function load() {
  if (!props.active) return;
  const request = ++generation; loading.value = true;
  try {
    const snapshot = { ...filters };
    const [next, nextStats] = await Promise.all([fetchCreatorSyncRoster({ ...snapshot, page: page.value, limit: 50 }), fetchCreatorSyncStats(snapshot)]);
    if (request === generation) { payload.value = next; stats.value = nextStats; error.value = ''; }
  }
  catch (reason) { if (request === generation) error.value = reason instanceof Error ? reason.message : '无法读取博主；未创建任务'; }
  finally { if (request === generation) loading.value = false; }
}
async function open() {
  if (props.disabled || busy.value) return;
  selected.value = new Map(); result.value = null; error.value = ''; copyNotice.value = ''; page.value = 1; payload.value = null; stats.value = null;
  preparingAnotherRound.value = false;
  Object.assign(filters, defaultFilters());
  if (failedRequest.value) { error.value = '上次提交尚未确认，请重试同一范围，不能另建一轮。'; }
  if (props.creator?.isActive) selected.value.set(props.creator.id, { id:props.creator.id, name:props.creator.name });
  dialog.value?.showModal();
  if (!props.creator) await load();
}
function onClose() { ++generation; loading.value = false; selected.value.clear(); }
function close() { if (!busy.value) dialog.value?.close(); }
function cancel(event: Event) { if (busy.value) event.preventDefault(); }
function toggle(item: CreatorSyncRow, checked: boolean) { if (busy.value || !item.isActive) return; if (checked) selected.value.set(item.creatorId, { id:item.creatorId, name:item.creatorName }); else selected.value.delete(item.creatorId); }
async function search() { page.value = 1; error.value = ''; await load(); }
async function goPage(next: number) { page.value = next; await load(); }
async function submit() {
  if (busy.value) return;
  const ids = failedRequest.value ? [...failedRequest.value.creatorIds] : [...selected.value.keys()];
  if (!ids.length) { error.value = '请先选择博主；没有创建任务。'; return; }
  busy.value = true; error.value = ''; copyNotice.value = '';
  const request = failedRequest.value ?? { id: crypto.randomUUID(), creatorIds: ids };
  try {
    // Save only the explicit request identity; a page return must retry rather than create another round.
    rememberRequest(request);
    const response = await planFirstCollection(ids, request.id);
    result.value = response;
    preparingAnotherRound.value = false;
    rememberRequest(null);
    emit('planned', ids);
    await nextTick();
    if (props.active && dialog.value?.open) { dialog.value.scrollTop = 0; copyButton.value?.focus({ preventScroll: true }); }
    if (!props.creator) await load();
  } catch (reason) {
    // A rejected request has not created a round; a lost/5xx response remains idempotently retryable.
    if (reason instanceof RequestError && [400, 403, 404, 409, 422].includes(reason.status)) {
      rememberRequest(null);
    }
    error.value = reason instanceof Error ? reason.message : '提交未确认；可重试相同选择，不会自动扩大范围。';
  }
  finally { busy.value = false; }
}
async function copyHandoff() {
  try { await navigator.clipboard.writeText(JSON.stringify(handoff.value)); copyNotice.value = '已复制固定任务范围；尚未执行采集或转存。'; }
  catch { copyNotice.value = '剪贴板不可用，请手动复制上方任务范围。'; }
}
watch(() => props.active, active => { if (!active) { ++generation; loading.value = false; } });
onBeforeUnmount(() => { ++generation; });
</script>

<style scoped>
button{border:1px solid var(--border);border-radius:.65rem;padding:.6rem .9rem;background:var(--surface);font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
button.primary{background:var(--accent);color:white;border-color:var(--accent);font-weight:600;min-height:2.75rem}.scope-note{font-size:.85rem;color:var(--muted)}summary{cursor:pointer}.more-filters{align-self:center}.more-filters>div{padding-top:.7rem}
dialog{width:min(65rem,94vw);max-height:88vh;overflow:auto;border:1px solid var(--border);border-radius:1rem;padding:1.25rem;background:var(--surface);color:var(--text)}dialog::backdrop{background:#0007}
header,.filters,.paging,.selection{display:flex;gap:.8rem;align-items:center;flex-wrap:wrap}header{justify-content:space-between}h2{margin:0;font-size:1.2rem}p,li{line-height:1.6}label{display:grid;gap:.3rem}input:not([type=checkbox]),select,textarea{border:1px solid var(--border);border-radius:.5rem;padding:.5rem;background:var(--bg);color:var(--text);font:inherit}textarea{box-sizing:border-box;width:100%}.table-scroll{overflow:auto;margin:1rem 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.7rem;border-bottom:1px solid var(--border)}small{display:block;color:var(--muted)}.selection{margin:1rem 0}[role=alert]{color:#b91c1c}section{margin-top:1rem}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
