import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { galleryTestRouter, workDetail } from '../../test/work-gallery-fixtures';
import { useViewerStore } from '../stores/viewer';
import PostView from './PostView.vue';

describe('PostView work deep links', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => setActivePinia(createPinia()));
  it('derives a safe return route from loaded Post data, without refetching on media changes', async () => {
    const store = useViewerStore();
    const load = vi.spyOn(store, 'loadImage').mockImplementation(async () => { store.image = workDetail(); });
    const router = galleryTestRouter();
    await router.push('/post/123?media=704&context=work&returnTo=https://example.invalid');
    const wrapper = mount(PostView, { props: { id: '123' }, global: { plugins: [router], stubs: { PostViewer: true, ConfirmDialog: true } } });
    await flushPromises();
    expect(wrapper.get('a').attributes('href')).toBe('/f/creator/works/123');
    expect(wrapper.get('a').text()).toContain('Back to work gallery');
    await router.replace('/post/123?media=705&context=work');
    expect(load).toHaveBeenCalledTimes(1);
    expect(wrapper.get('a').attributes('href')).not.toContain('example.invalid');
    await wrapper.setProps({ modal: true });
    expect(wrapper.find('a').exists()).toBe(false);
  });

  it('reloads canonical deep links through the ownership-scoped endpoint and returns to the exact work URL', async () => {
    const store = useViewerStore();
    const load = vi.spyOn(store, 'loadImage').mockImplementation(async () => { store.image = workDetail(); });
    const router = galleryTestRouter();
    const returnTo = '/library/166/works/123?loaded=2';
    await router.push({
      name: 'image',
      params: { id: '123' },
      query: { media: '704', context: 'work', creator: '166', returnTo }
    });
    const wrapper = mount(PostView, {
      props: { id: '123' },
      global: { plugins: [router], stubs: { PostViewer: true, ConfirmDialog: true } }
    });
    await flushPromises();

    expect(load).toHaveBeenCalledExactlyOnceWith(123, undefined, 166);
    expect(router.currentRoute.value.fullPath).toBe('/library/166/works/123?loaded=2&media=704');
    await router.replace({ query: { ...router.currentRoute.value.query, media: '705' } });
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each(['abc', '0', '166&creator=2'])('rejects malformed or repeated legacy creator %s without a generic lookup', async (creator) => {
    const load = vi.spyOn(useViewerStore(), 'loadImage');
    const router = galleryTestRouter();
    await router.push(`/post/123?context=work&creator=${creator}&media=704`);
    const wrapper = mount(PostView, { props: { id: '123' }, global: { plugins: [router], stubs: { PostViewer: true, ConfirmDialog: true } } });
    await flushPromises();
    expect(load).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('creator identity is invalid');
    expect(router.currentRoute.value.name).toBe('image');
  });

  it.each(['nope', '99999', '704&media=705', ''])('does not redirect or display first media for invalid canonical bookmark media %s', async (media) => {
    const store = useViewerStore();
    vi.spyOn(store, 'loadImage').mockImplementation(async () => { store.image = workDetail(); });
    const router = galleryTestRouter();
    await router.push(`/post/123?context=work&creator=166&media=${media}`);
    const wrapper = mount(PostView, { props: { id: '123' }, global: { plugins: [router], stubs: { PostViewer: true, ConfirmDialog: true } } });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('selected media does not exist');
    expect(wrapper.find('post-viewer-stub').exists()).toBe(false);
    expect(router.currentRoute.value.name).toBe('image');
  });

  it('does not redirect an unauthorized creator/Post response or stale work from another context', async () => {
    const store = useViewerStore();
    store.image = workDetail();
    vi.spyOn(store, 'loadImage').mockImplementation(async () => { store.image = null; store.error = 'Post not found'; });
    const router = galleryTestRouter();
    await router.push('/post/123?context=work&creator=999&media=704');
    const wrapper = mount(PostView, { props: { id: '123' }, global: { plugins: [router], stubs: { PostViewer: true, ConfirmDialog: true } } });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Post not found');
    expect(router.currentRoute.value.name).toBe('image');
  });

  it('reuses authorized canonical detail and forwards caption mutation rather than restoring stale work on reopen', async () => {
    const store = useViewerStore();
    const load = vi.spyOn(store, 'loadImage');
    const router = galleryTestRouter();
    await router.push('/library/166/works/123?media=704');
    const wrapper = mount(PostView, { props: { id: '123', authorizedWork: workDetail(), modal: true }, global: { plugins: [router], stubs: { PostViewer: true, ConfirmDialog: true } } });
    await flushPromises();
    expect(load).not.toHaveBeenCalled();
    store.updateCaption(123, 'Updated caption');
    await flushPromises();
    expect(wrapper.emitted('updatedWork')?.[0]?.[0]).toMatchObject({ id: 123, caption: 'Updated caption' });
    await router.replace('/library/166/works/123?media=999999');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('selected media does not exist');
    expect(wrapper.find('post-viewer-stub').exists()).toBe(false);
    expect(router.currentRoute.value.query.media).toBe('999999');
  });

  it('preserves only flat whitelisted reading state on an authorized legacy redirect', async () => {
    const store = useViewerStore();
    vi.spyOn(store, 'loadImage').mockImplementation(async () => { store.image = workDetail(); });
    const router = galleryTestRouter();
    await router.push('/post/123?context=work&creator=166&media=704&q=old&loaded=3&returnTo=https://example.invalid&unknown=no');
    mount(PostView, { props: { id: '123' }, global: { plugins: [router], stubs: { PostViewer: true, ConfirmDialog: true } } });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/library/166/works/123');
    expect(router.currentRoute.value.query).toEqual({ media: '704', q: 'old', loaded: '3' });
  });
});
