import { ref } from 'vue';

import { updateImageCaption as updateImageCaptionRequest } from '../api/gallery';
import { i18n } from '../locales';
import { useCollectionsStore } from '../stores/collections';
import { useExploreStore } from '../stores/explore';
import { useFeedStore } from '../stores/feed';
import { useFolderStoriesStore } from '../stores/folder-stories';
import { useFoldersStore } from '../stores/folders';
import { useLikesStore } from '../stores/likes';
import { useMomentsStore } from '../stores/moments';
import { usePlacesStore } from '../stores/places';
import { useReelsStore } from '../stores/reels';
import { useTrashStore } from '../stores/trash';
import { useViewerStore } from '../stores/viewer';
import type { ImageDetail } from '../types/api';
import { normalizeCaptionInput } from '../utils/caption';

export function useImageCaptionEditor() {
  const saving = ref(false);
  const error = ref<string | null>(null);

  const feedStore = useFeedStore();
  const foldersStore = useFoldersStore();
  const viewerStore = useViewerStore();
  const likesStore = useLikesStore();
  const collectionsStore = useCollectionsStore();
  const momentsStore = useMomentsStore();
  const placesStore = usePlacesStore();
  const reelsStore = useReelsStore();
  const trashStore = useTrashStore();
  const folderStoriesStore = useFolderStoriesStore();
  const exploreStore = useExploreStore();

  function applyCaption(id: number, caption: string | null) {
    feedStore.updateImageCaption(id, caption);
    foldersStore.updateImageCaption(id, caption);
    viewerStore.updateCaption(id, caption);
    likesStore.updateImageCaption(id, caption);
    collectionsStore.updateImageCaption(id, caption);
    momentsStore.updateImageCaption(id, caption);
    placesStore.updateImageCaption(id, caption);
    reelsStore.updateImageCaption(id, caption);
    trashStore.updateImageCaption(id, caption);
    folderStoriesStore.updateImageCaption(id, caption);
    exploreStore.updateImageCaption(id, caption);
  }

  async function saveCaption(
    image: Pick<ImageDetail, 'id' | 'filename'> | { id: number; filename: string },
    caption: string | null
  ) {
    saving.value = true;
    error.value = null;

    try {
      const normalizedCaption = normalizeCaptionInput(image, caption);
      const updatedImage = await updateImageCaptionRequest(image.id, normalizedCaption);
      applyCaption(updatedImage.id, updatedImage.caption ?? null);
      return updatedImage;
    } catch (saveError) {
      error.value = saveError instanceof Error ? saveError.message : i18n.global.t('post.captionModal.errors.update');
      throw saveError;
    } finally {
      saving.value = false;
    }
  }

  function clearError() {
    error.value = null;
  }

  return {
    saving,
    error,
    saveCaption,
    clearError
  };
}
