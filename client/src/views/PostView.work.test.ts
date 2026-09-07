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
    expect(wrapper.get('a').attributes('href')).toBe(returnTo);
    await router.replace({ query: { ...router.currentRoute.value.query, media: '705' } });
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
