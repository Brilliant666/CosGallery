<template>
  <section class="card p-8 text-center border-red-500/30">
    <h2 class="text-text">{{ title }}</h2>
    <p class="m-0 text-muted">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  message: string;
}>();
</script>
