<template>
  <div v-if="folders.length && authStore.canManageLibrary" class="text-sm text-muted" data-test="creator-folder-actions">
    <ul class="m-0 grid list-none gap-3 p-0 text-left">
      <li v-for="folder in folders" :key="folder.id" class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="break-words text-text">{{ folder.name }} · {{ folder.workCount }} 套</span>
        <div class="flex flex-wrap gap-3">
          <button type="button" :disabled="busy" :aria-label="`编辑目录资料：${folder.name}`" @click="open(folder, 'profile')">编辑目录资料</button>
          <button type="button" :disabled="busy" :aria-label="`分享此目录：${folder.name}`" @click="open(folder, 'share')">分享此目录</button>
        </div>
      </li>
    </ul>
    <p v-if="fetching" role="status">正在加载目录资料…</p>
    <p v-if="error && !selected" role="alert">{{ error }}</p>
    <FolderProfileModal v-if="selected && mode === 'profile'" :key="selected.id" :initial-name="selected.name" :initial-description="selected.description" :scope="`仅修改目录资料：${selected.folderPath}`" :loading="saving" :error="error" @cancel="close" @save="saveProfile" />
    <FolderShareModal v-if="selected && mode === 'share'" :key="selected.id" :folder="selected" @cancel="close" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { fetchFolder, updateFolderProfile } from '../api/gallery';
import { useAuthStore } from '../stores/auth';
import type { CosGalleryCreator, FolderSummary } from '../types/api';
import FolderProfileModal from './FolderProfileModal.vue';
import FolderShareModal from './FolderShareModal.vue';

type LocalFolder = NonNullable<CosGalleryCreator['localFolders']>[number];
const props = defineProps<{ folders: LocalFolder[] }>();
const emit = defineEmits<{ updated: [folder: FolderSummary] }>();
const authStore = useAuthStore();
const selected = shallowRef<FolderSummary | null>(null);
const mode = ref<'profile' | 'share'>('profile');
const fetching = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const busy = computed(() => fetching.value || saving.value);
let operation = 0;

function close() {
  operation += 1;
  selected.value = null;
  fetching.value = false;
  error.value = null;
}

async function open(folder: LocalFolder, action: 'profile' | 'share') {
  if (!authStore.canManageLibrary || busy.value) return;
  const token = ++operation;
  error.value = null;
  fetching.value = true;
  try {
    const detail = await fetchFolder(folder.slug);
    if (token !== operation || !authStore.canManageLibrary) return;
    selected.value = detail;
    mode.value = action;
  } catch (cause) {
    if (token === operation) error.value = cause instanceof Error ? cause.message : '无法加载目录资料';
  } finally {
    if (token === operation) fetching.value = false;
  }
}

async function saveProfile(data: { name: string; description: string | null }) {
  if (!selected.value || saving.value || !authStore.canManageLibrary) return;
  const folder = selected.value;
  const token = operation;
  saving.value = true;
  error.value = null;
  try {
    const updated = await updateFolderProfile(folder.slug, data.name, data.description);
    // A completed save still updates its row if the user dismissed the dialog meanwhile.
    if (authStore.canManageLibrary) emit('updated', updated);
    if (token === operation) close();
  } catch (cause) {
    if (token === operation) error.value = cause instanceof Error ? cause.message : '无法保存目录资料';
  } finally {
    saving.value = false;
  }
}

watch(() => authStore.canManageLibrary, (allowed) => { if (!allowed) close(); });
onBeforeUnmount(close);
</script>
