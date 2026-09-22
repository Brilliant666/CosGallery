<template>
  <div v-if="disposition?.status==='completed_later'" class="later-completion" data-test="completed-later">
    <strong>后续已完成</strong>
    <p>Work #{{ disposition.workId }} · LocalWork #{{ disposition.localWorkId }}</p>
    <p v-if="disposition.completedAt&&disposition.completionTimeBasis==='batch_completed'">后续批次完成时间：{{ new Date(disposition.completedAt).toLocaleString('zh-CN',{hour12:false}) }}</p><p v-else>完成时间未单独记录</p>
    <p>依据同一目录范围的后续完成记录；原计划状态与错误保留，本项不再编辑或继续。</p>
    <div class="links"><RouterLink :to="disposition.collectionId?{name:'local-admission-workspace',query:{collection:disposition.collectionId}}:{name:'local-admission',params:{creatorId},query:{batch:disposition.batchId}}">查看后续结果</RouterLink><RouterLink v-if="disposition.postId" :to="{name:'canonical-work-gallery',params:{creatorId,postId:disposition.postId}}">查看后续图集</RouterLink></div>
  </div>
  <p v-else-if="disposition?.status==='unresolved'" class="unresolved" data-test="completion-unresolved">后续处置待核对：尚无可靠的完整覆盖证据；不等于确定未入库，不按历史容器条数推算剩余作品。</p>
</template>
<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { AdmissionCurrentDisposition } from '../types/local-admission';
defineProps<{disposition?:AdmissionCurrentDisposition;creatorId:number}>();
</script>
<style scoped>
.later-completion{font-size:.82rem;padding:.65rem;border-radius:.5rem;background:#8877aa14;overflow-wrap:anywhere}.later-completion p,.unresolved{font-size:.78rem;line-height:1.6;margin:.35rem 0}.links{display:flex;gap:1rem;flex-wrap:wrap}a{color:var(--accent,#7764b0)}.unresolved{opacity:.78}
</style>
