<template>
  <div class="fixed inset-0 z-60 flex items-center justify-center p-6 bg-black/55" @click.self="$emit('cancel')">
    <section
      class="w-[min(100%,32rem)] p-[1.4rem] bg-surface border border-border rounded-[1.2rem] shadow-[var(--shadow)]"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="grid gap-[1.2rem]">
        <h2 :id="titleId" class="m-0 text-[1.25rem] font-semibold">{{ t('post.captionModal.title') }}</h2>

        <form class="grid gap-[1.1rem]" @submit.prevent="submit">
          <div class="grid gap-[0.35rem]">
            <div class="flex items-center justify-between gap-4">
              <label for="post-caption" class="text-[0.85rem] font-semibold text-text">{{ t('post.captionModal.captionLabel') }}</label>
              <span class="text-[0.75rem] text-muted">{{ formData.caption.length }} / 300</span>
            </div>
            <textarea
              id="post-caption"
              v-model="formData.caption"
              class="w-full min-h-[7rem] rounded-lg border border-border bg-surface px-[0.75rem] py-[0.6rem] text-[0.95rem] text-text placeholder-muted resize-y focus:border-text focus:outline-none focus:ring-1 focus:ring-text"
              maxlength="300"
              :placeholder="t('post.captionModal.placeholder')"
            />
          </div>

          <p
            v-if="error"
            class="m-0 rounded-[0.95rem] border border-[rgba(214,48,49,0.24)] bg-[rgba(214,48,49,0.08)] px-4 py-3 text-[0.88rem] text-[#c0392b]"
          >
            {{ error }}
          </p>

          <div class="flex flex-wrap items-center justify-between gap-3 mt-2">
            <button
              v-if="hasCustomCaption"
              class="min-h-[2.5rem] px-4 py-[0.6rem] border border-transparent rounded-[0.75rem] font-semibold cursor-pointer bg-surface-hover text-text disabled:opacity-70 disabled:cursor-wait"
              type="button"
              :disabled="loading"
              @click="resetToFilename"
            >
              {{ t('post.captionModal.resetToFilename') }}
            </button>
            <div class="flex items-center gap-3 ml-auto">
              <button
                class="min-h-[2.5rem] px-4 py-[0.6rem] border border-transparent rounded-[0.75rem] font-semibold cursor-pointer bg-surface-hover text-text disabled:opacity-70 disabled:cursor-wait"
                type="button"
                :disabled="loading"
                @click="$emit('cancel')"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                class="min-h-[2.5rem] px-4 py-[0.6rem] border border-transparent rounded-[0.75rem] font-semibold cursor-pointer bg-text text-bg disabled:opacity-70 disabled:cursor-wait"
                type="submit"
                :disabled="loading"
              >
                {{ loading ? t('common.saving') : t('common.save') }}
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { normalizeCaptionInput, resolveDisplayCaption } from '../utils/caption';

const props = defineProps<{
  filename: string;
  caption?: string | null;
  error?: string | null;
  loading?: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
  save: [caption: string | null];
}>();

const { t } = useI18n();
const titleId = `caption-dialog-title-${Math.random().toString(36).slice(2, 10)}`;
const hasCustomCaption = computed(() => props.caption !== null && props.caption !== undefined);
const formData = reactive({
  caption: resolveDisplayCaption({
    filename: props.filename,
    caption: props.caption
  })
});

watch(
  () => [props.filename, props.caption] as const,
  ([filename, caption]) => {
    formData.caption = resolveDisplayCaption({ filename, caption });
  }
);

function submit() {
  emit('save', normalizeCaptionInput({ filename: props.filename }, formData.caption));
}

function resetToFilename() {
  emit('save', null);
}
</script>
