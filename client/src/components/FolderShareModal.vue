<template>
  <div class="fixed inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 sm:p-6" @click.self="$emit('cancel')">
    <section
      class="flex flex-col w-[min(100%,48rem)] max-h-[min(44rem,calc(100dvh-2rem))] rounded-[1.25rem] border border-border bg-surface text-text shadow-[var(--shadow)] overflow-hidden"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <header class="flex items-center justify-between gap-4 border-b border-border/80 bg-surface/95 backdrop-blur-md px-5 py-4 sm:px-6">
        <div class="grid gap-[0.15rem]">
          <h2 :id="titleId" class="m-0 text-[1.15rem] sm:text-[1.25rem] font-bold tracking-[-0.02em] text-text">{{ t('folder.shareModal.title') }}</h2>
          <p class="m-0 text-[0.84rem] text-muted truncate max-w-sm sm:max-w-md">{{ folder.name }}</p>
        </div>
        <button
          class="inline-flex h-8.5 w-8.5 items-center justify-center rounded-full border border-border/80 bg-surface-alt/60 text-muted transition-all hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text/30 cursor-pointer"
          type="button"
          :aria-label="t('common.close')"
          @click="$emit('cancel')"
        >
          <span class="i-fluent-dismiss-20-regular h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      <div class="flex-1 overflow-y-auto p-5 sm:p-6 grid gap-5 min-h-0">
        <p
          v-if="foldersStore.shareError || localError"
          class="m-0 rounded-[0.85rem] border border-rose-500/30 bg-rose-500/10 dark:bg-rose-500/15 px-4 py-3 text-[0.88rem] text-rose-700 dark:text-rose-300 font-medium"
        >
          {{ localError ?? foldersStore.shareError }}
        </p>

        <p
          v-if="localNotice"
          class="m-0 rounded-[0.85rem] border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-[0.88rem] font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
          role="status"
        >
          {{ localNotice }}
        </p>

        <section class="grid gap-1 rounded-[1rem] border border-accent/25 bg-accent-soft/50 p-4 sm:p-4.5">
          <div class="flex items-center gap-2 text-text">
            <span class="i-fluent-shield-keyhole-20-regular h-5 w-5 text-accent-strong" aria-hidden="true" />
            <h3 class="m-0 text-[0.92rem] font-semibold">{{ t('folder.shareModal.accessSummaryTitle') }}</h3>
          </div>
          <p class="m-0 text-[0.84rem] leading-relaxed text-muted">{{ accessSummary }}</p>
          <p class="m-0 text-[0.78rem] leading-relaxed text-muted">{{ t('folder.shareModal.independentMethods') }}</p>
        </section>

        <section v-if="foldersStore.sharePublicAccess" class="grid gap-[0.75rem] rounded-[1rem] border border-border/70 bg-surface-alt/50 p-4 sm:p-4.5">
          <div class="flex items-center justify-between gap-3">
            <h3 class="m-0 text-[0.92rem] sm:text-[0.95rem] font-semibold text-text">{{ t('folder.shareModal.publicUrl') }}</h3>
            <button class="share-icon-button cursor-pointer" type="button" :title="t('common.copy')" @click="copyText(publicFolderUrl)">
              <span class="i-fluent-copy-20-regular h-4.5 w-4.5" aria-hidden="true" />
            </button>
          </div>
          <input class="share-url-input" type="text" :value="publicFolderUrl" readonly />
        </section>

        <section class="grid gap-[1rem] rounded-[1rem] border border-border/70 bg-surface-alt/50 p-4 sm:p-4.5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="grid max-w-[34rem] gap-1">
              <h3 class="m-0 text-[0.92rem] sm:text-[0.95rem] font-semibold text-text">{{ t('folder.shareModal.linkSection') }}</h3>
              <p class="m-0 text-[0.8rem] leading-relaxed text-muted">{{ t('folder.shareModal.linkDescription') }}</p>
            </div>
            <span class="rounded-full border border-border/60 bg-surface-hover px-2.5 py-0.5 text-[0.74rem] font-semibold text-muted">
              {{ activeLinkCountLabel }}
            </span>
          </div>

          <div class="grid gap-[0.75rem]">
            <div class="flex flex-wrap items-center gap-2.5 sm:gap-3">
              <div class="flex flex-wrap items-center gap-2" role="group" :aria-label="t('folder.shareModal.expiration')">
                <button
                  v-for="preset in expirationPresets"
                  :key="preset.value"
                  class="min-h-9 rounded-[0.75rem] border px-3.5 text-[0.82rem] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text/30 cursor-pointer"
                  :class="selectedPreset === preset.value ? 'border-text bg-text text-bg font-semibold shadow-xs' : 'border-border/80 bg-surface text-text hover:bg-surface-hover font-medium'"
                  type="button"
                  @click="selectedPreset = preset.value"
                >
                  {{ preset.label }}
                </button>
              </div>

              <button
                class="inline-flex min-h-9 items-center justify-center gap-2 rounded-[0.75rem] border border-transparent bg-text px-4 text-[0.85rem] font-semibold text-bg transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text/30 cursor-pointer sm:ml-2.5"
                type="button"
                :disabled="foldersStore.loadingShare"
                @click="createLink"
              >
                <span class="i-fluent-link-add-20-regular h-4.5 w-4.5" aria-hidden="true" />
                {{ foldersStore.loadingShare ? t('folder.shareModal.creating') : t('folder.shareModal.createLink') }}
              </button>
            </div>

            <label v-if="selectedPreset === 'custom'" class="grid gap-[0.35rem] text-[0.85rem] font-semibold text-text max-w-xs">
              {{ t('folder.shareModal.customExpiration') }}
              <input v-model="customExpiresAtLocal" class="share-url-input" type="datetime-local" />
            </label>
          </div>

          <div v-if="createdShareUrl" class="grid gap-[0.55rem] rounded-[0.85rem] border border-emerald-500/30 bg-emerald-500/10 dark:bg-emerald-500/15 p-3.5">
            <div class="flex items-center justify-between gap-3">
              <strong class="text-[0.84rem] text-emerald-800 dark:text-emerald-300 font-semibold">{{ t('folder.shareModal.createdLink') }}</strong>
              <button class="share-icon-button share-icon-button--emerald cursor-pointer" type="button" :title="t('common.copy')" @click="copyText(createdShareUrl)">
                <span class="i-fluent-copy-20-regular h-4.5 w-4.5" aria-hidden="true" />
              </button>
            </div>
            <input class="share-url-input share-url-input--emerald" type="text" :value="createdShareUrl" readonly />
          </div>

          <div class="grid gap-[0.55rem]">
            <article
              v-for="link in foldersStore.shareLinks"
              :key="link.id"
              class="grid gap-3 rounded-[0.85rem] border border-border/80 bg-surface p-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center shadow-xs"
            >
              <div class="grid gap-[0.2rem]">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-[0.88rem] font-semibold text-text">{{ formatExpiration(link.expiresAt) }}</span>
                  <span class="rounded-full border px-2.5 py-[0.18rem] text-[0.7rem] font-bold uppercase tracking-wider" :class="statusClass(link.status)">
                    {{ t(`folder.shareModal.status.${link.status}`) }}
                  </span>
                </div>
                <p class="m-0 text-[0.78rem] text-muted">
                  {{ t('folder.shareModal.linkMeta', { prefix: link.tokenPrefix ?? 'unknown', date: formatDate(link.createdAt) }) }}
                </p>
              </div>
              <button
                class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[0.7rem] border border-rose-500/25 bg-surface px-3 text-[0.82rem] font-semibold text-rose-600 dark:text-rose-400 transition-all hover:bg-rose-500/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30 cursor-pointer"
                type="button"
                :disabled="link.status === 'revoked' || foldersStore.loadingShare"
                @click="revokeLink(link.id)"
              >
                <span class="i-fluent-prohibited-20-regular h-4.5 w-4.5" aria-hidden="true" />
                {{ t('folder.shareModal.revoke') }}
              </button>
            </article>
            <p v-if="!foldersStore.loadingShare && foldersStore.shareLinks.length === 0" class="m-0 py-1 text-[0.86rem] text-muted text-center">
              {{ t('folder.shareModal.noLinks') }}
            </p>
          </div>
        </section>

        <section class="grid gap-[0.9rem] rounded-[1rem] border border-border/70 bg-surface-alt/50 p-4 sm:p-4.5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="grid max-w-[34rem] gap-1">
              <h3 class="m-0 text-[0.92rem] sm:text-[0.95rem] font-semibold text-text">{{ t('folder.shareModal.passwordSection') }}</h3>
              <p class="m-0 text-[0.8rem] leading-relaxed text-muted">{{ t('folder.shareModal.passwordDescription') }}</p>
            </div>
            <span class="rounded-full border border-border/60 bg-surface-hover px-2.5 py-0.5 text-[0.74rem] font-semibold text-muted">
              {{ foldersStore.sharePassword.enabled ? t('folder.shareModal.passwordEnabled') : t('folder.shareModal.passwordOff') }}
            </span>
          </div>

          <div class="grid gap-[0.6rem] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label class="grid gap-[0.35rem] text-[0.85rem] font-semibold text-text">
              {{ t('folder.shareModal.passwordLabel') }}
              <input
                v-model="password"
                class="share-url-input"
                type="password"
                autocomplete="new-password"
                maxlength="256"
                :placeholder="t('folder.shareModal.passwordPlaceholder')"
              />
            </label>
            <button
              class="inline-flex min-h-10 items-center justify-center gap-2 rounded-[0.75rem] border border-transparent bg-text px-4.5 text-[0.88rem] font-semibold text-bg transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text/30 cursor-pointer"
              type="button"
              :disabled="foldersStore.loadingShare"
              @click="savePassword"
            >
              <span class="i-fluent-key-20-regular h-5 w-5" aria-hidden="true" />
              {{ foldersStore.sharePassword.enabled ? t('folder.shareModal.changePassword') : t('folder.shareModal.setPassword') }}
            </button>
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <button
              class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[0.7rem] border border-border/80 bg-surface px-3 text-[0.82rem] font-semibold text-text transition-all hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text/30 cursor-pointer"
              type="button"
              @click="copyText(passwordShareUrl)"
            >
              <span class="i-fluent-copy-20-regular h-4.5 w-4.5" aria-hidden="true" />
              {{ t('folder.shareModal.copyPasswordUrl') }}
            </button>
            <button
              v-if="foldersStore.sharePassword.enabled"
              class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[0.7rem] border border-rose-500/25 bg-surface px-3 text-[0.82rem] font-semibold text-rose-600 dark:text-rose-400 transition-all hover:bg-rose-500/10 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30 cursor-pointer"
              type="button"
              :disabled="foldersStore.loadingShare"
              @click="removePassword"
            >
              <span class="i-fluent-delete-20-regular h-4.5 w-4.5" aria-hidden="true" />
              {{ t('folder.shareModal.removePassword') }}
            </button>
          </div>
          <p class="m-0 text-[0.78rem] leading-relaxed text-muted">{{ t('folder.shareModal.passwordSharingHint') }}</p>
        </section>
      </div>

      <footer class="flex justify-end border-t border-border/80 bg-surface/95 backdrop-blur-md px-5 py-3.5 sm:px-6">
        <button class="min-h-9.5 rounded-[0.75rem] border border-border/80 bg-surface-alt/60 px-4.5 text-[0.88rem] font-semibold text-text transition-all hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text/30 cursor-pointer" type="button" @click="$emit('cancel')">
          {{ t('common.close') }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { useFoldersStore } from '../stores/folders';
import type { FolderShareExpirationPreset, FolderShareLinkStatus, FolderSummary } from '../types/api';

const props = defineProps<{
  folder: FolderSummary;
}>();

defineEmits<{
  cancel: [];
}>();

const foldersStore = useFoldersStore();
const { locale, t } = useI18n();
const titleId = `folder-share-dialog-title-${Math.random().toString(36).slice(2, 10)}`;
const selectedPreset = ref<FolderShareExpirationPreset>('24h');
const customExpiresAtLocal = ref('');
const password = ref('');
const localError = ref<string | null>(null);
const localNotice = ref<string | null>(null);

const expirationPresets: Array<{ label: string; value: FolderShareExpirationPreset }> = [
  { label: t('folder.shareModal.presets.oneHour'), value: '1h' },
  { label: t('folder.shareModal.presets.day'), value: '24h' },
  { label: t('folder.shareModal.presets.week'), value: '7d' },
  { label: t('folder.shareModal.presets.custom'), value: 'custom' },
  { label: t('folder.shareModal.presets.unlimited'), value: 'unlimited' }
];

const activeLinkCount = computed(() => foldersStore.shareLinks.filter((link) => link.status === 'active').length);
const activeLinkCountLabel = computed(() =>
  t('folder.shareModal.activeLinks', {
    count: activeLinkCount.value
  })
);
const accessSummary = computed(() => {
  if (activeLinkCount.value > 0 && foldersStore.sharePassword.enabled) {
    return t('folder.shareModal.accessSummaryBoth', { count: activeLinkCount.value });
  }

  if (activeLinkCount.value > 0) {
    return t('folder.shareModal.accessSummaryLinks', { count: activeLinkCount.value });
  }

  if (foldersStore.sharePassword.enabled) {
    return t('folder.shareModal.accessSummaryPassword');
  }

  return t('folder.shareModal.accessSummaryNone');
});
const createdShareUrl = computed(() => (foldersStore.lastCreatedShareUrl ? toAbsoluteUrl(foldersStore.lastCreatedShareUrl) : null));
const publicFolderUrl = computed(() => toAbsoluteUrl(foldersStore.sharePublicFolderUrl ?? `/folders/${props.folder.slug}`));
const passwordShareUrl = computed(() => toAbsoluteUrl(`/share/${encodeURIComponent(props.folder.slug)}`));

function toAbsoluteUrl(url: string): string {
  if (typeof window === 'undefined') {
    return url;
  }

  return new URL(url, window.location.origin).toString();
}

function formatDate(value: string | null): string {
  if (!value) {
    return t('settings.status.never');
  }

  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function formatExpiration(value: string | null): string {
  return value ? t('folder.shareModal.expiresAt', { date: formatDate(value) }) : t('folder.shareModal.neverExpires');
}

function statusClass(status: FolderShareLinkStatus) {
  if (status === 'active') {
    return 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/25';
  }

  if (status === 'expired') {
    return 'bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25';
  }

  return 'bg-rose-500/12 text-rose-700 dark:text-rose-300 border-rose-500/25';
}

async function copyText(value: string | null) {
  if (!value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    localError.value = null;
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.append(textArea);
    textArea.select();
    document.execCommand('copy');
    textArea.remove();
  }
}

async function createLink() {
  localError.value = null;
  localNotice.value = null;

  try {
    await foldersStore.createShareLink(props.folder.slug, {
      expiresIn: selectedPreset.value,
      unlimited: selectedPreset.value === 'unlimited',
      customExpiresAt: selectedPreset.value === 'custom' ? new Date(customExpiresAtLocal.value).toISOString() : null
    });
    localNotice.value = t('folder.shareModal.notices.linkCreated');
  } catch (error) {
    localError.value = error instanceof Error ? error.message : t('folder.shareModal.errors.createLink');
  }
}

async function savePassword() {
  localError.value = null;
  localNotice.value = null;

  try {
    await foldersStore.setSharePassword(props.folder.slug, password.value);
    password.value = '';
    localNotice.value = t(
      activeLinkCount.value > 0
        ? 'folder.shareModal.notices.passwordEnabledWithLinks'
        : 'folder.shareModal.notices.passwordEnabled'
    );
  } catch (error) {
    localError.value = error instanceof Error ? error.message : t('folder.shareModal.errors.savePassword');
  }
}

async function revokeLink(linkId: number) {
  localError.value = null;
  localNotice.value = null;

  try {
    await foldersStore.revokeShareLink(props.folder.slug, linkId);
    localNotice.value = t(
      foldersStore.sharePassword.enabled
        ? 'folder.shareModal.notices.linkRevokedWithPassword'
        : 'folder.shareModal.notices.linkRevoked'
    );
  } catch (error) {
    localError.value = error instanceof Error ? error.message : t('folder.shareModal.errors.revokeLink');
  }
}

async function removePassword() {
  localError.value = null;
  localNotice.value = null;

  try {
    await foldersStore.removeSharePassword(props.folder.slug);
    localNotice.value = t(
      activeLinkCount.value > 0
        ? 'folder.shareModal.notices.passwordRemovedWithLinks'
        : 'folder.shareModal.notices.passwordRemoved'
    );
  } catch (error) {
    localError.value = error instanceof Error ? error.message : t('folder.shareModal.errors.removePassword');
  }
}

async function loadShareState() {
  try {
    await foldersStore.loadShareLinks(props.folder.slug);
  } catch {
    // The store-owned error is rendered in the dialog.
  }
}

onMounted(loadShareState);

watch(
  () => props.folder.slug,
  async () => {
    password.value = '';
    localError.value = null;
    localNotice.value = null;
    await loadShareState();
  }
);
</script>

<style scoped>
.share-url-input {
  width: 100%;
  min-height: 2.5rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.88rem;
  padding: 0.58rem 0.75rem;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  color-scheme: light dark;
}

.share-url-input:focus-visible,
.share-url-input:focus {
  outline: none;
  border-color: var(--text);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 18%, transparent);
}

.share-url-input--emerald {
  background: color-mix(in srgb, var(--surface) 90%, #10b981 10%);
  border-color: rgba(16, 185, 129, 0.35);
}

.share-icon-button {
  display: inline-flex;
  width: 2.25rem;
  height: 2.25rem;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
}

.share-icon-button:hover {
  background: var(--surface-hover);
  transform: translateY(-1px);
}

.share-icon-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 24%, transparent);
}

.share-icon-button--emerald {
  background: color-mix(in srgb, var(--surface) 90%, #10b981 10%);
  border-color: rgba(16, 185, 129, 0.35);
}

.share-icon-button--emerald:hover {
  background: color-mix(in srgb, var(--surface-hover) 85%, #10b981 15%);
}
</style>
