<template>
  <section class="card grid gap-3 p-5" aria-labelledby="media-trash-title">
    <h2 id="media-trash-title">{{ t('mediaRemoval.trashTitle') }}</h2>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">{{ t('trashPage.loading') }}</p>
    <p v-else-if="!items.length && !error">{{ t('mediaRemoval.empty') }}</p>
    <ul class="grid gap-3">
      <li
        v-for="item in items"
        :key="`${item.postId}:${item.mediaId}`"
        class="flex flex-wrap items-center gap-3"
      >
        <img
          v-if="item.thumbnailUrl"
          :src="item.thumbnailUrl"
          alt=""
          class="h-16 w-16 object-cover"
          loading="lazy"
        />
        <div class="min-w-0 flex-1 break-words">
          <strong>{{ item.filename }}</strong>
          <p>{{ item.postTitle }} · {{ item.trashedAt }}</p>
        </div>
        <button class="removal-button removal-neutral" type="button" :disabled="busy" @click="restore(item)">
          {{ t('mediaRemoval.restore') }}
        </button>
      </li>
    </ul>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  fetchTrashedMedia,
  restorePostMedia,
  type TrashedMedia,
} from '../api/media-trash';
import { refreshLibraryAfterRemoval } from '../utils/refresh-library';
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const items = ref<TrashedMedia[]>([]),
  loading = ref(false),
  busy = ref(false),
  error = ref('');
let generation = 0;
async function load() {
  const token = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const next = await fetchTrashedMedia();
    if (token === generation) items.value = next.items;
  } catch (cause) {
    if (token === generation)
      error.value =
        cause instanceof Error ? cause.message : t('mediaRemoval.loadFailed');
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function restore(item: TrashedMedia) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await restorePostMedia(item.postId, item.mediaId);
    items.value = items.value.filter(
      (entry) => entry.mediaId !== item.mediaId || entry.postId !== item.postId,
    );
    await refreshLibraryAfterRemoval();
    emit('changed');
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : t('mediaRemoval.failed');
  } finally {
    busy.value = false;
  }
}
defineExpose({ reload: load });
onMounted(load);
onBeforeUnmount(() => {
  ++generation;
});
</script>
