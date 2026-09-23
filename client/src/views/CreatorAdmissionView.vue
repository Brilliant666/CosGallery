<template>
  <section class="admission-shell mx-auto w-full max-w-[92rem] px-1 pb-12 sm:px-4 lg:px-6">
    <header class="mb-5">
      <div>
        <h1 class="m-0 text-2xl font-semibold sm:text-3xl">博主入库</h1>
        <p class="mt-2 mb-0 text-sm text-muted">本地已有图集直接入库；Costuan 资源按来源、暂存与入库分别处理。</p>
      </div>
    </header>
    <nav aria-label="入库方式" class="mb-5 flex gap-6 border-b border-border">
      <RouterLink :to="localLocation" :aria-current="module === 'local' ? 'page' : undefined" class="module-link border-b-2 px-1 py-3 text-sm font-semibold" :class="module === 'local' ? 'border-accent text-accent' : 'border-transparent text-muted'">本地入库</RouterLink>
      <RouterLink :to="costuanLocation" :aria-current="module === 'costuan' ? 'page' : undefined" class="module-link border-b-2 px-1 py-3 text-sm font-semibold" :class="module === 'costuan' ? 'border-accent text-accent' : 'border-transparent text-muted'">Costuan</RouterLink>
    </nav>
    <RouterView v-slot="{ Component, route: childRoute }">
      <KeepAlive :max="8">
        <component :is="Component" :key="childKey(childRoute)" />
      </KeepAlive>
    </RouterView>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, type RouteLocationNormalizedLoaded } from 'vue-router';
import { admissionModule } from '../utils/creator-admission-navigation';

const route = useRoute();
const module = computed(() => admissionModule(route));
const localLocation = ref('/creator-admission/local');
const costuanLocation = ref('/creator-admission/costuan?workspace=source');
// Only this mounted container's tab state; explicit links always take precedence.
watch(() => route.fullPath, () => {
  if (!route.matched.some(record => record.name === 'creator-admission')) return;
  if (module.value === 'local') localLocation.value = route.fullPath;
  else costuanLocation.value = route.fullPath;
}, { immediate: true });
function childKey(child: RouteLocationNormalizedLoaded) {
  if (child.name === 'local-admission') return `${String(child.name)}:${String(child.params.creatorId)}`;
  if (child.name === 'local-review') return `${String(child.name)}:${child.query.kind}:${child.query.creatorId}:${child.query.jobId ?? child.query.planId}:${child.query.itemKey ?? ''}`;
  return String(child.name);
}
</script>

<style scoped>
.admission-shell { min-width: 0; }
.module-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>
