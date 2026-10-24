<template>
  <div class="reel-action-rail" @click.stop>
    <button
      class="reel-action-rail__button"
      :class="{ 'reel-action-rail__button--liked': isLiked }"
      type="button"
      :aria-label="likesStore.toggleAriaLabel(isLiked)"
      :title="t('reels.rail.parentPostActions')"
      :aria-pressed="isLiked"
      :disabled="loadingParent || likesStore.isPending(item.postId) || !authStore.canUseSavedItems"
      @click="handleLike"
    >
      <span
        class="reel-action-rail__icon"
        :class="isLiked ? 'i-fluent-heart-20-filled' : 'i-fluent-heart-20-regular'"
        aria-hidden="true"
      />
    </button>

    <div class="reel-action-rail__info-wrap">
      <button
        class="reel-action-rail__button"
        type="button"
        :aria-label="infoOpen ? t('reels.rail.hideDetails') : t('reels.rail.showDetails')"
        :title="infoOpen ? t('reels.rail.hideDetails') : t('reels.rail.showDetails')"
        :aria-pressed="infoOpen"
        @click="$emit('toggle-info')"
      >
        <span
          class="reel-action-rail__icon"
          :class="infoOpen ? 'i-fluent-info-16-filled' : 'i-fluent-info-16-regular'"
          aria-hidden="true"
        />
      </button>

      <div v-if="$slots['info-panel']" class="reel-action-rail__info-panel">
        <slot name="info-panel" />
      </div>
    </div>

    <a
      class="reel-action-rail__button"
      :href="downloadOriginalMediaUrl"
      download
      :aria-label="t('reels.rail.downloadOriginal')"
      :title="t('reels.rail.downloadOriginal')"
    >
      <span class="reel-action-rail__icon i-fluent-arrow-download-20-regular" aria-hidden="true" />
    </a>

    <RouterLink
      class="reel-action-rail__button"
      :to="workMediaRoute(item.postId, item.mediaId, item.creatorId ?? undefined)"
      :aria-label="t('reels.rail.openAlbum')"
      :title="t('reels.rail.openAlbum')"
    >
      <span class="reel-action-rail__icon i-fluent-folder-16-regular" aria-hidden="true" />
    </RouterLink>
    <p v-if="actionError || likesStore.actionError(item.postId)" class="reel-action-rail__error" role="status">{{ actionError || likesStore.actionError(item.postId) }}</p>
  </div>
</template>

<script setup lang="ts">
import { workMediaRoute } from '../utils/work-gallery';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { fetchPostSummary } from '../api/gallery';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';

import { useAuthStore } from '../stores/auth';
import { useLikesStore } from '../stores/likes';
import type { ReelItem } from '../types/api';

const props = defineProps<{
  item: ReelItem;
  infoOpen?: boolean;
}>();

defineEmits<{
  'toggle-info': [];
}>();

const authStore = useAuthStore();
const likesStore = useLikesStore();
const { t } = useI18n();
const isLiked = computed(() => likesStore.isLiked(props.item.postId));
const downloadOriginalMediaUrl = computed(() => props.item.originalDownloadUrl);

const loadingParent = ref(false);
const actionError = ref<string | null>(null);
let actionGeneration = 0;
watch(() => props.item.postId, () => {
  ++actionGeneration;
  loadingParent.value = false;
  actionError.value = null;
});
onBeforeUnmount(() => { ++actionGeneration; });

async function handleLike() {
  const postId = props.item.postId;
  if (!authStore.canUseSavedItems || loadingParent.value || likesStore.isPending(postId)) return;
  actionError.value = null;
  // Removal needs no hydration; retain the existing complete snapshot for rollback.
  if (likesStore.isLiked(postId)) {
    const savedPost = likesStore.items.find(item => item.id === postId);
    if (savedPost) await likesStore.toggleLike(savedPost);
    else actionError.value = t('reels.rail.parentLoadError');
    return;
  }
  const turn = ++actionGeneration;
  const mode = authStore.likesMode;
  loadingParent.value = true;
  try {
    const parent = await fetchPostSummary(postId);
    if (turn !== actionGeneration || props.item.postId !== postId || authStore.likesMode !== mode || !authStore.canUseSavedItems) return;
    if (parent.id !== postId || parent.representation !== 'summary') throw new Error(t('reels.rail.parentLoadError'));
    // A different control may have added this post while the summary loaded.
    if (!likesStore.isLiked(postId)) await likesStore.toggleLike(parent);
  } catch (error) {
    if (turn === actionGeneration) actionError.value = error instanceof Error ? error.message : t('reels.rail.parentLoadError');
  } finally {
    if (turn === actionGeneration) loadingParent.value = false;
  }
}
</script>

<style scoped>
.reel-action-rail {
  display: grid;
  gap: 0.88rem;
  justify-items: center;
}

.reel-action-rail__error {
  position: absolute;
  right: 100%;
  bottom: 0;
  width: 15rem;
  padding: .65rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: var(--surface);
  color: var(--text);
}

.reel-action-rail__info-wrap {
  position: relative;
  display: inline-flex;
}

.reel-action-rail__info-panel {
  position: absolute;
  bottom: -0.85rem;
  left: calc(100% + 0.9rem);
  z-index: 7;
}

.reel-action-rail__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.3rem;
  height: 2.3rem;
  padding: 0;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--text) 82%, transparent);
  text-decoration: none;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    opacity 0.16s ease,
    color 0.16s ease;
}

.reel-action-rail__button:hover:not(:disabled) {
  transform: translateY(-1px);
  opacity: 0.96;
  color: var(--text);
}

.reel-action-rail__button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.reel-action-rail__button--liked {
  color: #ff6b81;
}

.reel-action-rail__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.45rem;
  height: 1.45rem;
}
</style>
