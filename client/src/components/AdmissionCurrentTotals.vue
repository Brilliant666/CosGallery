<template>
  <div v-if="totals" class="current-totals" data-test="current-disposition-totals">
    <p v-if="totals.completedLater"><strong>{{ totals.pending?'后续部分覆盖':'未完成历史项已由后续覆盖' }}</strong> · 后续已完成 {{ totals.completedLater }} 项 · 当前仍需核对 {{ totals.pending }} 项</p>
    <p v-else>当前仍需核对 {{ totals.pending }} 项 · 后续已完成 0 项</p>
    <p v-if="totals.unresolved" class="hint">{{ totals.unresolved }} 项缺少可靠后续完成证据；不代表这些历史目录各自仍是一套待入库作品。</p>
    <p v-if="totals.completedLater" class="hint">原状态与错误仅记录当时执行；不改成历史成功，不重放原确认计划。尚未开始的其他目录请独立重新核对，已移动项保留原检查点。</p>
  </div>
</template>
<script setup lang="ts">
import type { AdmissionCurrentTotals } from '../types/local-admission';
defineProps<{totals?:AdmissionCurrentTotals}>();
</script>
<style scoped>
.current-totals p{margin:.45rem 0;font-size:.84rem;line-height:1.6}.hint{font-size:.78rem!important;opacity:.76}
</style>
