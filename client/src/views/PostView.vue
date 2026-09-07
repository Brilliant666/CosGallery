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
      :deleting="viewerStore.deleting"
      @close="emit('close')"
      @delete="openDeleteDialog"
    />
    <div v-else-if="viewerStore.loading" class="card p-8 text-center">
      <p class="text-muted">Loading post...</p>
    </div>
    <ConfirmDialog
      v-if="confirmDeleteOpen"
      title="Delete this post?"
      :message="deleteDialogMessage"
      :confirm-label="deleteDialogConfirmLabel"
      :loading="viewerStore.deleting"
      @cancel="confirmDeleteOpen = false"
      @confirm="handleDelete"
    >
      <template #details>
        <label class="flex items-start gap-3 mt-3 cursor-pointer select-none">
          <input
            v-model="deleteOriginalFromDisk"
            class="mt-[0.2rem]"
            type="checkbox"
            :disabled="viewerStore.deleting"
          />
          <span class="grid gap-[0.18rem]">
            <span class="text-[0.92rem] font-semibold text-text">Also permanently delete original file from disk</span>
            <span class="text-[0.84rem] text-muted">Keep this unchecked to move the post to Trash while keeping the source file on disk.</span>
          </span>
        </label>
        <p
          v-if="deleteOriginalFromDisk"
          class="m-0 mt-3 px-3 py-[0.8rem] rounded-[0.9rem] border border-[rgba(217,48,37,0.24)] text-[0.84rem] text-[#b42318] bg-[rgba(217,48,37,0.08)]"
        >
          This will permanently delete the original file, thumbnail, and preview from disk. This action cannot be undone.
        </p>
        <p
          v-if="deleteError"
          class="m-0 mt-3 px-3 py-[0.8rem] rounded-[0.9rem] border border-[rgba(217,48,37,0.24)] text-[0.84rem] text-[#b42318] bg-[rgba(217,48,37,0.08)]"
        >
          {{ deleteError }}
        </p>
      </template>
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
import { useAppStore } from '../stores/app';
import { useFeedStore } from '../stores/feed';
import { useLikesStore } from '../stores/likes';
import { useFoldersStore } from '../stores/folders';
import { useMomentsStore } from '../stores/moments';
import { useViewerStore } from '../stores/viewer';
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

const appStore = useAppStore();
const feedStore = useFeedStore();
const likesStore = useLikesStore();
const viewerStore = useViewerStore();
const foldersStore = useFoldersStore();
const momentsStore = useMomentsStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const confirmDeleteOpen = ref(false);
const deleteOriginalFromDisk = ref(false);
const deleteError = ref<string | null>(null);

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
const deleteDialogMessage = computed(() =>
  deleteOriginalFromDisk.value
    ? 'This will permanently delete the post from the app and remove original media from disk.'
    : 'This will delete the post from the app and move it to Trash. The original file will stay on disk unless you choose permanent deletion.'
);
const deleteDialogConfirmLabel = computed(() => (deleteOriginalFromDisk.value ? 'Permanently Delete' : 'Delete'));

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
onBeforeUnmount(() => { viewerStore.reset(); });

function openDeleteDialog() {
  deleteOriginalFromDisk.value = false;
  deleteError.value = null;
  confirmDeleteOpen.value = true;
}

async function handleDelete() {
  if (!viewerStore.image) {
    return;
  }

  const currentImage = viewerStore.image;
  deleteError.value = null;

  try {
    const deleted = await viewerStore.deleteImage(currentImage.id, {
      permanent: deleteOriginalFromDisk.value
    });
    confirmDeleteOpen.value = false;
    deleteOriginalFromDisk.value = false;

    feedStore.removeImage(deleted.id);
    likesStore.removeImage(deleted.id);
    const removedFolder = foldersStore.removeImage(deleted.id, deleted.folderSlug, currentImage.mediaType);
    momentsStore.removeImage(deleted.id);
    appStore.removeIndexedImage(removedFolder ? 1 : 0, currentImage.mediaType);
    emit('removedWork');

    if (props.modal) {
      emit('close');
      return;
    }

    if (removedFolder) {
      await router.replace({ name: 'library' });
      return;
    }

    await router.replace({ name: 'folder', params: { slug: deleted.folderSlug } });
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : 'Unable to delete post';
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
