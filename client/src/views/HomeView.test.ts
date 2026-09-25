import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { i18n } from '../locales';
import type { AppStatus, ScanProgress } from '../types/api';
import { useAppStore } from '../stores/app';
import { useFeedStore } from '../stores/feed';
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

  it('waits for first feed settlement and a paint opportunity before moments, with a stable rail slot', async () => {
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }) });
    let complete!: () => void;
    vi.spyOn(useFeedStore(), 'loadInitial').mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const moments = vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
    const wrapper = mountHomeView();
    await flushPromises();
    expect(moments).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="moments-slot"]').attributes('aria-busy')).toBe('true');
    complete();
    await flushPromises();
    expect(moments).not.toHaveBeenCalled();
    frames.shift()!(0);
    await flushPromises();
    expect(moments).not.toHaveBeenCalled();
    frames.shift()!(16);
    await flushPromises();
    expect(moments).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('still requests moments after a failed first feed, without waiting forever', async () => {
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }) });
    vi.spyOn(galleryApi, 'fetchFeed').mockRejectedValue(new Error('feed offline'));
    const moments = vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const wrapper = mountHomeView();
    await flushPromises();
    expect(useFeedStore().error).toBe('feed offline');
    expect(moments).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it.each(['leave', 'access', 'reset'] as const)('does not dispatch a delayed rail after %s', async reason => {
    useAppStore().$patch({ stats: createAppStatus({ isScanning: false }) });
    let complete!: () => void;
    vi.spyOn(useFeedStore(), 'loadInitial').mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const moments = vi.spyOn(useMomentsStore(), 'fetchMoments').mockResolvedValue();
    const wrapper = mountHomeView();
    await flushPromises();
    if (reason === 'leave') wrapper.unmount();
    if (reason === 'access') useAuthStore().$patch({ authenticated: false, role: 'anonymous', accessMode: 'password', enabled: true });
    if (reason === 'reset') useAppStore().resetProtectedState();
    complete();
    await flushPromises();
    expect(moments).not.toHaveBeenCalled();
    if (reason !== 'leave') wrapper.unmount();
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

  it('renders the home stories rail with a dedicated horizontal scroll track', async () => {
    const appStore = useAppStore();
    const feedStore = useFeedStore();
    const momentsStore = useMomentsStore();

    appStore.$patch({
      stats: createAppStatus({
        isScanning: false
      })
    });
    feedStore.$patch({
      initialized: true,
      loading: false,
      items: []
    });
    momentsStore.$patch({
      items: [
        createMomentCapsule('moment-1', 'One'),
        createMomentCapsule('moment-2', 'Two'),
        createMomentCapsule('moment-3', 'Three'),
        createMomentCapsule('moment-4', 'Four')
      ]
    });

    vi.spyOn(feedStore, 'loadInitial').mockResolvedValue();
    vi.spyOn(momentsStore, 'fetchMoments').mockResolvedValue();

    const wrapper = mountHomeView();

    await flushPromises();

    expect(wrapper.get('.stories-bar.story-rail').attributes('aria-label')).toBe('Moments');
    expect(wrapper.get('.story-rail__track').classes()).not.toContain('justify-center');
    expect(wrapper.findAll('.story-rail__item')).toHaveLength(4);
  });

  it('localizes static highlight capsule titles on the home rail', async () => {
    const appStore = useAppStore();
    const feedStore = useFeedStore();
    const momentsStore = useMomentsStore();

    i18n.global.locale.value = 'zh';

    appStore.$patch({
      stats: createAppStatus({
        isScanning: false
      })
    });
    feedStore.$patch({
      initialized: true,
      loading: false,
      items: []
    });
    momentsStore.$patch({
      railKind: 'highlights',
      items: [
        createMomentCapsule('highlight-recent-batches', 'Recent Batches')
      ]
    });

    vi.spyOn(feedStore, 'loadInitial').mockResolvedValue();
    vi.spyOn(momentsStore, 'fetchMoments').mockResolvedValue();

    const wrapper = mountHomeView();

    await flushPromises();

    expect(wrapper.text()).toContain('近期批次');
  });
});
