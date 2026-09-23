<template>
  <div class="mt-4" aria-label="Stage 2 博主完整汇总">
    <form class="mb-3 flex flex-wrap gap-3 text-xs" @submit.prevent="search">
      <label>搜索规范名称或别名<input v-model="draft.q" class="ml-2 rounded-lg border border-border bg-bg p-2" type="search" /></label>
      <label>任务状态<select v-model="draft.status" class="ml-2 rounded-lg border border-border bg-bg p-2"><option value="">全部</option><option v-for="status in statuses" :key="status" :value="status">{{ statusLabel(status) }}</option></select></label>
      <label>博主状态<select v-model="draft.enabled" class="ml-2 rounded-lg border border-border bg-bg p-2"><option value="all">全部</option><option value="enabled">启用</option><option value="disabled">停用</option></select></label>
      <button class="rounded-lg border border-border px-3 py-2" :disabled="loading">筛选（只读）</button>
    </form>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}；保留上次读取结果，不代表零任务。</p>
    <p v-if="!payload && !error" class="text-sm text-muted">{{ loading ? '正在读取完整汇总…' : '汇总尚未读取' }}</p>
    <template v-if="payload">
      <div data-test="stage2-totals" class="mb-3 flex flex-wrap gap-3 rounded-xl bg-bg p-3 text-xs">
        <strong>{{ payload.taskTotal }} 条匹配任务 · {{ payload.total }} 位博主</strong>
        <span v-for="status in statuses" :key="status">{{ statusLabel(status) }} {{ payload.summary[status] }}</span>
      </div>
      <p data-test="stage2-preview-scope" class="text-xs text-muted">汇总统计完整匹配范围，不受明细分页影响。任务状态保留实际执行历史；本地满足与待复核另列，不计为新入库任务。读取时间：{{ payload.readAt }}</p>
      <p v-if="!payload.total" class="text-sm text-muted">当前筛选没有匹配的下载任务。</p>
      <div v-if="payload.items.length" data-test="stage2-creators" class="grid gap-2">
        <article v-for="group in payload.items" :key="group.creatorId" :data-creator-id="group.creatorId" class="overflow-hidden rounded-xl border border-border bg-bg">
          <button type="button" data-test="toggle-stage2-creator" class="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left text-xs" :aria-expanded="expanded.has(group.creatorId)" :aria-controls="`stage2-creator-${group.creatorId}`" @click="toggle(group.creatorId)">
            <span><strong class="block text-sm">{{ group.creatorName }} <small class="font-normal text-muted">#{{ group.creatorId }}</small></strong><small class="mt-1 block text-muted">完整汇总 {{ group.total }} 条 · {{ expanded.has(group.creatorId) ? '收起作品' : '展开作品' }}</small></span>
            <span class="flex flex-wrap gap-3"><span v-for="status in statuses.filter(value => group.summary[value] > 0)" :key="status"><strong>{{ group.summary[status] }}</strong> {{ statusLabel(status) }}</span></span>
          </button>
          <p v-if="group.localSatisfied || group.acquisitionReviewRequired" data-test="stage2-local-acceptance" class="m-0 px-3 pb-3 text-xs text-muted">
            本地已有资源满足 {{ group.localSatisfied ?? 0 }} 条 · 接受决定待复核 {{ group.acquisitionReviewRequired ?? 0 }} 条（未计为已满足，不自动重新获取）
          </p>
          <div v-if="expanded.has(group.creatorId)" :id="`stage2-creator-${group.creatorId}`" class="border-t border-border bg-surface p-3">
            <p v-if="detailErrors[group.creatorId]" role="alert" class="text-sm text-red-700">{{ detailErrors[group.creatorId] }} <button class="underline" @click="loadDetail(group.creatorId)">重试读取</button></p>
            <p v-if="detailLoading[group.creatorId]" class="text-xs text-muted">正在读取明细…</p>
            <p v-else-if="!details[group.creatorId] && !detailErrors[group.creatorId]" class="text-xs text-muted">明细未加载</p>
            <template v-if="details[group.creatorId]">
              <div class="max-h-[32rem] overflow-auto">
                <table class="w-full min-w-[46rem] border-collapse text-left text-sm">
                  <thead class="bg-bg text-xs text-muted"><tr><th class="p-3">作品</th><th class="p-3">网盘目录</th><th class="p-3">本地目标</th><th class="p-3">状态</th></tr></thead>
                  <tbody><tr v-for="task in details[group.creatorId]!.items" :key="task.id" data-test="stage2-task" class="border-t border-border"><td class="p-3"><span class="font-semibold">{{ task.sourceOrderLabel ?? task.targetFilename }}</span><small class="mt-0.5 block text-muted">{{ task.title }}</small></td><td class="p-3 font-mono text-xs">{{ task.destinationPath }}/{{ task.sourceFolderName }}</td><td class="p-3 font-mono text-xs">{{ task.targetRelativeDirectory }}\{{ task.targetFilename }}</td><td class="p-3"><span>{{ statusLabel(task.status) }}</span><small v-if="task.acquisitionState && task.acquisitionState !== 'required'" data-test="stage2-acquisition" class="mt-1 block text-muted">{{ task.acquisitionExplanation || (task.acquisitionState === 'local_satisfied' ? '本地已有资源满足，无需继续获取。' : '接受决定待复核，未计为已满足；不自动重新获取。') }}</small></td></tr></tbody>
                </table>
              </div>
              <div class="mt-3 flex justify-center gap-3 text-xs"><button :disabled="detailLoading[group.creatorId] || details[group.creatorId]!.page <= 1" @click="loadDetail(group.creatorId, details[group.creatorId]!.page - 1)">上一页明细</button><span>第 {{ details[group.creatorId]!.page }} / {{ pages(details[group.creatorId]!) }} 页 · 共 {{ details[group.creatorId]!.total }} 条</span><button :disabled="detailLoading[group.creatorId] || !details[group.creatorId]!.hasMore" @click="loadDetail(group.creatorId, details[group.creatorId]!.page + 1)">下一页明细</button></div>
            </template>
          </div>
        </article>
      </div>
      <div class="mt-3 flex justify-center gap-3 text-xs"><button data-test="stage2-creators-prev" :disabled="loading || payload.page <= 1" @click="goPage(payload.page - 1)">上一页博主</button><span>第 {{ payload.page }} / {{ pages(payload) }} 页 · 共 {{ payload.total }} 位</span><button data-test="stage2-creators-next" :disabled="loading || !payload.hasMore" @click="goPage(payload.page + 1)">下一页博主</button></div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue';
import { fetchDownloadCreators, fetchDownloadTaskPage } from '../api/creator-sync';
import type { DownloadCreatorPage, DownloadTaskPage, DownloadFilters } from '../api/creator-sync';
import type { ArchiveDownloadTaskStatus } from '../types/api';
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const statuses: ArchiveDownloadTaskStatus[] = ['pending', 'claimed', 'downloading', 'staged', 'downloaded', 'ingested', 'failed', 'cancelled'];
const statusLabel = (status: ArchiveDownloadTaskStatus) => ({ pending: '待转存', claimed: '插件处理中', downloading: '下载中', staged: '网盘已暂存，待本地确认', downloaded: '本地已下载，待入库', ingested: '已入库', failed: '失败', cancelled: '已取消' }[status]);
const payload = ref<DownloadCreatorPage | null>(null), loading = ref(false), error = ref('');
const expanded = reactive(new Set<number>());
const details = reactive<Record<number, DownloadTaskPage>>({}), detailErrors = reactive<Record<number, string>>({}), detailLoading = reactive<Record<number, boolean>>({});
const draft = reactive({ q: '', status: '' as ArchiveDownloadTaskStatus | '', enabled: 'all' as 'all' | 'enabled' | 'disabled' });
let filters: DownloadFilters = { enabled: 'all' }, page = 1, generation = 0, alive = true;
const detailGeneration = new Map<number, number>();
const pages = (value: { total: number; limit: number }) => Math.max(1, Math.ceil(value.total / value.limit));
async function loadDetail(creatorId: number, targetPage = details[creatorId]?.page ?? 1) {
  if (!props.active) return;
  const request = (detailGeneration.get(creatorId) ?? 0) + 1;
  detailGeneration.set(creatorId, request);
  const scope = generation;
  detailLoading[creatorId] = true; delete detailErrors[creatorId];
  try {
    const next = await fetchDownloadTaskPage({ ...filters, creatorId, page: targetPage, limit: 50 });
    if (!alive || scope !== generation || detailGeneration.get(creatorId) !== request) return;
    if (targetPage > pages(next)) { await loadDetail(creatorId, pages(next)); return; }
    details[creatorId] = next;
  } catch (reason) { if (alive && scope === generation && detailGeneration.get(creatorId) === request) detailErrors[creatorId] = reason instanceof Error ? reason.message : '明细读取失败'; }
  finally { if (scope === generation && detailGeneration.get(creatorId) === request) detailLoading[creatorId] = false; }
}
async function refresh() {
  if (!props.active) return;
  const request = ++generation;
  loading.value = true; error.value = '';
  try {
    const next = await fetchDownloadCreators({ ...filters, page, limit: 20 });
    if (!alive || request !== generation) return;
    if (page > pages(next)) { page = pages(next); await refresh(); return; }
    payload.value = next;
    await Promise.all(next.items.filter(group => expanded.has(group.creatorId)).map(group => loadDetail(group.creatorId)));
  } catch (reason) { if (alive && request === generation) error.value = reason instanceof Error ? reason.message : '完整汇总读取失败'; }
  finally { if (request === generation) loading.value = false; }
}
async function toggle(id: number) { if (expanded.has(id)) expanded.delete(id); else { expanded.add(id); await loadDetail(id); } }
async function search() {
  filters = { q: draft.q, status: draft.status || undefined, enabled: draft.enabled }; page = 1;
  for (const key of Object.keys(details)) delete details[Number(key)];
  for (const key of Object.keys(detailErrors)) delete detailErrors[Number(key)];
  await refresh();
}
async function goPage(next: number) { page = next; await refresh(); }
watch(() => props.active, active => {
  if (!active) {
    ++generation;
    loading.value = false;
    for (const key of Object.keys(detailLoading)) detailLoading[Number(key)] = false;
  }
});
onBeforeUnmount(() => { alive = false; ++generation; });
defineExpose({ refresh });
</script>
