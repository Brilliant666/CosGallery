<template>
  <section class="mx-auto w-full max-w-[92rem] px-1 pb-12 sm:px-4 lg:px-7">
    <header class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted">Creator Admission</p>
        <h1 class="m-0 text-2xl font-semibold sm:text-3xl">博主入库</h1>
        <p class="mt-2 mb-0 text-sm text-muted">选择资源收录途径；切换模块不会开始执行或取消后台任务。</p>
      </div>
      <RouterLink :to="{ name: 'archive-catalog', query: { workspace: 'roster' } }" class="text-sm text-accent">图库账本</RouterLink>
    </header>
    <nav aria-label="入库方式" class="mb-6 flex flex-wrap gap-2 border-b border-border pb-4">
      <RouterLink :to="localLocation" :aria-current="module === 'local' ? 'page' : undefined" class="rounded-xl border px-5 py-3 text-sm font-semibold" :class="module === 'local' ? 'border-accent bg-accent text-white' : 'border-border bg-surface'">本地入库</RouterLink>
      <RouterLink :to="costuanLocation" :aria-current="module === 'costuan' ? 'page' : undefined" class="rounded-xl border px-5 py-3 text-sm font-semibold" :class="module === 'costuan' ? 'border-accent bg-accent text-white' : 'border-border bg-surface'">Costuan</RouterLink>
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
