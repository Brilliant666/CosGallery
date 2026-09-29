<template>
  <div
    class="fixed inset-0 z-60 flex items-center justify-center bg-black/55 p-6"
    @click.self="close"
  >
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="work-removal-title"
      class="max-h-[85vh] w-[min(100%,42rem)] overflow-auto rounded-xl border border-border bg-surface p-6"
    >
      <h2 id="work-removal-title">{{ t(`workRemoval.${mode}.title`) }}</h2>
      <p>{{ t(`workRemoval.${mode}.message`) }}</p>
      <p v-if="loading" role="status">{{ t('workRemoval.loading') }}</p>
      <template v-if="preview">
        <h3>{{ preview.work.title }}</h3>
        <p>
          {{
            t('workRemoval.scope', {
              copies: preview.localCopies.length,
              files: preview.fileCount,
            })
          }}
        </p>
        <ul>
          <li
            v-for="copy in preview.localCopies"
            :key="copy.id"
            class="mb-3 break-words"
          >
            <strong>{{ copy.directoryName }}</strong
            ><br />{{ copy.path }}<br />
            {{ copy.imageCount }}P · {{ copy.videoCount }}V ·
            {{ t('workRemoval.files', { count: copy.fileCount }) }}
          </li>
        </ul>
        <p v-for="blocker in preview.blockers" :key="blocker" role="alert">
          {{ blocker }}
        </p>
      </template>
      <p v-if="error" role="alert" class="text-[#b42318]">{{ error }}</p>
      <p v-if="result" role="status">{{ t(workRemovalStatusKey(result)) }}</p>
      <div class="mt-4 flex justify-end gap-3">
        <button type="button" :disabled="executing" @click="close">
          {{ t(result ? 'common.close' : 'common.cancel') }}
        </button>
        <button
          v-if="!result && !loading && (!preview || invalidated)"
          type="button"
          :disabled="executing || unavailable"
          @click="load"
        >
          {{ t('workRemoval.refreshPreview') }}
        </button>
        <button
          v-if="!result"
          type="button"
          class="btn bg-[#b42318] text-white"
          :disabled="
            loading ||
            executing ||
            invalidated ||
            unavailable ||
            !preview?.canExecute
          "
          @click="execute"
        >
          {{
            t(
              executing
                ? 'workRemoval.processing'
                : `workRemoval.${mode}.confirm`,
            )
          }}
        </button>
      </div>
    </section>
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RequestError } from '../api/http';
import { workRemovalStatusKey } from '../utils/work-removal-status';
import {
  executeWorkRemoval,
  previewWorkRemoval,
  type WorkRemovalMode,
  type WorkRemovalPreview,
  type WorkRemovalResult,
} from '../api/work-removal';
const props = defineProps<{
  workId: number;
  creatorId: number;
  mode: WorkRemovalMode;
  revision?: string;
  revisionScope?: 'all' | 'creator';
  unavailable?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  changed: [result: WorkRemovalResult];
  stale: [];
}>();
const { t } = useI18n();
const preview = ref<WorkRemovalPreview | null>(null),
  result = ref<WorkRemovalResult | null>(null);
const loading = ref(false),
  executing = ref(false),
  invalidated = ref(false),
  error = ref('');
let generation = 0;
function close() {
  if (!executing.value) emit('close');
}
async function load() {
  if (props.unavailable) return;
  const token = ++generation;
  preview.value = null;
  result.value = null;
  invalidated.value = false;
  error.value = '';
  loading.value = true;
  try {
    const next = await previewWorkRemoval(
      props.workId,
      props.mode,
      props.revision,
      props.revisionScope,
    );
    if (token !== generation) return;
    if (
      next.work.id !== props.workId ||
      next.work.creatorId !== props.creatorId ||
      next.mode !== props.mode
    )
      throw new Error(t('workRemoval.scopeChanged'));
    preview.value = next;
  } catch (cause) {
    if (token !== generation) return;
    error.value =
      cause instanceof Error ? cause.message : t('workRemoval.failed');
    if (cause instanceof RequestError && cause.status === 409) emit('stale');
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function execute() {
  const target = preview.value;
  if (
    !target?.canExecute ||
    executing.value ||
    invalidated.value ||
    props.unavailable
  )
    return;
  executing.value = true;
  error.value = '';
  try {
    const next = await executeWorkRemoval(target.work.id, target.previewToken);
    result.value = next;
    emit('changed', next);
  } catch (cause) {
    // A failed/uncertain execution is never retried with the old confirmation.
    invalidated.value = true;
    error.value =
      cause instanceof Error ? cause.message : t('workRemoval.failed');
    if (cause instanceof RequestError && cause.status === 409) emit('stale');
  } finally {
    executing.value = false;
  }
}
watch(
  () => [
    props.workId,
    props.creatorId,
    props.mode,
    props.revision,
    props.revisionScope,
  ],
  load,
  { immediate: true },
);
watch(
  () => props.unavailable,
  (unavailable) => {
    if (unavailable && !executing.value) {
      ++generation;
      loading.value = false;
      invalidated.value = true;
      error.value = t('workRemoval.scopeChanged');
    }
  },
);
onBeforeUnmount(() => {
  ++generation;
});
</script>
