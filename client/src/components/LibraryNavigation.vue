<template>
  <div ref="container" class="library-nav" :class="[`library-nav--${variant}`, { 'library-nav--open': open }]" @keydown.esc.stop="closeMenu(true)">
    <div class="library-nav__row" :class="{ 'library-nav__row--active': active }">
      <RouterLink custom :to="{ name: 'library', query: {} }" v-slot="{ href }"><a :href="href" class="library-nav__all" aria-label="图库" @click="showAll">
        <span class="library-nav__icon i-fluent-folder-16-regular" aria-hidden="true" />
        <span class="library-nav__title">图库</span>
      </a></RouterLink>
      <button ref="toggle" type="button" class="library-nav__toggle" aria-label="展开图库分类" :aria-expanded="open" :aria-controls="menuId" @click="toggleMenu">
        <span class="i-fluent-chevron-down-16-regular" :class="{ 'rotate-180': open }" aria-hidden="true" />
      </button>
    </div>
    <div v-if="open" :id="menuId" class="library-nav__menu" aria-label="图库分类">
      <RouterLink v-for="option in creatorGalleryLabelOptions" :key="option.value"
        :to="{ name: 'library', query: { label: option.value } }"
        :aria-current="active && route.query.label === option.value ? 'page' : undefined"
        @click="emit('navigate')">
        <span class="library-nav__category-icon" :class="categoryIcons[option.value]" aria-hidden="true" />
        <span>{{ option.label }}</span>
      </RouterLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useCreatorReadingStore } from '../stores/creator-reading';
import { creatorGalleryLabelOptions, isGalleryReadingRoute, parseCreatorGalleryLabel } from '../utils/creator-gallery-labels';

const props = withDefaults(defineProps<{ variant?: 'desktop' | 'mobile' }>(), { variant: 'desktop' });
const emit = defineEmits<{ navigate: []; 'open-change': [open: boolean] }>();
const route = useRoute();
const router = useRouter();
const reading = useCreatorReadingStore();
const open = ref(false);
const container = ref<HTMLElement | null>(null);
const toggle = ref<HTMLButtonElement | null>(null);
const menuId = `library-categories-${props.variant}`;
const active = computed(() => isGalleryReadingRoute(route.name));
const categoryIcons = {
  cosplay: 'i-fluent-person-star-20-regular',
  portrait: 'i-fluent-camera-20-regular',
  selfie: 'i-fluent-phone-20-regular',
  fuliji: 'i-fluent-sparkle-20-regular'
};
function closeMenu(restoreFocus = false) { open.value = false; if (restoreFocus) toggle.value?.focus(); }
function toggleMenu() { open.value = !open.value; emit('navigate'); }
async function showAll(event: MouseEvent) {
  closeMenu();
  emit('navigate');
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  reading.libraryNavigationIntent = 'reset';
  await router.push({ name: 'library', query: {} });
  // A repeated click on /library does not trigger a route update.
  if (reading.libraryNavigationIntent === 'reset') reading.libraryResetVersion += 1;
}
function outside(event: PointerEvent) { if (!container.value?.contains(event.target as Node)) closeMenu(); }
watch(() => route.fullPath, () => {
  // Keep the four categories available while switching between their lists.
  if (route.name !== 'library' || !parseCreatorGalleryLabel(route.query.label)) closeMenu();
});
watch(open, value => emit('open-change', value), { flush: 'sync' });
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => { document.removeEventListener('pointerdown', outside); emit('open-change', false); });
</script>

<style scoped>
.library-nav { position: relative; min-width: 0; }
.library-nav__row { display: flex; align-items: center; border-radius: 1rem; }
.library-nav__row--active { background: var(--surface-hover); font-weight: 700; }
.library-nav__all { display: flex; min-width: 0; min-height: 3rem; align-items: center; gap: 1rem; padding: .7rem .75rem; border-radius: inherit; color: var(--text); text-decoration: none; flex: 1; }
.library-nav__icon { width: 1.45rem; height: 1.45rem; flex-shrink: 0; }
.library-nav__title { font-size: .9rem; white-space: nowrap; }
.library-nav__toggle { display: flex; flex-shrink: 0; justify-content: center; align-items: center; width: 2.25rem; min-height: 3rem; border: 0; border-radius: .75rem; background: transparent; color: var(--text); cursor: pointer; }
.library-nav__toggle span { width: 1rem; height: 1rem; }
.library-nav__all:hover, .library-nav__toggle:hover, .library-nav__menu a:hover { background: var(--surface-hover); }
.library-nav__all:focus-visible, .library-nav__toggle:focus-visible, .library-nav__menu a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.library-nav__menu { display: grid; gap: .2rem; }
.library-nav__menu a { display: flex; align-items: center; gap: .65rem; min-height: 2.75rem; padding: .65rem .85rem; border-radius: .6rem; color: color-mix(in srgb, var(--text) 75%, var(--muted)); font-size: .9rem; text-decoration: none; white-space: nowrap; }
.library-nav__category-icon { width: 1.1rem; height: 1.1rem; flex-shrink: 0; }
.library-nav__menu a[aria-current='page'] { color: var(--accent-strong); background: var(--accent-soft); font-weight: 700; }
.library-nav--desktop .library-nav__menu { margin: .35rem 0 .2rem 1.45rem; padding: .15rem 0 .15rem 1.5rem; border-inline-start: 1px solid var(--border); }
.library-nav--desktop .library-nav__menu a { padding-inline-start: .75rem; }
.library-nav--desktop .library-nav__title, .library-nav--desktop .library-nav__toggle { display: none; }
.library-nav--desktop.library-nav--open .library-nav__title { display: inline; }
.library-nav--desktop.library-nav--open .library-nav__toggle { display: flex; }
:global(.sidebar:hover .library-nav--desktop .library-nav__title), :global(.sidebar:focus-within .library-nav--desktop .library-nav__title) { display: inline; }
:global(.sidebar:hover .library-nav--desktop .library-nav__toggle), :global(.sidebar:focus-within .library-nav--desktop .library-nav__toggle) { display: flex; }
.library-nav--mobile { flex-shrink: 0; }
.library-nav--mobile .library-nav__all { padding: .5rem .35rem; min-height: 2.75rem; }
.library-nav--mobile .library-nav__icon { display: none; }
.library-nav--mobile .library-nav__toggle { min-height: 2.75rem; width: 2rem; }
.library-nav--mobile .library-nav__menu { position: absolute; bottom: calc(100% + .75rem); left: 50%; transform: translateX(-50%); width: 9rem; padding: .3rem; border: 1px solid var(--border); border-radius: .9rem; background: var(--bg); box-shadow: var(--shadow); }
</style>
