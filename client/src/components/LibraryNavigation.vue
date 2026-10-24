<template>
  <div ref="container" class="library-nav" :class="[`library-nav--${variant}`, { 'library-nav--open': open, 'library-nav--collapsed': isCollapsed }]" @keydown.esc.stop="closeMenu(true)">
    <div class="library-nav__row" :class="{ 'library-nav__row--active': active }">
      <RouterLink custom :to="{ name: 'library', query: {} }" v-slot="{ href }"><a ref="allLink" :href="href" class="library-nav__all" aria-label="图库" @click="showAll">
        <span class="library-nav__icon i-fluent-folder-16-regular" aria-hidden="true" />
        <span class="library-nav__title">图库</span>
      </a></RouterLink>
      <button ref="toggle" type="button" class="library-nav__toggle" aria-label="展开图库分类" :aria-expanded="open" :aria-controls="menuId" :aria-hidden="isCollapsed || undefined" :disabled="isCollapsed" :tabindex="isCollapsed ? -1 : undefined" @click="toggleMenu">
        <span class="i-fluent-chevron-down-16-regular" :class="{ 'rotate-180': open }" aria-hidden="true" />
      </button>
    </div>
    <Transition name="library-categories" @before-enter="restoreMenuInteraction" @before-leave="disableMenuInteraction" @leave-cancelled="restoreMenuInteraction">
      <div v-if="menuVisible" :id="menuId" ref="menu" class="library-nav__menu" aria-label="图库分类">
        <div class="library-nav__menu-clip">
          <div class="library-nav__options">
            <RouterLink v-for="option in creatorGalleryLabelOptions" :key="option.value"
              :to="{ name: 'library', query: { label: option.value } }"
              :aria-current="active && route.query.label === option.value ? 'page' : undefined"
              @click="emit('navigate')">
              <span class="library-nav__category-icon" :class="categoryIcons[option.value]" aria-hidden="true" />
              <span>{{ option.label }}</span>
            </RouterLink>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useCreatorReadingStore } from '../stores/creator-reading';
import { creatorGalleryLabelOptions, isGalleryReadingRoute, parseCreatorGalleryLabel } from '../utils/creator-gallery-labels';

const props = withDefaults(defineProps<{ variant?: 'desktop' | 'mobile'; collapsed?: boolean }>(), { variant: 'desktop', collapsed: false });
const emit = defineEmits<{ navigate: []; 'open-change': [open: boolean] }>();
const route = useRoute();
const router = useRouter();
const reading = useCreatorReadingStore();
const open = ref(false);
const container = ref<HTMLElement | null>(null);
const allLink = ref<HTMLAnchorElement | null>(null);
const toggle = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuId = `library-categories-${props.variant}`;
const active = computed(() => isGalleryReadingRoute(route.name));
const isCollapsed = computed(() => props.variant === 'desktop' && props.collapsed);
const menuVisible = computed(() => open.value && !isCollapsed.value);
const categoryIcons = {
  cosplay: 'i-fluent-person-star-20-regular',
  portrait: 'i-fluent-camera-20-regular',
  selfie: 'i-fluent-phone-20-regular',
  fuliji: 'i-fluent-sparkle-20-regular'
};
function closeMenu(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) (isCollapsed.value ? allLink.value : toggle.value)?.focus();
}
function toggleMenu() { open.value = !open.value; emit('navigate'); }
function disableMenuInteraction(element: Element) {
  element.setAttribute('inert', '');
  element.setAttribute('aria-hidden', 'true');
  element.querySelectorAll<HTMLElement>('a, button').forEach(link => { link.tabIndex = -1; });
}
function restoreMenuInteraction(element: Element) {
  element.removeAttribute('inert');
  element.removeAttribute('aria-hidden');
  element.querySelectorAll('a, button').forEach(link => { link.removeAttribute('tabindex'); });
}
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
function outside(event: PointerEvent) {
  const target = event.target as Node;
  // Folding this sidebar only hides its categories; the user's open choice survives.
  const sidebarToggle = props.variant === 'desktop'
    ? container.value?.closest('.sidebar')?.querySelector('[data-test="sidebar-toggle"]')
    : null;
  if (sidebarToggle?.contains(target)) return;
  if (!container.value?.contains(target)) closeMenu();
}
watch(menuVisible, visible => {
  if (!visible && menu.value?.contains(document.activeElement)) {
    (isCollapsed.value ? allLink.value : toggle.value)?.focus();
  }
}, { flush: 'sync' });
watch(isCollapsed, collapsed => {
  if (collapsed && document.activeElement === toggle.value) allLink.value?.focus();
}, { flush: 'sync' });
watch(() => route.fullPath, () => {
  // Keep the four categories available while switching between their lists.
  if (route.name !== 'library' || !parseCreatorGalleryLabel(route.query.label)) closeMenu();
});
watch(open, value => emit('open-change', value), { flush: 'sync' });
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => { document.removeEventListener('pointerdown', outside); emit('open-change', false); });
</script>

<style scoped>
.library-nav { position: relative; min-width: 0; flex-shrink: 0; }
.library-nav__row { position: relative; display: flex; align-items: center; border-radius: 1rem; }
.library-nav__row--active { background: var(--surface-hover); font-weight: 700; }
.library-nav__all { display: flex; min-width: 0; min-height: 3rem; align-items: center; gap: 1rem; padding: .7rem .75rem; border-radius: inherit; color: var(--text); text-decoration: none; flex: 1; }
.library-nav__icon { width: 1.45rem; height: 1.45rem; flex-shrink: 0; }
.library-nav__title { flex-shrink: 0; font-size: .9rem; white-space: nowrap; }
.library-nav__toggle { display: flex; flex-shrink: 0; justify-content: center; align-items: center; width: 2.25rem; min-height: 3rem; border: 0; border-radius: .75rem; background: transparent; color: var(--text); cursor: pointer; }
.library-nav__toggle span { width: 1rem; height: 1rem; transition: transform var(--sidebar-width-duration, 180ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)); }
.library-nav__all:hover, .library-nav__toggle:hover, .library-nav__menu a:hover { background: var(--surface-hover); }
.library-nav__all:focus-visible, .library-nav__toggle:focus-visible, .library-nav__menu a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.library-nav__menu { display: grid; grid-template-rows: 1fr; opacity: 1; }
.library-nav__menu-clip { min-height: 0; overflow: hidden; }
.library-nav__options { display: grid; gap: .2rem; }
.library-nav__menu a { display: flex; align-items: center; gap: .65rem; min-height: 2.75rem; padding: .65rem .85rem; border-radius: .6rem; color: color-mix(in srgb, var(--text) 75%, var(--muted)); font-size: .9rem; text-decoration: none; white-space: nowrap; }
.library-nav__category-icon { width: 1.1rem; height: 1.1rem; flex-shrink: 0; }
.library-nav__menu a[aria-current='page'] { color: var(--accent-strong); background: var(--accent-soft); font-weight: 700; }
.library-nav--desktop .library-nav__row { overflow: hidden; }
.library-nav--desktop .library-nav__all { padding-inline-end: 2.25rem; }
.library-nav--desktop .library-nav__toggle { position: absolute; right: 0; top: 0; }
.library-nav--desktop .library-nav__options { width: calc(var(--sidebar-expanded-width, 15rem) - 3.35rem); margin: .35rem 0 .2rem 1.45rem; padding: .15rem 0 .15rem 1.5rem; border-inline-start: 1px solid var(--border); }
.library-nav--desktop .library-nav__menu a { padding-inline-start: .75rem; }
.library-nav--desktop .library-nav__title, .library-nav--desktop .library-nav__toggle { opacity: 1; transition: opacity var(--sidebar-width-duration, 180ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)); }
.library-nav--collapsed .library-nav__title, .library-nav--collapsed .library-nav__toggle { opacity: 0; }
.library-nav--collapsed .library-nav__toggle { visibility: hidden; pointer-events: none; }
.library-categories-enter-active, .library-categories-leave-active { transition: grid-template-rows var(--sidebar-width-duration, 180ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)), opacity var(--sidebar-width-duration, 180ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)); }
.library-categories-enter-from, .library-categories-leave-to { grid-template-rows: 0fr; opacity: 0; }
.library-categories-leave-active { pointer-events: none; }
.library-nav--mobile { flex-shrink: 0; }
.library-nav--mobile .library-nav__all { padding: .5rem .35rem; min-height: 2.75rem; }
.library-nav--mobile .library-nav__icon { display: none; }
.library-nav--mobile .library-nav__toggle { min-height: 2.75rem; width: 2rem; }
.library-nav--mobile .library-nav__menu { position: absolute; bottom: calc(100% + .75rem); left: 50%; transform: translateX(-50%); width: 9rem; padding: .3rem; border: 1px solid var(--border); border-radius: .9rem; background: var(--bg); box-shadow: var(--shadow); }

@media (prefers-reduced-motion: reduce) {
  .library-nav__toggle span,
  .library-nav--desktop .library-nav__title,
  .library-nav--desktop .library-nav__toggle,
  .library-categories-enter-active,
  .library-categories-leave-active { transition: none; }
}
</style>
