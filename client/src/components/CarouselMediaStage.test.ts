import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { i18n } from '../locales';
import type { PostMediaItem } from '../types/api';
import CarouselMediaStage from './CarouselMediaStage.vue';

describe('CarouselMediaStage', () => {
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
      previewUrl: '/preview2.jpg',
      thumbnailUrl: '/thumb2.webp',
      originalUrl: '/original2.jpg',
      position: 2
    }
  ];

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
