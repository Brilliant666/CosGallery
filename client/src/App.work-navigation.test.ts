import { createWebHistory, createRouter } from 'vue-router';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import WorkGalleryView from './views/WorkGalleryView.vue';
import { workDetail } from '../test/work-gallery-fixtures';
import { fetchImage } from './api/gallery';
import { useAppStore } from './stores/app';
import { useAuthStore } from './stores/auth';
import { useFoldersStore } from './stores/folders';
import { useLikesStore } from './stores/likes';
import { useCollectionsStore } from './stores/collections';

vi.mock('./router', () => ({ canAccessRoute: () => true, routeAllowsPublicShareAccess: () => false }));
vi.mock('./api/gallery', async () => ({ ...await vi.importActual('./api/gallery'), fetchImage: vi.fn() }));
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
    useAuthStore().ready = true;
    vi.spyOn(useAppStore(), 'fetchStats').mockResolvedValue();
    vi.spyOn(useFoldersStore(), 'fetchFolders').mockResolvedValue();
    vi.spyOn(useLikesStore(), 'initialize').mockResolvedValue();
    vi.spyOn(useCollectionsStore(), 'initialize').mockResolvedValue();
  });
  afterEach(() => { histories.splice(0).forEach((history) => history.destroy()); vi.restoreAllMocks(); });

  it.each(['close', 'back'])('returns once via %s, preserving DOM and scroll, then back to creator', async (method) => {
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
    router.back();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('folder'));
    expect(wrapper.find('.app__image-modal-layer').exists()).toBe(false);
  });
});
