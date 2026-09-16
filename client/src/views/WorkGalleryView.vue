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
    <div v-if="showMedia" class="work-gallery__viewer" @click.self="closeMedia">
      <PostView v-if="work && !loading && !error" :id="postId" :authorized-work="work" modal @close="closeMedia" @updated-work="work = $event" @removed-work="loadWork" />
      <div v-else class="card work-gallery__state" role="alert">
        <p>{{ error || t('workGallery.loading') }}</p>
        <button type="button" class="btn" @click="closeMedia">{{ t('workGallery.backToGallery') }}</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { fetchCanonicalCreator, fetchCanonicalCreatorWork, fetchImage, fetchFolder } from '../api/gallery';
import { RequestError } from '../api/http';
import WorkMediaCard from '../components/WorkMediaCard.vue';
import PostView from './PostView.vue';
import { useAuthStore } from '../stores/auth';
import { useAppStore } from '../stores/app';
import { useFoldersStore } from '../stores/folders';
import { useCreatorReadingStore } from '../stores/creator-reading';
import type { ImageDetail } from '../types/api';
import { canonicalCreatorRoute, canonicalWorkGalleryRoute, libraryReadingQuery, orderedMediaItems, parsePositiveId, workTitle } from '../utils/work-gallery';

const props = defineProps<{ slug?: string; creatorId?: string; postId: string }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const foldersStore = useFoldersStore();
const authStore = useAuthStore();
const reading = useCreatorReadingStore();
// Independent page state keeps the background DOM and thumbnails alive while PostView uses the viewer store.
const work = shallowRef<ImageDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const canonicalCreatorName = ref<string | null>(null);
let loadToken = 0;
let nameToken = 0;
const mediaItems = computed(() => orderedMediaItems(work.value?.mediaItems));
const imageCount = computed(() => mediaItems.value.filter((item) => item.mediaType === 'image').length);
const videoCount = computed(() => mediaItems.value.length - imageCount.value);
const canonicalId = computed(() => props.creatorId ? parsePositiveId(props.creatorId) : null);
const creatorName = computed(() => canonicalCreatorName.value || work.value?.folderName || foldersStore.items.find((folder) => folder.slug === props.slug)?.name || props.slug || '');
const backgroundPath = computed(() => route.name !== 'canonical-work-gallery' ? route.fullPath
  : router.resolve({ path: route.path, query: libraryReadingQuery(route.fullPath) }).fullPath);
const showMedia = computed(() => route.name === 'canonical-work-gallery' && route.query.media !== undefined);
let closingMedia = false;
async function closeMedia() {
  if (closingMedia || !showMedia.value) return;
  closingMedia = true;
  const target = backgroundPath.value;
  const back = router.options.history.state.back;
  const previous = typeof back === 'string' && back.startsWith('/') && !back.startsWith('//') && !back.includes('\\') ? router.resolve(back) : null;
  const verifiedBackground = previous?.name === 'canonical-work-gallery' && previous.path === route.path
    && previous.query.media === undefined
    && JSON.stringify(libraryReadingQuery(previous.fullPath)) === JSON.stringify(libraryReadingQuery(target));
  if (verifiedBackground) router.back();
  else await router.replace(target);
}
watch(() => route.fullPath, () => { closingMedia = false; });
function onEscape(event: KeyboardEvent) {
  const target = event.target instanceof Element ? event.target : null;
  if (event.defaultPrevented || target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
  if (showMedia.value && event.key === 'Escape') { event.preventDefault(); void closeMedia(); }
}
onMounted(() => window.addEventListener('keydown', onEscape));
const backRoute = computed(() => {
  if (canonicalId.value !== null) {
    const candidate = Array.isArray(route.query.returnTo) ? route.query.returnTo[0] : route.query.returnTo;
    if (typeof candidate === 'string' && new RegExp(`^/(?:library|creators)/${canonicalId.value}(?:\\?|$)`, 'u').test(candidate) && !candidate.includes('\\')) {
      return canonicalCreatorRoute(canonicalId.value, candidate);
    }
    return canonicalCreatorRoute(canonicalId.value, route.fullPath);
  }
  return { name: 'folder', params: { slug: props.slug ?? '' } };
});

// Display data is not ownership evidence. The selected-work endpoint remains authoritative.
async function loadCreatorName(creatorId: number, token: number) {
  const requestToken = ++nameToken;
  const generation = reading.generation;
  canonicalCreatorName.value = null;
  const cached = reading.pages[String(creatorId)]?.creator;
  if (cached?.identityType === 'creator' && cached.id === creatorId && cached.canonicalCreatorId === creatorId) {
    canonicalCreatorName.value = cached.name;
    return;
  }
  const isCurrent = () => token === loadToken && requestToken === nameToken && generation === reading.generation;
  try {
    const { creator } = await fetchCanonicalCreator(creatorId);
    if (!isCurrent()) return;
    if (creator.id !== creatorId || creator.identityType !== 'creator' || creator.canonicalCreatorId !== creatorId) {
      throw new RequestError(t('workGallery.notFound'), 404);
    }
    canonicalCreatorName.value = creator.name;
  } catch (cause) {
    if (!isCurrent()) return;
    // Never downgrade authoritative access/not-found/storage failures into a name fallback.
    if (cause instanceof RequestError && [401, 403, 404, 503].includes(cause.status)) {
      work.value = null;
      error.value = cause.message;
      loading.value = false;
    }
    // An ordinary auxiliary network failure leaves the independently authorized detail usable.
  }
}

async function loadWork() {
  const token = ++loadToken;
  nameToken += 1;
  canonicalCreatorName.value = null;
  work.value = null;
  error.value = null;
  const postId = parsePositiveId(props.postId);
  if (postId === null || (props.creatorId !== undefined && canonicalId.value === null)) {
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
    // Start the detail first; a slow display-name request must not gate the media grid/Viewer.
    const detailRequest = canonicalCreatorId === null
      ? fetchImage(postId)
      : fetchCanonicalCreatorWork(canonicalCreatorId, postId);
    if (canonicalCreatorId !== null) void loadCreatorName(canonicalCreatorId, token);
    const detail = await detailRequest;
    if (token !== loadToken || error.value) return;
    // Both legacy Folder routes and canonical creator routes verify ownership.
    if (detail.id !== postId || (canonicalCreatorId === null && detail.folderSlug !== props.slug)) {
      error.value = t('workGallery.notFound');
      return;
    }
    if (!props.creatorId && props.slug && route.query.physical !== '1') {
      const folder = await fetchFolder(props.slug);
      if (token !== loadToken) return;
      if (folder.canonicalCreatorId) {
        await router.replace(canonicalWorkGalleryRoute(folder.canonicalCreatorId, postId));
        return;
      }
    }
    work.value = detail;
  } catch (cause) {
    if (token === loadToken) error.value = cause instanceof Error ? cause.message : t('workGallery.loadFailed');
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => [props.slug, props.creatorId, props.postId] as const, loadWork, { immediate: true });
watch(() => reading.generation, () => {
  if (canonicalId.value !== null && !appStore.isLibraryUnavailable) void loadCreatorName(canonicalId.value, loadToken);
});
watch(() => [authStore.authenticated, authStore.role, appStore.stats?.indexedPosts, appStore.stats?.scan.lastCompletedScan?.id, appStore.isLibraryUnavailable] as const,
  (values, previous) => {
    if (values.every((value, index) => value === previous[index])) return;
    if (previous[2] === undefined && values[0] === previous[0] && values[1] === previous[1]
      && values[4] === previous[4]) return;
    void loadWork();
  });
onBeforeUnmount(() => { loadToken += 1; nameToken += 1; window.removeEventListener('keydown', onEscape); });
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
.work-gallery__viewer { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 2rem; height: 100dvh; overflow: hidden; background: rgb(0 0 0 / 72%); overscroll-behavior: contain; }
@media (max-width: 768px) { .work-gallery__viewer { padding: 0.85rem; } }
@media (min-width: 640px) { .work-gallery__grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 1024px) { .work-gallery__grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (min-width: 1280px) { .work-gallery__grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@media (min-width: 1600px) { .work-gallery__grid { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
</style>
