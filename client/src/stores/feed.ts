import { defineStore } from 'pinia';

import { fetchFeed } from '../api/gallery';
import type { FeedItem, FeedMode } from '../types/api';
import { updateCaptionInItems } from '../utils/caption';
import { useAuthStore } from './auth';

interface FeedState {
  mode: FeedMode;
  loadedMode: FeedMode | null;
  items: FeedItem[];
  page: number;
  limit: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  randomSeed: number | null;
  reloadRequested: boolean;
  generation: number;
}

function createRandomSeed(): number {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    return cryptoObject.getRandomValues(new Uint32Array(1))[0] ?? Math.floor(Math.random() * 2_147_483_647);
  }

  return Math.floor(Math.random() * 2_147_483_647);
}

export const useFeedStore = defineStore('feed', {
  state: (): FeedState => ({
    mode: 'random',
    loadedMode: null,
    items: [],
    page: 1,
    limit: 18,
    hasMore: true,
    loading: false,
    error: null,
    initialized: false,
    randomSeed: null,
    reloadRequested: false,
    generation: 0
  }),
  actions: {
    initializeMode(mode: FeedMode = 'random') {
      this.mode = mode;

      if (mode !== 'random') {
        this.randomSeed = null;
      }
    },

    ensureRandomSeed() {
      if (this.randomSeed !== null) {
        return this.randomSeed;
      }

      this.randomSeed = createRandomSeed();
      return this.randomSeed;
    },

    async setMode(mode: FeedMode) {
      if (this.mode === mode && this.initialized && mode !== 'random') {
        return;
      }

      this.mode = mode;
      this.randomSeed = mode === 'random' ? createRandomSeed() : null;
      await this.loadInitial(true);
    },

    removeImage(id: number) {
      this.items = this.items.filter((item) => item.id !== id);
    },

    removeFolderItems(folderSlug: string) {
      this.items = this.items.filter((item) => item.folderSlug !== folderSlug);
    },

    updateImageCaption(id: number, caption: string | null) {
      this.items = updateCaptionInItems(this.items, id, caption);
    },

    resetForRebuild() {
      this.generation += 1;
      this.loadedMode = null;
      this.items = [];
      this.page = 1;
      this.hasMore = true;
      this.loading = false;
      this.error = null;
      this.initialized = false;
      this.reloadRequested = false;
    },

    async loadInitial(force = false) {
      const queueRequiresSeed = this.mode === 'random';
      const queueMatchesMode = this.loadedMode === this.mode && (!queueRequiresSeed || this.randomSeed !== null);

      if (this.loading) {
        if (force || !queueMatchesMode) {
          this.reloadRequested = true;
        }
        return;
      }

      if (this.initialized && !force && queueMatchesMode) {
        return;
      }

      this.items = [];
      this.loadedMode = null;
      this.page = 1;
      this.hasMore = true;
      this.initialized = false;
      this.reloadRequested = false;
      await this.loadMore();
    },

    async loadMore() {
      if (this.loading || !this.hasMore) {
        return;
      }

      this.loading = true;
      this.error = null;
      const requestMode = this.mode;
      const requestPage = this.page;
      const requestSeed = requestMode === 'random' ? this.ensureRandomSeed() : undefined;
      const generation = this.generation;
      const accessKey = () => JSON.stringify([useAuthStore().role, useAuthStore().authenticated, useAuthStore().capabilities]);
      const access = accessKey();
      const current = () => generation === this.generation && access === accessKey();

      try {
        const payload = await fetchFeed(requestPage, this.limit, requestMode, requestSeed);
        if (!current()) return;

        const modeChanged = this.mode !== requestMode;
        const seedChanged = requestMode === 'random' && this.randomSeed !== requestSeed;
        const pageChanged = this.page !== requestPage;

        if (modeChanged || seedChanged || pageChanged) {
          return;
        }

        this.items.push(...payload.items);
        this.loadedMode = payload.mode ?? requestMode;
        this.page += 1;
        this.hasMore = payload.hasMore;
        this.initialized = true;
      } catch (error) {
        if (current()) this.error = error instanceof Error ? error.message : 'Unable to load feed';
      } finally {
        if (current()) this.loading = false;

        if (current() && this.reloadRequested) {
          this.reloadRequested = false;
          await this.loadInitial(true);
        }
      }
    }
  }
});
