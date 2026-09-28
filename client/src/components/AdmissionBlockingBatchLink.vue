<template>
  <RouterLink v-if="batch.blockingBatch" data-test="admission-blocking-batch" :to="batch.blockingBatch.collectionId
    ? { name: 'local-admission-workspace', query: { collection: batch.blockingBatch.collectionId } }
    : { name: 'local-admission', params: { creatorId: batch.creatorId }, query: { batch: batch.blockingBatch.batchId } }">查看所属批次</RouterLink>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { AdmissionBatch } from '../types/local-admission';

defineProps<{ batch: Pick<AdmissionBatch, 'creatorId' | 'blockingBatch'> }>();
</script>
