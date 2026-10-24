<template>
  <section
    ref="homeLayoutElement"
    :class="[
      'grid gap-[4rem] items-start justify-center mx-auto',
      isCompactHomeLayout
        ? 'grid-cols-1 w-full'
        : 'grid-cols-[minmax(0,39.375rem)_19.9375rem] w-[min(100%,63.3125rem)]',
    ]"
  >
    <!-- Main feed column -->
    <div class="min-w-0">
      <section
        v-if="appStore.isLibraryRebuildRequired && appStore.stats && !appStore.isRebuilding"
        class="grid gap-[0.55rem] px-5 py-[1rem] mb-[1.1rem] border rounded-[1rem] shadow-[var(--shadow)]"
        style="background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 88%, #fff4d1 12%) 0%, color-mix(in srgb, var(--surface) 82%, #ffe49a 18%) 100%); border-color: color-mix(in srgb, var(--border) 72%, #d2a133 28%);"
      >
        <div class="flex items-start justify-between gap-4 max-sm:flex-col max-sm:items-start">
          <div class="grid gap-[0.2rem]">
            <strong>Library location changed</strong>
            <p class="m-0 text-muted">
              The current index may still contain folders and cached media from a previous gallery location. Review the rebuild steps to reset the index, reuse any matching thumbnails and previews, and generate only the missing derivatives for the current library.
            </p>
          </div>
          <RouterLink
            v-if="canManageLibrary"
            class="inline-flex items-center justify-center min-h-10 px-4 rounded-[0.8rem] text-[0.84rem] font-bold text-white bg-[#9f6a00] whitespace-nowrap"
            :to="{ name: 'settings', query: { action: 'rebuild' } }"
          >
            Review Rebuild
          </RouterLink>
          <p v-else class="m-0 text-[0.84rem] text-muted">An admin session needs to rebuild the library.</p>
        </div>
      </section>

      <section v-if="!appStore.isLibraryUnavailable" class="home-feed-modes mb-5 min-w-0 w-full max-w-[39.375rem]" data-test="feed-modes">
        <div class="story-rail-shell story-rail-shell--feed-modes">
          <div class="stories-bar story-rail story-rail--feed-modes" role="group" :aria-label="t('home.feedModesLabel')">
            <div class="story-rail__track">
              <button
                v-for="mode in feedModes"
                :key="mode.id"
                class="story-rail__item story-rail__button"
                :class="{ 'story-rail__button--selected': selectedFeedMode === mode.id }"
                :title="mode.description"
                :aria-label="`${mode.label}. ${mode.description}`"
                :aria-pressed="selectedFeedMode === mode.id"
                :aria-busy="selectedFeedMode === mode.id && feedStore.loading"
                :data-feed-mode="mode.id"
                type="button"
                @click="selectMode(mode.id)"
              >
                <span class="story-rail__ring">
                  <span class="story-rail__ring-inner">
                    <span class="story-rail__avatar story-rail__cover" aria-hidden="true">
                      <img v-if="mode.coverUrl && !failedModeCovers.has(mode.coverUrl)" :src="mode.coverUrl" alt="" loading="lazy" @error="failedModeCovers.add(mode.coverUrl)" />
                      <span v-else :class="mode.icon" class="story-rail__fallback" />
                      <span v-if="selectedFeedMode === mode.id && feedStore.loading" class="story-rail__loading" />
                    </span>
                  </span>
                </span>
                <span class="story-rail__label">{{ mode.label }}</span>
              </button>
            </div>
          </div>
        </div>
        <p class="sr-only" role="status">{{ feedStore.loading ? t('common.loading') : '' }}</p>
      </section>
      <!-- States -->
      <EmptyState v-if="appStore.isLibraryUnavailable" title="Library storage unavailable" :description="appStore.libraryUnavailableReason" />
      <div v-else-if="!appStore.stats && appStore.error">
        <ErrorState title="Could not load library status" :message="appStore.error" />
        <button class="btn-primary" type="button" :disabled="appStore.loadingStats" @click="appStore.ensureStatus()">{{ t('common.retry') }}</button>
      </div>
      <ErrorState v-else-if="feedStore.error" title="Could not load feed" :message="feedStore.error" />

      <!-- Initial scan state (no feed yet) -->
      <section v-else-if="showInitialScanState" class="grid gap-[0.85rem] px-5 py-5 mb-[1.1rem] border border-border rounded-[1rem] shadow-[var(--shadow)]" style="background: radial-gradient(circle at top right, rgba(0,149,246,0.12), transparent 38%), linear-gradient(180deg, var(--surface) 0%, color-mix(in srgb, var(--surface) 90%, var(--accent) 10%) 100%);">
        <div class="flex items-start justify-between gap-3 max-sm:flex-col max-sm:items-start">
          <span class="text-accent-strong text-[0.75rem] font-bold tracking-[0.08em] uppercase">Startup scan in progress</span>
          <span
            data-test="initial-scan-phase"
            class="inline-flex items-center justify-center min-h-8 px-[0.72rem] py-[0.34rem] rounded-full text-[0.73rem] font-bold whitespace-nowrap text-accent-strong"
            style="background: color-mix(in srgb, var(--surface-alt) 78%, var(--accent) 22%);"
          >
            {{ initialScanPhaseLabel }}
          </span>
        </div>
        <h2 class="m-0">Indexing your library</h2>
        <p class="m-0 text-muted">{{ scanDescription }}</p>
        <p v-if="scanActionLine" class="m-0 text-[0.86rem] font-semibold text-text">{{ scanActionLine }}</p>
        <dl class="grid grid-cols-4 gap-[0.8rem] m-0 max-sm:grid-cols-2">
          <div
            v-for="stat in initialScanStats"
            :key="stat.label"
            class="px-[0.9rem] py-[0.8rem] rounded-[0.85rem]"
            style="background: color-mix(in srgb, var(--surface-alt) 88%, var(--accent) 12%)"
          >
            <dt class="m-0 mb-[0.25rem] text-muted text-[0.74rem] uppercase tracking-[0.05em]">{{ stat.label }}</dt>
            <dd class="m-0 text-base font-bold">{{ stat.value }}</dd>
          </div>
        </dl>
      </section>

      <section
        v-else-if="showHomeSetupNotice"
        class="grid gap-[0.85rem] px-5 py-5 mb-[1.1rem] border rounded-[1rem] shadow-[var(--shadow)]"
        :style="homeSetupNoticeStyle"
      >
        <span class="text-[0.75rem] font-bold tracking-[0.08em] uppercase" :class="homeSetupNoticeEyebrowClass">
          {{ homeSetupNoticeEyebrow }}
        </span>
        <h2 class="m-0">{{ homeSetupNoticeTitle }}</h2>
        <p class="m-0 text-muted">{{ homeSetupNoticeDescription }}</p>
        <div class="flex items-center gap-4 max-sm:flex-col max-sm:items-start">
          <button v-if="canManageLibrary" class="btn-primary min-w-[11.5rem]" type="button" :disabled="homeScanDisabled" @click="runHomeScan">
            {{ homeScanButtonLabel }}
          </button>
          <p class="m-0 text-muted">{{ homeScanNote }}</p>
        </div>
        <p
          v-if="homeScanError"
          class="m-0 px-4 py-[0.85rem] border border-[rgba(214,48,49,0.24)] rounded-[0.9rem] text-[#c0392b] bg-[rgba(214,48,49,0.08)]"
        >
          {{ homeScanError }}
        </p>
      </section>
      <EmptyState v-else-if="feedStore.initialized && feedStore.items.length === 0" title="No posts indexed yet" description="Add folders under the gallery root and the feed will populate after the next scan." />
      <template v-else>
        <div
          v-if="feedStoryError"
          class="mx-auto mb-[1.1rem] grid w-full max-w-[29.375rem] gap-[0.75rem] rounded-[1rem] border border-[rgba(214,48,49,0.24)] bg-[rgba(214,48,49,0.08)] px-4 py-[0.95rem] text-[#c0392b]"
          role="alert"
        >
          <p class="m-0 text-[0.92rem]">{{ feedStoryError }}</p>
          <div>
            <button
              class="inline-flex min-h-9 items-center justify-center rounded-[0.8rem] border border-[rgba(192,57,43,0.18)] bg-white/65 px-3 text-[0.82rem] font-semibold text-[#a93226] transition-colors duration-180 hover:bg-white"
              type="button"
              :disabled="!feedStoryRetrySlug"
              @click="retryFeedFolderStory"
            >
              Retry Story
            </button>
          </div>
        </div>

        <!-- Feed cards in home-layout context: transparent card, no shadow -->
        <div class="w-full max-w-[29.375rem] mx-auto flex flex-col gap-[1.2rem]">
          <FeedList
            :items="feedStore.items"
            context="home"
            :show-skeleton="!feedStore.initialized && feedStore.loading"
            @open-folder-story="openFeedFolderStory"
          />
        </div>
        <div class="w-full max-w-[29.375rem] mx-auto">
          <InfiniteLoader v-if="initialFeedReady" :loading="feedStore.loading" :has-more="feedStore.hasMore" @load-more="feedStore.loadMore" />
        </div>
      </template>

      <StoriesModal
        v-if="activeFeedStoryId && folderStoriesStore.items.length"
        :items="folderStoriesStore.items"
        :initial-id="activeFeedStoryId"
        :rail-singular-label="folderStoriesStore.railSingularLabel"
        :store="folderStoriesStore"
        @close="closeFeedFolderStory"
      />
    </div>

    <!-- Right rail (suggestions) — hidden on mobile -->
    <aside
      v-if="
        !appStore.isLibraryUnavailable &&
        recommendedFolders.length > 0 &&
        !isCompactHomeLayout
      "
      class="sticky top-8 grid min-w-0 grid-cols-1 gap-[1.15rem] w-[19.9375rem] text-muted"
      :aria-label="t('home.sidebar.ariaLabel')"
    >
      <div class="flex items-center justify-between gap-4 text-text text-[0.96rem] font-bold">
        <h2 class="m-0 text-[0.96rem] font-bold">{{ t('home.sidebar.suggestedFolders') }}</h2>
        <RouterLink class="home-recommendations__all shrink-0 text-muted text-[0.76rem] font-bold" :to="{ name: 'library' }">{{ t('home.sidebar.viewAll') }}</RouterLink>
      </div>

      <div class="grid min-w-0 grid-cols-1 gap-[0.95rem]">
        <RouterLink
          v-for="folder in recommendedFolders"
          :key="folder.id"
          class="home-recommendations__creator flex min-w-0 items-center gap-[0.8rem]"
          :to="folderReadingRoute(folder.slug, folder.canonicalCreatorId)"
          :aria-label="`${formatDisplayFolderTitle(folder)} · ${t('home.sidebar.openFolder')}`"
        >
          <Avatar class="w-11 h-11 shrink-0" :name="formatDisplayFolderTitle(folder)" :src="folder.avatarUrl" />
          <div class="flex-1 min-w-0">
            <strong class="block truncate text-text text-[0.87rem] font-bold" :title="formatDisplayFolderTitle(folder)">{{ formatDisplayFolderTitle(folder) }}</strong>
            <p class="m-0 mt-[0.12rem] text-[0.79rem] truncate">{{ t('home.sidebar.workCount', { count: formatCount(folder.postCount ?? folder.imageCount) }) }}</p>
          </div>
          <span class="home-recommendations__action ml-auto shrink-0 whitespace-nowrap text-accent-strong text-[0.76rem] font-bold">{{ t('home.sidebar.openFolder') }}</span>
        </RouterLink>
      </div>

      <p class="m-0 mt-[1.4rem] text-center text-[0.7rem] leading-[1.7] text-muted">
        <a
          class="home-recommendations__all inline-block text-muted"
          href="https://github.com/foldergram/foldergram"
          target="_blank"
          rel="noreferrer"
        >
          {{ t('home.sidebar.openSourceText') }}
        </a>
      </p>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { folderReadingRoute } from '../utils/work-gallery';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';

import { triggerManualScan } from '../api/gallery';
import Avatar from '../components/Avatar.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorState from '../components/ErrorState.vue';
import FeedList from '../components/FeedList.vue';
import InfiniteLoader from '../components/InfiniteLoader.vue';
import StoriesModal from '../components/StoriesModal.vue';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { useFeedStore } from '../stores/feed';
import { useFolderStoriesStore } from '../stores/folder-stories';
import { useLikesStore } from '../stores/likes';
import { useFoldersStore } from '../stores/folders';
import type { FeedMode } from '../types/api';
import { formatFolderTitle } from '../utils/folder-titles';
import { buildLikedCountByFolder, selectHomeRecommendations } from '../utils/home-recommendations';
import { getInitialScanStats, getScanActionLine, getScanPhaseLabel, getScanSummary } from '../utils/scan-progress';

const appStore = useAppStore();
const authStore = useAuthStore();
const feedStore = useFeedStore();
const folderStoriesStore = useFolderStoriesStore();
const likesStore = useLikesStore();
const foldersStore = useFoldersStore();
const { t } = useI18n();
const likedCountByFolder = computed(() => buildLikedCountByFolder(likesStore.items));
const recommendedFolders = computed(() =>
  selectHomeRecommendations(foldersStore.items, likedCountByFolder.value)
);
const activeFeedStoryId = ref<string | null>(null);
const feedStoryRetrySlug = ref<string | null>(null);
const homeLayoutElement = ref<HTMLElement | null>(null);
const isCompactHomeLayout = ref(false);
const requestingHomeScan = ref(false);
const homeScanError = ref<string | null>(null);
const feedStoryError = ref<string | null>(null);
const initialFeedReady = ref(false);
let homeActive = true;
const explicitMode = ref<FeedMode | null>(null);
const failedModeCovers = ref(new Set<string>());
const firstFeedSettled = ref(false);
let homeGeneration = 0;
const pendingHomeWaits = new Set<() => void>();
const homeAccessKey = () => JSON.stringify([authStore.role, authStore.authenticated, authStore.accessMode, authStore.capabilities]);

function cancelHomeWork() {
  homeGeneration += 1;
  for (const cancel of [...pendingHomeWaits]) cancel();
}

function waitForFeedSettlement() {
  if (!feedStore.loading) return Promise.resolve();
  return new Promise<void>(resolve => {
    const stop = watch(() => feedStore.loading, loading => { if (!loading) finish(); });
    const finish = () => { stop(); pendingHomeWaits.delete(finish); resolve(); };
    pendingHomeWaits.add(finish);
  });
}

async function loadHomeFeed(load: () => Promise<void>) {
  cancelHomeWork();
  const generation = homeGeneration, access = homeAccessKey(), feedGeneration = feedStore.generation;
  const current = () => homeActive && generation === homeGeneration && access === homeAccessKey()
    && feedGeneration === feedStore.generation
    && authStore.accessGranted && Boolean(appStore.stats) && !appStore.isLibraryUnavailable;
  await load();
  if (!current()) return;
  await waitForFeedSettlement();
  if (current()) firstFeedSettled.value = true;
}
function formatDisplayFolderTitle(folder: (typeof recommendedFolders.value)[number]) {
  return formatFolderTitle(folder, appStore.nestedFolderTitleFormat);
}

const HOME_RIGHT_RAIL_BREAKPOINT = 960;
let homeLayoutResizeObserver: ResizeObserver | null = null;

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

const selectedFeedMode = computed(() => explicitMode.value ?? feedStore.mode);
const modeThumbnailUrls = computed(() => [...new Set([
  ...foldersStore.items.map(folder => folder.avatarUrl),
  ...feedStore.items.map(item => item.thumbnailUrl)
].filter((url): url is string => Boolean(url)))]);
const feedModes = computed<Array<{ id: FeedMode; label: string; description: string; icon: string; coverUrl: string | null }>>(() => [
  {
    id: 'recent',
    label: t('settings.general.homeFeed.options.recent.label'),
    description: t('settings.general.homeFeed.options.recent.description'),
    icon: 'i-fluent-clock-24-regular',
    coverUrl: modeThumbnailUrls.value[0] ?? null
  },
  {
    id: 'rediscover',
    label: t('settings.general.homeFeed.options.rediscover.label'),
    description: t('settings.general.homeFeed.options.rediscover.description'),
    icon: 'i-fluent-history-24-regular',
    coverUrl: modeThumbnailUrls.value[1] ?? null
  },
  {
    id: 'random',
    label: t('settings.general.homeFeed.options.random.label'),
    description: t('settings.general.homeFeed.options.random.description'),
    icon: 'i-fluent-arrow-shuffle-24-regular',
    coverUrl: modeThumbnailUrls.value[2] ?? null
  }
]);
const showInitialScanState = computed(
  () => appStore.isScanning && feedStore.items.length === 0 && !feedStore.loading && !feedStore.error
);
const ignoredRootMediaCount = computed(() => appStore.stats?.libraryIndex.ignoredRootMediaCount ?? 0);
const hasIndexedFolders = computed(() => (appStore.stats?.folders ?? 0) > 0);
const showHomeSetupNotice = computed(
  () =>
    !appStore.isLibraryUnavailable &&
    !showInitialScanState.value &&
    Boolean(appStore.stats) &&
    feedStore.initialized &&
    feedStore.items.length === 0 &&
    !hasIndexedFolders.value
);
const homeSetupNoticeEyebrow = computed(() => (ignoredRootMediaCount.value > 0 ? 'Gallery Root' : 'Get Started'));
const homeSetupNoticeEyebrowClass = computed(() => (ignoredRootMediaCount.value > 0 ? 'text-[#9f6a00]' : 'text-accent-strong'));
const homeSetupNoticeTitle = computed(() =>
  ignoredRootMediaCount.value > 0 ? 'Files in the gallery root are being ignored' : 'No folders found yet'
);
const homeSetupNoticeDescription = computed(() => {
  if (ignoredRootMediaCount.value > 0) {
    const supportedFileLabel = ignoredRootMediaCount.value === 1 ? 'supported file is' : 'supported files are';
    return `${formatCount(ignoredRootMediaCount.value)} ${supportedFileLabel} being ignored in the gallery root. Move them into a folder inside your gallery root, such as example-album, to create App Folders. Files placed directly in the gallery root are ignored.`;
  }

  return 'Create a folder inside your gallery root, such as example-album, and place photos or videos in it to create your first App Folder. Files placed directly in the gallery root are ignored.';
});
const homeSetupNoticeStyle = computed(() =>
  ignoredRootMediaCount.value > 0
    ? 'background: radial-gradient(circle at top right, rgba(210,161,51,0.16), transparent 38%), linear-gradient(180deg, color-mix(in srgb, var(--surface) 92%, #fff4d1 8%) 0%, color-mix(in srgb, var(--surface) 88%, #ffeab1 12%) 100%); border-color: color-mix(in srgb, var(--border) 70%, #d2a133 30%);'
    : 'background: radial-gradient(circle at top right, rgba(0,149,246,0.12), transparent 38%), linear-gradient(180deg, var(--surface) 0%, color-mix(in srgb, var(--surface) 92%, var(--accent) 8%) 100%); border-color: color-mix(in srgb, var(--border) 78%, var(--accent) 22%);'
);
const homeScanDisabled = computed(
  () =>
    !authStore.canManageLibrary ||
    appStore.isLibraryUnavailable ||
    appStore.isLibraryRebuildRequired ||
    appStore.isScanning ||
    requestingHomeScan.value
);
const canManageLibrary = computed(() => authStore.canManageLibrary);
const homeScanButtonLabel = computed(() => {
  if (appStore.isScanning || requestingHomeScan.value) {
    return 'Scanning library...';
  }

  return 'Run Scan Library';
});
const homeScanNote = computed(() => {
  if (appStore.isLibraryUnavailable) {
    return appStore.libraryUnavailableReason;
  }

  if (appStore.isLibraryRebuildRequired) {
    return 'Rebuild the library index first because the gallery location changed.';
  }

  if (!authStore.canManageLibrary) {
    return 'An admin session needs to run the next scan before new folders or moved media will appear here.';
  }

  if (appStore.isScanning || requestingHomeScan.value) {
    return 'Scanning the gallery now and refreshing the Home feed when it finishes.';
  }

  return 'Run a scan after adding folders or moving files so the library can index them.';
});
const initialScanPhaseLabel = computed(() => getScanPhaseLabel(appStore.stats?.scan ?? null));
const initialScanStats = computed(() => getInitialScanStats(appStore.stats?.scan ?? null));
const scanDescription = computed(() => {
  const scan = appStore.stats?.scan;
  return scan ? getScanSummary(scan) : 'Preparing scan status...';
});
const scanActionLine = computed(() => getScanActionLine(appStore.stats?.scan ?? null));

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function warmScanStatus() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(attempt === 0 ? 150 : 250);

    try {
      await appStore.fetchStats({ background: true });
    } catch {
      // The rescan request may win the race; keep polling until scan state flips or the request finishes.
    }

    if (appStore.stats?.scan.isScanning) {
      return;
    }
  }
}

async function selectMode(mode: FeedMode) {
  explicitMode.value = mode;
  // User intent wins over a late saved preference, but storage/access status is
  // still required before any request is made.
  if (!initialFeedReady.value) return;
  await loadHomeFeed(() => feedStore.setMode(mode));
}

async function openFeedFolderStory(slug: string) {
  if (appStore.isLibraryUnavailable) {
    return;
  }

  activeFeedStoryId.value = null;
  feedStoryRetrySlug.value = slug;
  feedStoryError.value = null;

  await folderStoriesStore.fetchStories(slug, folderStoriesStore.currentFolderSlug !== slug);
  if (folderStoriesStore.listError) {
    feedStoryError.value = folderStoriesStore.listError;
    return;
  }

  if (!folderStoriesStore.hasAvatarStory || !folderStoriesStore.avatarStoryId) {
    return;
  }

  activeFeedStoryId.value = folderStoriesStore.avatarStoryId;
}

function closeFeedFolderStory() {
  activeFeedStoryId.value = null;
}

async function retryFeedFolderStory() {
  if (!feedStoryRetrySlug.value) {
    return;
  }

  await folderStoriesStore.fetchStories(feedStoryRetrySlug.value, true);
  if (folderStoriesStore.listError) {
    feedStoryError.value = folderStoriesStore.listError;
    return;
  }

  feedStoryError.value = null;

  if (folderStoriesStore.hasAvatarStory && folderStoriesStore.avatarStoryId) {
    activeFeedStoryId.value = folderStoriesStore.avatarStoryId;
  }
}

function updateHomeLayout() {
  const layoutWidth = homeLayoutElement.value?.clientWidth ?? window.innerWidth;
  isCompactHomeLayout.value = layoutWidth <= HOME_RIGHT_RAIL_BREAKPOINT;
}

async function runHomeScan() {
  if (homeScanDisabled.value || !authStore.canManageLibrary) {
    return;
  }

  requestingHomeScan.value = true;
  homeScanError.value = null;

  try {
    const request = triggerManualScan();
    void warmScanStatus();
    await request;
    await appStore.fetchStats({ background: true });
    await Promise.all([foldersStore.fetchFolders(true), loadHomeFeed(() => feedStore.loadInitial(true))]);
  } catch (error) {
    homeScanError.value = error instanceof Error ? error.message : 'Unable to start a library scan.';
  } finally {
    requestingHomeScan.value = false;
  }
}

async function initializeHomeFeed() {
  if (initialFeedReady.value || !homeActive || !appStore.stats || appStore.isLibraryUnavailable || !authStore.accessGranted) return;
  if (explicitMode.value || !feedStore.initialized) {
    feedStore.initializeMode(explicitMode.value ?? appStore.defaultHomeFeedMode);
  }
  initialFeedReady.value = true;
  await loadHomeFeed(() => feedStore.loadInitial());
}

onMounted(async () => {
  updateHomeLayout();

  if (typeof ResizeObserver !== 'undefined' && homeLayoutElement.value) {
    homeLayoutResizeObserver = new ResizeObserver(() => {
      updateHomeLayout();
    });
    homeLayoutResizeObserver.observe(homeLayoutElement.value);
  } else {
    window.addEventListener('resize', updateHomeLayout);
  }

  if (!appStore.stats) {
    await appStore.ensureStatus();
  }

  await initializeHomeFeed();
});

watch(() => appStore.stats, async (stats) => {
  if (!stats) {
    cancelHomeWork();
    firstFeedSettled.value = false;
    initialFeedReady.value = false;
    explicitMode.value = null;
    return;
  }
  await initializeHomeFeed();
});

watch(
  () => [appStore.stats?.indexedImages ?? 0, appStore.stats?.folders ?? 0] as const,
  async ([indexedImages], previous) => {
    if (!previous || previous[0] === 0 && !feedStore.initialized) return;
    if (!initialFeedReady.value || !firstFeedSettled.value || !appStore.stats || appStore.isLibraryUnavailable) {
      return;
    }

    // App owns folder-list refreshes. Retry an empty feed when indexing adds content,
    // without issuing a second request for the folder list.

    if (indexedImages > 0 && feedStore.items.length === 0 && !feedStore.loading) {
      await loadHomeFeed(() => feedStore.loadInitial(true));
      return;
    }
  }
);

watch(
  () => folderStoriesStore.items.map((item) => item.id),
  (ids) => {
    if (activeFeedStoryId.value && !ids.includes(activeFeedStoryId.value)) {
      activeFeedStoryId.value = folderStoriesStore.avatarStoryId && ids.includes(folderStoriesStore.avatarStoryId)
        ? folderStoriesStore.avatarStoryId
        : null;
    }
  }
);

watch(homeAccessKey, async () => { cancelHomeWork(); firstFeedSettled.value = false; initialFeedReady.value = false; await initializeHomeFeed(); });

onUnmounted(() => {
  homeActive = false;
  cancelHomeWork();
  homeLayoutResizeObserver?.disconnect();
  homeLayoutResizeObserver = null;
  window.removeEventListener('resize', updateHomeLayout);
});
</script>

<style scoped>
.home-recommendations__creator,
.home-recommendations__all {
  border-radius: 0.5rem;
}

.home-recommendations__action {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  justify-content: center;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: transparent;
  transition: background-color 180ms, border-color 180ms;
}

.home-recommendations__creator:hover .home-recommendations__action,
.home-recommendations__creator:focus-visible .home-recommendations__action {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.home-recommendations__creator:active .home-recommendations__action {
  border-color: var(--accent-strong);
  background: var(--surface-alt);
}

.home-recommendations__all:hover,
.home-recommendations__all:active {
  color: var(--text);
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.home-recommendations__creator:focus-visible,
.home-recommendations__all:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}

@media (prefers-reduced-motion: reduce) {
  .home-recommendations__action {
    transition: none;
  }
}
</style>
