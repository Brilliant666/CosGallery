import { createWebHistory, createRouter } from 'vue-router';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import WorkGalleryView from './views/WorkGalleryView.vue';
import { mixedOrientationItems, workDetail } from '../test/work-gallery-fixtures';
import { fetchImage, fetchFolder, fetchCanonicalCreator, fetchCanonicalCreatorWork } from './api/gallery';
import { useAppStore } from './stores/app';
import { useAuthStore } from './stores/auth';
import { useFoldersStore } from './stores/folders';
import { useLikesStore } from './stores/likes';
import { useCollectionsStore } from './stores/collections';

vi.mock('./router', () => ({ canAccessRoute: () => true, routeAllowsPublicShareAccess: () => false, routeLoadRecovery: { state: { value: null } } }));
vi.mock('./components/MediaLoadNotice.vue', () => ({ default: { template: '<div />' } }));
vi.mock('./api/gallery', async () => ({ ...await vi.importActual('./api/gallery'), fetchCanonicalCreator: vi.fn(), fetchCanonicalCreatorWork: vi.fn(), fetchImage: vi.fn(), fetchFolder: vi.fn().mockResolvedValue({ canonicalCreatorId: null }) }));
vi.mock('./views/PostView.vue', async () => {
  const { defineComponent } = await import('vue');
  const { useRouter, useRoute } = await import('vue-router');
  return { default: defineComponent({
    emits: ['close'],
    setup() {
      const router = useRouter();
      const route = useRoute();
      return { next: () => router.replace({ path: route.path, query: { ...route.query, media: String(Number(route.query.media) + 1) } }) };
    },
    template: '<div><button data-close @click="$emit(\'close\')">Close</button><button data-next @click="next">Next</button></div>'
  }) };
});

describe('work gallery route modal history and background', () => {
  enableAutoUnmount(afterEach);
  const histories: ReturnType<typeof createWebHistory>[] = [];
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchImage).mockReset().mockResolvedValue(workDetail());
    vi.mocked(fetchCanonicalCreatorWork).mockReset().mockResolvedValue(workDetail(mixedOrientationItems(500)));
    vi.mocked(fetchCanonicalCreator).mockReset().mockResolvedValue({ creator: { id: 166, canonicalCreatorId: 166, identityType: 'creator', name: 'lunana' } } as Awaited<ReturnType<typeof fetchCanonicalCreator>>);
    vi.mocked(fetchFolder).mockResolvedValue({ canonicalCreatorId: null } as Awaited<ReturnType<typeof fetchFolder>>);
    useAuthStore().ready = true;
    vi.spyOn(useAppStore(), 'fetchStats').mockResolvedValue();
    vi.spyOn(useFoldersStore(), 'fetchFolders').mockResolvedValue();
    vi.spyOn(useLikesStore(), 'initialize').mockResolvedValue();
    vi.spyOn(useCollectionsStore(), 'initialize').mockResolvedValue();
  });
  afterEach(() => { histories.splice(0).forEach((history) => history.destroy()); vi.restoreAllMocks(); });

  it.each([['close', 'stable', ''], ['back', 'stable', ''], ['close', 'auto', '15px']])('returns via %s with %s gutter, preserving DOM and scroll', async (method, gutter, padding) => {
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = computedStyle(element, pseudo);
      if (element === document.documentElement) Object.defineProperty(style, 'scrollbarGutter', { value: gutter });
      return style;
    });
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(window.innerWidth - 15);
    const history = createWebHistory();
    histories.push(history);
    const blank = { template: '<div data-creator>Creator</div>' };
    const router = createRouter({ history, routes: [
      { path: '/', name: 'home', component: blank },
      { path: '/f/:slug', name: 'folder', component: blank },
      { path: '/f/:slug/works/:postId', name: 'work-gallery', props: true, component: WorkGalleryView },
      { path: '/post/:id', name: 'image', component: blank }
    ] });
    await router.replace('/f/creator');
    await router.push('/f/creator/works/123');
    const wrapper = mount(App, { global: { plugins: [router], stubs: { AppShell: { template: '<main><slot /></main>' }, AdminUnlockDialog: true } } });
    await flushPromises();
    const grid = wrapper.get('.work-gallery__grid').element;
    const firstImage = wrapper.get('[data-position="1"] img').element;
    const scroll = vi.spyOn(window, 'scrollTo');
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(840);
    const before = window.history.length;
    await wrapper.get('[data-position="2"] a').trigger('click');
    await flushPromises();
    expect(wrapper.find('.app__image-modal-layer').exists()).toBe(true);
    expect(document.body.style.top).toBe('-840px');
    expect(document.body.style.paddingRight).toBe(padding);
    await wrapper.get('[data-next]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-next]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.media).toBe('704');
    expect(window.history.length).toBe(before + 1);
    expect(wrapper.get('.work-gallery__grid').element).toBe(grid);
    if (method === 'close') await wrapper.get('[data-close]').trigger('click');
    else router.back();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('work-gallery'));
    await flushPromises();
    expect(wrapper.find('.app__image-modal-layer').exists()).toBe(false);
    expect(wrapper.get('[data-position="1"] img').element).toBe(firstImage);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith(0, 840);
    expect(document.body.style.position).not.toBe('fixed');
    expect(document.body.style.paddingRight).toBe('');
    router.back();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('folder'));
    expect(wrapper.find('.app__image-modal-layer').exists()).toBe(false);
  });

  it.each(['close', 'back', 'escape'])('canonical query viewer preserves 500 nodes through %s and Forward without refetching', async (method) => {
    const history = createWebHistory();
    histories.push(history);
    const router = createRouter({ history, routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/library/:creatorId', name: 'canonical-creator', component: { template: '<div />' } },
      { path: '/library/:creatorId/works/:postId', name: 'canonical-work-gallery', props: true, component: WorkGalleryView }
    ] });
    await router.replace('/library/166?loaded=3');
    await router.push('/library/166/works/123?loaded=3&q=old');
    const wrapper = mount(App, { global: { plugins: [router], stubs: { AppShell: { template: '<main><slot /></main>' }, AdminUnlockDialog: true } } });
    await flushPromises();
    const grid = wrapper.get('.work-gallery__grid').element;
    const image = wrapper.get('[data-position="400"] img').element;
    const scroll = vi.spyOn(window, 'scrollTo');
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(1200);
    const before = window.history.length;
    await wrapper.get('[data-position="400"] a').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/library/166/works/123');
    expect(router.currentRoute.value.query).toEqual({ q: 'old', loaded: '3', media: '1100' });
    expect(document.body.style.top).toBe('-1200px');
    await wrapper.get('[data-next]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-next]').trigger('click');
    await flushPromises();
    expect(window.history.length).toBe(before + 1);
    expect(wrapper.get('.work-gallery__grid').element).toBe(grid);
    if (method === 'close') await wrapper.get('[data-close]').trigger('click');
    else if (method === 'back') router.back();
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.waitFor(() => expect(router.currentRoute.value.query.media).toBeUndefined());
    await flushPromises();
    expect(wrapper.find('.work-gallery__viewer').exists()).toBe(false);
    expect(wrapper.get('[data-position="400"] img').element).toBe(image);
    expect(wrapper.findAll('.work-media-card')).toHaveLength(500);
    expect(scroll).toHaveBeenCalledWith(0, 1200);
    expect(fetchCanonicalCreatorWork).toHaveBeenCalledTimes(1);
    expect(fetchCanonicalCreator).toHaveBeenCalledTimes(1);
    router.forward();
    await vi.waitFor(() => expect(router.currentRoute.value.query.media).toBe('1102'));
    expect(wrapper.get('.work-gallery__grid').element).toBe(grid);
    router.back();
    await vi.waitFor(() => expect(router.currentRoute.value.query.media).toBeUndefined());
    router.back();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('canonical-creator'));
  });

  it('replaces a direct canonical media link to its safe base, never to the unrelated previous page', async () => {
    const history = createWebHistory();
    histories.push(history);
    const router = createRouter({ history, routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/library/:creatorId', name: 'canonical-creator', component: { template: '<div />' } },
      { path: '/library/:creatorId/works/:postId', name: 'canonical-work-gallery', props: true, component: WorkGalleryView }
    ] });
    await router.replace('/');
    await router.push('/library/166/works/123?media=704&q=old');
    const wrapper = mount(App, { global: { plugins: [router], stubs: { AppShell: { template: '<main><slot /></main>' }, AdminUnlockDialog: true } } });
    await flushPromises();
    const length = window.history.length;
    await wrapper.get('[data-close]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/library/166/works/123?q=old');
    expect(window.history.length).toBe(length);
    expect(wrapper.findAll('.work-media-card')).toHaveLength(500);
  });
});
