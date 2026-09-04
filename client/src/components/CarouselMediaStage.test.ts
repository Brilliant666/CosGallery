import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';

import { i18n } from '../locales';
import type { PostMediaItem } from '../types/api';
import CarouselMediaStage from './CarouselMediaStage.vue';
import { mixedOrientationItems } from '../../test/work-gallery-fixtures';

describe('CarouselMediaStage', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const mockItems: PostMediaItem[] = [
    {
      imageId: 1,
      filename: 'slide1.mp4',
      mediaType: 'video',
      width: 1080,
      height: 1080,
      durationMs: 1000,
      isAnimated: false,
      previewUrl: '/preview1.mp4',
      thumbnailUrl: '/thumb1.webp',
      originalUrl: '/original1.mp4',
      position: 1
    },
    {
      imageId: 2,
      filename: 'slide2.jpg',
      mediaType: 'image',
      width: 1080,
      height: 1080,
      durationMs: null,
      isAnimated: false,
      previewUrl: '/preview2.jpg',
      thumbnailUrl: '/thumb2.webp',
      originalUrl: '/original2.jpg',
      position: 2
    }
  ];

  function renderAspect(modelValue: number, followActiveAspectRatio?: boolean, items = mixedOrientationItems()) {
    return mount(CarouselMediaStage, {
      props: { items, modelValue, ...(followActiveAspectRatio === undefined ? {} : { followActiveAspectRatio }) },
      global: { stubs: { ResilientImage: { props: ['src'], template: '<img :src="src" />' }, VideoMediaPlayer: { props: ['src'], template: '<div data-test="video" />' } } }
    });
  }

  it('defaults to the first-item frame even when selecting a landscape image or video', async () => {
    const wrapper = renderAspect(1);
    expect(wrapper.props('followActiveAspectRatio')).toBe(false);
    expect(wrapper.element.style.aspectRatio).toBe('4000 / 6000');
    await wrapper.setProps({ modelValue: 3 });
    expect(wrapper.element.style.aspectRatio).toBe('4000 / 6000');
  });

  it.each([[0, '4000 / 6000'], [1, '6000 / 4000'], [2, '4000 / 4000'], [3, '1920 / 1080']])('follows active index %i only when explicitly enabled', (index, ratio) => {
    const wrapper = renderAspect(Number(index), true);
    expect(wrapper.element.style.aspectRatio).toBe(ratio);
    const media = wrapper.find('img, [data-test="video"]');
    expect(media.classes()).toContain('object-contain');
    expect(media.classes()).not.toContain('object-cover');
  });

  it('updates the frame as selection changes and restores stable sizing when disabled', async () => {
    const wrapper = renderAspect(1, true);
    await wrapper.setProps({ modelValue: 3 });
    expect(wrapper.element.style.aspectRatio).toBe('1920 / 1080');
    await wrapper.setProps({ followActiveAspectRatio: false });
    expect(wrapper.element.style.aspectRatio).toBe('4000 / 6000');
  });

  it.each([-10, 50])('clamps out-of-range index %i safely', (index) => {
    const wrapper = renderAspect(index, true);
    expect(wrapper.element.style.aspectRatio).toBe('4000 / 6000');
    expect(wrapper.get('img').attributes('src')).toBe(`/thumbnails/${index < 0 ? 701 : 705}.webp`);
  });

  it('safely falls back for an empty list, non-index selection and invalid dimensions', () => {
    expect(renderAspect(100, true, []).element.style.aspectRatio).toBe('1 / 1');
    expect(renderAspect(Number.NaN, true).element.style.aspectRatio).toBe('4000 / 6000');
    const invalidDimensions = { ...mixedOrientationItems()[0]!, width: 0, height: -1 };
    expect(renderAspect(0, true, [invalidDimensions]).element.style.aspectRatio).toBe('1 / 1');
  });

  it('does not opt feed or shared-post consumers into active-media sizing', () => {
    for (const file of ['components/FeedCard.vue', 'views/SharedPostView.vue']) {
      const source = readFileSync(path.resolve(process.cwd(), 'src', file), 'utf8');
      expect(source).toContain('<CarouselMediaStage');
      expect(source).not.toMatch(/follow-active-aspect-ratio|followActiveAspectRatio/);
    }
  });

  it('renders video slides using VideoMediaPlayer and navigates between slides', async () => {
    const wrapper = mount(CarouselMediaStage, {
      props: {
        items: mockItems,
        modelValue: 0,
        autoplay: true
      },
      global: {
        plugins: [i18n]
      }
    });

    const player = wrapper.findComponent({ name: 'VideoMediaPlayer' });
    expect(player.exists()).toBe(true);
    expect(player.props('autoplay')).toBe(true);

    const nextBtn = wrapper.find('button[aria-label="Next carousel item"]');
    expect(nextBtn.exists()).toBe(true);
    await nextBtn.trigger('click');

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([1]);
  });

  it('ignores pointer swipes when initiated on controls with data-swipe-ignore', async () => {
    const wrapper = mount(CarouselMediaStage, {
      props: {
        items: mockItems,
        modelValue: 0
      },
      global: {
        plugins: [i18n]
      }
    });

    const root = wrapper.element as HTMLElement;
    const progressFooter = wrapper.find('.video-progress-footer');
    expect(progressFooter.exists()).toBe(true);

    // Trigger pointerdown on progress footer (data-swipe-ignore="true")
    await progressFooter.trigger('pointerdown', {
      pointerId: 1,
      clientX: 200,
      button: 0
    });

    // Trigger pointerup with horizontal movement
    await wrapper.trigger('pointerup', {
      pointerId: 1,
      clientX: 50
    });

    // Should NOT have navigated because pointerdown was on an ignored element
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
