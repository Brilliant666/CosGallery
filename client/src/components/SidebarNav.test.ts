import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import SidebarNav from './SidebarNav.vue';
import { usePlacesStore } from '../stores/places';
import { useFoldersStore } from '../stores/folders';
import { useAppStore } from '../stores/app';
import type { FolderSummary } from '../types/api';
import { i18n } from '../locales';

enableAutoUnmount(afterEach);

async function setup(folders: FolderSummary[] = [], recentHistory: string[] = []) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useFoldersStore().items = folders;
  useAppStore().recentOpenedCreatorKeys = recentHistory;
  vi.spyOn(usePlacesStore(), 'fetchPlaces').mockResolvedValue(undefined);
  const router = createRouter({ history: createMemoryHistory(), routes:
    ['home', 'library', 'reels', 'explore', 'places', 'likes', 'collections', 'trash', 'archive-catalog', 'creator-admission', 'settings', 'folder']
      .map(name => ({ name, path: name === 'home' ? '/' : `/${name}`, component: { template: '<p>Fixture</p>' } }))
      .concat([{ name: 'canonical-creator', path: '/library/:creatorId', component: { template: '<p>Fixture</p>' } }])
  });
  await router.push('/library');
  await router.isReady();
  const wrapper = mount({ components: { SidebarNav }, data: () => ({ expanded: false }),
    template: '<SidebarNav :expanded="expanded" @expanded-change="expanded = $event" />'
  }, { global: { plugins: [pinia, router] } });
  await nextTick();
  return { wrapper, sidebar: wrapper.getComponent(SidebarNav), router };
}

describe('sidebar hover intent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 48rem)', addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('requires 100 ms dwell, delays exit by 120 ms and cancels pending collapse on reentry', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(99);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(119);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(119);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
  });

  it('cancels a brief pass and starts a fresh dwell when the pointer returns', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(45);
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(99);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).toContain('sidebar--expanded');
  });

  it.each(['cosplay', 'portrait', 'selfie', 'fuliji'])('collapses after leaving %s while preserving its open list and selected route', async label => {
    const { sidebar, router } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(100);
    const toggle = sidebar.get('button[aria-label="展开图库分类"]');
    await toggle.trigger('click');
    await sidebar.get(`.library-nav__menu a[href="/library?label=${label}"]`).trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ label });
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(119);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(toggle.attributes('disabled')).toBeDefined();
    expect(sidebar.find('.library-nav__menu').exists()).toBe(false);
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    expect(sidebar.get(`.library-nav__menu a[href="/library?label=${label}"]`).attributes('aria-current')).toBe('page');
    expect(sidebar.findAll('.library-nav__menu a')).toHaveLength(4);
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(60);
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    expect(router.currentRoute.value.query).toEqual({ label });
  });
});

describe('recently viewed creators', () => {
  function creator(id: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
    return {
      id, canonicalCreatorId: id + 100, slug: `creator-${id}`, name: `Creator ${id}`, description: null,
      folderPath: `creator-${id}`, breadcrumb: null, contentRating: 'R15',
      postCount: 3, imageCount: 3, videoCount: 0, latestImageMtimeMs: null,
      avatarImageId: null, avatarUrl: null, ...overrides
    };
  }

  it('hides the entire recent section without valid browsing history instead of filling it with recommendations', async () => {
    i18n.global.locale.value = 'zh';
    const { sidebar } = await setup([creator(1)], ['missing-creator']);
    expect(sidebar.find('.sidebar__section-label').exists()).toBe(false);
    expect(sidebar.find('.sidebar__folder').exists()).toBe(false);
    useAppStore().recentOpenedCreatorKeys = [];
    await nextTick();
    expect(sidebar.text()).not.toContain('最近浏览');
  });

  it('shows browsing order, deduplicates canonical creators and reacts to newly opened creators', async () => {
    i18n.global.locale.value = 'zh';
    const { sidebar } = await setup([
      creator(1), creator(2), creator(3), creator(4, { canonicalCreatorId: 102 })
    ], ['creator:102', 'creator-4', 'creator-1']);
    const routes = () => sidebar.findAll('.sidebar__folder').map(link => link.attributes('href'));
    expect(routes()).toEqual(['/library/102', '/library/101']);
    useAppStore().recentOpenedCreatorKeys = ['creator:103', 'creator:102', 'creator-1'];
    await nextTick();
    expect(routes()).toEqual(['/library/103', '/library/102', '/library/101']);
    expect(sidebar.text()).toContain('最近浏览');
    expect(sidebar.text()).not.toContain('精选博主');
  });

  it('shows the work count instead of a physical breadcrumb and opens the canonical creator', async () => {
    i18n.global.locale.value = 'zh';
    const { sidebar, router } = await setup([{
      id: 11, canonicalCreatorId: 42, slug: 'sample', name: '合成博主', description: null,
      folderPath: 'Sample', breadcrumb: '旧父目录', contentRating: 'R15',
      postCount: 3, imageCount: 99, videoCount: 0, latestImageMtimeMs: null,
      avatarImageId: null, avatarUrl: null
    }], ['creator:42']);
    expect(sidebar.text()).toContain('最近浏览');
    const link = sidebar.get('.sidebar__folder');
    expect(link.get('small').text()).toBe('3 个作品');
    expect(link.attributes('href')).toBe('/library/42');
    await link.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.params.creatorId).toBe('42');
  });
});
