<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-60 flex items-center justify-center bg-black/55 p-5" @click.self="cancel">
      <section ref="dialog" class="w-full max-w-md rounded-2xl border border-border bg-surface p-6 text-text shadow-xl" role="dialog" aria-modal="true" aria-labelledby="creator-gallery-labels-title" tabindex="-1" @keydown="handleKeydown">
        <h2 id="creator-gallery-labels-title" class="m-0 text-xl font-semibold">编辑分类</h2>
        <p class="mt-2 break-words">{{ creator.name }}</p>
        <p class="text-sm text-muted">可选择多个分类；这些分类会在图库中公开展示。</p>
        <p v-if="loading" role="status">正在读取分类…</p>
        <form v-else @submit.prevent="save">
          <fieldset :disabled="saving || !revision" class="m-0 grid grid-cols-2 gap-3 border-0 p-0">
            <legend class="sr-only">博主分类</legend>
            <label v-for="option in creatorGalleryLabelOptions" :key="option.value" class="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-border px-3 py-2">
              <input v-model="selected" type="checkbox" :value="option.value" class="h-4 w-4" />{{ option.label }}
            </label>
          </fieldset>
          <div class="mt-3 flex items-center gap-3">
            <button type="button" class="rounded-lg border border-border px-3 py-2 text-sm" :disabled="saving || !revision || !selected.length" @click="selected = []">清空分类</button>
            <span v-if="!selected.length" class="text-sm text-muted">未分类 · 仍在全部图库显示</span>
          </div>
          <p v-if="error" role="alert" class="mt-4 text-red-600">{{ error }}</p>
          <button v-if="conflict || !revision" type="button" class="mt-2 rounded-lg border border-border px-3 py-2" :disabled="saving" @click="load">重新读取分类</button>
          <div class="mt-6 flex justify-end gap-3">
            <button type="button" class="rounded-lg border border-border px-4 py-2" :disabled="saving" @click="cancel">取消</button>
            <button type="submit" class="rounded-lg border border-accent bg-accent px-4 py-2 font-semibold text-white" :disabled="saving || !revision || conflict">{{ saving ? '正在保存…' : '保存分类' }}</button>
          </div>
        </form>
        <button v-if="loading" type="button" class="mt-4 rounded-lg border border-border px-4 py-2" @click="cancel">取消</button>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fetchCreatorGalleryLabels, updateCreatorGalleryLabels } from '../api/gallery';
import { RequestError } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useCreatorReadingStore } from '../stores/creator-reading';
import type { CosGalleryCreator, CreatorGalleryLabel } from '../types/api';
import { creatorGalleryLabelOptions } from '../utils/creator-gallery-labels';

const props = defineProps<{ creator: CosGalleryCreator }>();
const emit = defineEmits<{ close: []; saved: [labels: CreatorGalleryLabel[]] }>();
const auth = useAuthStore();
const reading = useCreatorReadingStore();
const selected = ref<CreatorGalleryLabel[]>([]);
const revision = ref('');
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const conflict = ref(false);
const dialog = ref<HTMLElement | null>(null);
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
let requestToken = 0;
async function load() {
  if (!auth.isAdmin) { emit('close'); return; }
  const token = ++requestToken;
  loading.value = true;
  error.value = '';
  try {
    const state = await fetchCreatorGalleryLabels(props.creator.id);
    if (token !== requestToken || !auth.isAdmin) return;
    selected.value = [...state.galleryLabels];
    revision.value = state.revision;
    conflict.value = false;
  } catch (reason) {
    if (token === requestToken) error.value = reason instanceof Error ? reason.message : '无法读取分类';
  } finally {
    if (token === requestToken) loading.value = false;
  }
}
async function save() {
  if (saving.value || !revision.value || conflict.value || !auth.isAdmin) return;
  const token = ++requestToken;
  saving.value = true;
  error.value = '';
  try {
    const labels = creatorGalleryLabelOptions.filter(option => selected.value.includes(option.value)).map(option => option.value);
    const state = await updateCreatorGalleryLabels(props.creator.id, labels, revision.value);
    if (token !== requestToken || !auth.isAdmin) return;
    reading.invalidate();
    emit('saved', state.galleryLabels);
    emit('close');
  } catch (reason) {
    if (token !== requestToken) return;
    conflict.value = reason instanceof RequestError && reason.status === 409;
    error.value = conflict.value ? '分类已被其他操作修改。请重新读取最新分类，再确认并保存。' : reason instanceof Error ? reason.message : '无法保存分类';
  } finally {
    if (token === requestToken) saving.value = false;
  }
}
function cancel() { if (!saving.value) emit('close'); }
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  if (event.key !== 'Tab') return;
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
  const first = controls[0], last = controls.at(-1);
  if (!first || !last) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first.focus(); }
}
watch(() => auth.isAdmin, isAdmin => { if (!isAdmin) { requestToken += 1; emit('close'); } });
onMounted(async () => { await nextTick(); dialog.value?.focus(); void load(); });
onBeforeUnmount(() => { requestToken += 1; if (previousFocus?.isConnected) previousFocus.focus(); });
</script>
