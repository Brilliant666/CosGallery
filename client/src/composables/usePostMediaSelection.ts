import { computed, ref, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { ImageDetail } from '../types/api';
import { orderedMediaItems, resolveMediaSelection } from '../utils/work-gallery';

export function usePostMediaSelection(image: Readonly<Ref<ImageDetail | null>>) {
  const route = useRoute();
  const router = useRouter();
  const index = ref(0);
  const items = computed(() => orderedMediaItems(image.value?.mediaItems));
  const isWorkContext = computed(() => route.name === 'canonical-work-gallery' || route.query.context === 'work');
  const isCanonicalContext = computed(() => route.name === 'canonical-work-gallery' || (route.query.context === 'work' && route.query.creator !== undefined));

  watch(
    [() => image.value?.id, () => items.value.map((item) => `${item.position}:${item.imageId}`).join(','), () => route.query.media],
    () => {
      if (!image.value) return;
      const selection = resolveMediaSelection(items.value, route.query.media);
      index.value = selection.index;
      if (selection.invalid && !isCanonicalContext.value) {
        const { media: _invalidMedia, ...query } = route.query;
        void router.replace({ name: 'image', params: { id: String(image.value.id) }, query, hash: route.hash });
      }
    },
    { immediate: true }
  );

  const carouselIndex = computed({
    get: () => index.value,
    set: (next: number) => {
      if (!image.value || items.value.length === 0) return;
      const boundedIndex = Math.min(Math.max(Math.trunc(next), 0), items.value.length - 1);
      if (boundedIndex === index.value) return;
      index.value = boundedIndex;
      // Work links are durable, but an ordinary feed carousel keeps its existing route semantics.
      if (isWorkContext.value || route.query.media !== undefined) {
        void router.replace({
          name: route.name === 'canonical-work-gallery' ? 'canonical-work-gallery' : 'image',
          params: route.name === 'canonical-work-gallery' ? { creatorId: route.params.creatorId, postId: String(image.value.id) } : { id: String(image.value.id) },
          query: { ...route.query, media: String(items.value[boundedIndex]!.imageId) },
          hash: route.hash
        });
      }
    }
  });

  const activeMediaItem = computed(() => items.value[carouselIndex.value] ?? null);
  return { items, carouselIndex, activeMediaItem, isWorkContext };
}
