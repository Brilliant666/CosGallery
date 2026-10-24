<template>
  <aside
    ref="sidebar"
    class="sidebar flex h-full flex-col overflow-visible bg-bg px-[0.95rem] py-5 text-text"
    :class="{ 'sidebar--expanded': expanded }"
    @pointerenter="handlePointerEnter"
    @pointerleave="handlePointerLeave"
    @focusin="handleFocusIn"
    @focusout="handleFocusOut"
  >
    <RouterLink
      class="sidebar__brand relative inline-flex items-center justify-center w-12 h-12 p-[0.3rem] rounded-[1rem] color-inherit transition-[background-color,transform,opacity] duration-180 hover:bg-surface-hover hover:-translate-y-px"
      to="/"
      :aria-label="t('nav.foldergramHome')"
      :title="buildIdentity"
    >
      <span
        class="pointer-events-none absolute top-[0.16rem] left-1/2 -translate-x-1/2 text-[0.42rem] leading-none tracking-[0.08em] text-muted"
        aria-hidden="true"
      >
        {{ appVersion }}
      </span>
      <BrandMark />
    </RouterLink>

    <nav
      class="sidebar__nav flex flex-col flex-1 min-h-0 gap-[0.4rem] overflow-y-auto mt-5 [scrollbar-width:none]"
    >
      <RouterLink custom to="/" v-slot="{ href, navigate, isActive }">
        <a
          :href="href"
          class="sidebar__link sidebar-item"
          :class="isActive ? sidebarActiveClass : ''"
          @click="navigate"
        >
          <span
            class="sidebar__icon flex-shrink-0 w-[1.45rem] h-[1.45rem]"
            :class="
              isActive ? 'i-fluent-home-16-filled' : 'i-fluent-home-16-regular'
            "
            aria-hidden="true"
          />
          <span
            class="sidebar__label overflow-hidden whitespace-nowrap text-[0.9rem]"
            >{{ t('nav.home') }}</span
          >
        </a>
      </RouterLink>

      <RouterLink
        custom
        :to="{ name: 'reels' }"
        v-slot="{ href, navigate, isActive }"
      >
        <a
          :href="href"
          class="sidebar__link sidebar-item"
          :class="isActive ? sidebarActiveClass : ''"
          @click="navigate"
        >
          <span
            class="sidebar__icon flex-shrink-0 w-[1.45rem] h-[1.45rem]"
            :class="
              isActive
                ? 'i-fluent-play-circle-24-filled'
                : 'i-fluent-play-circle-24-regular'
            "
            aria-hidden="true"
          />
          <span
            class="sidebar__label overflow-hidden whitespace-nowrap text-[0.9rem]"
            >{{ t('nav.reels') }}</span
          >
        </a>
      </RouterLink>

      <RouterLink
        custom
        :to="{ name: 'explore' }"
        v-slot="{ href, navigate, isActive }"
      >
        <a
          :href="href"
          class="sidebar__link sidebar-item"
          :class="isActive ? sidebarActiveClass : ''"
          @click="navigate"
        >
          <span
            class="sidebar__icon flex-shrink-0 w-[1.45rem] h-[1.45rem]"
            :class="
              isActive
                ? 'i-fluent-search-16-filled'
                : 'i-fluent-search-16-regular'
            "
            aria-hidden="true"
          />
          <span
            class="sidebar__label overflow-hidden whitespace-nowrap text-[0.9rem]"
            >{{ t('nav.search') }}</span
          >
        </a>
      </RouterLink>

      <LibraryNavigation variant="desktop" :collapsed="!expanded" @navigate="closeMoreMenu" />

      <RouterLink
        v-if="showPlacesNav"
        custom
        :to="{ name: 'places' }"
        v-slot="{ href, navigate, isActive }"
      >
        <a
          :href="href"
          class="sidebar__link sidebar-item"
          :class="isActive || isPlacesRoute ? sidebarActiveClass : ''"
          @click="navigate"
        >
          <span
            class="sidebar__icon flex-shrink-0 w-[1.45rem] h-[1.45rem]"
            :class="
              isActive || isPlacesRoute
                ? 'i-fluent-location-20-filled'
                : 'i-fluent-location-20-regular'
            "
            aria-hidden="true"
          />
          <span
            class="sidebar__label overflow-hidden whitespace-nowrap text-[0.9rem]"
            >{{ t('nav.places') }}</span
          >
        </a>
      </RouterLink>

      <RouterLink
        v-if="authStore.canUseSavedItems"
        custom
        :to="{ name: 'likes' }"
        v-slot="{ href, navigate, isActive }"
      >
        <a
          :href="href"
          class="sidebar__link sidebar-item"
          :class="isActive ? sidebarActiveClass : ''"
          @click="navigate"
        >
          <span
            class="sidebar__icon flex-shrink-0 w-[1.58rem] h-[1.58rem]"
            :class="
              isActive
                ? 'i-fluent-heart-20-filled'
                : 'i-fluent-heart-20-regular'
            "
            aria-hidden="true"
          />
          <span
            class="sidebar__label sidebar__label--saved overflow-hidden whitespace-nowrap text-[0.9rem]"
            >{{ likesStore.collectionLabel }}</span
          >
          <small
            class="sidebar__badge sidebar__meta ml-auto min-w-[1.5rem] overflow-hidden whitespace-nowrap rounded-full bg-white/12 px-[0.45rem] py-[0.1rem] text-center text-[0.72rem] font-bold text-white/86"
            >{{ likesStore.items.length }}</small
          >
        </a>
      </RouterLink>

      <RouterLink
        v-if="authStore.canUseSharedCollections || authStore.canUseLocalCollections"
        custom
        :to="{ name: 'collections' }"
        v-slot="{ href, navigate, isActive }"
      >
        <a
          :href="href"
          class="sidebar__link sidebar-item"
          :class="isActive || isCollectionsRoute ? sidebarActiveClass : ''"
          @click="navigate"
        >
          <span
            class="sidebar__icon flex-shrink-0 w-[1.52rem] h-[1.52rem]"
            :class="
              isActive || isCollectionsRoute
                ? 'i-fluent-bookmark-20-filled'
                : 'i-fluent-bookmark-20-regular'
            "
            aria-hidden="true"
          />
          <span
            class="sidebar__label overflow-hidden whitespace-nowrap text-[0.9rem]"
            >{{ t('nav.collections') }}</span
          >
        </a>
      </RouterLink>

      <div class="sidebar__statistics sidebar__meta" :aria-hidden="!expanded">
        <GalleryStatistics />
      </div>
    </nav>

    <div
      v-if="moreMenuOpen"
      class="fixed inset-0 z-40"
      @pointerenter="handlePointerLeave"
      @click="handleMoreBackdropClick"
    />

    <div class="z-50 mt-auto pt-10 pb-2">
      <button
        v-if="touchControls"
        class="sidebar__toggle sidebar-item w-full mb-[0.4rem]"
        data-test="sidebar-toggle"
        type="button"
        :aria-label="expanded ? '收起侧栏' : '展开侧栏'"
        :aria-expanded="expanded"
        :title="expanded ? '收起侧栏' : '展开侧栏'"
        @click="toggleTouchSidebar"
      >
        <span
          class="sidebar__toggle-icon sidebar__icon i-fluent-chevron-right-20-regular flex-shrink-0 w-[1.45rem] h-[1.45rem]"
          aria-hidden="true"
        />
        <span class="sidebar__label overflow-hidden whitespace-nowrap text-[0.9rem]">{{ expanded ? '收起侧栏' : '展开侧栏' }}</span>
      </button>
      <div class="relative">
        <div
          v-if="moreMenuOpen"
          class="absolute bottom-[calc(100%+0.35rem)] left-0 w-[18rem] overflow-hidden rounded-[1.55rem] border border-border bg-[color-mix(in_srgb,var(--surface)_96%,var(--bg)_4%)] shadow-[0_28px_70px_rgba(0,0,0,0.24)]"
        >
          <RouterLink
            v-if="authStore.canDeleteMedia"
            class="flex items-center gap-[0.95rem] px-[1.2rem] py-[1rem] text-[0.98rem] text-text transition-colors duration-150 hover:bg-surface-hover"
            :to="{ name: 'trash' }"
            @click="closeMoreMenu"
          >
            <span class="i-fluent-delete-16-regular w-[1.18rem] h-[1.18rem] shrink-0" aria-hidden="true" />
            <span>{{ t('nav.trash') }}</span>
          </RouterLink>

          <RouterLink v-if="authStore.canAccessSettings" custom :to="{ name: 'archive-catalog' }" v-slot="{ href, navigate, isActive }">
            <a
              :href="href"
              class="flex items-center gap-[0.95rem] px-[1.2rem] py-[1rem] text-[0.98rem] text-text transition-colors duration-150 hover:bg-surface-hover"
              @click="handleSettingsNavigate($event, navigate)"
            >
              <span
                class="w-[1.18rem] h-[1.18rem] shrink-0"
                :class="isActive ? 'i-fluent-database-20-filled' : 'i-fluent-database-20-regular'"
                aria-hidden="true"
              />
              <span>{{ t('nav.archiveCatalog') }}</span>
            </a>
          </RouterLink>

          <RouterLink v-if="authStore.canAccessSettings" class="flex items-center gap-[0.95rem] px-[1.2rem] py-[1rem] text-[0.98rem] text-text transition-colors duration-150 hover:bg-surface-hover" :class="route.meta.admission ? 'bg-surface-hover font-semibold' : ''" :aria-current="route.meta.admission ? 'page' : undefined" :to="{name:'creator-admission'}" @click="closeMoreMenu">
            <span class="i-fluent-folder-add-20-regular w-[1.18rem] h-[1.18rem] shrink-0" aria-hidden="true" /><span>博主入库</span>
          </RouterLink>

          <RouterLink v-if="authStore.canAccessSettings" custom :to="{ name: 'settings' }" v-slot="{ href, navigate, isActive }">
            <a
              :href="href"
              class="flex items-center gap-[0.95rem] px-[1.2rem] py-[1rem] text-[0.98rem] text-text transition-colors duration-150 hover:bg-surface-hover"
              @click="handleSettingsNavigate($event, navigate)"
              >
                <span
                  class="w-[1.18rem] h-[1.18rem] shrink-0"
                  :class="isActive ? 'i-fluent-settings-20-filled' : 'i-fluent-settings-20-regular'"
                  aria-hidden="true"
                />
              <span>{{ t('nav.settings') }}</span>
            </a>
          </RouterLink>

          <button
            v-if="authStore.canUnlockAdmin"
            class="flex items-center gap-[0.95rem] w-full px-[1.2rem] py-[1rem] border-0 bg-transparent text-[0.98rem] text-text cursor-pointer text-left transition-colors duration-150 hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
            type="button"
            :disabled="authStore.loading"
            @click="handleUnlockAdmin"
          >
            <span
              class="i-fluent-key-16-regular w-[1.18rem] h-[1.18rem] shrink-0"
              aria-hidden="true"
            />
            <span>{{ t('nav.unlockAdmin') }}</span>
          </button>

          <button
            class="flex items-center gap-[0.95rem] w-full px-[1.2rem] py-[1rem] border-0 bg-transparent text-[0.98rem] text-text cursor-pointer text-left transition-colors duration-150 hover:bg-surface-hover"
            type="button"
            :aria-label="appearanceLabel"
            @click="handleAppearanceToggle"
          >
            <span
              v-if="appStore.theme === 'light'"
              class="i-fluent-weather-moon-20-regular w-[1.18rem] h-[1.18rem] shrink-0"
              aria-hidden="true"
            />
            <span
              v-else
              class="i-fluent-weather-sunny-20-regular w-[1.18rem] h-[1.18rem] shrink-0"
              aria-hidden="true"
            />
            <span>{{ t('nav.switchAppearance') }}</span>
          </button>

          <button
            v-if="authStore.canSignOut"
            class="flex items-center gap-[0.95rem] w-full px-[1.2rem] py-[1rem] border-0 bg-transparent text-[0.98rem] text-text cursor-pointer text-left transition-colors duration-150 hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
            type="button"
            :disabled="authStore.loading"
            @click="handleSignOut"
          >
            <span
              class="i-fluent-arrow-exit-20-regular w-[1.18rem] h-[1.18rem] shrink-0"
              aria-hidden="true"
            />
            <span>{{ signOutLabel }}</span>
          </button>
        </div>

        <button
          class="sidebar-item w-full"
          :class="moreMenuOpen ? 'bg-surface-hover font-semibold' : ''"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="moreMenuOpen"
          @click="toggleMoreMenu"
        >
          <span
            class="sidebar__icon flex-shrink-0 w-[1.45rem] h-[1.45rem]"
            :class="'i-fluent-line-horizontal-3-20-filled'"
            aria-hidden="true"
          />
          <span
            class="sidebar__label overflow-hidden whitespace-nowrap text-[0.9rem]"
            >{{ t('nav.more') }}</span
          >
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import LibraryNavigation from './LibraryNavigation.vue';
import GalleryStatistics from './GalleryStatistics.vue';
  import { computed, onMounted, onUnmounted, ref, watch } from "vue"
  import { useI18n } from "vue-i18n"
  import { RouterLink, useRoute } from "vue-router"

  import { useAppStore } from "../stores/app"
  import { useAuthStore } from "../stores/auth"
  import { useLikesStore } from "../stores/likes"
  import { usePlacesStore } from "../stores/places"
  import BrandMark from "./BrandMark.vue"

  const props = withDefaults(defineProps<{ expanded?: boolean }>(), { expanded: false })
  const emit = defineEmits<{ 'expanded-change': [expanded: boolean] }>()
  const { t } = useI18n()
  const appVersion = __APP_VERSION__
  const buildIdentity = `${__BUILD_INFO__.product} ${appVersion} · ${__BUILD_INFO__.commit?.slice(0, 12) ?? 'unverified'}${__BUILD_INFO__.dirty ? ' (modified build)' : ''}`
  const appStore = useAppStore()
  const authStore = useAuthStore()
  const likesStore = useLikesStore()
  const placesStore = usePlacesStore()
  const route = useRoute()
  const moreMenuOpen = ref(false)
  const sidebar = ref<HTMLElement | null>(null)
  const desktop = ref(false)
  const touchControls = ref(false)
  const keyboardFocus = ref(false)
  const touchExpanded = ref(false)
  let pointerInside = false
  let inputMode: 'keyboard' | 'pointer' | null = null
  let expandTimer: ReturnType<typeof setTimeout> | undefined
  let collapseTimer: ReturnType<typeof setTimeout> | undefined
  let desktopMedia: MediaQueryList | undefined
  let touchMedia: MediaQueryList | undefined

  const appearanceLabel = computed(() =>
    appStore.theme === "light" ? t("nav.switchToDarkMode") : t("nav.switchToLightMode"),
  )
  const showPlacesNav = computed(() =>
    placesStore.items.length > 0 && placesStore.listError === null,
  )
  const isPlacesRoute = computed(() =>
    route.name === "places" || route.name === "place",
  )
  const isCollectionsRoute = computed(() =>
    route.name === "collections" || route.name === "collection",
  )
  const signOutLabel = computed(() =>
    authStore.accessMode === "public" ? t("nav.returnToPublicView") : t("nav.signOut"),
  )
  const sidebarActiveClass =
    "router-link-active bg-[color-mix(in_srgb,var(--surface)_92%,transparent_8%)] font-bold"

  function closeMoreMenu() {
    moreMenuOpen.value = false
  }

  function toggleMoreMenu() {
    moreMenuOpen.value = !moreMenuOpen.value
  }

  function clearExpandTimer() {
    clearTimeout(expandTimer)
    expandTimer = undefined
  }

  function clearCollapseTimer() {
    clearTimeout(collapseTimer)
    collapseTimer = undefined
  }

  function clearTimers() {
    clearExpandTimer()
    clearCollapseTimer()
  }

  function requestExpanded(expanded: boolean) {
    emit('expanded-change', expanded)
  }

  function hasExpansionHold() {
    // Touch uses the explicit fallback button, including folding an open category list.
    // Category visibility follows the sidebar; its open choice must not pin the width.
    return keyboardFocus.value || (touchControls.value
      ? touchExpanded.value
      : moreMenuOpen.value)
  }

  function reconcileExpansion() {
    if (!desktop.value) return
    if (hasExpansionHold()) {
      clearTimers()
      requestExpanded(true)
    } else if (touchControls.value) {
      clearTimers()
      requestExpanded(false)
    } else if (pointerInside) {
      clearCollapseTimer()
      if (!props.expanded && expandTimer === undefined) {
        expandTimer = setTimeout(() => {
          expandTimer = undefined
          if (desktop.value && pointerInside) requestExpanded(true)
        }, 100)
      }
    } else {
      clearExpandTimer()
      if (props.expanded && collapseTimer === undefined) {
        collapseTimer = setTimeout(() => {
          collapseTimer = undefined
          if (!pointerInside && !hasExpansionHold()) requestExpanded(false)
        }, 120)
      }
    }
  }

  function handlePointerEnter(event: PointerEvent) {
    if (!desktop.value || touchControls.value || event.pointerType === 'touch') return
    pointerInside = pointerIsOverSidebar(event)
    reconcileExpansion()
  }

  function handlePointerLeave() {
    pointerInside = false
    reconcileExpansion()
  }

  function pointerIsOverSidebar(event: MouseEvent) {
    const bounds = sidebar.value?.getBoundingClientRect()
    return Boolean(bounds && event.clientX >= bounds.left && event.clientX < bounds.right &&
      event.clientY >= bounds.top && event.clientY < bounds.bottom)
  }

  function handlePointerMove(event: PointerEvent) {
    // The menu/backdrop are aside descendants. Removing them can omit the
    // aside's pointerleave, so observe document coordinates even after closing.
    // Only an actual pointer event updates hover; keyboard clicks do not.
    if (!desktop.value || touchControls.value || event.pointerType === 'touch') return
    if (!props.expanded && !pointerInside && !moreMenuOpen.value) return
    const inside = pointerIsOverSidebar(event)
    if (inside !== pointerInside) {
      pointerInside = inside
      reconcileExpansion()
    }
  }

  function handleMoreBackdropClick(event: MouseEvent) {
    pointerInside = !touchControls.value && pointerIsOverSidebar(event)
    closeMoreMenu()
    reconcileExpansion()
  }

  function toggleTouchSidebar() {
    touchExpanded.value = !props.expanded
    if (!touchExpanded.value) keyboardFocus.value = false
    closeMoreMenu()
    reconcileExpansion()
  }

  function handlePointerDown(event: PointerEvent) {
    inputMode = 'pointer'
    keyboardFocus.value = false
    handlePointerMove(event)
  }

  function handleFocusIn(event: FocusEvent) {
    const target = event.target
    keyboardFocus.value = inputMode !== 'pointer' && target instanceof HTMLElement &&
      (inputMode === 'keyboard' || target.matches(':focus-visible'))
  }

  function handleFocusOut(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || !sidebar.value?.contains(event.relatedTarget)) {
      keyboardFocus.value = false
    }
  }

  function handleMediaChange() {
    clearTimers()
    // Reset before changing capability flags so their watchers cannot retain a hold.
    desktop.value = false
    pointerInside = false
    keyboardFocus.value = false
    touchExpanded.value = false
    closeMoreMenu()
    touchControls.value = Boolean(desktopMedia?.matches && touchMedia?.matches)
    desktop.value = Boolean(desktopMedia?.matches)
    requestExpanded(false)
  }

  function handleAppearanceToggle() {
    appStore.toggleTheme()
    closeMoreMenu()
  }

  function handleUnlockAdmin() {
    authStore.openUnlockDialog()
    closeMoreMenu()
  }

  function handleSettingsNavigate(event: MouseEvent, navigate: (event?: MouseEvent) => void) {
    closeMoreMenu()
    navigate(event)
  }

  async function handleSignOut() {
    closeMoreMenu()

    try {
      await authStore.logout()
    } catch {
      // Keep the current shell visible and let auth-store error handling surface the failure.
    }
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    const isNavigationKey = ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)
    if (isNavigationKey && (event.key === 'Tab' || sidebar.value?.contains(document.activeElement))) {
      inputMode = 'keyboard'
      if (sidebar.value?.contains(document.activeElement)) keyboardFocus.value = true
    }
    if (event.key === "Escape") {
      closeMoreMenu()
    }
  }

  watch(
    () => route.fullPath,
    () => {
      closeMoreMenu()
    },
  )

  watch([moreMenuOpen, keyboardFocus, touchExpanded], reconcileExpansion, { flush: 'sync' })
  watch(moreMenuOpen, open => {
    // Removing a focused menu item does not reliably dispatch focusout.
    if (!open && !sidebar.value?.contains(document.activeElement)) keyboardFocus.value = false
  }, { flush: 'post' })

  onMounted(() => {
    void placesStore.fetchPlaces()
    desktopMedia = window.matchMedia('(min-width: 48rem)')
    touchMedia = window.matchMedia('(hover: none), (pointer: coarse)')
    handleMediaChange()
    desktopMedia.addEventListener('change', handleMediaChange)
    touchMedia.addEventListener('change', handleMediaChange)
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true })
    window.addEventListener("keydown", handleWindowKeydown, true)
  })

  onUnmounted(() => {
    clearTimers()
    desktopMedia?.removeEventListener('change', handleMediaChange)
    touchMedia?.removeEventListener('change', handleMediaChange)
    document.removeEventListener('pointerdown', handlePointerDown, true)
    document.removeEventListener('pointermove', handlePointerMove, true)
    window.removeEventListener("keydown", handleWindowKeydown, true)
  })
</script>

<style scoped>
.sidebar {
  width: var(--sidebar-collapsed-width, 4.85rem);
  transition: width var(--sidebar-width-duration, 180ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
}

.sidebar--expanded {
  width: var(--sidebar-expanded-width, 15rem);
}

.sidebar-item {
  overflow: hidden;
  flex-shrink: 0;
}

/* Keep text laid out at its final size while the row clips it during resizing. */
.sidebar__label,
.sidebar__meta {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--sidebar-width-duration, 180ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
}

.sidebar__label {
  max-width: calc(var(--sidebar-expanded-width, 15rem) - 5.85rem);
  text-overflow: ellipsis;
}

.sidebar__label--saved {
  max-width: calc(var(--sidebar-expanded-width, 15rem) - 8.35rem);
}

.sidebar__section-label {
  max-width: 100%;
}

.sidebar__statistics {
  width: calc(var(--sidebar-expanded-width, 15rem) - 1.9rem);
  padding: 0 .6rem;
  margin-top: 1.6rem;
  pointer-events: none;
}

.sidebar--expanded .sidebar__statistics { pointer-events: auto; }

.sidebar--expanded .sidebar__label,
.sidebar--expanded .sidebar__meta {
  opacity: 1;
}

.sidebar__toggle-icon {
  transition: transform var(--sidebar-width-duration, 180ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
}

.sidebar--expanded .sidebar__toggle-icon {
  transform: rotate(180deg);
}

.sidebar__toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .sidebar,
  .sidebar__label,
  .sidebar__meta,
  .sidebar__toggle-icon {
    transition: none;
  }
}
</style>
