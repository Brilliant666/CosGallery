import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFeed, fetchFeedSearch, fetchFolders } from '../api/gallery';
import { i18n } from '../locales';
import { useExploreStore } from '../stores/explore';
import type { FeedItem } from '../types/api';
import ExploreView from './ExploreView.vue';

vi.mock('../api/gallery', () => ({ fetchFeed: vi.fn(), fetchFeedSearch: vi.fn(), fetchFolders: vi.fn() }));
const routerState = vi.hoisted(() => ({ route: { query: {} as Record<string, string> }, replace: vi.fn(), push: vi.fn() }));
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  routerState.route = reactive(routerState.route);
  return { useRoute: () => routerState.route, useRouter: () => ({ replace: routerState.replace, push: routerState.push }) };
});
function page(ids: number[], hasMore = false) {
  return { items: ids.map(id => ({ id, folderId: 1, folderSlug: 'sample', folderName: 'Sample', folderPath: 'sample', folderBreadcrumb: null, filename: `${id}.jpg`, width: 100, height: 100, mediaType: 'image', durationMs: null, thumbnailUrl: `/thumb/${id}`, previewUrl: `/preview/${id}`, sortTimestamp: id, takenAt: null } as FeedItem)), page: 1, limit: 30, total: 60, hasMore };
}
const mountView = () => mount(ExploreView, { global: { stubs: {
  Avatar: true,
  ExploreGrid: { props: ['items'], template: '<div data-test="results">{{ items.map(item => item.id).join(",") }}</div>' },
  InfiniteLoader: { template: '<div data-test="infinite-loader" />' }
} } });

describe('explore error recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); setActivePinia(createPinia()); window.localStorage.clear();
    i18n.global.locale.value = 'en'; routerState.route.query = {};
    routerState.replace.mockImplementation(async value => { routerState.route.query = value.query; });
    vi.mocked(fetchFeed).mockResolvedValue(page([]));
    vi.mocked(fetchFeedSearch).mockResolvedValue(page([]));
    vi.mocked(fetchFolders).mockResolvedValue([]);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('names the input separately from Clear search and retries a failed first search', async () => {
    routerState.route.query = { q: 'sample' };
    vi.mocked(fetchFeedSearch).mockRejectedValueOnce(new Error('Search unavailable')).mockResolvedValueOnce(page([1]));
    const wrapper = mountView();
    await vi.advanceTimersByTimeAsync(180); await flushPromises();
    expect(wrapper.get('input[type=search]').attributes('aria-label')).toBe(i18n.global.t('explore.searchLabel'));
    expect(wrapper.get('button[aria-label="Clear search"]').exists()).toBe(true);
    expect(wrapper.get('[role=alert]').text()).toContain('Search unavailable');
    await wrapper.get('[data-test=retry-search]').trigger('click'); await flushPromises();
    expect(fetchFeedSearch).toHaveBeenLastCalledWith('sample', 1, 30);
    expect(wrapper.get('[data-test=results]').text()).toBe('1');
    expect(wrapper.find('[role=alert]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps earlier search results visible after a later page fails and retries that page', async () => {
    routerState.route.query = { q: 'sample' };
    vi.mocked(fetchFeedSearch).mockResolvedValueOnce(page([1], true)).mockRejectedValueOnce(new Error('Page unavailable')).mockResolvedValueOnce(page([2]));
    const wrapper = mountView(); await vi.advanceTimersByTimeAsync(180); await flushPromises();
    await useExploreStore().loadMoreSearch(); await flushPromises();
    expect(wrapper.get('[data-test=results]').text()).toBe('1');
    expect(wrapper.find('[data-test=infinite-loader]').exists()).toBe(false);
    await wrapper.get('[data-test=retry-search]').trigger('click'); await flushPromises();
    expect(fetchFeedSearch).toHaveBeenLastCalledWith('sample', 2, 30);
    expect(wrapper.get('[data-test=results]').text()).toBe('1,2');
    wrapper.unmount();
  });

  it('offers a retry for directory lookup failure instead of showing no matches', async () => {
    routerState.route.query = { q: 'sample', tab: 'folders' };
    vi.mocked(fetchFolders).mockRejectedValueOnce(new Error('Directory unavailable')).mockResolvedValueOnce([]);
    const wrapper = mountView(); await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('Directory unavailable');
    expect(wrapper.text()).not.toContain(i18n.global.t('explore.noFoldersFound'));
    await wrapper.get('[data-test=retry-directories]').trigger('click'); await flushPromises();
    expect(fetchFolders).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain(i18n.global.t('explore.noFoldersFound'));
    wrapper.unmount();
  });

  it('retries the random discovery feed without requiring a page reload', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('Feed unavailable')).mockResolvedValueOnce(page([1]));
    const wrapper = mountView(); await flushPromises();
    const seed = useExploreStore().randomSeed;
    await wrapper.get('[data-test=retry-explore]').trigger('click'); await flushPromises();
    expect(fetchFeed).toHaveBeenLastCalledWith(1, 30, 'random', seed);
    expect(wrapper.get('[data-test=results]').text()).toBe('1');
    wrapper.unmount();
  });
});
