import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import LibraryNavigation from './LibraryNavigation.vue';
import CosGalleryHomeView from '../views/CosGalleryHomeView.vue';
import { fetchCosGalleryCreators } from '../api/gallery';
import { useAuthStore } from '../stores/auth';
import { useCreatorReadingStore } from '../stores/creator-reading';
import type { AuthRole, CosGalleryCreator } from '../types/api';

vi.mock('../api/gallery', () => ({ fetchCosGalleryCreators: vi.fn() }));
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
  const wrapper = mount({ components: { LibraryNavigation }, template: `<main><LibraryNavigation variant="${variant}" /><RouterView /></main>` }, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

describe('gallery navigation and public reading state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchCosGalleryCreators).mockReset().mockResolvedValue(payload());
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
    }
    expect(nav.emitted('open-change')).toEqual([[true]]);
    await toggle.trigger('click');
    expect(nav.find('[aria-label="图库分类"]').exists()).toBe(false);
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
