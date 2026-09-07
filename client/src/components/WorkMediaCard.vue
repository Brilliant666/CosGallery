<template>
  <article class="work-media-card" :data-media-id="item.imageId" :data-position="item.position">
    <RouterLink
      :to="workMediaRoute(postId, item.imageId, creatorId ?? undefined, creatorId ? backgroundPath : undefined)"
      custom
      v-slot="{ href, navigate }"
    >
      <a :href="href" class="work-media-card__link" :aria-label="accessibleName" @click="openMedia($event, navigate)">
        <span class="work-media-card__placeholder" aria-hidden="true">
          <span :class="item.mediaType === 'video' ? 'i-fluent-video-24-regular' : 'i-fluent-image-24-regular'" class="h-8 w-8" />
          <span>{{ item.mediaType === 'video' ? t('workGallery.videoPosterMissing') : t('workGallery.thumbnailUnavailable') }}</span>
        </span>
        <img
          v-if="source && !failed"
          :key="retryCount"
          :src="source"
          :alt="item.filename"
          :width="item.width || undefined"
          :height="item.height || undefined"
          loading="lazy"
          decoding="async"
          class="work-media-card__image"
          @error="onImageError"
        />
        <span class="work-media-card__number" aria-hidden="true">{{ ordinal }}</span>
        <span v-if="item.mediaType === 'video'" class="work-media-card__video" aria-hidden="true">
          <span class="i-fluent-play-circle-24-filled h-9 w-9" />
          <span class="work-media-card__duration">{{ duration }}</span>
        </span>
      </a>
    </RouterLink>
    <button v-if="failed" type="button" class="work-media-card__retry" :aria-label="t('workGallery.retryThumbnail', { index: ordinal })" @click="retryThumbnail">
      {{ t('workGallery.retry') }}
    </button>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';

import { useAppStore } from '../stores/app';
import type { PostMediaItem } from '../types/api';
import { formatMediaDuration } from '../utils/media';
import { workMediaRoute } from '../utils/work-gallery';

const props = defineProps<{
  item: PostMediaItem;
  ordinal: number;
  postId: number;
  backgroundPath: string;
  creatorId?: number | null;
}>();
const { t } = useI18n();
const appStore = useAppStore();
const source = ref<string | null>(props.item.thumbnailUrl || null);
const failed = ref(!source.value);
const triedPreview = ref(false);
const retryCount = ref(0);
const duration = computed(() => formatMediaDuration(props.item.durationMs) || t('workGallery.unknownDuration'));
const accessibleName = computed(() => t('workGallery.openMedia', {
  index: props.ordinal,
  type: t(props.item.mediaType === 'video' ? 'workGallery.video' : 'workGallery.image'),
  filename: props.item.filename
}));

function onImageError() {
  // Never send a video preview (or an original file) to an image card.
  const preview = props.item.previewUrl;
  if (!triedPreview.value && props.item.mediaType === 'image' && preview &&
      preview !== source.value && preview !== props.item.originalUrl && !preview.startsWith('/api/originals/')) {
    triedPreview.value = true;
    source.value = preview;
    return;
  }
  failed.value = true;
}

function retryThumbnail() {
  triedPreview.value = false;
  source.value = props.item.thumbnailUrl || null;
  failed.value = !source.value;
  retryCount.value += 1;
}

function openMedia(event: MouseEvent, navigate: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  appStore.setImageModalBackground(props.backgroundPath);
  navigate();
}

watch(() => [props.item.imageId, props.item.thumbnailUrl] as const, retryThumbnail);
</script>

<style scoped>
.work-media-card { position: relative; min-width: 0; }
.work-media-card__link {
  position: relative; display: block; aspect-ratio: 2 / 3; overflow: hidden;
  background: var(--surface-alt);
  color: var(--text); text-decoration: none;
}
.work-media-card__link:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.work-media-card__image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center center; background: var(--surface-alt); }
.work-media-card__placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.7rem; padding: 1rem; text-align: center; color: var(--muted); font-size: 0.75rem; }
.work-media-card__number { position: absolute; top: 0.5rem; left: 0.5rem; padding: 0.15rem 0.45rem; border-radius: 0.35rem; background: rgb(0 0 0 / 62%); color: white; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.work-media-card__video { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: white; filter: drop-shadow(0 1px 3px rgb(0 0 0 / 70%)); }
.work-media-card__duration { position: absolute; right: 0.5rem; bottom: 0.5rem; padding: 0.2rem 0.45rem; border-radius: 0.35rem; background: rgb(0 0 0 / 65%); font-size: 0.75rem; }
.work-media-card__retry { position: absolute; bottom: 0.5rem; left: 0.5rem; z-index: 1; border: 1px solid var(--border); border-radius: 0.4rem; padding: 0.25rem 0.5rem; background: var(--surface); color: var(--text); font-size: 0.75rem; cursor: pointer; }
</style>
