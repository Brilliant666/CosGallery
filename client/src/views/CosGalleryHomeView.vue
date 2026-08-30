<template>
  <section class="mx-auto w-full max-w-[92rem] px-2 pb-12 sm:px-5 lg:px-8">
    <header class="mb-7 grid gap-5">
      <div>
        <p class="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted">CosGallery</p>
        <h1 class="m-0 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">我的图库</h1>
      </div>

      <form class="flex gap-2" @submit.prevent="loadCreators">
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

      <div class="flex flex-wrap items-center gap-2" aria-label="博主内容分级筛选">
        <button
          v-for="option in ratingOptions"
          :key="option.value"
          type="button"
          class="rounded-full border px-4 py-2 text-sm font-semibold transition"
          :class="rating === option.value ? 'border-accent bg-accent text-white' : 'border-border bg-surface text-text hover:border-accent'"
          @click="setRating(option.value)"
        >
          {{ option.label }}
        </button>
        <span class="ml-auto text-sm text-muted">{{ total }} 位博主</span>
      </div>
    </header>

    <p v-if="error" class="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-red-700">{{ error }}</p>

    <div
      v-if="creators.length"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
      aria-label="博主目录"
    >
      <RouterLink
        v-for="creator in creators"
        :key="creator.id"
        :to="{ name: 'folder', params: { slug: creator.slug } }"
        class="group min-w-0 overflow-hidden rounded-2xl border border-border bg-surface text-text no-underline shadow-sm transition hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-lg"
      >
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
            class="absolute left-2 top-2 rounded-full px-2.5 py-1 text-xs font-bold text-white shadow-sm"
            :class="ratingBadgeClass(creator.contentRating)"
          >
            {{ creator.contentRating ?? '待分类' }}
          </span>
          <span class="absolute right-2 top-2 rounded-full bg-black/65 px-2.5 py-1 text-xs font-semibold text-white shadow-sm">
            {{ creator.workCount }} 套
          </span>
        </div>
        <div class="p-3.5">
          <h2 class="m-0 truncate text-[0.95rem] font-semibold">{{ creator.name }}</h2>
          <p v-if="creator.ratingConflict" class="mt-1 mb-0 text-xs font-medium text-amber-600">来源分类存在差异</p>
          <p v-else class="mt-1 mb-0 text-xs text-muted">点击查看全部图册</p>
        </div>
      </RouterLink>
    </div>

    <div v-else-if="loading" class="py-20 text-center text-muted">正在加载博主目录…</div>
    <div v-else class="rounded-2xl border border-dashed border-border py-16 text-center text-muted">
      没有符合当前条件的博主。
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { fetchCosGalleryCreators } from '../api/gallery';
import type { ContentRating, CosGalleryCreator } from '../types/api';

type RatingFilter = 'all' | ContentRating | 'unclassified';

const creators = ref<CosGalleryCreator[]>([]);
const query = ref('');
const rating = ref<RatingFilter>('all');
const total = ref(0);
const loading = ref(false);
const error = ref('');

const ratingOptions: Array<{ value: RatingFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'R15', label: 'R15' },
  { value: 'R18', label: 'R18' },
  { value: 'unclassified', label: '待分类' }
];

function creatorInitial(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';
}

function ratingBadgeClass(value: ContentRating | null) {
  if (value === 'R18') return 'bg-[#b72d45]';
  if (value === 'R15') return 'bg-[#55718f]';
  return 'bg-[#6b7280]';
}

async function loadCreators() {
  loading.value = true;
  error.value = '';
  try {
    const payload = await fetchCosGalleryCreators(rating.value === 'all' ? undefined : rating.value, query.value);
    creators.value = payload.items;
    total.value = payload.total;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法读取博主目录';
  } finally {
    loading.value = false;
  }
}

async function setRating(value: RatingFilter) {
  if (rating.value === value) return;
  rating.value = value;
  await loadCreators();
}

onMounted(loadCreators);
</script>
