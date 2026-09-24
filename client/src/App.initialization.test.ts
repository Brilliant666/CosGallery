import { createMemoryHistory, createRouter } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import { fetchFolders } from './api/gallery';
import type { AppStatus, FolderSummary } from './types/api';
import { useAppStore } from './stores/app';
import { useAuthStore } from './stores/auth';
import { useCreatorReadingStore } from './stores/creator-reading';
import { useFoldersStore } from './stores/folders';
import { useLikesStore } from './stores/likes';
import { useCollectionsStore } from './stores/collections';

vi.mock('./router', () => ({ canAccessRoute: () => true, routeAllowsPublicShareAccess: () => false, routeLoadRecovery: { state: { value: null } } }));
vi.mock('./components/MediaLoadNotice.vue', () => ({ default: { template: '<div />' } }));
vi.mock('./api/gallery', async () => ({ ...await vi.importActual('./api/gallery'), fetchFolders: vi.fn() }));
const stats = (folders = 1, scan = 1) => ({ folders, indexedPosts: 5, storage: { available: true }, scan: { lastCompletedScan: { id: scan } } } as AppStatus);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('protected initial hydration versus business invalidation', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchFolders).mockReset();
    useAuthStore().ready = true;
    vi.spyOn(useLikesStore(), 'initialize').mockResolvedValue();
    vi.spyOn(useCollectionsStore(), 'initialize').mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['stats-first', 'folders-first'])('%s makes one list request and retains initial reading state', async order => {
    const firstStats = deferred<AppStatus>();
    const firstFolders = deferred<FolderSummary[]>();
    const app = useAppStore();
    vi.spyOn(app, 'fetchStats').mockImplementation(async () => { app.stats = await firstStats.promise; });
    vi.mocked(fetchFolders).mockReturnValueOnce(firstFolders.promise).mockResolvedValue([]);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div>Current page ready</div>' } }] });
    await router.push('/');
    const wrapper = mount(App, { global: { plugins: [router], stubs: { AppShell: { template: '<main><slot /></main>' }, AdminUnlockDialog: true } } });
    const generation = useCreatorReadingStore().generation;
    expect(wrapper.text()).toContain('Current page ready');
    if (order === 'stats-first') {
      firstStats.resolve(stats()); await flushPromises();
      firstFolders.resolve([{ id: 1 } as FolderSummary]);
    } else {
      firstFolders.resolve([{ id: 1 } as FolderSummary]); await flushPromises();
      firstStats.resolve(stats());
    }
    await flushPromises();
    expect(fetchFolders).toHaveBeenCalledTimes(1);
    expect(useCreatorReadingStore().generation).toBe(generation);
    expect(useFoldersStore().hasLoadedList).toBe(true);
    // A real empty-library transition still refreshes, unlike initial hydration.
    app.stats = stats(0, 2);
    await flushPromises();
    expect(fetchFolders).toHaveBeenCalledTimes(2);
    expect(useFoldersStore().items).toEqual([]);
    expect(useCreatorReadingStore().generation).toBeGreaterThan(generation);
    app.stats = stats(0, 3);
    await flushPromises();
    expect(fetchFolders).toHaveBeenCalledTimes(3);
  });

  it('does not discard an invalidation arriving during the first list request', async () => {
    const first = deferred<FolderSummary[]>();
    const app = useAppStore();
    vi.spyOn(app, 'fetchStats').mockImplementation(async () => { app.stats = stats(); });
    vi.mocked(fetchFolders).mockReturnValueOnce(first.promise).mockResolvedValue([]);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/');
    mount(App, { global: { plugins: [router], stubs: { AppShell: { template: '<main><slot /></main>' }, AdminUnlockDialog: true } } });
    await flushPromises();
    expect(fetchFolders).toHaveBeenCalledTimes(1);
    app.stats = stats(0, 2);
    await flushPromises();
    first.resolve([{ id: 1 } as FolderSummary]);
    await flushPromises();
    expect(fetchFolders).toHaveBeenCalledTimes(2);
    expect(useFoldersStore().items).toEqual([]);
  });
});
