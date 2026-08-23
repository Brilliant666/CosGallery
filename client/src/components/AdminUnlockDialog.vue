<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/52 px-6 py-8" @click.self="closeDialog">
    <div class="w-full max-w-[27rem] rounded-[1.5rem] border border-border bg-surface p-8 shadow-[var(--shadow)]">
      <div class="flex items-start justify-between gap-4">
        <div class="grid gap-[0.28rem]">
          <p class="m-0 text-[0.74rem] font-bold uppercase tracking-[0.08em] text-accent-strong">{{ t('auth.adminUnlock.eyebrow') }}</p>
          <h2 class="m-0 text-[1.5rem] font-semibold tracking-[-0.04em]">{{ t('auth.adminUnlock.title') }}</h2>
        </div>
        <button
          class="inline-flex h-10 w-10 items-center justify-center rounded-full border-0 bg-transparent text-muted transition-colors duration-150 hover:bg-surface-alt hover:text-text"
          type="button"
          :aria-label="t('auth.adminUnlock.closeAria')"
          @click="closeDialog"
        >
          <span class="i-fluent-dismiss-20-filled h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <p class="mt-5 mb-0 text-[0.95rem] leading-[1.65] text-muted">
        {{ t('auth.adminUnlock.description') }}
      </p>

      <form class="mt-6 grid gap-4" @submit.prevent="submitUnlock">
        <label class="grid gap-[0.45rem]">
          <span class="text-[0.76rem] font-bold uppercase tracking-[0.08em] text-muted">{{ t('auth.adminUnlock.passwordLabel') }}</span>
          <input
            v-model="password"
            class="h-12 rounded-[0.95rem] border border-border bg-[color-mix(in_srgb,var(--surface-alt)_84%,transparent_16%)] px-4 text-[0.95rem] text-text outline-none transition-[border-color,box-shadow] duration-180 focus:border-[color-mix(in_srgb,var(--accent)_48%,var(--border)_52%)] focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent-soft)_76%,transparent_24%)]"
            type="password"
            autocomplete="current-password"
            :placeholder="t('auth.adminUnlock.placeholder')"
            :disabled="submitting"
          />
        </label>

        <p v-if="errorMessage" class="m-0 rounded-[0.95rem] border border-[rgba(214,48,49,0.24)] bg-[rgba(214,48,49,0.08)] px-4 py-3 text-[0.88rem] text-[#c0392b]">
          {{ errorMessage }}
        </p>

        <div class="flex items-center gap-3 max-sm:flex-col max-sm:items-stretch">
          <button class="btn-primary min-h-12 flex-1 justify-center" type="submit" :disabled="submitting || password.length === 0">
            {{ submitting ? t('auth.adminUnlock.unlocking') : t('auth.adminUnlock.unlock') }}
          </button>
          <button
            class="inline-flex min-h-12 items-center justify-center rounded-[0.95rem] border border-border bg-transparent px-4 text-[0.92rem] font-semibold text-text transition-colors duration-180 hover:bg-surface-alt disabled:cursor-wait disabled:opacity-60"
            type="button"
            :disabled="submitting"
            @click="closeDialog"
          >
            {{ t('common.cancel') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { useAuthStore } from '../stores/auth';

const { t } = useI18n();
const authStore = useAuthStore();
const password = ref('');
const submitting = ref(false);
const localError = ref<string | null>(null);
const errorMessage = computed(() => localError.value ?? authStore.error);

function closeDialog() {
  password.value = '';
  localError.value = null;
  authStore.closeUnlockDialog();
}

async function submitUnlock() {
  if (submitting.value || password.value.length === 0) {
    return;
  }

  submitting.value = true;
  localError.value = null;
  authStore.clearError();

  try {
    await authStore.unlockAdmin(password.value);
    closeDialog();
  } catch (error) {
    localError.value = error instanceof Error ? error.message : t('auth.adminUnlock.unableToUnlock');
  } finally {
    submitting.value = false;
  }
}
</script>
