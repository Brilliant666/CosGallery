<template>
  <section class="mx-auto w-full max-w-[92rem] px-1 pb-12 sm:px-4 lg:px-7">
    <header class="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted">CosGallery Catalog</p>
        <h1 class="m-0 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">图库账本</h1>
        <p class="mt-2 mb-0 max-w-2xl text-sm leading-6 text-muted">
          汇总博主名单、资源平台收录和本地归档差异。这里只读取账本，不会修改图库文件。
        </p>
      </div>
      <span class="rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-muted">
        {{ total }} 位符合条件
      </span>
    </header>

    <div v-if="summary" class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6" aria-label="账本概览">
      <article v-for="card in summaryCards" :key="card.label" class="rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <p class="m-0 text-xs font-semibold text-muted">{{ card.label }}</p>
        <strong class="mt-2 block text-2xl tracking-[-0.04em]">{{ formatCount(card.value) }}</strong>
        <small class="mt-1 block text-xs leading-5 text-muted">{{ card.note }}</small>
      </article>
    </div>

    <section class="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5" aria-label="缺失作品下载队列">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Stage 2</p>
          <h2 class="mt-1 mb-0 text-lg font-semibold">缺失作品下载队列</h2>
          <p class="mt-1.5 mb-0 max-w-3xl text-sm leading-6 text-muted">
            仅检查 G:\cos图集 中已存在并匹配到博主 ID 的目录；为这些博主已转存到百度网盘、但本地尚未关联的 Costuan 作品生成任务。插件会按博主批量复制缺失压缩包到“我的网盘/cos待入库/博主 ID”，供你随后整目录下载。
          </p>
        </div>
        <div v-if="downloadTasks" class="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
          <span class="rounded-xl bg-bg px-3 py-2 text-xs"><strong class="block text-base">{{ downloadTasks.summary.total }}</strong>全部</span>
          <span class="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"><strong class="block text-base">{{ downloadTasks.summary.pending }}</strong>待下载</span>
          <span class="rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700"><strong class="block text-base">{{ downloadTasks.summary.downloading + downloadTasks.summary.claimed }}</strong>处理中</span>
          <span class="rounded-xl bg-violet-50 px-3 py-2 text-xs text-violet-700"><strong class="block text-base">{{ downloadTasks.summary.staged }}</strong>网盘待下载</span>
          <span class="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700"><strong class="block text-base">{{ downloadTasks.summary.downloaded + downloadTasks.summary.ingested }}</strong>已完成</span>
          <span class="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700"><strong class="block text-base">{{ downloadTasks.summary.failed }}</strong>失败</span>
        </div>
      </div>

      <div class="mt-4 grid gap-3 lg:grid-cols-[minmax(18rem,1fr)_auto_auto]">
        <label class="grid gap-1.5 text-xs font-semibold text-muted">
          本地待入库根目录（账本）
          <input v-model="inboxRoot" class="h-11 rounded-xl border border-border bg-bg px-3.5 text-sm text-text outline-none focus:border-accent" autocomplete="off" />
        </label>
        <button type="button" data-test="plan-downloads" class="h-11 self-end rounded-xl bg-accent px-5 text-sm font-semibold text-white disabled:opacity-50" :disabled="planningDownloads" @click="planDownloads()">
          {{ planningDownloads ? '正在生成…' : '生成现有博主缺失任务' }}
        </button>
        <button type="button" class="h-11 self-end rounded-xl border border-border bg-bg px-5 text-sm font-semibold text-text disabled:opacity-50" :disabled="rotatingBridgeToken" @click="rotateBridgeToken">
          {{ bridgeConfigured ? '重新生成插件密钥' : '生成插件连接密钥' }}
        </button>
      </div>

      <p v-if="downloadNotice" data-test="download-notice" class="mt-3 mb-0 rounded-xl border border-border bg-bg px-3.5 py-3 text-sm text-text">{{ downloadNotice }}</p>
      <div v-if="bridgeToken" class="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-900">
        <strong>请立即复制到 CostuanArchiveManager；页面刷新后不再显示。</strong>
        <div class="mt-2 flex gap-2">
          <input :value="bridgeToken" readonly class="h-10 min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 font-mono text-xs" />
          <button type="button" class="rounded-lg border border-amber-300 bg-white px-4 text-xs font-semibold" @click="copyBridgeToken">复制</button>
        </div>
      </div>

      <div v-if="downloadTasks?.items.length" class="mt-4 overflow-x-auto rounded-xl border border-border">
        <table class="w-full min-w-[52rem] border-collapse text-left text-sm">
          <thead class="bg-bg text-xs text-muted"><tr><th class="p-3">博主</th><th class="p-3">作品</th><th class="p-3">网盘目录</th><th class="p-3">本地目标</th><th class="p-3">状态</th></tr></thead>
          <tbody>
            <tr v-for="task in downloadTasks.items.slice(0, 20)" :key="task.id" class="border-t border-border">
              <td class="p-3 font-semibold">{{ task.creatorName }}</td>
              <td class="p-3"><span class="font-semibold">{{ task.sourceOrderLabel ?? task.targetFilename }}</span><small class="mt-0.5 block text-muted">{{ task.title }}</small></td>
              <td class="p-3 font-mono text-xs">{{ task.destinationPath }}/{{ task.sourceFolderName }}</td>
              <td class="p-3 font-mono text-xs">{{ task.targetRelativeDirectory }}\{{ task.targetFilename }}</td>
              <td class="p-3">{{ downloadStatusLabel(task.status) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="downloadTasks.total > 20" class="m-0 border-t border-border p-3 text-center text-xs text-muted">管理页预览前 20 条；插件按完整队列领取。</p>
      </div>
    </section>

    <form class="mb-5 grid gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm lg:grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(9rem,0.22fr))_auto]" @submit.prevent="applyFilters">
      <label class="grid gap-1.5 text-xs font-semibold text-muted">
        搜索博主
        <input
          v-model="query"
          type="search"
          placeholder="输入博主 ID 或名称"
          class="h-11 min-w-0 rounded-xl border border-border bg-bg px-3.5 text-sm text-text outline-none transition focus:border-accent"
        />
      </label>
      <label class="grid gap-1.5 text-xs font-semibold text-muted">
        偏好
        <select v-model="preference" class="h-11 rounded-xl border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent" @change="applyFilters">
          <option value="">喜欢 + 保留</option>
          <option value="liked">喜欢</option>
          <option value="kept">保留</option>
        </select>
      </label>
      <label class="grid gap-1.5 text-xs font-semibold text-muted">
        分级
        <select v-model="rating" class="h-11 rounded-xl border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent" @change="applyFilters">
          <option value="">R15 + R18</option>
          <option value="R15">R15</option>
          <option value="R18">R18</option>
        </select>
      </label>
      <label class="grid gap-1.5 text-xs font-semibold text-muted">
        入库状态
        <select v-model="state" class="h-11 rounded-xl border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent" @change="applyFilters">
          <option value="">全部状态</option>
          <option value="missing">有待收录作品</option>
          <option value="no-local">尚未入库</option>
          <option value="complete">已完整关联</option>
          <option value="no-source">尚未接入资源</option>
          <option value="unresolved">待核查</option>
        </select>
      </label>
      <div class="flex items-end gap-2">
        <button type="submit" class="h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white">筛选</button>
        <button type="button" class="h-11 rounded-xl border border-border bg-bg px-4 text-sm font-semibold text-text" @click="resetFilters">重置</button>
      </div>
    </form>

    <p v-if="error" role="alert" class="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ error }}
    </p>

    <div v-if="loading" class="rounded-2xl border border-dashed border-border py-20 text-center text-muted">
      正在读取图库账本…
    </div>

    <div v-else-if="items.length" class="grid gap-3" aria-label="博主账本列表">
      <article v-for="creator in items" :key="creator.id" data-test="catalog-creator" class="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div class="catalog-row grid items-center gap-3 p-4">
          <div class="min-w-0">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <strong class="truncate text-[0.98rem]">{{ creator.name }}</strong>
              <span class="rounded-full px-2 py-0.5 text-[0.68rem] font-bold" :class="preferenceClass(creator.preference)">
                {{ creator.preference === 'liked' ? '喜欢' : creator.preference === 'kept' ? '保留' : '未分类' }}
              </span>
              <span class="rounded-full px-2 py-0.5 text-[0.68rem] font-bold text-white" :class="ratingClass(creator.rating)">
                {{ creator.rating ?? '未分级' }}
              </span>
            </div>
            <p class="mt-1 mb-0 text-xs text-muted">{{ creator.sourceCollections }} 个资源合集 · {{ statusLabel(creator) }}</p>
          </div>
          <CatalogMetric label="平台作品" :value="creator.remoteWorks" />
          <CatalogMetric label="本地作品" :value="creator.localWorks" />
          <CatalogMetric label="已关联" :value="creator.matchedWorks" />
          <CatalogMetric label="待收录" :value="creator.missingWorks" :alert="creator.missingWorks > 0" />
          <button
            type="button"
            class="h-10 rounded-xl border border-border bg-bg px-4 text-sm font-semibold text-text transition hover:border-accent"
            :aria-expanded="expandedCreatorId === creator.id"
            @click="toggleCreator(creator.id)"
          >
            {{ expandedCreatorId === creator.id ? '收起' : '查看' }}
          </button>
        </div>

        <div v-if="expandedCreatorId === creator.id" data-test="catalog-detail" class="border-t border-border bg-bg/45 p-4 sm:p-5">
          <p v-if="detailLoadingId === creator.id" class="m-0 py-6 text-center text-sm text-muted">正在读取详细账本…</p>
          <p v-else-if="detailErrors[creator.id]" class="m-0 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {{ detailErrors[creator.id] }}
          </p>
          <div v-else-if="details[creator.id]" class="grid gap-5">
            <section>
              <div class="mb-2 flex items-center justify-between gap-3">
                <h2 class="m-0 text-sm font-semibold">资源来源</h2>
                <span class="text-xs text-muted">别名 {{ details[creator.id].aliases.length }} 个</span>
              </div>
              <div v-if="details[creator.id].collections.length" class="grid gap-2 md:grid-cols-2">
                <article v-for="collection in details[creator.id].collections" :key="collection.id" class="rounded-xl border border-border bg-surface p-3.5">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <span class="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-muted">{{ collection.source }}</span>
                      <h3 class="mt-1 mb-0 text-sm leading-5">{{ collection.title }}</h3>
                    </div>
                    <a v-if="collection.url" :href="collection.url" target="_blank" rel="noreferrer" class="shrink-0 text-xs font-semibold text-accent">打开来源</a>
                  </div>
                  <p class="mt-2 mb-0 text-xs text-muted">
                    平台标注 {{ collection.declaredWorkCount ?? '未知' }} 套
                    <template v-if="collection.deliveries.length"> · {{ deliveryLabel(collection.deliveries[0]) }}</template>
                  </p>
                </article>
              </div>
              <p v-else class="m-0 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted">尚未接入资源平台合集。</p>
            </section>

            <section>
              <div class="mb-2 flex items-center justify-between gap-3">
                <h2 class="m-0 text-sm font-semibold">待收录作品</h2>
                <div class="flex items-center gap-3">
                  <button v-if="details[creator.id].missing.length && creator.localWorks > 0" type="button" class="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold" @click="planDownloads(creator.id)">只生成此博主任务</button>
                  <span class="text-xs font-semibold" :class="details[creator.id].missing.length ? 'text-amber-600' : 'text-emerald-600'">
                    {{ details[creator.id].missing.length }} 套
                  </span>
                </div>
              </div>
              <div v-if="details[creator.id].missing.length" class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <article v-for="work in details[creator.id].missing" :key="work.workId" class="rounded-xl border border-border bg-surface px-3.5 py-3">
                  <div class="flex items-start gap-3">
                    <span class="shrink-0 rounded-md bg-amber-100 px-2 py-1 text-[0.68rem] font-bold text-amber-800">
                      {{ work.sourceOrderLabel ?? (work.sourceOrder === null ? '无序号' : `NO.${String(work.sourceOrder).padStart(3, '0')}`) }}
                    </span>
                    <div class="min-w-0">
                      <p class="m-0 text-sm font-medium leading-5">{{ work.title }}</p>
                      <small class="mt-1 block text-[0.68rem] uppercase text-muted">{{ work.source }}</small>
                    </div>
                  </div>
                </article>
              </div>
              <p v-else class="m-0 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-700">平台作品已全部关联到本地图库。</p>
            </section>

            <section v-if="details[creator.id].unresolved.length">
              <h2 class="mb-2 text-sm font-semibold text-amber-700">待核查的本地目录</h2>
              <ul class="m-0 grid gap-2 p-0 list-none">
                <li v-for="work in details[creator.id].unresolved" :key="work.relativePath" class="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
                  {{ work.folderName }} · {{ work.status === 'ambiguous' ? '存在多个可能匹配' : '未找到匹配作品' }}
                </li>
              </ul>
            </section>
          </div>
        </div>
      </article>
    </div>

    <div v-else-if="!error" class="rounded-2xl border border-dashed border-border py-16 text-center text-muted">
      没有符合当前条件的博主。
    </div>

    <footer v-if="total > limit" class="mt-5 flex items-center justify-center gap-3">
      <button type="button" class="h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold disabled:opacity-40" :disabled="page <= 1" @click="goToPage(page - 1)">上一页</button>
      <span class="text-sm text-muted">第 {{ page }} / {{ totalPages }} 页</span>
      <button type="button" class="h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold disabled:opacity-40" :disabled="!hasMore" @click="goToPage(page + 1)">下一页</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, ref } from 'vue';

import {
  fetchArchiveBridgeStatus,
  fetchArchiveCatalog,
  fetchArchiveCatalogCreator,
  fetchArchiveDownloadTasks,
  planArchiveDownloadTasks,
  rotateArchiveBridgeToken
} from '../api/gallery';
import type {
  ArchiveCatalogCreator,
  ArchiveCatalogCreatorDetail,
  ArchiveCatalogPreference,
  ArchiveCatalogState,
  ArchiveCatalogSummary,
  ArchiveDownloadTaskStatus,
  ArchiveDownloadTasksPayload,
  ContentRating
} from '../types/api';

const CatalogMetric = defineComponent({
  props: {
    label: { type: String, required: true },
    value: { type: Number, required: true },
    alert: { type: Boolean, default: false }
  },
  setup(props) {
    return () => h('div', { class: 'min-w-[4.5rem]' }, [
      h('small', { class: 'block text-[0.68rem] font-semibold text-muted' }, props.label),
      h('strong', { class: props.alert ? 'mt-0.5 block text-base text-amber-600' : 'mt-0.5 block text-base text-text' }, String(props.value))
    ]);
  }
});

const limit = 50;
const items = ref<ArchiveCatalogCreator[]>([]);
const summary = ref<ArchiveCatalogSummary | null>(null);
const total = ref(0);
const page = ref(1);
const hasMore = ref(false);
const loading = ref(false);
const error = ref('');
const query = ref('');
const preference = ref<'' | ArchiveCatalogPreference>('');
const rating = ref<'' | ContentRating>('');
const state = ref<'' | ArchiveCatalogState>('');
const expandedCreatorId = ref<number | null>(null);
const detailLoadingId = ref<number | null>(null);
const details = ref<Record<number, ArchiveCatalogCreatorDetail>>({});
const detailErrors = ref<Record<number, string>>({});
const inboxRoot = ref('G:\\cos待入库');
const downloadTasks = ref<ArchiveDownloadTasksPayload | null>(null);
const planningDownloads = ref(false);
const downloadNotice = ref('');
const bridgeConfigured = ref(false);
const bridgeToken = ref('');
const rotatingBridgeToken = ref(false);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)));
const summaryCards = computed(() => summary.value ? [
  { label: '首批博主', value: summary.value.creators, note: `喜欢 ${summary.value.liked} · 保留 ${summary.value.kept}` },
  { label: '内容分级', value: summary.value.r18, note: `R18 ${summary.value.r18} · R15 ${summary.value.r15}` },
  { label: '已接入来源', value: summary.value.creatorsWithSources, note: `${summary.value.sourceCollections} 个资源合集` },
  { label: '平台作品', value: summary.value.remoteWorks, note: '当前资源平台已记录' },
  { label: '本地作品', value: summary.value.localWorks, note: `${summary.value.matchedWorks} 套已关联` },
  { label: '待收录作品', value: summary.value.missingWorks, note: `${summary.value.unresolvedLocalWorks} 套待核查` }
] : []);

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function preferenceClass(value: ArchiveCatalogPreference | null) {
  if (value === 'liked') return 'bg-red-100 text-red-700';
  if (value === 'kept') return 'bg-amber-100 text-amber-800';
  return 'bg-surface-alt text-muted';
}

function ratingClass(value: ContentRating | null) {
  if (value === 'R18') return 'bg-[#b72d45]';
  if (value === 'R15') return 'bg-[#55718f]';
  return 'bg-[#6b7280]';
}

function statusLabel(creator: ArchiveCatalogCreator) {
  if (creator.unresolvedLocalWorks > 0) return '待核查';
  if (creator.remoteWorks === 0) return '尚未接入资源';
  if (creator.localWorks === 0) return '尚未入库';
  if (creator.missingWorks > 0) return `有 ${creator.missingWorks} 套待收录`;
  return '已完整关联';
}

function deliveryLabel(delivery: ArchiveCatalogCreatorDetail['collections'][number]['deliveries'][number]) {
  const provider = delivery.provider === 'baidu' ? '百度网盘' : delivery.provider;
  return delivery.status ? `${provider}：${delivery.status}` : provider;
}

function downloadStatusLabel(status: ArchiveDownloadTaskStatus) {
  return ({
    pending: '待下载',
    claimed: '已领取',
    staged: '网盘待下载',
    downloading: '下载中',
    downloaded: '已下载',
    ingested: '已入库',
    failed: '失败',
    cancelled: '已取消'
  } as const)[status];
}

async function loadDownloadTasks() {
  downloadTasks.value = await fetchArchiveDownloadTasks({ limit: 100 });
}

async function planDownloads(creatorId?: number) {
  planningDownloads.value = true;
  downloadNotice.value = '';
  try {
    const result = await planArchiveDownloadTasks(inboxRoot.value, creatorId ? [creatorId] : undefined);
    const cleanupNotice = result.removedOutOfScope > 0 ? `已移除 ${result.removedOutOfScope} 条非本地博主任务；` : '';
    const reconcileNotice = result.reconciledLocal > 0 ? `已将 ${result.reconciledLocal} 条本地已有任务标记为已入库；` : '';
    downloadNotice.value = `${cleanupNotice}${reconcileNotice}已新增 ${result.created} 条任务，已有 ${result.existing} 条；${result.skippedWithoutDelivery} 条因尚无可用百度转存记录而跳过。目标根目录：${result.targetRoot}`;
    await loadDownloadTasks();
  } catch (reason) {
    downloadNotice.value = reason instanceof Error ? reason.message : '无法生成下载任务';
  } finally {
    planningDownloads.value = false;
  }
}

async function rotateBridgeToken() {
  rotatingBridgeToken.value = true;
  downloadNotice.value = '';
  try {
    const result = await rotateArchiveBridgeToken();
    bridgeToken.value = result.token;
    bridgeConfigured.value = true;
    downloadNotice.value = '新密钥已生成；旧密钥立即失效。';
  } catch (reason) {
    downloadNotice.value = reason instanceof Error ? reason.message : '无法生成插件连接密钥';
  } finally {
    rotatingBridgeToken.value = false;
  }
}

async function copyBridgeToken() {
  await navigator.clipboard.writeText(bridgeToken.value);
  downloadNotice.value = '插件连接密钥已复制。';
}

async function loadCatalog() {
  loading.value = true;
  error.value = '';
  expandedCreatorId.value = null;
  try {
    const payload = await fetchArchiveCatalog({
      page: page.value,
      limit,
      preference: preference.value || undefined,
      rating: rating.value || undefined,
      state: state.value || undefined,
      query: query.value
    });
    items.value = payload.items;
    summary.value = payload.summary;
    total.value = payload.total;
    hasMore.value = payload.hasMore;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法读取图库账本';
  } finally {
    loading.value = false;
  }
}

async function applyFilters() {
  page.value = 1;
  await loadCatalog();
}

async function resetFilters() {
  query.value = '';
  preference.value = '';
  rating.value = '';
  state.value = '';
  page.value = 1;
  await loadCatalog();
}

async function goToPage(nextPage: number) {
  page.value = nextPage;
  await loadCatalog();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function toggleCreator(creatorId: number) {
  if (expandedCreatorId.value === creatorId) {
    expandedCreatorId.value = null;
    return;
  }
  expandedCreatorId.value = creatorId;
  if (details.value[creatorId]) return;
  detailLoadingId.value = creatorId;
  delete detailErrors.value[creatorId];
  try {
    const detail = await fetchArchiveCatalogCreator(creatorId);
    details.value = { ...details.value, [creatorId]: detail };
  } catch (reason) {
    detailErrors.value = {
      ...detailErrors.value,
      [creatorId]: reason instanceof Error ? reason.message : '无法读取博主账本详情'
    };
  } finally {
    detailLoadingId.value = null;
  }
}

onMounted(async () => {
  await Promise.all([
    loadCatalog(),
    loadDownloadTasks().catch(() => undefined),
    fetchArchiveBridgeStatus().then((result) => { bridgeConfigured.value = result.configured; }).catch(() => undefined)
  ]);
});
</script>

<style scoped>
.catalog-row {
  grid-template-columns: minmax(13rem, 2fr) repeat(4, minmax(4.6rem, 0.55fr)) auto;
}

@media (max-width: 900px) {
  .catalog-row {
    grid-template-columns: repeat(4, minmax(4rem, 1fr));
  }

  .catalog-row > :first-child {
    grid-column: 1 / -1;
  }

  .catalog-row > :last-child {
    grid-column: 1 / -1;
    width: 100%;
  }
}
</style>
