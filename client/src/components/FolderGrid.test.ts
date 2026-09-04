import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { galleryTestRouter, mediaItem, workDetail } from '../../test/work-gallery-fixtures';
import { useAppStore } from '../stores/app';
import FolderGrid from './FolderGrid.vue';

describe('FolderGrid explicit navigation', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => setActivePinia(createPinia()));

  async function render(props: Record<string, unknown> = {}) {
    const router = galleryTestRouter();
    await router.push('/f/creator');
    const wrapper = mount(FolderGrid, {
      props: { items: [workDetail()], ...props },
      global: { plugins: [router], stubs: { ResilientImage: true } }
    });
    return { wrapper, router };
  }

  it.each([true, false])('retains normal carousel behavior regardless of showWorkLabels=%s', async (showWorkLabels) => {
    const { wrapper, router } = await render({ showWorkLabels });
    expect(wrapper.get('a').attributes('href')).toBe('/post/123');
    await wrapper.get('a').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('image');
    expect(useAppStore().imageModalBackgroundPath).toBe('/f/creator');
  });

  it.each([1, 5])('opens work-gallery explicitly for a %i-media work without modal state', async (count) => {
    const items = [workDetail(Array.from({ length: count }, (_, i) => mediaItem(i + 1)))];
    const { wrapper, router } = await render({ items, navigationMode: 'work-gallery', showWorkLabels: true });
    expect(wrapper.get('a').attributes('href')).toBe('/f/creator/works/123');
    expect(wrapper.get('a').attributes('aria-label')).toContain('Creator');
    if (count > 1) expect(wrapper.text()).toContain('Creator');
    await wrapper.get('a').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('work-gallery');
    expect(useAppStore().imageModalBackgroundPath).toBeNull();
  });

  it('keeps public share routes separate even if a work navigation prop is passed', async () => {
    const { wrapper, router } = await render({ sharedSlug: 'public', navigationMode: 'work-gallery' });
    expect(wrapper.get('a').attributes('href')).toBe('/share/public/posts/123');
    await wrapper.get('a').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('shared-post');
    expect(useAppStore().imageModalBackgroundPath).toBeNull();
  });

  it('preserves modifier-click native links', async () => {
    const { wrapper, router } = await render({ navigationMode: 'work-gallery' });
    // Keep jsdom from attempting native tab navigation after the component leaves this click alone.
    wrapper.get('a').element.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await wrapper.get('a').trigger('click', { ctrlKey: true });
    expect(router.currentRoute.value.name).toBe('folder');
    expect(useAppStore().imageModalBackgroundPath).toBeNull();
  });
});
