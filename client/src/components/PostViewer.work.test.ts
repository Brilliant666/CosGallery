import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { galleryTestRouter, mediaItem, workDetail } from '../../test/work-gallery-fixtures';
import { useFoldersStore } from '../stores/folders';
import { useLikesStore } from '../stores/likes';
import PostViewer from './PostViewer.vue';
import CollectionBookmark from './CollectionBookmark.vue';

vi.mock('vidstack/bundle', () => ({}));
const stubs = {
  Avatar: true,
  ResilientImage: { props: ['src', 'alt'], template: '<img :src="src" :alt="alt" />' },
  VideoMediaPlayer: { props: ['src'], template: '<div data-test="active-video" :data-src="src" />' },
  CollectionBookmark: true
};

describe('PostViewer work context', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  async function render(query = '?context=work&media=702', detail = workDetail(), modal = true) {
    const router = galleryTestRouter();
    await router.push(`/post/123${query}`);
    const push = vi.spyOn(router, 'push');
    const replace = vi.spyOn(router, 'replace');
    const wrapper = mount(PostViewer, { props: { image: detail, isModal: modal }, global: { plugins: [router], stubs } });
    await flushPromises();
    return { wrapper, router, push, replace };
  }

  it('starts at the selected video and updates all current-media information and actions', async () => {
    const cover = vi.spyOn(useFoldersStore(), 'setFolderCover').mockResolvedValue();
    const { wrapper, router, replace } = await render();
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('2 / 5');
    expect(wrapper.get('[data-test="active-video"]').attributes('data-src')).toBe('/previews/702.mp4');
    expect(wrapper.get('.viewer__sidebar-path-value').text()).toBe('Creator/Work/002.mp4');
    expect(wrapper.get('.viewer__sidebar-filename').text()).toBe('002.mp4');
    expect(wrapper.get('.viewer__sidebar-stats').text()).toContain('800 × 1200');
    expect(wrapper.get('.viewer__sidebar-stats').text()).toContain('video/mp4');
    expect(wrapper.get('.viewer__sidebar-stats').text()).toContain('1:02');
    expect(wrapper.get('.viewer__sidebar-stats').text()).toContain('2.00 MB');
    expect(wrapper.get('a[aria-label="Download original file"]').attributes('href')).toBe('/api/originals/702?download=1');
    expect(wrapper.get('a[aria-label="Open original file"]').attributes('href')).toBe('/api/originals/702');
    await wrapper.get('button[aria-label="Set as folder cover"]').trigger('click');
    await flushPromises();
    expect(cover).toHaveBeenCalledWith('creator', 702);
    await wrapper.get('button[aria-label="Next carousel item"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.media).toBe('703');
    expect(replace).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('3 / 5');
    expect(wrapper.find('[data-test="active-video"]').exists()).toBe(false);
    expect(wrapper.get('.viewer__sidebar-path-value').text()).toBe('Creator/Work/003.jpg');
    expect(wrapper.get('.viewer__sidebar-stats').text()).toContain('1920 × 1080');
    expect(wrapper.get('.viewer__sidebar-stats').text()).toContain('3.00 MB');
    expect(wrapper.get('.viewer__sidebar-stats').text()).not.toContain('Duration');
    expect(wrapper.get('button[aria-label="Set as folder cover"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('button[aria-label="Set as folder cover"]').trigger('click');
    await flushPromises();
    expect(cover).toHaveBeenLastCalledWith('creator', 703);
  });

  it('keeps likes, bookmarks, caption and delete at Post level', async () => {
    const like = vi.spyOn(useLikesStore(), 'toggleLike').mockResolvedValue();
    const { wrapper } = await render();
    await wrapper.get('button[aria-label="Like post"]').trigger('click');
    expect(like.mock.calls[0]?.[0].id).toBe(123);
    expect(wrapper.getComponent(CollectionBookmark).props('item').id).toBe(123);
    expect(wrapper.get('.viewer__sidebar-caption').text()).toContain('Creator NO.033 Work');
    await wrapper.get('button[aria-label="Delete post"]').trigger('click');
    expect(wrapper.emitted('delete')).toHaveLength(1);
  });

  it('disables both outer post links and clamps keys, wheel and swipes at the work boundary', async () => {
    const { wrapper, router, push } = await render('?context=work&media=705');
    expect(wrapper.find('a[aria-label="Previous post"], a[aria-label="Next post"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="Next carousel item"]').exists()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await wrapper.get('.viewer__media').trigger('wheel', { deltaY: 150, deltaX: 0 });
    const carousel = wrapper.get('[aria-roledescription="carousel"]');
    await carousel.trigger('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 200 });
    await carousel.trigger('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 20 });
    await flushPromises();
    expect(router.currentRoute.value.params.id).toBe('123');
    expect(router.currentRoute.value.query.media).toBe('705');
    expect(push).not.toHaveBeenCalled();
    await carousel.trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect(router.currentRoute.value.query.media).toBe('704');
    await carousel.trigger('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 20 });
    await carousel.trigger('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 200 });
    await flushPromises();
    expect(router.currentRoute.value.query.media).toBe('703');
    expect(push).not.toHaveBeenCalled();
  });

  it('supports keyboard navigation in a standalone work deep link', async () => {
    const { router, push } = await render('?context=work&media=703', workDetail(), false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushPromises();
    expect(router.currentRoute.value.query.media).toBe('704');
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps cross-Post keyboard navigation in the normal modal context', async () => {
    const { push } = await render('');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushPromises();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ params: { id: '124' } }));
  });

  it('uses the media Image ID even for a single-media Post whose ID differs', async () => {
    const { wrapper, push } = await render('?context=work&media=701', workDetail([mediaItem(1)]));
    expect(wrapper.get('a[aria-label="Download original file"]').attributes('href')).toBe('/api/originals/701?download=1');
    expect(wrapper.find('a[aria-label="Next post"]').exists()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(push).not.toHaveBeenCalled();
  });
});
