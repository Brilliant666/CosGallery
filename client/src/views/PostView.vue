<template>
  <div :class="modal ? 'image-view image-view--modal' : 'image-view image-view--page'" @click.stop>
    <RouterLink v-if="!modal && returnToWork" class="mb-4 inline-flex font-semibold text-text" :to="returnToWork">
      {{ t('workGallery.backToGallery') }}
    </RouterLink>
    <div v-if="viewError" role="alert">
      <ErrorState title="Could not load post" :message="viewError" />
      <button v-if="modal" type="button" class="btn" @click="emit('close')">{{ t('workGallery.backToGallery') }}</button>
    </div>
    <PostViewer
      v-else-if="activeImage"
      :image="activeImage"
      :folder="folder"
      :is-modal="modal"
      :deleting="mediaDeleting"
      @close="emit('close')"
      @delete="openDeleteDialog"
    />
    <div v-else-if="viewerStore.loading" class="card p-8 text-center">
      <p class="text-muted">Loading post...</p>
    </div>
    <ConfirmDialog
      v-if="confirmDeleteOpen"
      :title="t('mediaRemoval.title')"
      :message="deleteDialogMessage"
      :confirm-label="t('mediaRemoval.confirm')"
      :cancel-label="t('common.cancel')"
      :loading="mediaDeleting"
      @cancel="cancelDelete"
      @confirm="handleDelete"
    >
      <template #details><p v-if="deleteError" role="alert">{{ deleteError }}</p></template>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import ConfirmDialog from '../components/ConfirmDialog.vue';
import ErrorState from '../components/ErrorState.vue';
import PostViewer from '../components/PostViewer.vue';
import { useFoldersStore } from '../stores/folders';
import { useViewerStore } from '../stores/viewer';
import { trashPostMedia } from '../api/media-trash';
import { refreshLibraryAfterRemoval } from '../utils/refresh-library';
import type { ImageDetail } from '../types/api';
import { canonicalWorkGalleryRoute, libraryReadingQuery, orderedMediaItems, parsePositiveId, resolveMediaSelection, workGalleryRoute, workMediaRoute } from '../utils/work-gallery';

const props = defineProps<{
  id: string;
  modal?: boolean;
  authorizedWork?: ImageDetail;
}>();

const emit = defineEmits<{
  close: [];
  updatedWork: [work: ImageDetail];
  removedWork: [];
}>();

const viewerStore = useViewerStore();
const foldersStore = useFoldersStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const confirmDeleteOpen = ref(false);
const mediaDeleting = ref(false);
const deleteTarget = ref<{ postId: number; mediaId: number; filename: string; last: boolean; route: string } | null>(null);
const deleteError = ref<string | null>(null);
let disposed = false;

const imageId = computed(() => Number(props.id));
const activeMediaType = computed(() => (route.query.tab === 'reels' ? 'video' : undefined));
const canonicalCreatorId = computed(() => {
  const value = route.name === 'canonical-work-gallery' ? route.params.creatorId : route.query.creator;
  return parsePositiveId(value) ?? undefined;
});
const activeImage = computed(() => (viewerStore.image?.id === imageId.value ? viewerStore.image : null));
const identityError = computed(() => (route.name === 'canonical-work-gallery' || route.query.creator !== undefined)
  && canonicalCreatorId.value === undefined ? 'Invalid canonical creator identity' : null);
const viewError = computed(() => identityError.value || viewerStore.error ||
  ((route.name === 'canonical-work-gallery' || (route.query.context === 'work' && route.query.creator !== undefined)) && activeImage.value
    && resolveMediaSelection(orderedMediaItems(activeImage.value.mediaItems), route.query.media).invalid
    ? 'Requested media does not exist or does not belong to this work' : null));
const returnToWork = computed(() => {
  if (route.query.context !== 'work' || !activeImage.value) return null;
  const creatorValue = Array.isArray(route.query.creator) ? route.query.creator[0] : route.query.creator;
  const creatorId = parsePositiveId(creatorValue);
  const requestedReturn = Array.isArray(route.query.returnTo) ? route.query.returnTo[0] : route.query.returnTo;
  if (creatorId !== null && typeof requestedReturn === 'string'
    && new RegExp(`^/(?:library|creators)/${creatorId}/works/${activeImage.value.id}(?:\\?|$)`, 'u').test(requestedReturn)
    && !requestedReturn.includes('\\')) {
    return canonicalWorkGalleryRoute(creatorId, activeImage.value.id, requestedReturn);
  }
  return creatorId === null
    ? workGalleryRoute(activeImage.value.folderSlug, activeImage.value.id)
    : canonicalWorkGalleryRoute(creatorId, activeImage.value.id);
});
const folder = computed(() =>
  activeImage.value ? foldersStore.items.find((entry) => entry.slug === activeImage.value?.folderSlug) ?? null : null
);
const deleteDialogMessage = computed(() => deleteTarget.value
  ? t(deleteTarget.value.last ? 'mediaRemoval.lastMessage' : 'mediaRemoval.message', { filename: deleteTarget.value.filename }) : '');

async function loadImage() {
  if (identityError.value) { viewerStore.reset(); return; }
  if (route.name === 'canonical-work-gallery' && props.authorizedWork?.id === imageId.value) {
    viewerStore.adoptAuthorizedWork(props.authorizedWork);
    return;
  }
  if (Number.isFinite(imageId.value)) {
    await viewerStore.loadImage(imageId.value, activeMediaType.value, canonicalCreatorId.value);
  }
}

watch([imageId, activeMediaType, canonicalCreatorId, () => props.authorizedWork, identityError], loadImage, { immediate: true });
watch(() => viewerStore.image, (image) => {
  if (props.authorizedWork && image?.id === props.authorizedWork.id && image !== props.authorizedWork) emit('updatedWork', image);
});
// Old canonical bookmarks redirect only after the ownership-scoped request and media validation.
watch([activeImage, viewError, () => viewerStore.loading, () => route.fullPath], async () => {
  if (route.name !== 'image' || route.query.context !== 'work' || !canonicalCreatorId.value || !activeImage.value || viewError.value || viewerStore.loading) return;
  const mediaId = parsePositiveId(route.query.media);
  const returnTo = typeof route.query.returnTo === 'string' ? route.query.returnTo : undefined;
  const destination = mediaId === null
    ? canonicalWorkGalleryRoute(canonicalCreatorId.value, imageId.value, returnTo)
    : workMediaRoute(imageId.value, mediaId, canonicalCreatorId.value, returnTo);
  const encoded = new URLSearchParams();
  for (const key of ['q', 'rating', 'libraryPage', 'loaded']) {
    const value = route.query[key];
    if (typeof value === 'string') encoded.set(key, value);
  }
  await router.replace({ ...destination, query: {
    ...destination.query, ...libraryReadingQuery(`/library/reader?${encoded}`)
  } });
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; viewerStore.reset(); });

function cancelDelete() {
  if (mediaDeleting.value) return;
  confirmDeleteOpen.value = false;
  deleteTarget.value = null;
}
watch(() => route.fullPath, () => { if (!mediaDeleting.value) cancelDelete(); });
function openDeleteDialog(mediaId: number) {
  const work = activeImage.value;
  if (!work || mediaDeleting.value) return;
  const items = orderedMediaItems(work.mediaItems);
  const item = items.find(item => item.imageId === mediaId);
  // A post ID is never a fallback media ID.
  if (!item) return;
  deleteTarget.value = { postId: work.id, mediaId, filename: item.filename, last: items.length === 1, route: route.fullPath };
  deleteError.value = null;
  confirmDeleteOpen.value = true;
}

async function handleDelete() {
  const target = deleteTarget.value;
  if (!target || mediaDeleting.value || target.route !== route.fullPath) return;
  mediaDeleting.value = true;
  deleteError.value = null;
  const creatorId = canonicalCreatorId.value;
  const current = activeImage.value;
  try {
    const result = await trashPostMedia(target.postId, target.mediaId, target.last);
    confirmDeleteOpen.value = false;
    deleteTarget.value = null;
    void refreshLibraryAfterRemoval().catch(() => {});
    if (disposed || route.fullPath !== target.route) return;
    if (result.postTrashed) {
      await router.replace(creatorId
        ? { name: 'canonical-creator', params: { creatorId: String(creatorId) }, query: libraryReadingQuery(target.route) }
        : { name: 'folder', params: { slug: current?.folderSlug ?? '' } });
    } else {
      // Close the removed media route before reloading its remaining siblings.
      const { media: _removed, ...query } = route.query;
      if (props.modal) {
        emit('removedWork');
        await router.replace({ path: route.path, query });
        emit('close');
      } else if (current) {
        await router.replace(creatorId ? canonicalWorkGalleryRoute(creatorId, target.postId, target.route) : workGalleryRoute(current.folderSlug, target.postId));
      }
    }
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : t('mediaRemoval.failed');
  } finally {
    mediaDeleting.value = false;
  }
}

</script>

<style scoped>
.image-view {
  width: min(100%, 72rem);
}

.image-view--modal {
  display: flex;
  justify-content: center;
  min-height: 0;
  height: 100%;
  max-height: 100%;
}

.image-view--page {
  margin: 0 auto;
}
</style>
