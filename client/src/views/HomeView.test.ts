import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { i18n } from '../locales';
import type { AppStatus, FolderSummary, ScanProgress } from '../types/api';
import { useAppStore } from '../stores/app';
import { useFeedStore } from '../stores/feed';
import { useFoldersStore } from '../stores/folders';
import { useMomentsStore } from '../stores/moments';
import { useAuthStore } from '../stores/auth';
import * as galleryApi from '../api/gallery';
import HomeView from './HomeView.vue';

const routerLinkStub = defineComponent({
  name: 'RouterLink',
  props: {
    to: {
      type: [String, Object],
      default: null
    }
  },
  template: '<a><slot /></a>'
});

function createScanProgress(overrides: Partial<ScanProgress> = {}): ScanProgress {
  return {
    isScanning: true,
    scanReason: 'startup',
    phase: 'discovery',
    startedAt: '2026-04-03T12:00:00.000Z',
    runId: 1,
    migrationTotalRows: 0,
    processedMigrationRows: 0,
    migratedDerivativeFiles: 0,
    missingDerivativeFiles: 0,
    repairedDerivativeFiles: 0,
    backfilledAssetKeys: 0,
    discoveredFolders: 3,
    processedFolders: 1,
    discoveredImages: 12,
    processedImages: 4,
    queuedDerivativeJobs: 0,
    processedDerivativeJobs: 0,
    generatedThumbnails: 0,
    generatedPreviews: 0,
    currentOperation: 'discovering_media',
    currentFile: null,
    currentPhaseMessage: 'Discovering folders and media...',
    currentFolder: null,
    lastCompletedScan: null,
    ...overrides
  };
}

function createAppStatus(scanOverrides: Partial<ScanProgress> = {}): AppStatus {
  return {
    folders: 0,
    indexedImages: 0,
    indexedVideos: 0,
    scan: createScanProgress(scanOverrides),
    storage: {
      available: true,
      reason: null
    },
    libraryIndex: {
      rebuildRequired: false,
      reason: null,
      ignoredRootMediaCount: 0
    },
    preferences: {
      defaultHomeFeedMode: 'random',
      defaultReelsFeedMode: 'recommended',
      treatStoriesAsFolders: false
    },
    storiesMigration: {
      hasLegacyStoriesCandidates: false,
      decisionPending: false
    }
  };
}

function createMomentCapsule(id: string, title: string) {
  return {
    id,
    title,
    subtitle: `${title} capsule`,
    dateContext: 'Latest Apr 9, 2026',
    imageCount: 1,
    coverImage: {
      id: Number(id.replace(/\D/g, '')) || 1,
      folderId: 10,
      folderSlug: 'weekend-trip',
      folderName: 'Weekend Trip',
      folderPath: 'weekend-trip',
      folderBreadcrumb: null,
      filename: `${id}.jpg`,
      width: 1080,
      height: 1080,
      mediaType: 'image' as const,
      durationMs: null,
      thumbnailUrl: `/thumbs/${id}.webp`,
      previewUrl: `/previews/${id}.webp`,
      sortTimestamp: 1_777_000_000_000,
      takenAt: 1_777_000_000_000
    }
  };
}

function mountHomeView() {
  return mount(HomeView, {
    global: {
      stubs: {
        RouterLink: routerLinkStub,
        Avatar: true,
        EmptyState: true,
        ErrorState: true,
        FeedList: true,
        InfiniteLoader: true,
        StoriesModal: true
      }
    }
  });
}

function recommendationFolder(id: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id, canonicalCreatorId: id + 100, slug: `creator-${id}`, name: `Creator ${id}`,
    description: null, folderPath: `creator-${id}`, breadcrumb: null, contentRating: 'R15',
    imageCount: 17, postCount: 17, videoCount: 0, latestImageMtimeMs: id,
    avatarImageId: null, avatarUrl: null, ...overrides
  };
}

describe('HomeView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    i18n.global.locale.value = 'en';
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1280
    });
  });

  it('keeps recent creators eligible in recommendations while preserving work counts and canonical links', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }), recentOpenedCreatorKeys: ['creator:102'] });
    useFoldersStore().items = Array.from({ length: 6 }, (_, index) => recommendationFolder(index + 1,
      index === 0 ? { postCount: 7, imageCount: 999 } : {}));
    vi.spyOn(useFeedStore(), 'loadInitial').mockResolvedValue();
    vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const wrapper = mountHomeView();
    await flushPromises();

    const rail = wrapper.get('aside[aria-label="Creator recommendations"]');
    expect(rail.element.firstElementChild?.querySelector('h2')?.textContent).toBe('Recommended creators');
    const links = rail.findAllComponents(routerLinkStub).filter(link => link.attributes('aria-label')?.endsWith('View works'));
    expect(links).toHaveLength(6);
    expect(new Set(links.map(link => JSON.stringify(link.props('to')))).size).toBe(6);
    expect(links.some(link => link.text().includes('Creator 2'))).toBe(true);
    const countedCreator = links.find(link => link.props('to').params.creatorId === '101');
    expect(countedCreator?.text()).toContain('7 works');
    expect(countedCreator?.text()).not.toContain('999');
    expect(countedCreator?.props('to')).toEqual({ name: 'canonical-creator', params: { creatorId: '101' } });
    expect(rail.findAll('a a')).toHaveLength(0);
    const all = rail.findAllComponents(routerLinkStub).find(link => link.text() === 'View all');
    expect(all?.props('to')).toEqual({ name: 'library' });
    const attribution = rail.get('a[href="https://github.com/foldergram/foldergram"]');
    expect(attribution.text()).toBe('Built on Foldergram');
    expect(attribution.attributes('target')).toBe('_blank');
    expect(attribution.attributes('rel')).toBe('noreferrer');
    wrapper.unmount();
  });

  it('does not reorder or hide recommendations when local browsing history changes', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }), recentOpenedCreatorKeys: ['creator:101'] });
    useFoldersStore().items = [recommendationFolder(1), recommendationFolder(2), recommendationFolder(3)];
    vi.spyOn(useFeedStore(), 'loadInitial').mockResolvedValue();
    vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const wrapper = mountHomeView();
    await flushPromises();
    const creatorIds = () => wrapper.findAllComponents(routerLinkStub)
      .filter(link => link.attributes('aria-label')?.endsWith('View works'))
      .map(link => link.props('to').params.creatorId).sort();
    expect(creatorIds()).toEqual(['101', '102', '103']);
    useAppStore().recentOpenedCreatorKeys = ['creator:102', 'creator:101'];
    await flushPromises();
    expect(creatorIds()).toEqual(['101', '102', '103']);
    useAppStore().recentOpenedCreatorKeys = ['creator:103', 'creator:102', 'creator:101'];
    await flushPromises();
    expect(creatorIds()).toEqual(['101', '102', '103']);
    wrapper.unmount();
  });

  it('uses the same complete-library destination for public visitors and keeps the single-creator and empty cases coherent', async () => {
    i18n.global.locale.value = 'zh';
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    useAuthStore().$patch({ authenticated: false, role: 'anonymous', accessMode: 'public', enabled: true });
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }) });
    useFoldersStore().items = [recommendationFolder(1, { postCount: undefined, breadcrumb: 'Legacy source path' })];
    vi.spyOn(useFeedStore(), 'loadInitial').mockResolvedValue();
    vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const wrapper = mountHomeView();
    await flushPromises();

    const rail = wrapper.get('aside[aria-label="博主推荐"]');
    expect(rail.get('h2').text()).toBe('推荐博主');
    expect(rail.findAllComponents(routerLinkStub).filter(link => link.attributes('aria-label')?.endsWith('查看作品'))).toHaveLength(1);
    expect(rail.text()).toContain('17 个作品');
    expect(rail.findAll('p')[0].text()).not.toContain('Legacy source path');
    expect(rail.text()).not.toContain('查看收藏');
    expect(rail.text()).not.toContain('查看赞过');
    expect(rail.findAllComponents(routerLinkStub).find(link => link.text() === '查看全部')?.props('to')).toEqual({ name: 'library' });
    useFoldersStore().items = [];
    await flushPromises();
    expect(wrapper.find('aside').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows an explicit startup scan phase badge and updates it with the current phase', async () => {
    const appStore = useAppStore();
    const feedStore = useFeedStore();
    const momentsStore = useMomentsStore();

    appStore.$patch({
      stats: createAppStatus()
    });

    vi.spyOn(feedStore, 'loadInitial').mockResolvedValue();
    vi.spyOn(momentsStore, 'fetchMoments').mockResolvedValue();

    const wrapper = mountHomeView();

    await flushPromises();

    expect(wrapper.get('[data-test="initial-scan-phase"]').text()).toBe('Discovery');

    appStore.$patch({
      stats: createAppStatus({
        phase: 'derivatives',
        queuedDerivativeJobs: 12,
        processedDerivativeJobs: 5,
        currentOperation: 'generating_thumbnail_and_preview',
        currentPhaseMessage: 'Generating thumbnails and previews for queued changes.'
      })
    });

    await flushPromises();

    expect(wrapper.get('[data-test="initial-scan-phase"]').text()).toBe('Derivatives');
  });

  it('waits for saved preferences before mounting the loader and requests only recent', async () => {
    let resolve!: (status: AppStatus) => void;
    vi.spyOn(galleryApi, 'fetchStats').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const fetch = vi.spyOn(galleryApi, 'fetchFeed').mockResolvedValue({ items: [], page: 1, limit: 18, total: 0, hasMore: false, mode: 'recent' });
    vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const wrapper = mountHomeView();
    await flushPromises();
    expect(wrapper.findComponent({ name: 'InfiniteLoader' }).exists()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    const status = createAppStatus({ isScanning: false });
    status.preferences.defaultHomeFeedMode = 'recent';
    resolve(status);
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(1, 18, 'recent', undefined);
    wrapper.unmount();
  });

  it('keeps three mode circles visible while the feed is pending, failed, or moments are unavailable', async () => {
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }) });
    let rejectFeed!: (error: Error) => void;
    vi.spyOn(galleryApi, 'fetchFeed').mockImplementation(() => new Promise((_resolve, reject) => { rejectFeed = reject; }));
    const moments = vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    useMomentsStore().$patch({ items: [], listError: 'old moments error' });
    const wrapper = mountHomeView();
    await flushPromises();
    expect(wrapper.findAll('[data-feed-mode]').map(button => button.attributes('data-feed-mode'))).toEqual(['recent', 'rediscover', 'random']);
    expect(wrapper.get('[data-feed-mode="random"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.find('.story-rail__loading').exists()).toBe(true);
    expect(wrapper.find('[data-test="moments-slot"]').exists()).toBe(false);
    expect(moments).not.toHaveBeenCalled();
    rejectFeed(new Error('feed offline'));
    await flushPromises();
    expect(useFeedStore().error).toBe('feed offline');
    expect(wrapper.get('[data-feed-mode="random"]').attributes('aria-busy')).toBe('false');
    expect(wrapper.findAll('[data-feed-mode]')).toHaveLength(3);
    expect(moments).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('switches the lower feed with the circles and repeated random clicks create a new seed', async () => {
    const status = createAppStatus({ isScanning: false });
    status.preferences.defaultHomeFeedMode = 'recent';
    useAppStore().$patch({ stats: status });
    const fetch = vi.spyOn(galleryApi, 'fetchFeed').mockImplementation(async (page, limit, mode) => ({ items: [], page, limit, total: 0, hasMore: false, mode }));
    const moments = vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    let seed = 100;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array: any) => { array[0] = ++seed; return array; });
    const wrapper = mountHomeView();
    await flushPromises();
    expect(wrapper.get('[data-feed-mode="recent"]').attributes('aria-pressed')).toBe('true');
    await wrapper.get('[data-feed-mode="rediscover"]').trigger('click');
    await flushPromises();
    expect(fetch).toHaveBeenLastCalledWith(1, 18, 'rediscover', undefined);
    expect(wrapper.get('[data-feed-mode="rediscover"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-feed-mode="recent"]').attributes('aria-pressed')).toBe('false');
    await wrapper.get('[data-feed-mode="random"]').trigger('click');
    await flushPromises();
    expect(fetch).toHaveBeenLastCalledWith(1, 18, 'random', 101);
    await wrapper.get('[data-feed-mode="random"]').trigger('click');
    await flushPromises();
    expect(fetch).toHaveBeenLastCalledWith(1, 18, 'random', 102);
    expect(wrapper.findComponent({ name: 'StoriesModal' }).exists()).toBe(false);
    expect(moments).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('keeps an explicit mode choice while preferences are pending', async () => {
    let resolve!: (status: AppStatus) => void;
    vi.spyOn(galleryApi, 'fetchStats').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const fetch = vi.spyOn(galleryApi, 'fetchFeed').mockResolvedValue({ items: [], page: 1, limit: 18, total: 0, hasMore: false, mode: 'rediscover' });
    vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const wrapper = mountHomeView();
    const mode = wrapper.findAll('button').find(button => button.attributes('aria-label')?.startsWith('Rediscover'));
    expect(mode).toBeDefined();
    await mode!.trigger('click');
    expect(fetch).not.toHaveBeenCalled();
    const status = createAppStatus({ isScanning: false });
    status.preferences.defaultHomeFeedMode = 'recent';
    resolve(status);
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(1, 18, 'rediscover', undefined);
    wrapper.unmount();
  });

  it('does not load feed when storage is unavailable or the view left during initialization', async () => {
    const status = createAppStatus({ isScanning: false });
    status.storage.available = false;
    vi.spyOn(galleryApi, 'fetchStats').mockResolvedValueOnce(status);
    const fetch = vi.spyOn(galleryApi, 'fetchFeed');
    const wrapper = mountHomeView();
    await flushPromises();
    expect(fetch).not.toHaveBeenCalled();
    wrapper.unmount();
    useAppStore().resetProtectedState();
    let resolve!: (value: AppStatus) => void;
    vi.mocked(galleryApi.fetchStats).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const departed = mountHomeView();
    departed.unmount();
    resolve(createAppStatus({ isScanning: false }));
    await flushPromises();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows fixed localized mode labels even when legacy moment capsules contain different titles', async () => {
    i18n.global.locale.value = 'zh';
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }) });
    useMomentsStore().$patch({ railKind: 'highlights', items: [createMomentCapsule('highlight-recent-batches', 'Recent Batches')] });
    vi.spyOn(useFeedStore(), 'loadInitial').mockResolvedValue();
    const moments = vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const wrapper = mountHomeView();
    await flushPromises();
    expect(wrapper.findAll('.story-rail__label').map(label => label.text())).toEqual(['最新', '重新发现', '随机']);
    expect(wrapper.get('.story-rail--feed-modes').attributes('role')).toBe('group');
    expect(wrapper.text()).not.toContain('近期批次');
    expect(moments).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('reuses existing lightweight thumbnails and falls back without losing the mode button', async () => {
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }) });
    useFoldersStore().items = [recommendationFolder(1, { avatarUrl: '/thumbnails/creator-1.webp' })];
    vi.spyOn(useFeedStore(), 'loadInitial').mockResolvedValue();
    const wrapper = mountHomeView();
    await flushPromises();
    const recent = wrapper.get('[data-feed-mode="recent"]');
    expect(recent.get('img').attributes('src')).toBe('/thumbnails/creator-1.webp');
    expect(wrapper.get('[data-feed-mode="rediscover"]').find('img').exists()).toBe(false);
    await recent.get('img').trigger('error');
    expect(recent.find('img').exists()).toBe(false);
    expect(recent.find('.story-rail__fallback').exists()).toBe(true);
    expect(wrapper.findAll('[data-feed-mode]')).toHaveLength(3);
    wrapper.unmount();
  });
});
