import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { galleryTestRouter, mediaItem, workDetail } from '../../test/work-gallery-fixtures';
import { useAppStore } from '../stores/app';
import FolderGrid from './FolderGrid.vue';
import ResilientImage from './ResilientImage.vue';
import type { CanonicalWorkSummary } from '../types/api';

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

  function summary(): CanonicalWorkSummary {
    const { mediaItems: _mediaItems, ...item } = workDetail([mediaItem(1, 'video'), mediaItem(2, 'image')]);
    return {
      ...item, representation: 'summary', postType: 'carousel', itemCount: 2, imageCount: 1, videoCount: 1,
      cardCover: { imageId: 702, filename: 'cover.jpg', thumbnailUrl: '/thumbnails/702.webp?v=cover' }
    };
  }

  it('uses the summary image cover and alt while linking to the work ID and preserving video and album badges', async () => {
    const item = summary();
    const { wrapper, router } = await render({
      items: [item], variant: 'works', navigationMode: 'canonical-work-gallery', canonicalCreatorId: 166
    });
    expect(wrapper.getComponent(ResilientImage).props()).toMatchObject({
      src: item.cardCover!.thumbnailUrl, alt: item.cardCover!.filename
    });
    expect(wrapper.get('a').classes()).toContain('aspect-[2/3]');
    expect(wrapper.find('.i-fluent-play-circle-24-filled').exists()).toBe(true);
    expect(wrapper.find('.i-fluent-square-multiple-24-filled').exists()).toBe(true);
    expect(wrapper.text()).toContain('1:02');
    expect(wrapper.text()).toContain('2');
    await wrapper.get('a').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('canonical-work-gallery');
    expect(router.currentRoute.value.params).toMatchObject({ creatorId: '166', postId: '123' });
    expect(useAppStore().imageModalBackgroundPath).toBeNull();
  });

  it('falls back to the original cover for an older work summary', async () => {
    const { cardCover: _cardCover, ...item } = summary();
    const { wrapper } = await render({ items: [item], variant: 'works' });
    expect(wrapper.getComponent(ResilientImage).props()).toMatchObject({ src: item.thumbnailUrl, alt: item.filename });
  });

  it.each(['square', 'posts', 'reels'] as const)('preserves the original thumbnail in %s cards even with a work-summary cover', async variant => {
    const item = summary();
    const { wrapper } = await render({ items: [item], variant });
    expect(wrapper.getComponent(ResilientImage).props()).toMatchObject({ src: item.thumbnailUrl, alt: item.filename });
    expect(wrapper.get('a').attributes('href')).toBe('/post/123');
  });

  it('keeps public cards on their shared thumbnail even if a summary cover is passed', async () => {
    const item = summary();
    const { wrapper } = await render({ items: [item], variant: 'works', sharedSlug: 'public' });
    expect(wrapper.getComponent(ResilientImage).props()).toMatchObject({ src: item.thumbnailUrl, alt: item.filename });
    expect(wrapper.get('a').attributes('href')).toBe('/share/public/posts/123');
  });

  it('uses the original thumbnail for ordinary feed items in the works layout', async () => {
    const item = workDetail();
    const { wrapper } = await render({ items: [item], variant: 'works' });
    expect(wrapper.getComponent(ResilientImage).props()).toMatchObject({ src: item.thumbnailUrl, alt: item.filename });
  });
});
