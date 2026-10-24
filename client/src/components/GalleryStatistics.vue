<template>
  <section class="gallery-statistics" :aria-label="t('galleryStatistics.title')">
    <h2>{{ t('galleryStatistics.title') }}</h2>
    <dl>
      <div v-for="row in rows" :key="row.key" :data-stat="row.key">
        <dt>{{ row.label }}</dt>
        <dd :title="row.exact" :aria-label="row.exact">{{ row.display }}</dd>
      </div>
    </dl>
    <p v-if="unavailable" class="gallery-statistics__status">{{ t('galleryStatistics.unavailable') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';

const { t, locale } = useI18n();
const app = useAppStore();
const unavailable = computed(() => app.isLibraryUnavailable || Boolean(app.error));
const rows = computed(() => (['creators', 'works', 'photos'] as const).map(key => {
  const count = unavailable.value ? undefined : app.stats?.galleryStatistics?.[key];
  const valid = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  const label = t(`galleryStatistics.${key}`);
  return {
    key,
    label,
    exact: valid ? `${label}: ${new Intl.NumberFormat(locale.value).format(count)}` : t('galleryStatistics.pending'),
    display: valid ? (count >= 1000 ? `${(count / 1000).toFixed(1)}K` : String(count)) : '—'
  };
}));
</script>

<style scoped>
.gallery-statistics { color: var(--text); }
.gallery-statistics h2 { margin: 0 0 .65rem; font-size: .85rem; font-weight: 650; }
.gallery-statistics dl { margin: 0; display: grid; gap: .45rem; }
.gallery-statistics dl > div {
  display: flex; align-items: center; justify-content: space-between; gap: .75rem;
  border-radius: .7rem; padding: .55rem .7rem;
  background: color-mix(in srgb, var(--surface) 70%, var(--bg) 30%);
}
.gallery-statistics dt { color: var(--muted); font-size: .8rem; white-space: nowrap; }
.gallery-statistics dd { margin: 0; font-size: 1.1rem; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--accent); }
.gallery-statistics__status { margin: .5rem 0 0; color: var(--muted); font-size: .72rem; }
</style>
