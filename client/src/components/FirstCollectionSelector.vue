<template>
  <div class="first-collection">
    <button type="button" data-test="open-first-collection" :disabled="disabled" @click="open">{{ creator ? '建立Costuan来源' : '从博主库选择' }}</button>
    <dialog ref="dialog" aria-label="选择 Stage 1 来源收录博主" @cancel="cancel" @close="onClose">
      <header><h2>选择 Stage 1 来源收录博主</h2><button type="button" :disabled="busy" @click="close">{{ result ? '关闭' : '取消' }}</button></header>
      <p>仅提交明确勾选的规范 ID；筛选与翻页不会扩大范围。不创建本地目录，不自动操作网盘。</p>
      <form v-if="!creator" class="filters" @submit.prevent="search">
        <label>搜索规范名称或别名<input v-model="filters.q" type="search" /></label>
        <label>状态<select v-model="filters.active"><option value="active">启用</option><option value="inactive">停用</option><option value="all">全部状态</option></select></label>
        <label>Costuan 来源<select v-model="filters.hasSource"><option value="no">尚无来源</option><option value="yes">已有来源</option><option value="all">全部来源状态</option></select></label>
        <button :disabled="loading || busy">筛选</button>
      </form>
      <p v-if="error" role="alert">{{ error }}</p>
      <div v-if="!creator" class="table-scroll">
        <table><thead><tr><th>选择 / 规范 ID</th><th>博主 / 别名</th><th>偏好 / 分级</th><th>本地</th><th>Costuan 来源 / 任务</th></tr></thead>
          <tbody><tr v-for="item in payload?.items" :key="item.creatorId">
            <td><input type="checkbox" :aria-label="`选择 #${item.creatorId} ${item.creatorName}`" :checked="selected.has(item.creatorId)" :disabled="!item.isActive || busy" @change="toggle(item, ($event.target as HTMLInputElement).checked)" /> #{{ item.creatorId }}</td>
            <td>{{ item.creatorName }}<small>{{ item.aliases.join(' / ') }}</small></td>
            <td>{{ preferenceLabel(item.preference) }} / {{ item.rating ?? '待分类' }}<small v-if="!item.isActive">已停用，不能创建</small></td>
            <td>{{ item.localWorks }} 套</td>
            <td>{{ sourceStateLabel(item.sourceState) }}<small v-if="item.task">任务 #{{ item.task.id }} · {{ statusLabel(item.task.status) }}{{ item.task.claimedBy ? ` · ${item.task.claimedBy}` : '' }}</small></td>
          </tr></tbody>
        </table>
        <p v-if="payload && !payload.items.length">没有符合条件的博主。</p>
      </div>
      <p v-else>#{{ creator.id }} {{ creator.name }} · {{ creator.localWorks }} 套本地作品 · {{ preferenceLabel(creator.preference) }} / {{ creator.rating ?? '待分类' }}</p>
      <footer v-if="!creator" class="paging"><button :disabled="page <= 1 || loading || busy" @click="goPage(page - 1)">上一页</button><span>第 {{ page }} 页 / {{ payload?.pages ?? 1 }} 页 · {{ payload?.total ?? 0 }} 位</span><button :disabled="page >= (payload?.pages ?? 1) || loading || busy" @click="goPage(page + 1)">下一页</button></footer>
      <div class="selection"><strong data-test="selected-count">已选 {{ selected.size }} 位</strong><span>{{ [...selected.values()].map(item => `#${item.id} ${item.name}`).join('、') }}</span></div>
      <button type="button" data-test="submit-first-collection" :disabled="!selected.size || busy" @click="submit(false)">{{ busy ? '正在提交…' : '加入 Stage 1 来源收录任务' }}</button>
      <section v-if="result" aria-label="逐项任务结果">
        <h3>逐项结果</h3>
        <ul><li v-for="item in result.items" :key="item.creatorId">#{{ item.creatorId }} {{ item.creatorName }}：{{ resultLabel(item.result) }}<span v-if="item.task"> · 任务 #{{ item.task.id }} · {{ statusLabel(item.task.status) }}{{ item.task.claimedBy ? ` · ${item.task.claimedBy}` : '' }}</span><small v-if="item.task">{{ sourceStateLabel(item.task.sourceState) }}</small></li></ul>
        <p v-if="result.items.some(item => item.result === 'source_ready')">已有可用来源的博主无需重新采集；可查看 Stage 2 缺失任务。</p>
        <button v-if="retryIds.length" type="button" data-test="retry-first-collection" :disabled="busy" @click="submit(true)">明确重试以上 {{ retryIds.length }} 位待重试博主</button>
        <template v-if="handoff.taskIds.length">
          <p>以下 {{ handoff.taskIds.length }} 项为本次固定范围。复制后粘贴到新版插件的「Stage 1 指定任务范围」，核对名称后开始；旧插件不支持时请升级，不能改用全名单自动转存。</p>
          <textarea data-test="stage1-handoff" aria-label="Stage 1 固定任务范围" readonly :value="JSON.stringify(handoff)" rows="3" />
          <button type="button" data-test="copy-stage1-handoff" @click="copyHandoff">复制本次任务范围</button><p v-if="copyNotice" role="status">{{ copyNotice }}</p>
        </template>
      </section>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { fetchFirstCollectionCandidates, planFirstCollection, sourceStateLabel } from '../api/first-collection';
import type { FirstCollectionCandidate, FirstCollectionCandidates, FirstCollectionResult } from '../api/first-collection';
import type { ArchiveCatalogCreator } from '../types/api';
const props = defineProps<{ creator?: Pick<ArchiveCatalogCreator, 'id' | 'name' | 'isActive' | 'localWorks' | 'preference' | 'rating'>; disabled?: boolean }>();
const emit = defineEmits<{ planned: [creatorIds: number[]] }>();
const dialog = ref<HTMLDialogElement | null>(null), busy = ref(false), loading = ref(false), error = ref(''), copyNotice = ref('');
const payload = ref<FirstCollectionCandidates | null>(null), page = ref(1), result = ref<FirstCollectionResult | null>(null);
const filters = reactive({ q: '', active: 'active' as 'active'|'inactive'|'all', hasSource: 'no' as 'yes'|'no'|'all' });
const selected = ref(new Map<number, { id: number; name: string }>());
let generation = 0;
const statusLabel = (status: string) => ({ pending: '待采集', claimed: '已领取', completed: '元数据已接入', failed: '失败', not_found: '未找到合集', cancelled: '已取消' }[status] ?? status);
const preferenceLabel = (value: string | null) => value === 'liked' ? '喜欢' : value === 'kept' ? '保留' : '未设置';
const resultLabel = (value: string) => ({ created:'新建任务', reused:'复用已有待处理任务', claimed:'已有执行者，未重复领取', source_ready:'已有可用来源', delivery_required:'元数据已接入，需确认完整网盘来源', retry_required:'历史失败、未找到或取消记录，需要明确重试', inactive:'博主已停用，未创建任务' }[value] ?? value);
const retryIds = computed(() => result.value?.items.filter(item => ['retry_required', 'delivery_required'].includes(item.result)).map(item => item.creatorId) ?? []);
const handoff = computed(() => {
  const allowed = new Set(result.value?.taskIds ?? []);
  const items = result.value?.items.filter(item => item.task && allowed.has(item.task.id)) ?? [];
  return { version: 1, type: 'costuan-stage1-scope', taskIds: items.map(item => item.task!.id), creatorIds: items.map(item => item.creatorId), names: items.map(item => item.creatorName) };
});
async function load() {
  const request = ++generation; loading.value = true;
  try { const next = await fetchFirstCollectionCandidates({ ...filters, page: page.value, limit: 50 }); if (request === generation) payload.value = next; }
  catch (reason) { if (request === generation) error.value = reason instanceof Error ? reason.message : '无法读取博主；未创建任务'; }
  finally { if (request === generation) loading.value = false; }
}
async function open() {
  if (props.disabled || busy.value) return;
  selected.value = new Map(); result.value = null; error.value = ''; copyNotice.value = ''; page.value = 1;
  Object.assign(filters, { q:'', active:'active', hasSource:'no' });
  if (props.creator?.isActive) selected.value.set(props.creator.id, { id:props.creator.id, name:props.creator.name });
  dialog.value?.showModal();
  if (!props.creator) await load();
}
function onClose() { ++generation; loading.value = false; selected.value.clear(); }
function close() { if (!busy.value) dialog.value?.close(); }
function cancel(event: Event) { if (busy.value) event.preventDefault(); }
function toggle(item: FirstCollectionCandidate, checked: boolean) { if (busy.value || !item.isActive) return; if (checked) selected.value.set(item.creatorId, { id:item.creatorId, name:item.creatorName }); else selected.value.delete(item.creatorId); }
async function search() { page.value = 1; error.value = ''; await load(); }
async function goPage(next: number) { page.value = next; await load(); }
async function submit(retry: boolean) {
  if (busy.value) return;
  const ids = retry ? [...retryIds.value] : [...selected.value.keys()];
  if (!ids.length) { error.value = '请先选择博主；没有创建任务。'; return; }
  busy.value = true; error.value = ''; copyNotice.value = '';
  try {
    const response = await planFirstCollection(ids, retry);
    // A retry affects only the explicitly listed failures; keep other successful handoff entries.
    result.value = retry && result.value ? {
      items: result.value.items.map(item => response.items.find(next => next.creatorId === item.creatorId) ?? item),
      taskIds: [...new Set([...result.value.taskIds, ...response.taskIds])]
    } : response;
    emit('planned', ids);
    if (!props.creator) await load();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '提交未确认；可重试相同选择，不会自动扩大范围。'; }
  finally { busy.value = false; }
}
async function copyHandoff() {
  try { await navigator.clipboard.writeText(JSON.stringify(handoff.value)); copyNotice.value = '已复制固定任务范围；尚未执行采集或转存。'; }
  catch { copyNotice.value = '剪贴板不可用，请手动复制上方任务范围。'; }
}
onBeforeUnmount(() => { ++generation; });
</script>

<style scoped>
button{border:1px solid var(--border);border-radius:.65rem;padding:.6rem .9rem;background:var(--surface);font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
dialog{width:min(65rem,94vw);max-height:88vh;overflow:auto;border:1px solid var(--border);border-radius:1rem;padding:1.25rem;background:var(--surface);color:var(--text)}dialog::backdrop{background:#0007}
header,.filters,.paging,.selection{display:flex;gap:.8rem;align-items:center;flex-wrap:wrap}header{justify-content:space-between}h2{margin:0;font-size:1.2rem}p,li{line-height:1.6}label{display:grid;gap:.3rem}input:not([type=checkbox]),select,textarea{border:1px solid var(--border);border-radius:.5rem;padding:.5rem;background:var(--bg);color:var(--text);font:inherit}textarea{box-sizing:border-box;width:100%}.table-scroll{overflow:auto;margin:1rem 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.7rem;border-bottom:1px solid var(--border)}small{display:block;color:var(--muted)}.selection{margin:1rem 0}[role=alert]{color:#b91c1c}section{margin-top:1rem}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
