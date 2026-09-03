<template>
  <section class="work-gallery" :aria-busy="loading">
    <RouterLink class="work-gallery__back" :to="{ name: 'folder', params: { slug } }">
      {{ t('workGallery.backToCreator', { name: creatorName }) }}
    </RouterLink>
    <div v-if="appStore.isLibraryUnavailable" class="card work-gallery__state" role="alert">
      <h1>{{ t('workGallery.storageUnavailable') }}</h1>
      <p>{{ appStore.libraryUnavailableReason }}</p>
    </div>
    <div v-else-if="loading" class="card work-gallery__state" role="status">{{ t('workGallery.loading') }}</div>
    <div v-else-if="error" class="card work-gallery__state" role="alert">
      <h1>{{ t('workGallery.loadFailed') }}</h1>
      <p>{{ error }}</p>
      <button type="button" class="btn" @click="loadWork">{{ t('workGallery.retry') }}</button>
    </div>
    <template v-else-if="work">
      <header class="work-gallery__header">
        <p class="work-gallery__creator">{{ creatorName }}</p>
        <h1>{{ workTitle(work) }}</h1>
        <p class="work-gallery__counts">{{ t('workGallery.counts', { images: imageCount, videos: videoCount, total: mediaItems.length }) }}</p>
      </header>
      <div v-if="mediaItems.length === 0" class="card work-gallery__state" role="alert">
        {{ t('workGallery.empty') }}
      </div>
      <div v-else class="work-gallery__grid" :aria-label="t('workGallery.mediaList')">
        <WorkMediaCard
          v-for="(item, index) in mediaItems"
          :key="item.imageId"
          :item="item"
          :ordinal="index + 1"
          :post-id="work.id"
          :background-path="backgroundPath"
        />
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRouter } from 'vue-router';

import { fetchImage } from '../api/gallery';
import WorkMediaCard from '../components/WorkMediaCard.vue';
import { useAppStore } from '../stores/app';
import { useFoldersStore } from '../stores/folders';
import type { ImageDetail } from '../types/api';
import { orderedMediaItems, parsePositiveId, workGalleryRoute, workTitle } from '../utils/work-gallery';

const props = defineProps<{ slug: string; postId: string }>();
const { t } = useI18n();
const router = useRouter();
const appStore = useAppStore();
const foldersStore = useFoldersStore();
// Independent page state keeps the background DOM and thumbnails alive while PostView uses the viewer store.
const work = shallowRef<ImageDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let loadToken = 0;
const mediaItems = computed(() => orderedMediaItems(work.value?.mediaItems));
const imageCount = computed(() => mediaItems.value.filter((item) => item.mediaType === 'image').length);
const videoCount = computed(() => mediaItems.value.length - imageCount.value);
const creatorName = computed(() => work.value?.folderName || foldersStore.items.find((folder) => folder.slug === props.slug)?.name || props.slug);
const backgroundPath = computed(() => router.resolve(workGalleryRoute(props.slug, Number(props.postId))).fullPath);

async function loadWork() {
  const token = ++loadToken;
  work.value = null;
  error.value = null;
  const postId = parsePositiveId(props.postId);
  if (postId === null) {
    error.value = t('workGallery.notFound');
    loading.value = false;
    return;
  }
  if (appStore.isLibraryUnavailable) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const detail = await fetchImage(postId);
    if (token !== loadToken) return;
    // Fixed not-found behavior: never render another creator's work under a mismatched slug.
    if (detail.id !== postId || detail.folderSlug !== props.slug) {
      error.value = t('workGallery.notFound');
      return;
    }
    work.value = detail;
  } catch (cause) {
    if (token === loadToken) error.value = cause instanceof Error ? cause.message : t('workGallery.loadFailed');
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => [props.slug, props.postId] as const, loadWork, { immediate: true });
onBeforeUnmount(() => { loadToken += 1; });
</script>

<style scoped>
.work-gallery { width: min(100%, 90rem); margin: 0 auto; padding: 0 0.5rem 2rem; min-width: 0; }
.work-gallery__back { display: inline-flex; margin-bottom: 1.15rem; color: var(--text); font-weight: 600; text-decoration: none; }
.work-gallery__back:hover { color: var(--accent); }
.work-gallery__header { margin-bottom: 1.25rem; overflow-wrap: anywhere; }
.work-gallery__header h1 { margin: 0.4rem 0 0.7rem; font-size: clamp(1.15rem, 2vw, 1.75rem); line-height: 1.4; }
.work-gallery__creator, .work-gallery__counts { margin: 0; color: var(--muted); font-size: 0.9rem; }
.work-gallery__state { padding: 2rem; text-align: center; overflow-wrap: anywhere; }
.work-gallery__state h1 { font-size: 1.2rem; }
.work-gallery__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; }
@media (min-width: 640px) { .work-gallery__grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 1024px) { .work-gallery__grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (min-width: 1280px) { .work-gallery__grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@media (min-width: 1600px) { .work-gallery__grid { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
</style>
