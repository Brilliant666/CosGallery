<template>
  <section class="card p-8 text-center">
    <h2 class="text-text">{{ title }}</h2>
    <p class="m-0 text-muted">{{ description }}</p>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  description: string;
}>();
</script>
