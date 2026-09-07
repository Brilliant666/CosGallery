<template>
  <section class="mx-auto w-full max-w-[69rem] px-2 pb-12 sm:px-5">
    <RouterLink class="mb-5 inline-flex font-semibold text-text no-underline hover:text-accent" :to="libraryReturn">
      返回我的图库
    </RouterLink>
    <div v-if="loading" class="card p-8 text-center text-muted">正在加载博主图册…</div>
    <div v-else-if="error" class="card p-8 text-center" role="alert">
      <h1 class="text-xl">无法加载博主图册</h1>
      <p class="text-muted">{{ error }}</p>
      <button type="button" class="btn" @click="load">重试</button>
    </div>
    <template v-else-if="creator">
      <header class="mb-5 border-b border-border pb-5">
        <p class="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted">规范博主 #{{ creator.id }}</p>
        <h1 class="my-2 text-2xl font-semibold">{{ creator.name }}</h1>
        <p class="m-0 text-sm text-muted">{{ total }} 套作品 · {{ creator.folderIds.length }} 个本地目录</p>
      </header>
      <FolderGrid
        v-if="items.length"
        :items="items"
        variant="posts"
        navigation-mode="canonical-work-gallery"
        :canonical-creator-id="creator.id"
        show-work-labels
      />
      <div v-else class="card p-8 text-center text-muted">该博主当前没有可浏览作品。</div>
      <nav v-if="totalPages > 1" class="mt-6 flex items-center justify-center gap-4" aria-label="博主图册分页">
        <button type="button" class="btn" :disabled="page <= 1 || loading" @click="setPage(page - 1)">上一页</button>
        <span class="text-sm text-muted">第 {{ page }} / {{ totalPages }} 页</span>
        <button type="button" class="btn" :disabled="page >= totalPages || loading" @click="setPage(page + 1)">下一页</button>
      </nav>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { fetchCanonicalCreatorWorks } from '../api/gallery';
import FolderGrid from '../components/FolderGrid.vue';
import type { CosGalleryCreator, FeedItem } from '../types/api';
import { parsePositiveId } from '../utils/work-gallery';

const props = defineProps<{ creatorId: string }>();
const route = useRoute();
const router = useRouter();
const creator = shallowRef<CosGalleryCreator | null>(null);
const items = ref<FeedItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const limit = 24;
let loadToken = 0;

const creatorIdParam = computed(() => props.creatorId);
const page = computed(() => {
  const raw = Array.isArray(route.query.page) ? route.query.page[0] : route.query.page;
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : 1;
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
});
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)));
const libraryReturn = computed(() => {
  const value = Array.isArray(route.query.returnTo) ? route.query.returnTo[0] : route.query.returnTo;
  return typeof value === 'string' && /^\/library(?:\?|$)/u.test(value) && !value.includes('\\')
    ? value
    : { name: 'library' };
});

async function load() {
  const id = parsePositiveId(props.creatorId);
  const token = ++loadToken;
  error.value = null;
  if (id === null) {
    error.value = '博主 ID 无效';
    return;
  }
  loading.value = true;
  try {
    const payload = await fetchCanonicalCreatorWorks(id, page.value, limit);
    if (token !== loadToken) return;
    creator.value = payload.creator;
    items.value = payload.items;
    total.value = payload.total;
  } catch (cause) {
    if (token === loadToken) error.value = cause instanceof Error ? cause.message : '无法加载博主图册';
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

async function setPage(value: number) {
  await router.push({
    name: 'canonical-creator',
    params: { creatorId: props.creatorId },
    query: { ...route.query, page: value > 1 ? String(value) : undefined }
  });
}

watch([creatorIdParam, page], load, { immediate: true });
</script>
