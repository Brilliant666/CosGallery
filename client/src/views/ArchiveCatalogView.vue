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
                <span class="text-xs font-semibold" :class="details[creator.id].missing.length ? 'text-amber-600' : 'text-emerald-600'">
                  {{ details[creator.id].missing.length }} 套
                </span>
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

import { fetchArchiveCatalog, fetchArchiveCatalogCreator } from '../api/gallery';
import type {
  ArchiveCatalogCreator,
  ArchiveCatalogCreatorDetail,
  ArchiveCatalogPreference,
  ArchiveCatalogState,
  ArchiveCatalogSummary,
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

onMounted(loadCatalog);
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
