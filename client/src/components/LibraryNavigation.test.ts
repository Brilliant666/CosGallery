import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import LibraryNavigation from './LibraryNavigation.vue';
import CosGalleryHomeView from '../views/CosGalleryHomeView.vue';
import { fetchCosGalleryCreators, fetchCreatorGalleryLabels, updateCreatorGalleryLabels } from '../api/gallery';
import { useAuthStore } from '../stores/auth';
import { useCreatorReadingStore } from '../stores/creator-reading';
import type { AuthRole, CosGalleryCreator } from '../types/api';

vi.mock('../api/gallery', () => ({ fetchCosGalleryCreators: vi.fn(), fetchCreatorGalleryLabels: vi.fn(), updateCreatorGalleryLabels: vi.fn() }));
enableAutoUnmount(afterEach);
const creator = { id: 12, key: 'creator:12', identityType: 'creator', canonicalCreatorId: 12, name: 'Sample creator', slug: 'sample', contentRating: 'R18', galleryLabels: ['cosplay', 'portrait'], workCount: 1 } as CosGalleryCreator;
function payload(name = 'Sample creator') { return { items: [{ ...creator, name }], total: 1, page: 1, limit: 60, hasMore: false, summary: { all: 1, R15: 0, R18: 1, unclassified: 0, unlinked: 0, inactive: 0 } }; }
function become(role: AuthRole) {
  const auth = useAuthStore();
  auth.applyStatus({ enabled: true, authenticated: role !== 'anonymous', role, accessMode: 'public', likesMode: role === 'anonymous' ? 'local' : 'shared', defaultLocale: null,
    capabilities: { canAccessSettings: role === 'admin', canManageLibrary: role === 'admin', canDeleteMedia: role === 'admin', canUseSharedLikes: role !== 'anonymous', canUseLocalFavorites: role === 'anonymous', canUseSharedCollections: role !== 'anonymous', canUseLocalCollections: role === 'anonymous' } });
}
async function setup(path: string, variant: 'desktop' | 'mobile' = 'desktop') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/library', name: 'library', component: CosGalleryHomeView },
    { path: '/library/:creatorId', name: 'canonical-creator', component: { template: '<div>Creator</div>' } },
    { path: '/', name: 'home', component: { template: '<div>Home</div>' } }
  ] });
  await router.push(path);
  await router.isReady();
  const wrapper = mount({ components: { LibraryNavigation }, data: () => ({ collapsed: false }), template: `<main><aside class="sidebar"><button data-test="sidebar-toggle" data-sidebar-control @click="collapsed = !collapsed"><span>Toggle sidebar</span></button><LibraryNavigation variant="${variant}" :collapsed="collapsed" /></aside><RouterView /></main>` }, { attachTo: document.body, global: { plugins: [router], stubs: { Teleport: true } } });
  await flushPromises();
  return { wrapper, router };
}

describe('gallery navigation and public reading state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchCosGalleryCreators).mockReset().mockResolvedValue(payload());
    vi.mocked(fetchCreatorGalleryLabels).mockReset().mockResolvedValue({ galleryLabels: [], revision: 'a'.repeat(64) });
    vi.mocked(updateCreatorGalleryLabels).mockReset();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    become('admin');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['desktop', 'mobile'] as const)('%s has separate all-gallery navigation and four category links', async variant => {
    const { wrapper, router } = await setup('/library?rating=R18&preference=liked&q=sample', variant);
    const toggle = wrapper.get('button[aria-label="展开图库分类"]');
    await toggle.trigger('click');
    expect(router.currentRoute.value.query).toEqual({ rating: 'R18', preference: 'liked', q: 'sample' });
    const links = wrapper.get('[aria-label="图库分类"]').findAll('a');
    expect(links.map(link => link.text())).toEqual(['Cosplay', '写真', '自拍', '福利姬']);
    await links[1].trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ label: 'portrait' });
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[aria-label="图库分类"] a[aria-current="page"]').text()).toBe('写真');
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(undefined, '', 1, 60, undefined, 'portrait');
    expect(wrapper.find('[aria-label="分级"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="creator-rating"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="creator-gallery-labels"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="edit-gallery-labels"]').exists()).toBe(false);
    expect(wrapper.get('h1').text()).toBe('写真图库');
    expect(wrapper.get('a[href^="/library/12"]').attributes('href')).toBe('/library/12?label=portrait');
    await wrapper.get('a[aria-label="图库"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/library');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[aria-label="图库分类"]').exists()).toBe(false);
    expect(wrapper.get('h1').text()).toBe('全部图库');
    expect(wrapper.find('[aria-label="分级"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="creator-rating"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="creator-gallery-labels"]').text()).toContain('Cosplay');
    expect(wrapper.get('[data-test="creator-gallery-labels"]').text()).toContain('写真');
    expect(wrapper.find('[data-test="edit-gallery-labels"]').exists()).toBe(true);
    // Back restores the category rather than reviving its discarded rating.
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ label: 'portrait' });
    expect(wrapper.find('[aria-label="分级"]').exists()).toBe(false);
  });

  it('removes a category deep link rating before requesting data and repeated all resets unsent search', async () => {
    const { wrapper, router } = await setup('/library?label=cosplay&rating=R18');
    expect(router.currentRoute.value.query).toEqual({ label: 'cosplay' });
    expect(vi.mocked(fetchCosGalleryCreators).mock.calls.every(call => call[0] === undefined)).toBe(true);
    await wrapper.get('a[aria-label="图库"]').trigger('click'); await flushPromises();
    await wrapper.get('input[type="search"]').setValue('unsent draft');
    await wrapper.get('a[aria-label="图库"]').trigger('click'); await flushPromises();
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('');
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0 });
  });

  it.each(['desktop', 'mobile'] as const)('%s keeps all four categories available through repeated selections', async variant => {
    const { wrapper, router } = await setup('/library', variant);
    const nav = wrapper.getComponent(LibraryNavigation);
    const toggle = nav.get('button[aria-label="展开图库分类"]');
    await toggle.trigger('click');
    const options = [
      ['cosplay', 'Cosplay', 'i-fluent-person-star-20-regular'],
      ['portrait', '写真', 'i-fluent-camera-20-regular'],
      ['selfie', '自拍', 'i-fluent-phone-20-regular'],
      ['fuliji', '福利姬', 'i-fluent-sparkle-20-regular']
    ] as const;
    for (const [value, label, icon] of [...options, options[3]]) {
      const link = nav.get(`.library-nav__menu a[href="/library?label=${value}"]`);
      expect(link.text()).toBe(label);
      expect(link.get('[aria-hidden="true"]').classes()).toContain(icon);
      await link.trigger('click');
      await flushPromises();
      expect(router.currentRoute.value.query).toEqual({ label: value });
      expect(toggle.attributes('aria-expanded')).toBe('true');
      expect(nav.get('[aria-current="page"]').text()).toBe(label);
      expect(wrapper.find('[data-test="creator-gallery-labels"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="edit-gallery-labels"]').exists()).toBe(false);
    }
    expect(nav.emitted('open-change')).toEqual([[true]]);
    await toggle.trigger('click');
    expect(nav.find('[aria-label="图库分类"]').exists()).toBe(false);
  });

  it.each(['admin', 'anonymous', 'viewer'] as const)('shows %s public labels only in all-gallery and preserves labels through all four category round trips', async role => {
    become(role);
    const response = payload();
    response.items.push({ ...creator, id: 13, key: 'creator:13', canonicalCreatorId: 13, name: 'Untagged creator', galleryLabels: [] });
    response.total = 2;
    const originalLabels = response.items.map(item => [...(item.galleryLabels ?? [])]);
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue(response);
    const { wrapper } = await setup('/library');
    const expectAllCards = () => {
      expect(wrapper.findAll('[data-test="creator-gallery-labels"] span').map(badge => badge.text())).toEqual(['Cosplay', '写真']);
      expect(wrapper.findAll('[data-test="edit-gallery-labels"]')).toHaveLength(role === 'admin' ? 2 : 0);
      expect(wrapper.find('[data-test="edit-gallery-labels"][aria-label="编辑 Untagged creator 的分类"]').exists()).toBe(role === 'admin');
    };
    expectAllCards();
    for (const value of ['cosplay', 'portrait', 'selfie', 'fuliji']) {
      await wrapper.get('button[aria-label="展开图库分类"]').trigger('click');
      await wrapper.get(`.library-nav__menu a[href="/library?label=${value}"]`).trigger('click');
      await flushPromises();
      expect(wrapper.findAll('[aria-label="博主目录"] article')).toHaveLength(2);
      expect(wrapper.find('[data-test="creator-gallery-labels"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="edit-gallery-labels"]').exists()).toBe(false);
      await wrapper.get('a[aria-label="图库"]').trigger('click');
      await flushPromises();
      expectAllCards();
    }
    expect(response.items.map(item => item.galleryLabels)).toEqual(originalLabels);
    expect(fetchCreatorGalleryLabels).not.toHaveBeenCalled();
    expect(updateCreatorGalleryLabels).not.toHaveBeenCalled();
  });

  it('opens classification for an untagged admin card without navigating or saving on cancel', async () => {
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue({ ...payload(), items: [{ ...creator, galleryLabels: [] }] });
    const { wrapper, router } = await setup('/library');
    expect(wrapper.find('[data-test="creator-gallery-labels"]').exists()).toBe(false);
    await wrapper.get('[data-test="edit-gallery-labels"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/library');
    expect(fetchCreatorGalleryLabels).toHaveBeenCalledExactlyOnceWith(12);
    expect(wrapper.get('[role="dialog"]').findAll('input[type="checkbox"]')).toHaveLength(4);
    expect(wrapper.get('[role="dialog"]').findAll('input:checked')).toHaveLength(0);
    const cancel = wrapper.get('[role="dialog"]').findAll('button').find(button => button.text() === '取消');
    await cancel!.trigger('click');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(updateCreatorGalleryLabels).not.toHaveBeenCalled();
  });

  it('closes an open editor when entering a category and does not reopen it on return to all', async () => {
    const { wrapper, router } = await setup('/library');
    await wrapper.get('[data-test="edit-gallery-labels"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    await router.push('/library?label=cosplay');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="edit-gallery-labels"]').exists()).toBe(false);
    await router.push('/library');
    await flushPromises();
    expect(wrapper.find('[data-test="edit-gallery-labels"]').exists()).toBe(true);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(updateCreatorGalleryLabels).not.toHaveBeenCalled();
  });

  it.each(['desktop', 'mobile'] as const)('%s closes for outside clicks and routes outside a category list', async variant => {
    const { wrapper, router } = await setup('/library?label=portrait', variant);
    const nav = wrapper.getComponent(LibraryNavigation);
    const toggle = nav.get('button[aria-label="展开图库分类"]');
    await toggle.trigger('click');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(toggle.attributes('aria-expanded')).toBe('false');
    for (const path of ['/library/12?label=portrait', '/library', '/']) {
      await router.push('/library?label=portrait');
      await flushPromises();
      await toggle.trigger('click');
      await router.push(path);
      await flushPromises();
      expect(toggle.attributes('aria-expanded')).toBe('false');
      expect(nav.find('[aria-label="图库分类"]').exists()).toBe(false);
    }
  });

  it.each(['desktop', 'mobile'] as const)('%s reports its open state and Escape closes while retaining keyboard focus', async variant => {
    const { wrapper } = await setup('/library', variant);
    const nav = wrapper.getComponent(LibraryNavigation);
    const toggle = nav.get('button[aria-label="展开图库分类"]');
    await toggle.trigger('click');
    expect(nav.emitted('open-change')).toEqual([[true]]);
    expect(nav.classes()).toContain('library-nav--open');
    await nav.get('[aria-label="图库分类"] a').trigger('keydown', { key: 'Escape' });
    expect(nav.emitted('open-change')).toEqual([[true], [false]]);
    expect(nav.find('[aria-label="图库分类"]').exists()).toBe(false);
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle.element);
  });

  it('hides a desktop submenu on collapse, moves its focus and restores the open choice on expansion', async () => {
    const { wrapper } = await setup('/library?label=portrait');
    const nav = wrapper.getComponent(LibraryNavigation);
    await nav.get('button[aria-label="展开图库分类"]').trigger('click');
    (nav.get('.library-nav__menu a').element as HTMLAnchorElement).focus();
    await wrapper.setData({ collapsed: true });
    await flushPromises();
    expect(nav.find('.library-nav__menu').exists()).toBe(false);
    expect(document.activeElement).toBe(nav.get('a[aria-label="图库"]').element);
    expect(nav.emitted('open-change')).toEqual([[true]]);
    await wrapper.setData({ collapsed: false });
    await flushPromises();
    expect(nav.get('.library-nav__menu a[aria-current="page"]').text()).toBe('写真');
    expect(nav.get('button[aria-label="展开图库分类"]').attributes('aria-expanded')).toBe('true');
    expect(nav.emitted('open-change')).toEqual([[true]]);
  });

  it('keeps the category choice when the actual sidebar toggle receives pointerdown', async () => {
    const { wrapper } = await setup('/library?label=cosplay');
    const nav = wrapper.getComponent(LibraryNavigation);
    await nav.get('button[aria-label="展开图库分类"]').trigger('click');
    const shellToggle = wrapper.get('[data-test="sidebar-toggle"]');
    await shellToggle.get('span').trigger('pointerdown');
    await shellToggle.trigger('click');
    await shellToggle.trigger('pointerdown');
    await shellToggle.trigger('click');
    await flushPromises();
    expect(nav.get('.library-nav__menu a[aria-current="page"]').text()).toBe('Cosplay');
    expect(nav.emitted('open-change')).toEqual([[true]]);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(nav.find('.library-nav__menu').exists()).toBe(false);
  });

  it('does not let a desktop collapse preference hide mobile categories', async () => {
    const { wrapper } = await setup('/library', 'mobile');
    const nav = wrapper.getComponent(LibraryNavigation);
    await nav.get('button[aria-label="展开图库分类"]').trigger('click');
    await wrapper.setData({ collapsed: true });
    expect(nav.findAll('.library-nav__menu a')).toHaveLength(4);
    expect(nav.get('button[aria-label="展开图库分类"]').attributes('aria-expanded')).toBe('true');
  });

  it.each(['anonymous', 'viewer'] as const)('cleans %s private links and rejects stale admin data after a role switch', async role => {
    let resolveOld!: (value: ReturnType<typeof payload>) => void;
    vi.mocked(fetchCosGalleryCreators).mockImplementationOnce(() => new Promise(done => { resolveOld = done; })).mockResolvedValue(payload('Public creator'));
    const { wrapper, router } = await setup('/library?preference=liked');
    const reading = useCreatorReadingStore();
    reading.libraryPages['old-admin-cache'] = { items: [{ ...creator, preference: 'liked' }], total: 1, scrollY: 99 };
    become(role);
    expect(reading.libraryPages).toEqual({});
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(undefined, '', 1, 60, undefined, undefined);
    expect(wrapper.find('[aria-label="偏好"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="edit-gallery-labels"]').exists()).toBe(false);
    resolveOld(payload('Private stale creator'));
    await flushPromises();
    expect(wrapper.text()).toContain('Public creator');
    expect(wrapper.text()).not.toContain('Private stale creator');
  });

  it('clears an already displayed private subset before waiting for a public request, including failure', async () => {
    const { wrapper, router } = await setup('/library?preference=liked');
    expect(wrapper.text()).toContain('Sample creator');
    let rejectPublic!: (error: Error) => void;
    vi.mocked(fetchCosGalleryCreators).mockImplementation(() => new Promise((_resolve, reject) => { rejectPublic = reject; }));
    become('anonymous');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(wrapper.text()).not.toContain('Sample creator');
    expect(wrapper.find('[aria-label="博主目录"]').exists()).toBe(false);
    rejectPublic(new Error('Public request failed'));
    await flushPromises();
    expect(wrapper.text()).toContain('Public request failed');
    expect(wrapper.text()).not.toContain('Sample creator');
  });
});
