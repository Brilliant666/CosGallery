<template>
  <details class="mt-2 max-w-[30rem]" data-test="ingest-performance">
    <summary class="cursor-pointer font-semibold text-accent">执行耗时{{ latest ? ` · ${seconds(latest.durationMs)}` : ' · 未记录' }}</summary>
    <template v-if="latest">
      <p class="my-1 text-muted">{{ operation }} · {{ latest.status }} · 本次执行，非累计耗时</p>
      <p v-if="latest.errorCode" class="my-1 text-red-700">{{ latest.errorCode }} · 清理状态：{{ latest.cleanupStatus }}</p>
      <dl class="grid grid-cols-[minmax(8rem,1fr)_auto] gap-x-3 gap-y-1">
        <template v-for="phase in phases" :key="phase.key"><dt>{{ phase.label }}</dt><dd>{{ seconds(phase.ms) }}</dd></template>
      </dl>
      <small class="mt-1 block text-muted">未列步骤可能未执行或复用结果；总耗时另含流程管理开销。最多保留最近5次记录。</small>
    </template>
    <p v-else class="my-1 text-muted">旧任务未记录分阶段耗时，不追溯估算，也无需重跑。</p>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ performance?: unknown }>();
const labels: Record<string, string> = {
  source_hash: '源压缩包哈希', outer_list: '外层目录安全校验', outer_test: '外层压缩包测试', outer_extract: '外层解压',
  inner_list: '内层目录安全校验', inner_test: '内层压缩包测试', inner_extract: '内层解压',
  media_validation: '媒体校验', staging_copy: '暂存文件复制', final_commit: '提交至图库',
  gallery_index: '图库索引', ledger_reconciliation: '账本对账', index_ledger_reconciliation: '索引与账本（未细分）', cleanup: '回收清理'
};
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function validMs(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
const latest = computed(() => {
  const p = object(props.performance);
  const run = p?.version === 1 ? object(p.latest) : null;
  return run && validMs(run.durationMs) ? run : null;
});
const operation = computed(() => ({run:'入库执行',reconcile:'对账重试',cleanup:'回收重试',manual_placement:'人工接收'}[String(latest.value?.operation)] ?? '任务执行'));
const phases = computed(() => {
  const values = object(latest.value?.phases);
  return Object.entries(labels).flatMap(([key,label]) => validMs(values?.[key]) ? [{key,label,ms:values![key] as number}] : []);
});
function seconds(value: unknown) { return validMs(value) ? `${(value / 1000).toFixed(2)} 秒` : '未记录'; }
</script>
