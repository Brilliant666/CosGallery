<template>
  <div class="source-status">
    <strong>{{ headline }}</strong>
    <small v-if="hasSource">来源 {{ item.sourceWorks }} 套 · 已知缺失 {{ item.missingWorks }} 套</small>
    <small v-else>来源套数、缺失数量待确认</small>
    <small v-if="hasSource">{{ item.sourceState.deliveryMode === 'direct-share' ? '原分享已核验，暂存进度见 Stage2' : item.sourceState.deliveryReady ? (item.sourceState.deliveryEvidence === 'verified' ? (item.pendingSupplementalTitles?.length ? '编号作品网盘来源已核验' : '网盘来源已核验') : '历史网盘记录可用，尚未实时核验') : '网盘来源待确认' }}</small>
    <small v-if="hasSource">最近有效来源：{{ formatTime(item.latestSourceAt) }}</small>
    <small v-if="item.pendingSupplementalTitles?.length">{{ item.pendingSupplementalTitles.join('、') }}：附加内容待人工处理，不参与自动下载/入库</small>
    <small v-if="item.metadataTask">最近检查：{{ attemptLabel }} · {{ formatTime(item.metadataTask.updatedAt) }}</small>
    <details v-if="item.metadataTask">
      <summary>检查详情</summary>
      <small>任务 #{{ item.metadataTask.id }}</small>
      <small v-if="item.metadataTask.lastError">{{ item.metadataTask.lastError }}</small>
      <small v-if="item.metadataTask.claimedBy">执行者：{{ item.metadataTask.claimedBy }}</small>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CreatorSyncRow } from '../api/creator-sync';
const props = defineProps<{ item: CreatorSyncRow }>();
const hasSource = computed(() => props.item.sourceState.metadataAccepted);
const attemptLabel = computed(() => {
  const status = props.item.metadataTask?.status;
  return ({ pending: '等待检查', claimed: '检查已领取', completed: '检查已完成', failed: '检查失败', not_found: '未找到合集', cancelled: '检查已取消' } as Record<string, string>)[status ?? ''] ?? '状态待确认';
});
const headline = computed(() => {
  if (hasSource.value) return '已有有效来源';
  const status = props.item.metadataTask?.status;
  if (!status) return '尚未检查来源';
  if (status === 'not_found') return '上次检查未找到合集';
  if (status === 'failed') return '来源检查失败';
  if (status === 'pending') return '来源待检查';
  if (status === 'claimed') return '来源检查已领取';
  if (status === 'cancelled') return '来源检查已取消';
  return '尚未取得有效来源';
});
function formatTime(value: string | null) {
  if (!value) return '时间未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间待确认' : date.toLocaleString('zh-CN', { hour12: false });
}
</script>

<style scoped>
.source-status{display:grid;gap:.25rem;min-width:15rem;line-height:1.5}strong{font-weight:600}small{display:block;color:var(--muted)}summary{font-size:.85rem;color:var(--muted);cursor:pointer}details small{overflow-wrap:anywhere}summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
