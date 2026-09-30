<template>
  <div v-if="summary" class="admission-error-notice">
    <p class="error" role="alert" data-test="admission-error-message">{{ summary }} <slot /></p>
    <details v-if="error || issue" data-test="admission-error-detail"><summary>技术详情</summary>
      <p v-if="error" class="technical-detail">{{ error }}</p>
      <p v-if="issue?.detail && issue.detail !== error" class="technical-detail">{{ issue.detail }}</p>
      <p v-if="issue?.code">错误代码：{{ issue.code }}</p>
      <p v-if="issue?.blockedByItemKey">依赖项目：{{ issue.blockedByItemKey }}</p>
    </details>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { admissionErrorMessage } from '../utils/admission-execution-display';
import type { AdmissionExecutionIssue } from '../types/local-admission';
const props = defineProps<{ error?: string | null; message?: string | null; issue?: AdmissionExecutionIssue }>();
const summary = computed(() => admissionErrorMessage(props.error, props.message ?? props.issue?.message));
</script>
<style scoped>
.error{color:#bb2938;white-space:pre-wrap;overflow-wrap:anywhere}.technical-detail{white-space:pre-wrap;overflow-wrap:anywhere}details{font-size:.8rem;line-height:1.6}summary{cursor:pointer}
</style>
