<template>
  <div class="fixed inset-0 z-60 flex items-center justify-center p-6 bg-black/55" @click.self="cancel">
    <section class="w-[min(100%,26rem)] p-[1.4rem] bg-surface border border-border rounded-[1.2rem] shadow-[var(--shadow)]" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="messageId" v-dialog-focus="{ close: cancel, locked: loading }">
      <!-- Icon -->
      <div class="inline-flex items-center justify-center w-12 h-12 mb-4 rounded-full text-[#d93025] bg-[rgba(217,48,37,0.1)]" aria-hidden="true">
        <svg class="w-[1.3rem] h-[1.3rem]" viewBox="0 0 24 24" role="presentation">
          <path
            d="M12 8.5v4m0 3h.01M10.2 4.9 3.9 16a1.5 1.5 0 0 0 1.3 2.25h13.6A1.5 1.5 0 0 0 20.1 16L13.8 4.9a1.5 1.5 0 0 0-2.6 0Z"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.8"
          />
        </svg>
      </div>
      <!-- Copy -->
      <div class="grid gap-[0.45rem]">
        <h2 :id="titleId" class="m-0 text-[1.15rem]">{{ title }}</h2>
        <p :id="messageId" class="m-0 text-muted">{{ message }}</p>
        <slot name="details" />
      </div>
      <!-- Actions -->
      <div class="flex flex-wrap justify-end gap-3 mt-[1.4rem]">
        <button class="removal-button removal-neutral" type="button" :disabled="loading" @click="cancel">
          {{ cancelLabel ?? t('common.cancel') }}
        </button>
        <button class="removal-button removal-danger" type="button" :disabled="loading" @click="$emit('confirm')">
          {{ loading ? (loadingLabel ?? t('collections.detail.delete.deleting')) : (confirmLabel ?? t('collections.detail.delete.confirm')) }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { vAdmissionDialog as vDialogFocus } from '../utils/admission-dialog';

const props = withDefaults(
  defineProps<{
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    loadingLabel?: string;
    loading?: boolean;
  }>(),
  {
    loading: false
  }
);

const emit = defineEmits<{
  cancel: [];
  confirm: [];
}>();

const titleId = `confirm-dialog-title-${Math.random().toString(36).slice(2, 10)}`;
const messageId = `${titleId}-message`;
const { t } = useI18n();
function cancel() {
  if (!props.loading) emit('cancel');
}
</script>
