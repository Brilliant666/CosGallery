<template>
  <aside
    class="sidebar flex h-full flex-col overflow-visible bg-bg px-[0.95rem] py-5 text-text"
    :class="{ 'sidebar--expanded': expanded }"
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

      <span
        class="sidebar__section-label sidebar__meta inline-flex min-h-[1rem] items-center self-start mt-7 overflow-hidden whitespace-nowrap px-[0.75rem] text-[0.68rem] leading-[1.2] font-semibold uppercase tracking-[0.12em] text-muted"
        >{{ t('nav.foldersSpotlight') }}</span
      >
      <div
        class="flex min-h-0 flex-col gap-[0.2rem] max-h-[22.5rem] overflow-y-auto [scrollbar-width:none]"
      >
        <RouterLink
          v-for="folder in featuredFolders"
          :key="folder.id"
          custom
          :to="folderReadingRoute(folder.slug, folder.canonicalCreatorId)"
          v-slot="{ href, navigate, isActive }"
        >
          <a
            :href="href"
            class="sidebar__folder sidebar-item"
            :class="isActive ? sidebarActiveClass : ''"
            :title="
              folder.breadcrumb
                ? `${folder.breadcrumb} / ${folder.name}`
                : folder.name
            "
            @click="navigate"
          >
            <Avatar
              :name="formatFeaturedFolderTitle(folder)"
              :src="folder.avatarUrl"
              class="h-[1.75rem] w-[1.75rem]"
            />
            <span
              class="sidebar__folder-copy sidebar__meta flex min-w-0 flex-col gap-[0.05rem] overflow-hidden whitespace-nowrap"
            >
              <strong class="truncate text-[0.82rem]">{{ formatFeaturedFolderTitle(folder) }}</strong>
              <small class="truncate text-[0.68rem] text-muted">{{
                folder.breadcrumb ?? t('nav.folderPosts', { count: folder.imageCount })
              }}</small>
            </span>
          </a>
        </RouterLink>
      </div>
    </nav>

    <div
      v-if="moreMenuOpen"
      class="fixed inset-0 z-40"
      @click="closeMoreMenu"
    />

    <div class="z-50 mt-auto pt-10 pb-2">
      <button
        class="sidebar__toggle sidebar-item w-full mb-[0.4rem]"
        data-test="sidebar-toggle"
        type="button"
        :aria-label="expanded ? '收起侧栏' : '展开侧栏'"
        :aria-expanded="expanded"
        :title="expanded ? '收起侧栏' : '展开侧栏'"
        @click="toggleSidebar"
      >
        <span
          class="sidebar__toggle-icon sidebar__icon i-fluent-chevron-right-20-regular flex-shrink-0 w-[1.45rem] h-[1.45rem]"
          aria-hidden="true"
        />
        <span class="sidebar__label overflow-hidden whitespace-nowrap text-[0.9rem]">收起侧栏</span>
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
import { folderReadingRoute } from '../utils/work-gallery';
  import { computed, onMounted, onUnmounted, ref, watch } from "vue"
  import { useI18n } from "vue-i18n"
  import { RouterLink, useRoute } from "vue-router"

  import { useAppStore } from "../stores/app"
  import { useAuthStore } from "../stores/auth"
  import { useLikesStore } from "../stores/likes"
  import { useFoldersStore } from "../stores/folders"
  import { usePlacesStore } from "../stores/places"
  import { formatFolderTitle } from "../utils/folder-titles"
  import { buildLikedCountByFolder } from "../utils/home-recommendations"
  import { selectSidebarFolders } from "../utils/sidebar-folders"
  import Avatar from "./Avatar.vue"
  import BrandMark from "./BrandMark.vue"

  withDefaults(defineProps<{ expanded?: boolean }>(), { expanded: false })
  const emit = defineEmits<{ toggle: [] }>()
  const { t } = useI18n()
  const appVersion = __APP_VERSION__
  const buildIdentity = `${__BUILD_INFO__.product} ${appVersion} · ${__BUILD_INFO__.commit?.slice(0, 12) ?? 'unverified'}${__BUILD_INFO__.dirty ? ' (modified build)' : ''}`
  const appStore = useAppStore()
  const authStore = useAuthStore()
  const likesStore = useLikesStore()
  const foldersStore = useFoldersStore()
  const placesStore = usePlacesStore()
  const route = useRoute()
  const moreMenuOpen = ref(false)

  const likedCountByFolder = computed(() =>
    buildLikedCountByFolder(likesStore.items),
  )
  const featuredFolders = computed(() =>
    selectSidebarFolders(
      foldersStore.items,
      likedCountByFolder.value,
      appStore.recentOpenedFolderSlugs,
    ),
  )
  const appearanceLabel = computed(() =>
    appStore.theme === "light" ? t("nav.switchToDarkMode") : t("nav.switchToLightMode"),
  )
  const showPlacesNav = computed(() =>
    placesStore.items.length > 0 && placesStore.listError === null,
  )
  function formatFeaturedFolderTitle(folder: (typeof featuredFolders.value)[number]) {
    return formatFolderTitle(folder, appStore.nestedFolderTitleFormat)
  }
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

  function toggleSidebar() {
    closeMoreMenu()
    emit('toggle')
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

  onMounted(() => {
    void placesStore.fetchPlaces()
    window.addEventListener("keydown", handleWindowKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener("keydown", handleWindowKeydown)
  })
</script>

<style scoped>
.sidebar {
  width: var(--sidebar-collapsed-width, 4.85rem);
  transition: width var(--sidebar-width-duration, 220ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
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
  transition: opacity var(--sidebar-width-duration, 220ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
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

.sidebar__folder-copy {
  width: calc(var(--sidebar-expanded-width, 15rem) - 6.15rem);
}

.sidebar--expanded .sidebar__label,
.sidebar--expanded .sidebar__meta {
  opacity: 1;
}

.sidebar__toggle-icon {
  transition: transform var(--sidebar-width-duration, 220ms) var(--sidebar-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
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
