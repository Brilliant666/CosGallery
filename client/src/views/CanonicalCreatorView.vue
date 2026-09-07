<template>
  <section class="w-full" :aria-busy="loading">
    <div class="mx-auto grid w-full max-w-[69rem] gap-[0.15rem]">
      <RouterLink class="mb-5 inline-flex font-semibold text-text no-underline hover:text-accent" :to="libraryReturn">返回我的图库</RouterLink>
      <div v-if="appStore.isLibraryUnavailable" class="card p-8 text-center text-muted">{{ appStore.libraryUnavailableReason }}</div>
      <div v-else-if="loading && !creator" class="card p-8 text-center text-muted">正在加载博主图册…</div>
      <template v-else-if="creator">
        <header class="mx-auto grid w-[min(100%,54rem)] grid-cols-[10.75rem_minmax(0,1fr)] items-start gap-x-[2.65rem] pb-[2.4rem] pt-[0.6rem] max-md:grid-cols-[9rem_minmax(0,1fr)] max-md:gap-x-8 max-sm:grid-cols-1 max-sm:gap-y-5 max-sm:text-center">
          <div class="grid place-items-center"><div class="rounded-full bg-surface-alt p-1"><Avatar class="h-[9.35rem] w-[9.35rem] max-md:h-[7.75rem] max-md:w-[7.75rem]" :name="creator.name" :src="creator.avatarUrl ?? creator.coverUrl" /></div></div>
          <div class="grid min-w-0 gap-4 pt-[0.35rem]">
            <div class="flex flex-wrap items-center gap-3 max-sm:justify-center">
              <h1 class="m-0 break-words text-[clamp(1.6rem,2.4vw,2rem)] font-medium leading-tight tracking-[-0.04em]">{{ creator.name }}</h1>
              <span class="text-sm text-muted">{{ creator.contentRating ?? '待分类' }}</span>
            </div>
            <div class="flex flex-wrap gap-6 text-[0.95rem] max-sm:justify-center">
              <span>{{ total }} 套作品</span>
              <span v-if="creator.imageCount !== undefined">{{ creator.imageCount }} 张图片</span>
              <span v-if="creator.videoCount !== undefined">{{ creator.videoCount }} 个视频</span>
              <span v-if="updatedDate">更新于 {{ updatedDate }}</span>
            </div>
            <p v-if="creator.description" class="m-0 whitespace-pre-wrap break-words text-[0.95rem]">{{ creator.description }}</p>
            <details v-if="creator.localFolders?.length && authStore.canManageLibrary" class="text-sm text-muted">
              <summary class="cursor-pointer">本地目录 · 编辑或分享指定目录</summary>
              <ul class="grid gap-2 pl-5 text-left"><li v-for="folder in creator.localFolders" :key="folder.id"><RouterLink :to="{ name: 'folder', params: { slug: folder.slug }, query: { physical: '1' } }">{{ folder.name }} · {{ folder.workCount }} 套</RouterLink></li></ul>
            </details>
          </div>
        </header>
        <section class="mx-auto w-[min(100%,66.5625rem)]">
          <div class="mb-px flex justify-center border-b border-border py-2" aria-label="全部图册"><span class="i-fluent-grid-24-regular h-7 w-7" aria-hidden="true" /></div>
          <FolderGrid v-if="items.length" :items="items" variant="posts" navigation-mode="canonical-work-gallery" :canonical-creator-id="creator.id" show-work-labels />
          <div v-else-if="!loading && !error" class="p-8 text-center text-muted">该博主当前没有可浏览作品。</div>
          <InfiniteLoader v-if="!error" :loading="loading" :has-more="hasMore" @load-more="loadMore" />
        </section>
      </template>
      <div v-if="error" class="p-8 text-center" role="alert"><h2>无法加载博主图册</h2><p class="text-muted">{{ error }}</p><button class="btn" type="button" @click="loadMore">重试</button></div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { fetchCanonicalCreatorWorks } from '../api/gallery';
import Avatar from '../components/Avatar.vue';
import FolderGrid from '../components/FolderGrid.vue';
import InfiniteLoader from '../components/InfiniteLoader.vue';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { useCreatorReadingStore } from '../stores/creator-reading';
import type { CosGalleryCreator, FeedItem } from '../types/api';
import { parsePositiveId, libraryReturnRoute } from '../utils/work-gallery';

const props = defineProps<{ creatorId: string }>();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const authStore = useAuthStore();
const reading = useCreatorReadingStore();
const creator = shallowRef<CosGalleryCreator | null>(null);
const items = ref<FeedItem[]>([]);
const total = ref(0);
const nextPage = ref(1);
const hasMore = ref(true);
const loading = ref(false);
const error = ref<string | null>(null);
let loadToken = 0;
let activeKey = '';
let generation = reading.generation;
const libraryReturn = computed(() => libraryReturnRoute(route.query));
const updatedDate = computed(() => {
  const timestamp = creator.value?.latestImageMtimeMs ?? creator.value?.latestWorkAt;
  return timestamp ? new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
});

function save() {
  if (creator.value && activeKey && generation === reading.generation) reading.save(activeKey, { creator: creator.value, items: [...items.value], total: total.value, nextPage: nextPage.value, hasMore: hasMore.value, scrollY: window.scrollY });
}

async function loadMore() {
  if (loading.value || !hasMore.value || appStore.isLibraryUnavailable) return;
  const id = parsePositiveId(props.creatorId);
  if (id === null) { error.value = '博主 ID 无效'; return; }
  const token = loadToken;
  const page = nextPage.value;
  error.value = null;
  loading.value = true;
  try {
    const payload = await fetchCanonicalCreatorWorks(id, page, 24);
    if (token !== loadToken) return;
    creator.value = payload.creator;
    const known = new Set(items.value.map(item => item.id));
    items.value.push(...payload.items.filter(item => !known.has(item.id)));
    total.value = payload.total;
    hasMore.value = payload.hasMore;
    nextPage.value = page + 1;
    if (page > 1 && route.name === 'canonical-creator') {
      await router.replace({ name: 'canonical-creator', params: { creatorId: String(id) }, query: { ...route.query, loaded: String(page), page: undefined } });
    }
  } catch (cause) {
    if (token === loadToken) error.value = cause instanceof Error ? cause.message : '无法加载博主图册';
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => [props.creatorId, reading.generation] as const, async ([id]) => {
  save();
  const token = ++loadToken;
  activeKey = id;
  generation = reading.generation;
  error.value = null;
  loading.value = false;
  const cached = reading.pages[id];
  creator.value = cached?.creator ?? null;
  items.value = cached ? [...cached.items] : [];
  total.value = cached?.total ?? 0;
  nextPage.value = cached?.nextPage ?? 1;
  hasMore.value = cached?.hasMore ?? true;
  if (cached) {
    await nextTick();
    requestAnimationFrame(() => { if (token === loadToken) window.scrollTo({ top: cached.scrollY }); });
  } else {
    const requested = parsePositiveId(route.query.loaded ?? route.query.page) ?? 1;
    do { await loadMore(); }
    while (token === loadToken && !error.value && !appStore.isLibraryUnavailable && hasMore.value && nextPage.value <= Math.min(requested, 1000));
  }
}, { immediate: true });
onBeforeRouteLeave(save);
onBeforeUnmount(() => { loadToken += 1; });
</script>
