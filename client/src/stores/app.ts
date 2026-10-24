import { defineStore } from 'pinia';
import type { RouteLocationNormalized } from 'vue-router';

import {
  fetchAdminScanProgress,
  fetchAdminStats,
  fetchScanProgress,
  fetchStats as fetchStatus
} from '../api/gallery';
import {
  DEFAULT_LOCALE,
  i18n,
  resolvePreferredLocale,
  resolveSupportedLocale,
  syncDocumentLanguage,
  type SupportedLocale
} from '../locales';
import { ACCENT_COLORS, type AccentColor, type AppStatus, type FeedMode, type FolderImageOrder, type ReelsFeedMode, type ScanProgress } from '../types/api';
import { useAuthStore } from './auth';

interface AppState {
  stats: AppStatus | null;
  statsGeneration: number;
  statsContext: string | null;
  loadingStats: boolean;
  error: string | null;
  theme: 'light' | 'dark';
  locale: SupportedLocale;
  videoMuted: boolean;
  lastOpenedFolderSlug: string | null;
  recentOpenedFolderSlugs: string[];
  // Creator identities for recent navigation, with legacy slugs supported during migration.
  recentOpenedCreatorKeys: string[];
  imageModalBackgroundPath: string | null;
  statsPollFailures: number;
  statsPollTimer: number | null;
  statsPollInFlight: boolean;
}

const THEME_STORAGE_KEY = 'foldergram-theme';
const LOCALE_STORAGE_KEY = 'foldergram-locale';
const VIDEO_MUTED_STORAGE_KEY = 'foldergram-video-muted';
const LAST_OPENED_FOLDER_STORAGE_KEY = 'foldergram-last-opened-folder';
const RECENT_OPENED_FOLDERS_STORAGE_KEY = 'foldergram-recent-opened-folders';
const RECENT_CREATORS_STORAGE_KEY = 'cosgallery-recent-viewed-creators';
const RECENT_OPENED_FOLDERS_LIMIT = 24;
const SCAN_PROGRESS_POLL_INTERVAL_MS = 1000;

// Only equivalent initialization reads share a promise. Explicit refreshes remain
// new generations, including refreshes following mutations in another view.
const initialStatusRequests = new WeakMap<object, { key: string; promise: Promise<void> }>();
function accessContextKey() {
  const auth = useAuthStore();
  return JSON.stringify([auth.role, auth.authenticated, auth.enabled, auth.accessMode, auth.capabilities]);
}

function parseStoredRecentFolderSlugs(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry, index, items) => entry.length > 0 && items.indexOf(entry) === index)
      .slice(0, RECENT_OPENED_FOLDERS_LIMIT);
  } catch {
    return [];
  }
}

function getStoredLocalePreference(): SupportedLocale | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return resolveSupportedLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
}

function resolveSavedDefaultLocale(locale: string | null | undefined): SupportedLocale | null {
  return resolveSupportedLocale(locale);
}

function resolveAccentColor(value: unknown): AccentColor {
  return ACCENT_COLORS.includes(value as AccentColor) ? value as AccentColor : 'purple';
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    stats: null,
    statsGeneration: 0,
    statsContext: null,
    loadingStats: false,
    error: null,
    theme: 'light',
    locale: DEFAULT_LOCALE,
    videoMuted: true,
    lastOpenedFolderSlug: null,
    recentOpenedFolderSlugs: [],
    recentOpenedCreatorKeys: [],
    imageModalBackgroundPath: null,
    statsPollFailures: 0,
    statsPollTimer: null,
    statsPollInFlight: false
  }),
  getters: {
    isLibraryUnavailable: (state) => state.stats?.storage.available === false,
    libraryUnavailableReason: (state) => state.stats?.storage.reason ?? 'Configured library storage is unavailable.',
    isLibraryRebuildRequired: (state) => state.stats?.libraryIndex.rebuildRequired === true,
    isScanning: (state) => state.stats?.scan.isScanning === true,
    isRebuilding: (state) => state.stats?.scan.isScanning === true && state.stats?.scan.scanReason === 'rebuild',
    hasCompletedScan: (state) => state.stats?.scan.lastCompletedScan !== null,
    isInitialScan: (state) => state.stats?.scan.isScanning === true && state.stats?.scan.lastCompletedScan === null,
    defaultHomeFeedMode: (state): FeedMode => state.stats?.preferences.defaultHomeFeedMode ?? 'random',
    accentColor: (state): AccentColor => resolveAccentColor(state.stats?.preferences.accentColor),
    savedDefaultLocale: (state): SupportedLocale | null => resolveSupportedLocale(state.stats?.preferences.defaultLocale ?? null),
    defaultReelsFeedMode: (state): ReelsFeedMode => state.stats?.preferences.defaultReelsFeedMode ?? 'random',
    defaultFolderImageOrder: (state): FolderImageOrder => state.stats?.preferences.defaultFolderImageOrder ?? 'newest',
    nestedFolderTitleFormat: (state) => state.stats?.preferences.nestedFolderTitleFormat ?? 'folder',
    treatStoriesAsFolders: (state) => state.stats?.preferences.treatStoriesAsFolders === true,
    treatCarouselsAsFolders: (state) => state.stats?.preferences.treatCarouselsAsFolders === true,
    isCarouselsReconciliationPending: (state) => state.stats?.carouselsMigration?.reconciliationPending === true
  },
  actions: {
    persistOpenedFolderState() {
      if (this.lastOpenedFolderSlug) {
        window.localStorage.setItem(LAST_OPENED_FOLDER_STORAGE_KEY, this.lastOpenedFolderSlug);
      } else {
        window.localStorage.removeItem(LAST_OPENED_FOLDER_STORAGE_KEY);
      }

      window.localStorage.setItem(
        RECENT_OPENED_FOLDERS_STORAGE_KEY,
        JSON.stringify(this.recentOpenedFolderSlugs.slice(0, RECENT_OPENED_FOLDERS_LIMIT))
      );
    },

    initializeTheme() {
      const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      const preferredTheme =
        savedTheme === 'light' || savedTheme === 'dark'
          ? savedTheme
          : window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';

      this.setTheme(preferredTheme);
    },

    initializeLocale() {
      const rawStoredLocale = typeof window === 'undefined' ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY);
      const storedLocale = resolveSupportedLocale(rawStoredLocale);

      if (typeof window !== 'undefined') {
        if (rawStoredLocale && storedLocale && rawStoredLocale !== storedLocale) {
          window.localStorage.setItem(LOCALE_STORAGE_KEY, storedLocale);
        }

        if (rawStoredLocale && !storedLocale) {
          window.localStorage.removeItem(LOCALE_STORAGE_KEY);
        }
      }

      if (storedLocale) {
        this.setLocale(storedLocale, { persist: false });
        return;
      }

      // A fresh profile starts in Chinese, matching the initial HTML. Explicit
      // local preferences and the saved application default still take priority.
      this.setLocale(DEFAULT_LOCALE, { persist: false });
    },

    initializeLastOpenedFolder() {
      const savedSlug = window.localStorage.getItem(LAST_OPENED_FOLDER_STORAGE_KEY);
      this.lastOpenedFolderSlug = savedSlug && savedSlug.length > 0 ? savedSlug : null;

      const savedRecentSlugs = parseStoredRecentFolderSlugs(window.localStorage.getItem(RECENT_OPENED_FOLDERS_STORAGE_KEY));
      this.recentOpenedFolderSlugs = this.lastOpenedFolderSlug
        ? [this.lastOpenedFolderSlug, ...savedRecentSlugs.filter((slug) => slug !== this.lastOpenedFolderSlug)]
        : savedRecentSlugs;

      this.persistOpenedFolderState();
      const savedCreators = window.localStorage.getItem(RECENT_CREATORS_STORAGE_KEY);
      this.recentOpenedCreatorKeys = savedCreators === null
        ? [...this.recentOpenedFolderSlugs].slice(0, RECENT_OPENED_FOLDERS_LIMIT)
        : parseStoredRecentFolderSlugs(savedCreators);
      this.persistRecentCreators();
    },

    setTheme(theme: 'light' | 'dark') {
      this.theme = theme;
      document.documentElement.dataset.theme = theme;
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    },

    setLocale(locale: string | SupportedLocale, options: { persist?: boolean } = {}) {
      const resolvedLocale = resolvePreferredLocale(locale);

      this.locale = resolvedLocale;
      i18n.global.locale.value = resolvedLocale;
      syncDocumentLanguage(resolvedLocale);

      if ((options.persist ?? true) && typeof window !== 'undefined') {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, resolvedLocale);
      }
    },

    syncLocaleFromSavedDefault(defaultLocale: string | null | undefined) {
      if (getStoredLocalePreference()) {
        return;
      }

      const resolvedLocale = resolveSavedDefaultLocale(defaultLocale);
      if (!resolvedLocale) {
        return;
      }

      this.setLocale(resolvedLocale, { persist: false });
    },

    syncLocaleFromStats(stats?: AppStatus | null) {
      this.syncLocaleFromSavedDefault((stats ?? this.stats)?.preferences.defaultLocale ?? null);
    },

    syncAccentFromStats(stats?: AppStatus | null) {
      document.documentElement.dataset.accent = resolveAccentColor((stats ?? this.stats)?.preferences.accentColor);
    },

    syncLocaleFromAuthStatus(defaultLocale: string | null | undefined) {
      this.syncLocaleFromSavedDefault(defaultLocale);
    },

    toggleTheme() {
      this.setTheme(this.theme === 'light' ? 'dark' : 'light');
    },

    initializeVideoMuted() {
      const savedPreference = window.localStorage.getItem(VIDEO_MUTED_STORAGE_KEY);
      this.videoMuted = savedPreference === 'false' ? false : true;
    },

    setVideoMuted(videoMuted: boolean) {
      this.videoMuted = videoMuted;
      window.localStorage.setItem(VIDEO_MUTED_STORAGE_KEY, String(videoMuted));
    },

    recordOpenedFolder(slug: string) {
      this.lastOpenedFolderSlug = slug;
      this.recentOpenedFolderSlugs = [slug, ...this.recentOpenedFolderSlugs.filter((entry) => entry !== slug)].slice(
        0,
        RECENT_OPENED_FOLDERS_LIMIT
      );
      this.persistOpenedFolderState();
      this.recordRecentCreator(slug);
    },

    persistRecentCreators() {
      window.localStorage.setItem(RECENT_CREATORS_STORAGE_KEY, JSON.stringify(this.recentOpenedCreatorKeys));
    },

    recordRecentCreator(key: string) {
      this.recentOpenedCreatorKeys = [key, ...this.recentOpenedCreatorKeys.filter((entry) => entry !== key)]
        .slice(0, RECENT_OPENED_FOLDERS_LIMIT);
      this.persistRecentCreators();
    },

    recordOpenedRoute(route: Pick<RouteLocationNormalized, 'name' | 'params'>) {
      if (route.name === 'canonical-creator' || route.name === 'canonical-work-gallery') {
        const rawId = route.params.creatorId;
        if (typeof rawId !== 'string' || !/^[1-9]\d*$/.test(rawId)) return;
        const creatorId = Number(rawId);
        if (!Number.isSafeInteger(creatorId)) return;
        this.recordRecentCreator(`creator:${creatorId}`);
      } else if ((route.name === 'folder' || route.name === 'work-gallery') && typeof route.params.slug === 'string') {
        const slug = route.params.slug.trim();
        if (slug) this.recordOpenedFolder(slug);
      }
    },

    setImageModalBackground(path: string) {
      this.imageModalBackgroundPath = path;
    },

    clearImageModalBackground() {
      this.imageModalBackgroundPath = null;
    },

    markLibraryRebuildStarted() {
      if (!this.stats) {
        return;
      }

      this.error = null;
      this.stats = {
        ...this.stats,
        folders: 0,
        indexedImages: 0,
        indexedVideos: 0,
        scan: {
          ...this.stats.scan,
          isScanning: true,
          scanReason: 'rebuild',
          phase: 'discovery',
          startedAt: new Date().toISOString(),
          runId: null,
          migrationTotalRows: 0,
          processedMigrationRows: 0,
          migratedDerivativeFiles: 0,
          missingDerivativeFiles: 0,
          repairedDerivativeFiles: 0,
          backfilledAssetKeys: 0,
          discoveredFolders: 0,
          processedFolders: 0,
          discoveredImages: 0,
          processedImages: 0,
          queuedDerivativeJobs: 0,
          processedDerivativeJobs: 0,
          generatedThumbnails: 0,
          generatedPreviews: 0,
          currentOperation: 'discovering_media',
          currentFile: null,
          currentPhaseMessage: 'Discovering folders and media for the current gallery root.',
          currentFolder: null
        }
      };
      this.startStatsPolling();
    },

    markScanStatusUnavailable() {
      if (!this.stats) {
        return;
      }

      this.stats = {
        ...this.stats,
        scan: {
          ...this.stats.scan,
          isScanning: false,
          scanReason: null,
          phase: 'idle',
          startedAt: null,
          runId: null,
          migrationTotalRows: 0,
          processedMigrationRows: 0,
          migratedDerivativeFiles: 0,
          missingDerivativeFiles: 0,
          repairedDerivativeFiles: 0,
          backfilledAssetKeys: 0,
          discoveredFolders: 0,
          processedFolders: 0,
          discoveredImages: 0,
          processedImages: 0,
          queuedDerivativeJobs: 0,
          processedDerivativeJobs: 0,
          generatedThumbnails: 0,
          generatedPreviews: 0,
          currentOperation: null,
          currentFile: null,
          currentPhaseMessage: null,
          currentFolder: null
        }
      };
    },

    startStatsPolling() {
      if (this.statsPollTimer) {
        return;
      }

      this.statsPollTimer = window.setInterval(() => {
        if (document.visibilityState === 'hidden') {
          return;
        }

        if (!this.stats?.scan.isScanning) {
          this.stopStatsPolling();
          return;
        }

        if (this.statsPollInFlight) {
          return;
        }

        this.statsPollInFlight = true;
        void this.refreshScanProgress().finally(() => {
          this.statsPollInFlight = false;
        });
      }, SCAN_PROGRESS_POLL_INTERVAL_MS);
    },

    stopStatsPolling() {
      if (this.statsPollTimer) {
        clearInterval(this.statsPollTimer);
        this.statsPollTimer = null;
      }

      this.statsPollFailures = 0;
      this.statsPollInFlight = false;
    },

    resetProtectedState() {
      this.statsGeneration += 1;
      initialStatusRequests.delete(this);
      this.statsContext = null;
      this.stopStatsPolling();
      this.stats = null;
      this.loadingStats = false;
      this.error = null;
      this.imageModalBackgroundPath = null;
    },

    shouldUseAdminScanProgress() {
      return useAuthStore().canAccessSettings;
    },

    updateScanProgress(progress: ScanProgress) {
      if (!this.stats) {
        return;
      }

      this.stats = {
        ...this.stats,
        scan: progress
      };
    },

    removeIndexedImage(removedFolderCount = 0, mediaType: 'image' | 'video' = 'image') {
      if (!this.stats) {
        return;
      }

      this.stats.folders = Math.max(0, this.stats.folders - removedFolderCount);
      this.stats.indexedImages = Math.max(0, this.stats.indexedImages - 1);
      if (mediaType === 'video') {
        this.stats.indexedVideos = Math.max(0, this.stats.indexedVideos - 1);
      }
    },

    removeFolder(deletedImageCount: number) {
      if (!this.stats) {
        return;
      }

      this.stats.folders = Math.max(0, this.stats.folders - 1);
      this.stats.indexedImages = Math.max(0, this.stats.indexedImages - deletedImageCount);
    },

    ensureStatus(force = false): Promise<void> {
      const key = () => `${this.statsGeneration}:${accessContextKey()}`;
      const pending = initialStatusRequests.get(this);
      if (!force && pending?.key === key()) return pending.promise;
      if (!force && this.stats && this.statsContext === accessContextKey()) return Promise.resolve();
      const promise = this.fetchStats({ lightweight: true, background: force });
      const entry = { key: key(), promise };
      initialStatusRequests.set(this, entry);
      void promise.finally(() => {
        if (initialStatusRequests.get(this) === entry) initialStatusRequests.delete(this);
      });
      return promise;
    },

    async fetchStats(options: { background?: boolean; lightweight?: boolean } = {}) {
      // Stats calls also follow mutations: do not share an older read with a
      // newer refresh. Only the latest request in this access context may win.
      this.statsGeneration += 1;
      const admin = !options.lightweight && this.shouldUseAdminScanProgress();
      const contextKey = () => `${this.statsGeneration}:${accessContextKey()}`;
      const key = contextKey();
      const current = () => contextKey() === key;
      if (!options.background) {
        this.loadingStats = true;
        this.error = null;
      }
      try {
        const stats = admin ? await fetchAdminStats() : await fetchStatus();
        if (!current()) return;
        this.stats = stats;
        this.statsContext = accessContextKey();
        this.syncLocaleFromStats(this.stats);
        this.syncAccentFromStats(this.stats);
        this.statsPollFailures = 0;
        if (options.background && this.error) this.error = null;
        if (this.stats.scan.isScanning) {
          this.startStatsPolling();
        } else {
          this.stopStatsPolling();
        }
      } catch (error) {
        if (!current()) return;
        const message = error instanceof Error ? error.message : 'Unable to load app stats';
        if (options.background) {
          this.statsPollFailures += 1;
          if (this.statsPollFailures >= 3) {
            this.stopStatsPolling();
            this.markScanStatusUnavailable();
            this.error = 'Lost connection while refreshing scan status.';
          }
        } else {
          this.error = message;
        }
      } finally {
        if (current()) this.loadingStats = false;
      }
    },

    async refreshScanProgress() {
      if (!this.stats) {
        await this.fetchStats({ background: true, lightweight: true });
        return;
      }

      const key = `${this.statsGeneration}:${accessContextKey()}`;
      const current = () => key === `${this.statsGeneration}:${accessContextKey()}`;
      try {
        const progress = this.shouldUseAdminScanProgress()
          ? await fetchAdminScanProgress()
          : await fetchScanProgress();

        if (!current()) return;
        this.updateScanProgress(progress);
        this.statsPollFailures = 0;

        if (this.error) {
          this.error = null;
        }

        if (!progress.isScanning) {
          this.stopStatsPolling();
          await this.fetchStats({ background: true, lightweight: true });
        }
      } catch {
        if (!current()) return;
        this.statsPollFailures += 1;

        if (this.statsPollFailures >= 3) {
          this.stopStatsPolling();
          this.markScanStatusUnavailable();
          this.error = 'Lost connection while refreshing scan status.';
        }
      }
    }
  }
});
