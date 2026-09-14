<template>
  <details class="mt-4 rounded-xl border border-border p-3" @toggle="onToggle">
    <summary class="cursor-pointer text-sm font-semibold">本地作品与来源关联说明（只读）</summary>
    <p class="text-xs text-muted">最近来源检查记录：本地已满足的作品无需再次获取；有歧义的条目保留待确认。这里不实时检查磁盘，也不执行关联或领取。</p>
    <button type="button" class="rounded-lg border border-border px-3 py-1 text-sm" :disabled="loading" @click="load(1)">刷新说明（只读）</button>
    <p v-if="loading" role="status">正在读取…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="result">
      <p v-if="!result.total" class="text-sm text-muted">暂无本地复用或待确认记录。</p>
      <ul class="list-none p-0 text-sm">
        <li v-for="(item, index) in result.items" :key="`${item.collectionId}-${item.sourceOrder}-${index}`" class="border-t border-border py-2">
          <strong>{{ item.creatorName }} · {{ item.rawTitle }}</strong>
          <p class="my-1">{{ item.status === 'review' ? '待确认' : '本地已有无需获取' }}</p>
          <p class="my-1 text-muted">{{ item.status === 'review' ? '待确认原因：' : '关联依据：' }}{{ item.reason }}</p>
        </li>
      </ul>
      <div class="flex items-center gap-3 text-sm">
        <button type="button" :disabled="loading || result.page <= 1" @click="load(result.page - 1)">上一页</button>
        <span>第 {{ result.page }} 页 · 共 {{ result.total }} 条</span>
        <button type="button" :disabled="loading || !result.hasMore" @click="load(result.page + 1)">下一页</button>
      </div>
    </template>
  </details>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { fetchSourceReuse, type SourceReusePage } from '../api/source-reuse';
const result = ref<SourceReusePage | null>(null);
const loading = ref(false);
const error = ref('');
async function load(page: number) {
  if (loading.value) return;
  loading.value = true; error.value = '';
  try { result.value = await fetchSourceReuse(page); }
  catch { error.value = '关联说明读取失败，请重试；未执行任何关联操作。'; }
  finally { loading.value = false; }
}
function onToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !result.value) void load(1);
}
</script>
