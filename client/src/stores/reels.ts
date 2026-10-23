import { defineStore } from 'pinia';

import { fetchReels } from '../api/gallery';
import type { ReelItem, ReelsFeedMode } from '../types/api';
import { resolveReelsAffinitySnapshot, type ReelsAffinitySnapshot } from '../utils/reels';
import { useAppStore } from './app';

interface ReelsState {
  mode: ReelsFeedMode;
  loadedMode: ReelsFeedMode | null;
  items: ReelItem[];
  page: number;
  limit: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  seed: number | null;
  affinitySnapshot: ReelsAffinitySnapshot | null;
  activeReelId: number | null;
  cursor: string | null;
}

function createReelsSeed(): number {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    return cryptoObject.getRandomValues(new Uint32Array(1))[0] ?? Math.floor(Math.random() * 2_147_483_647);
  }

  return Math.floor(Math.random() * 2_147_483_647);
}

export const useReelsStore = defineStore('reels', {
  state: (): ReelsState => ({
    mode: 'random',
    loadedMode: null,
    items: [],
    page: 1,
    limit: 6,
    hasMore: true,
    loading: false,
    error: null,
    initialized: false,
    seed: null,
    affinitySnapshot: null,
    activeReelId: null,
    cursor: null
  }),
  getters: {
    activeItem: (state) => state.items.find((item) => item.id === state.activeReelId) ?? state.items[0] ?? null
  },
  actions: {
    syncModeWithDefault(force = false) {
      const appStore = useAppStore();
      const nextMode = appStore.defaultReelsFeedMode;
      const modeChanged = this.mode !== nextMode;

      this.mode = nextMode;

      if (modeChanged) {
        this.seed = null;
      }

      this.affinitySnapshot = this.mode === 'recommended' && !force && !modeChanged ? this.affinitySnapshot : null;
      return modeChanged;
    },

    ensureSeed() {
      if (this.seed !== null) {
        return this.seed;
      }

      this.seed = createReelsSeed();
      return this.seed;
    },

    setActiveReel(id: number | null) {
      this.activeReelId = id;
    },

    reset() {
      this.mode = 'random';
      this.loadedMode = null;
      this.items = [];
      this.page = 1;
      this.hasMore = true;
      this.loading = false;
      this.error = null;
      this.initialized = false;
      this.seed = null;
      this.affinitySnapshot = null;
      this.activeReelId = null;
      this.cursor = null;
    },

    async loadInitial(force = false) {
      if (this.loading) {
        return;
      }

      const modeChanged = this.syncModeWithDefault(force);
      if (force) this.seed = null;
      const queueRequiresSeed = this.mode !== 'recent';
      const queueMatchesMode = this.loadedMode === this.mode && (!queueRequiresSeed || this.seed !== null);

      if (this.initialized && !force && !modeChanged && queueMatchesMode) {
        return;
      }

      this.items = [];
      this.loadedMode = null;
      this.page = 1;
      this.hasMore = true;
      this.error = null;
      this.initialized = false;
      this.activeReelId = null;
      this.cursor = null;
      await this.loadMore();
    },

    async loadMore() {
      if (this.loading || !this.hasMore) {
        return;
      }

      const appStore = useAppStore();
      if (this.mode === 'recommended') {
        this.affinitySnapshot = resolveReelsAffinitySnapshot(
          this.affinitySnapshot,
          appStore.lastOpenedFolderSlug,
          appStore.recentOpenedFolderSlugs
        );
      } else {
        this.affinitySnapshot = null;
      }

      this.loading = true;
      this.error = null;

      try {
        const payload = await fetchReels(
          this.page,
          this.limit,
          this.mode,
          this.mode === 'recent' ? undefined : this.ensureSeed(),
          {
            ...(this.cursor ? { cursor: this.cursor } : {}),
            ...(this.mode === 'recommended'
              ? {
                  lastFolder: this.affinitySnapshot?.lastFolder ?? null,
                  recentFolders: this.affinitySnapshot?.recentFolders ?? []
                }
              : {})
          }
        );

        const knownMediaIds = new Set(this.items.map(item => item.mediaId));
        this.items.push(...payload.items.filter(item => !knownMediaIds.has(item.mediaId)));
        this.cursor = payload.nextCursor ?? null;
        this.loadedMode = payload.mode ?? this.mode;
        this.page += 1;
        this.hasMore = payload.hasMore;
        this.initialized = true;

        if (this.activeReelId === null && this.items.length > 0) {
          this.activeReelId = this.items[0]?.id ?? null;
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Unable to load reels';
      } finally {
        this.loading = false;
      }
    },

    async prefetchIfNeeded(activeIndex: number) {
      if (activeIndex < 0 || !this.hasMore || this.loading) {
        return;
      }

      if (activeIndex >= this.items.length - 3) {
        await this.loadMore();
      }
    },

    updateImageCaption(id: number, caption: string | null) {
      this.items = this.items.map(item => item.postId === id ? { ...item, caption } : item);
    }
  }
});
