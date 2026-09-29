<template>
  <section class="card grid gap-3 p-5" aria-labelledby="work-trash-title">
    <h2 id="work-trash-title">{{ t('workRemoval.trashTitle') }}</h2>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">{{ t('trashPage.loading') }}</p>
    <p v-else-if="!items.length && !pendingOperations.length && !error">
      {{ t('workRemoval.empty') }}
    </p>
    <section
      v-if="pendingOperations.length"
      aria-labelledby="pending-work-removals"
    >
      <h3 id="pending-work-removals">{{ t('workRemoval.pendingTitle') }}</h3>
      <ul class="grid gap-3">
        <li
          v-for="operation in pendingOperations"
          :key="operation.operationId"
          class="break-words"
          data-test="pending-operation"
        >
          <strong>{{ operation.title }}</strong>
          <p>{{ t(workRemovalStatusKey(operation)) }}</p>
          <p>#{{ operation.operationId }}</p>
          <p v-if="operation.message">{{ operation.message }}</p>
          <button
            type="button"
            :disabled="retrying !== null"
            @click="retry(operation)"
          >
            {{
              t(
                retrying === operation.operationId
                  ? 'workRemoval.processing'
                  : 'workRemoval.retry',
              )
            }}
          </button>
        </li>
      </ul>
    </section>
    <ul class="grid gap-3">
      <li
        v-for="item in items"
        :key="item.workId"
        class="flex flex-wrap items-center gap-3"
      >
        <div class="min-w-0 flex-1 break-words">
          <strong>{{ item.title }}</strong>
          <p>
            {{ item.localCopyCount }} {{ t('workRemoval.copies') }} ·
            {{ item.trashedAt }}
          </p>
        </div>
        <button
          type="button"
          :disabled="retrying !== null || hasPending(item.workId)"
          @click="select(item, 'restore')"
        >
          {{ t('workRemoval.restoreAction') }}
        </button>
        <button
          type="button"
          class="text-[#b42318]"
          :disabled="retrying !== null || hasPending(item.workId)"
          @click="select(item, 'permanent')"
        >
          {{ t('workRemoval.permanentAction') }}
        </button>
      </li>
    </ul>
    <WorkRemovalDialog
      v-if="target"
      :work-id="target.workId"
      :creator-id="target.creatorId"
      :mode="mode"
      @close="target = null"
      @changed="changed"
    />
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  fetchTrashedWorks,
  retryWorkRemoval,
  type PendingWorkRemoval,
  type TrashedWork,
  type WorkRemovalMode,
  type WorkRemovalResult,
} from '../api/work-removal';
import { refreshLibraryAfterRemoval } from '../utils/refresh-library';
import { workRemovalStatusKey } from '../utils/work-removal-status';
import WorkRemovalDialog from './WorkRemovalDialog.vue';
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const items = ref<TrashedWork[]>([]),
  target = ref<TrashedWork | null>(null),
  mode = ref<WorkRemovalMode>('restore');
const loading = ref(false),
  error = ref(''),
  notice = ref('');
const pendingOperations = ref<PendingWorkRemoval[]>([]),
  retrying = ref<string | number | null>(null);
let generation = 0;
function hasPending(workId: number) {
  return pendingOperations.value.some(
    (operation) => operation.workId === workId,
  );
}
function select(item: TrashedWork, next: WorkRemovalMode) {
  if (retrying.value !== null || hasPending(item.workId)) return;
  target.value = item;
  mode.value = next;
}
async function load() {
  const token = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const next = await fetchTrashedWorks();
    if (token === generation) {
      items.value = next.items;
      pendingOperations.value = next.pendingOperations ?? [];
    }
  } catch (cause) {
    if (token === generation)
      error.value =
        cause instanceof Error ? cause.message : t('workRemoval.loadFailed');
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function changed(result: WorkRemovalResult) {
  target.value = null;
  notice.value = `${t(workRemovalStatusKey(result))} #${result.operationId}`;
  await refreshLibraryAfterRemoval().catch(() => {});
  await load();
  emit('changed');
}
async function retry(operation: PendingWorkRemoval) {
  if (retrying.value !== null) return;
  retrying.value = operation.operationId;
  error.value = '';
  notice.value = '';
  try {
    await changed(await retryWorkRemoval(operation.operationId));
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : t('workRemoval.failed');
  } finally {
    retrying.value = null;
  }
}
defineExpose({ reload: load });
onMounted(load);
onBeforeUnmount(() => {
  ++generation;
});
</script>
