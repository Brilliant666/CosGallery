<template>
  <section class="work-gallery" :aria-busy="loading">
    <RouterLink class="work-gallery__back" :to="backRoute">
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
          :creator-id="canonicalId"
        />
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute } from 'vue-router';

import { fetchCanonicalCreator, fetchCanonicalCreatorWork, fetchImage } from '../api/gallery';
import WorkMediaCard from '../components/WorkMediaCard.vue';
import { useAppStore } from '../stores/app';
import { useFoldersStore } from '../stores/folders';
import type { ImageDetail } from '../types/api';
import { canonicalCreatorRoute, orderedMediaItems, parsePositiveId, workTitle } from '../utils/work-gallery';

const props = defineProps<{ slug?: string; creatorId?: string; postId: string }>();
const { t } = useI18n();
const route = useRoute();
const appStore = useAppStore();
const foldersStore = useFoldersStore();
// Independent page state keeps the background DOM and thumbnails alive while PostView uses the viewer store.
const work = shallowRef<ImageDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const canonicalCreatorName = ref<string | null>(null);
let loadToken = 0;
const mediaItems = computed(() => orderedMediaItems(work.value?.mediaItems));
const imageCount = computed(() => mediaItems.value.filter((item) => item.mediaType === 'image').length);
const videoCount = computed(() => mediaItems.value.length - imageCount.value);
const canonicalId = computed(() => props.creatorId ? parsePositiveId(props.creatorId) : null);
const creatorName = computed(() => canonicalCreatorName.value || work.value?.folderName || foldersStore.items.find((folder) => folder.slug === props.slug)?.name || props.slug || '');
const backgroundPath = computed(() => route.fullPath);
const backRoute = computed(() => {
  if (canonicalId.value !== null) {
    const candidate = Array.isArray(route.query.returnTo) ? route.query.returnTo[0] : route.query.returnTo;
    if (typeof candidate === 'string' && new RegExp(`^/creators/${canonicalId.value}(?:\\?|$)`, 'u').test(candidate) && !candidate.includes('\\')) {
      return candidate;
    }
    return canonicalCreatorRoute(canonicalId.value);
  }
  return { name: 'folder', params: { slug: props.slug ?? '' } };
});

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
    const canonicalCreatorId = canonicalId.value;
    const [detail, creatorPayload] = canonicalCreatorId === null
      ? [await fetchImage(postId), null]
      : await Promise.all([
          fetchCanonicalCreatorWork(canonicalCreatorId, postId),
          fetchCanonicalCreator(canonicalCreatorId)
        ]);
    if (token !== loadToken) return;
    // Both legacy Folder routes and canonical creator routes verify ownership.
    if (detail.id !== postId || (canonicalCreatorId === null && detail.folderSlug !== props.slug)) {
      error.value = t('workGallery.notFound');
      return;
    }
    canonicalCreatorName.value = creatorPayload?.creator.name ?? null;
    work.value = detail;
  } catch (cause) {
    if (token === loadToken) error.value = cause instanceof Error ? cause.message : t('workGallery.loadFailed');
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => [props.slug, props.creatorId, props.postId] as const, loadWork, { immediate: true });
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
