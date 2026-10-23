<template>
  <section class="creator-gallery mx-auto w-full max-w-[92rem] px-2 pb-12 sm:px-5 lg:px-8">
    <header class="mb-7 grid gap-5">
      <div>
        <p class="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted">CosGallery</p>
        <h1 class="m-0 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">{{ activeLabelTitle ? `${activeLabelTitle}图库` : '全部图库' }}</h1>
      </div>

      <form class="flex gap-2" @submit.prevent="applyFilters">
        <label class="relative min-w-0 flex-1">
          <span class="sr-only">搜索博主</span>
          <input
            v-model="query"
            type="search"
            placeholder="搜索博主"
            class="h-12 w-full rounded-full border border-border bg-surface px-5 text-base outline-none transition focus:border-accent"
          />
        </label>
        <button type="submit" class="h-12 rounded-full bg-accent px-6 font-semibold text-white">搜索</button>
      </form>

      <div class="flex flex-wrap items-center gap-3" aria-label="博主筛选">
        <!-- Keep filter wrapping stable without rendering grading controls on category pages. -->
        <div class="min-h-[2.625rem] w-64 max-w-full" :aria-hidden="label ? true : undefined">
          <div v-if="!label" role="group" aria-label="分级" class="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] items-center gap-2 text-sm font-semibold">
            <span aria-hidden="true" class="mr-1 text-muted">分级</span>
            <button v-for="option in ratingOptions" :key="option.value" type="button" :value="option.value" :aria-pressed="rating === option.value"
              class="rounded-full border px-3 py-2.5 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              :class="rating === option.value ? 'border-accent bg-accent text-white' : 'border-border bg-surface text-text hover:border-accent/60'"
              @click="setRating(option.value)">{{ option.label }}</button>
          </div>
        </div>
        <div v-if="auth.isAdmin" role="group" aria-label="偏好" class="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <span aria-hidden="true" class="mr-1 text-muted">偏好</span>
          <button v-for="option in preferenceOptions" :key="option.value" type="button" :value="option.value" :aria-pressed="preference === option.value"
            class="rounded-full border px-4 py-2.5 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            :class="preference === option.value ? 'border-accent bg-accent text-white' : 'border-border bg-surface text-text hover:border-accent/60'"
            @click="setPreference(option.value)">{{ option.label }}</button>
        </div>
        <span class="ml-auto text-sm text-muted">{{ total }} 位博主 · 每页 {{ PAGE_SIZE }} 位</span>
      </div>
      <p v-if="legacyRatingLabel" role="status" class="m-0 rounded-xl border border-amber-300 px-4 py-3 text-sm text-amber-700">当前沿用旧链接的“{{ legacyRatingLabel }}”筛选，范围未改变。日常入口已收起；选择分级“全部”可退出此筛选，身份管理请前往博主库。</p>
    </header>

    <p v-if="error" class="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-red-700">{{ error }}</p>

    <div
      v-if="creators.length"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
      aria-label="博主目录"
    >
      <article
        v-for="creator in creators"
        :key="creator.key"
        class="group min-w-0 overflow-hidden rounded-2xl border border-border bg-surface text-text no-underline shadow-sm transition hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-lg"
      >
        <RouterLink :to="creatorRoute(creator)" class="block text-inherit no-underline">
        <div class="relative aspect-[4/5] overflow-hidden bg-surface-alt">
          <img
            v-if="creator.coverUrl"
            :src="creator.coverUrl"
            :alt="`${creator.name}封面`"
            loading="lazy"
            class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]"
          />
          <div v-else class="grid h-full place-items-center bg-gradient-to-br from-[#b8a8cc] to-[#a8c4ca] text-4xl font-semibold text-white">
            {{ creatorInitial(creator.name) }}
          </div>
          <span
            v-if="!label"
            data-test="creator-rating"
            class="absolute left-2 top-2 rounded-full px-2.5 py-1 text-xs font-bold text-white shadow-sm"
            :class="ratingBadgeClass(creator.contentRating)"
          >
            {{ creator.linkStatus === 'unlinked' ? '未关联' : creator.contentRating ?? '待分类' }}
          </span>
          <span class="absolute right-2 top-2 rounded-full bg-black/65 px-2.5 py-1 text-xs font-semibold text-white shadow-sm">
            {{ creator.workCount }} 套
          </span>
        </div>
        <div class="p-3.5">
          <h2 class="m-0 truncate text-[0.95rem] font-semibold">{{ creator.name }}</h2>
          <p v-if="creator.rosterStatus === 'inactive'" class="mt-1 mb-0 text-xs font-medium text-amber-600">已停用 · 本地图册仍可浏览</p>
          <p v-else-if="creator.linkStatus === 'unlinked'" class="mt-1 mb-0 text-xs text-muted">请在博主库关联目录</p>
          <p v-else class="mt-1 mb-0 text-xs text-muted">点击查看全部图册</p>
          <div v-if="creator.galleryLabels?.length" class="mt-2 flex flex-wrap gap-1">
            <span v-for="item in creator.galleryLabels" :key="item" class="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{{ galleryLabelTitle(item) }}</span>
          </div>
        </div>
        </RouterLink>
        <div v-if="auth.isAdmin && creator.identityType === 'creator'" class="px-3.5 pb-3.5">
          <button type="button" class="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold hover:border-accent" :aria-label="`编辑 ${creator.name} 的分类`" data-test="edit-gallery-labels" @click="editingCreator = creator">编辑分类</button>
        </div>
      </article>
    </div>

    <div v-else-if="loading" class="py-20 text-center text-muted">正在加载博主目录…</div>
    <div v-else class="rounded-2xl border border-dashed border-border py-16 text-center text-muted">
      没有符合当前条件的博主。
    </div>
    <nav v-if="totalPages > 1" class="mt-7 flex items-center justify-center gap-4" aria-label="博主分页">
      <button type="button" class="rounded-full border border-border bg-surface px-5 py-2 text-sm font-semibold" :disabled="page <= 1 || loading" @click="setPage(page - 1)">上一页</button>
      <span class="text-sm text-muted">第 {{ page }} / {{ totalPages }} 页</span>
      <button type="button" class="rounded-full border border-border bg-surface px-5 py-2 text-sm font-semibold" :disabled="page >= totalPages || loading" @click="setPage(page + 1)">下一页</button>
    </nav>
    <CreatorGalleryLabelsDialog v-if="editingCreator && auth.isAdmin" :creator="editingCreator" @close="editingCreator = null" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';

import { fetchCosGalleryCreators } from '../api/gallery';
import CreatorGalleryLabelsDialog from '../components/CreatorGalleryLabelsDialog.vue';
import { useAuthStore } from '../stores/auth';
import { creatorGalleryLabelOptions, parseCreatorGalleryLabel, sanitizedGalleryQuery } from '../utils/creator-gallery-labels';
import type { ContentRating, CosGalleryCreator } from '../types/api';
import { canonicalCreatorRoute } from '../utils/work-gallery';
import { useCreatorReadingStore } from '../stores/creator-reading';

type RatingFilter = 'all' | ContentRating | 'unclassified' | 'unlinked' | 'inactive';
type PreferenceFilter = 'all' | 'liked' | 'kept';
const PAGE_SIZE = 60;
const ratingOptions = [{ value: 'all', label: '全部' }, { value: 'R15', label: 'R15' }, { value: 'R18', label: 'R18' }] as const;
const preferenceOptions = [{ value: 'all', label: '全部' }, { value: 'liked', label: '喜欢' }, { value: 'kept', label: '保留' }] as const;
const legacyLabels = { unclassified: '待分类', unlinked: '未关联', inactive: '已停用' };
const validRatings = ['R15', 'R18', ...Object.keys(legacyLabels)];

const creators = ref<CosGalleryCreator[]>([]);
const route = useRoute();
const router = useRouter();
const reading = useCreatorReadingStore();
const auth = useAuthStore();
const editingCreator = ref<CosGalleryCreator | null>(null);
const label = computed(() => parseCreatorGalleryLabel(route.query.label));
const activeLabelTitle = computed(() => galleryLabelTitle(label.value));
let requestToken = 0;
let generation = reading.generation;
let navigationIntent: 'filter' | 'page' | null = null;
const initialRating = Array.isArray(route.query.rating) ? route.query.rating[0] : route.query.rating;
const initialQuery = Array.isArray(route.query.q) ? route.query.q[0] : route.query.q;
const initialPage = Array.isArray(route.query.page) ? route.query.page[0] : route.query.page;
const query = ref(typeof initialQuery === 'string' ? initialQuery : '');
const rating = ref<RatingFilter>(['R15','R18','unclassified','unlinked','inactive'].includes(initialRating ?? '') ? initialRating as RatingFilter : 'all');
const preference = ref<PreferenceFilter>('all');
const page = ref(typeof initialPage === 'string' && /^\d+$/.test(initialPage) && Number(initialPage) > 0 ? Number(initialPage) : 1);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const legacyRatingLabel = computed(() => label.value ? '' : legacyLabels[rating.value as keyof typeof legacyLabels] ?? '');
function cacheKey(path = route.fullPath) { return `library:${PAGE_SIZE}:${path}`; }
function galleryLabelTitle(value: unknown) { return creatorGalleryLabelOptions.find(option => option.value === value)?.label ?? ''; }

function creatorInitial(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';
}

function ratingBadgeClass(value: ContentRating | null) {
  if (value === 'R18') return 'bg-[#b72d45]';
  if (value === 'R15') return 'bg-[#55718f]';
  return 'bg-[#6b7280]';
}

async function correctOutOfRangePage(resultTotal: number) {
  const lastPage = Math.max(1, Math.ceil(resultTotal / PAGE_SIZE));
  if (page.value <= lastPage) return false;
  // Old fifty-per-page links and a shrinking result set can point beyond the end.
  // Do not publish/cache their empty response or add an unusable history entry.
  delete reading.libraryPages[cacheKey()];
  navigationIntent = 'page';
  const nextQuery = { ...route.query };
  if (lastPage > 1) nextQuery.page = String(lastPage);
  else delete nextQuery.page;
  await router.replace({
    name: 'library',
    query: nextQuery
  });
  return true;
}

async function loadCreators(scroll: 'restore' | 'top' | 'preserve') {
  const token = ++requestToken;
  generation = reading.generation;
  const requestGeneration = generation;
  const admin = auth.isAdmin;
  const isCurrent = () => token === requestToken && requestGeneration === reading.generation && admin === auth.isAdmin;
  loading.value = true;
  error.value = '';
  const cached = reading.libraryPages[cacheKey()];
  if (cached) {
    if (await correctOutOfRangePage(cached.total)) return;
    if (!isCurrent()) return;
    creators.value = cached.items;
    total.value = cached.total;
    loading.value = false;
    await nextTick();
    requestAnimationFrame(() => { if (token === requestToken && scroll !== 'preserve') window.scrollTo({ top: scroll === 'restore' ? cached.scrollY : 0 }); });
    return;
  }
  try {
    const payload = await fetchCosGalleryCreators(label.value || rating.value === 'all' ? undefined : rating.value, query.value, page.value, PAGE_SIZE, !admin || preference.value === 'all' ? undefined : preference.value, label.value);
    if (!isCurrent()) return;
    if (await correctOutOfRangePage(payload.total)) return;
    if (!isCurrent()) return;
    creators.value = payload.items;
    total.value = payload.total;
    await nextTick();
    if (token === requestToken && scroll === 'top') window.scrollTo({ top: 0 });
  } catch (reason) {
    if (!isCurrent()) return;
    error.value = reason instanceof Error ? reason.message : '无法读取博主目录';
  } finally {
    if (token === requestToken) loading.value = false;
  }
}

async function syncLocation(intent: 'filter' | 'page') {
  const location = {
    name: 'library',
    query: {
      ...(query.value.trim() ? { q: query.value.trim() } : {}),
      ...(label.value ? { label: label.value } : rating.value !== 'all' ? { rating: rating.value } : {}),
      ...(auth.isAdmin && preference.value !== 'all' ? { preference: preference.value } : {}),
      ...(page.value > 1 ? { page: String(page.value) } : {})
    }
  };
  const active = { q: typeof route.query.q === 'string' ? route.query.q : '', rating: route.query.rating ?? 'all', preference: route.query.preference ?? 'all', page: String(route.query.page ?? '1') };
  if (active.q === query.value.trim() && active.rating === rating.value && active.preference === preference.value && active.page === String(page.value)) return;
  navigationIntent = intent;
  await router.push(location);
}

async function applyFilters() {
  page.value = 1;
  await syncLocation('filter');
}

async function setRating(value: RatingFilter) {
  if (label.value) return;
  if (rating.value === value) return;
  rating.value = value;
  page.value = 1;
  await syncLocation('filter');
}

async function setPreference(value: PreferenceFilter) {
  if (!auth.isAdmin) return;
  if (preference.value === value) return;
  preference.value = value;
  page.value = 1;
  await syncLocation('filter');
}

async function setPage(value: number) {
  page.value = value;
  await syncLocation('page');
}

function creatorRoute(creator: CosGalleryCreator) {
  return creator.identityType === 'creator'
    ? canonicalCreatorRoute(creator.id, route.fullPath)
    : { name: 'folder', params: { slug: creator.slug } };
}

function saveReadingPosition() {
  if (!loading.value && !error.value && generation === reading.generation) {
    reading.libraryPages[cacheKey()] = { items: [...creators.value], total: total.value, scrollY: window.scrollY };
    const keys = Object.keys(reading.libraryPages);
    if (keys.length > 10) delete reading.libraryPages[keys[0]!];
  }
}
onBeforeRouteLeave(saveReadingPosition);
onBeforeRouteUpdate(saveReadingPosition);
watch(() => [route.fullPath, reading.generation, reading.libraryResetVersion, auth.isAdmin] as const, (_current, previous) => {
  if (route.name !== 'library') return;
  if (previous && previous[3] !== auth.isAdmin) { creators.value = []; total.value = 0; editingCreator.value = null; error.value = ''; }
  const cleanQuery = sanitizedGalleryQuery(route.query, auth.isAdmin);
  if (JSON.stringify(cleanQuery) !== JSON.stringify(route.query)) {
    requestToken += 1;
    void router.replace({ name: 'library', query: cleanQuery });
    return;
  }
  query.value = typeof route.query.q === 'string' ? route.query.q : '';
  rating.value = !label.value && typeof route.query.rating === 'string' && validRatings.includes(route.query.rating) ? route.query.rating as RatingFilter : 'all';
  preference.value = auth.isAdmin && (route.query.preference === 'liked' || route.query.preference === 'kept') ? route.query.preference : 'all';
  page.value = typeof route.query.page === 'string' && /^\d+$/.test(route.query.page) && Number(route.query.page) > 0 ? Number(route.query.page) : 1;
  const scroll = navigationIntent || reading.libraryNavigationIntent === 'reset' ? 'top' : previous && previous[1] !== reading.generation ? 'preserve' : 'restore';
  reading.libraryNavigationIntent = null;
  navigationIntent = null;
  void loadCreators(scroll);
}, { immediate: true });
onBeforeUnmount(() => { requestToken += 1; });
</script>

<style scoped>
:global(html:has(.creator-gallery)) {
  scrollbar-gutter: stable;
}
</style>
