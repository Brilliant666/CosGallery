import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('opts video IDs into native playback explicitly while preserving image sources', async () => {
    const wrapper = mount(CarouselMediaStage, {
      props: { items: mockItems },
      global: {
        stubs: {
          VideoMediaPlayer: { name: 'VideoMediaPlayer', props: ['src', 'mediaId', 'durationMs'], template: '<div data-test="video" />' },
          ResilientImage: { name: 'ResilientImage', props: ['src', 'fallbackSrc'], template: '<img :src="src" />' }
        }
      }
    });
    expect(wrapper.props('nativeVideoPlayback')).toBe(false);
    let video = wrapper.findComponent({ name: 'VideoMediaPlayer' });
    expect(video.props('mediaId')).toBeUndefined();
    expect(video.props('durationMs')).toBe(1000);
    expect(video.props('src')).toBe('/preview1.mp4');
    await wrapper.setProps({ nativeVideoPlayback: true });
    video = wrapper.findComponent({ name: 'VideoMediaPlayer' });
    expect(video.props('mediaId')).toBe(1);
    await wrapper.setProps({ modelValue: 1 });
    const img = wrapper.get('img');
    expect(img.attributes('src')).toBe('/thumb2.webp');
    expect(img.attributes('media-id')).toBeUndefined();
    await wrapper.setProps({ preferPreview: true });
    expect(img.attributes('src')).toBe('/preview2.jpg');
    expect(wrapper.findComponent({ name: 'ResilientImage' }).props('fallbackSrc')).toBe('/original2.jpg');
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

  function renderGestures(modelValue = 0) {
    const surfaceClick = vi.fn();
    const controlClick = vi.fn();
    const wrapper = mount(CarouselMediaStage, {
      props: { items: mockItems, modelValue },
      global: {
        stubs: {
          ResilientImage: { template: '<img />' },
          VideoMediaPlayer: {
            setup: () => ({ surfaceClick, controlClick }),
            template: `<div data-test="surface" @click="surfaceClick">
              <button data-test="play" @click.stop="controlClick"><span>Play</span></button>
              <div data-swipe-ignore="true"><input data-test="seek" type="range" /></div>
            </div>`
          }
        }
      }
    });
    let captured: number | null = null;
    const setCapture = vi.fn((id: number) => { captured = id; });
    const releaseCapture = vi.fn(() => { captured = null; });
    Object.assign(wrapper.element, {
      setPointerCapture: setCapture,
      hasPointerCapture: (id: number) => captured === id,
      releasePointerCapture: releaseCapture
    });
    return { wrapper, surfaceClick, controlClick, setCapture, releaseCapture };
  }

  const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 200, clientY: 100 };

  it('leaves taps and small movement on the video surface without capturing their click target', async () => {
    const { wrapper, surfaceClick, setCapture } = renderGestures();
    const surface = wrapper.get('[data-test="surface"]');
    await surface.trigger('pointerdown', pointer);
    expect(setCapture).not.toHaveBeenCalled();
    await surface.trigger('pointermove', { ...pointer, clientX: 205, clientY: 103 });
    await surface.trigger('pointerup', { ...pointer, clientX: 205, clientY: 103 });
    surface.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(setCapture).not.toHaveBeenCalled();
    expect(surfaceClick).toHaveBeenCalledOnce();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('captures only a horizontal drag, advances once and suppresses its trailing surface click', async () => {
    const { wrapper, surfaceClick, setCapture, releaseCapture } = renderGestures();
    const surface = wrapper.get('[data-test="surface"]');
    await surface.trigger('pointerdown', pointer);
    expect(setCapture).not.toHaveBeenCalled();
    await surface.trigger('pointermove', { ...pointer, clientX: 180 });
    expect(setCapture).toHaveBeenCalledExactlyOnceWith(1);
    await wrapper.trigger('pointerup', { ...pointer, clientX: 100 });
    expect(wrapper.emitted('update:modelValue')).toEqual([[1]]);
    expect(releaseCapture).toHaveBeenCalledExactlyOnceWith(1);
    surface.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(surfaceClick).not.toHaveBeenCalled();
    await surface.trigger('pointerdown', pointer);
    await surface.trigger('pointerup', pointer);
    surface.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(surfaceClick).toHaveBeenCalledOnce();
  });

  it('preserves image swiping and clamps navigation at both ends', async () => {
    const { wrapper } = renderGestures(1);
    const img = wrapper.get('img');
    await img.trigger('pointerdown', pointer);
    await img.trigger('pointermove', { ...pointer, clientX: 100 });
    await wrapper.trigger('pointerup', { ...pointer, clientX: 100 });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await img.trigger('pointerdown', pointer);
    await img.trigger('pointermove', { ...pointer, clientX: 260 });
    await wrapper.trigger('pointerup', { ...pointer, clientX: 260 });
    expect(wrapper.emitted('update:modelValue')).toEqual([[0]]);
    await wrapper.setProps({ modelValue: 0 });
    await wrapper.trigger('pointerdown', pointer);
    await wrapper.trigger('pointermove', { ...pointer, clientX: 260 });
    await wrapper.trigger('pointerup', { ...pointer, clientX: 260 });
    expect(wrapper.emitted('update:modelValue')).toEqual([[0]]);
  });

  it.each(['[data-test="play"] span', '[data-test="seek"]'])('leaves controls %s outside swipe handling', async (selector) => {
    const { wrapper, setCapture } = renderGestures();
    await wrapper.get(selector).trigger('pointerdown', pointer);
    await wrapper.trigger('pointermove', { ...pointer, clientX: 50 });
    await wrapper.trigger('pointerup', { ...pointer, clientX: 50 });
    expect(setCapture).not.toHaveBeenCalled();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('keeps vertical scrolling available even if a scroll later moves horizontally', async () => {
    const { wrapper, setCapture } = renderGestures();
    expect(wrapper.element.style.touchAction).toBe('pan-y pinch-zoom');
    await wrapper.trigger('pointerdown', pointer);
    await wrapper.trigger('pointermove', { ...pointer, clientX: 190, clientY: 120 });
    await wrapper.trigger('pointermove', { ...pointer, clientX: 50, clientY: 130 });
    await wrapper.trigger('pointerup', { ...pointer, clientX: 50, clientY: 130 });
    expect(setCapture).not.toHaveBeenCalled();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it.each(['pointercancel', 'lostpointercapture'])('abandons a claimed gesture after %s', async (event) => {
    const { wrapper, releaseCapture } = renderGestures();
    await wrapper.trigger('pointerdown', pointer);
    await wrapper.trigger('pointermove', { ...pointer, clientX: 100 });
    await wrapper.trigger(event, pointer);
    await wrapper.trigger('pointerup', { ...pointer, clientX: 50 });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(releaseCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not navigate a short horizontal drag or swallow later keyboard and control clicks', async () => {
    const { wrapper, surfaceClick, controlClick } = renderGestures();
    await wrapper.trigger('pointerdown', pointer);
    await wrapper.trigger('pointermove', { ...pointer, clientX: 180 });
    await wrapper.trigger('pointerup', { ...pointer, clientX: 180 });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    wrapper.get('[data-test="surface"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(surfaceClick).toHaveBeenCalledOnce();
    const control = wrapper.get('[data-test="play"]');
    await control.trigger('pointerdown', pointer);
    await control.trigger('pointerup', pointer);
    control.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(controlClick).toHaveBeenCalledOnce();
  });

  it('ignores secondary pointers without ending the active gesture', async () => {
    const { wrapper, setCapture } = renderGestures();
    await wrapper.trigger('pointerdown', pointer);
    await wrapper.trigger('pointerdown', { ...pointer, pointerId: 2, isPrimary: false, clientX: 50 });
    await wrapper.trigger('pointermove', { ...pointer, pointerId: 2, clientX: 0 });
    await wrapper.trigger('pointercancel', { ...pointer, pointerId: 2 });
    expect(setCapture).not.toHaveBeenCalled();
    await wrapper.trigger('pointermove', { ...pointer, clientX: 100 });
    await wrapper.trigger('pointerup', { ...pointer, clientX: 100 });
    expect(wrapper.emitted('update:modelValue')).toEqual([[1]]);
  });

  it.each(['pointerup', 'pointercancel'])('releases uncaptured tracking when %s occurs outside the stage', async (type) => {
    const { wrapper, setCapture } = renderGestures();
    await wrapper.trigger('pointerdown', pointer);
    expect(setCapture).not.toHaveBeenCalled();
    window.dispatchEvent(Object.assign(new Event(type), { pointerId: 1 }));
    await wrapper.trigger('pointerdown', { ...pointer, pointerId: 2 });
    await wrapper.trigger('pointermove', { ...pointer, pointerId: 2, clientX: 100 });
    await wrapper.trigger('pointerup', { ...pointer, pointerId: 2, clientX: 100 });
    expect(setCapture).toHaveBeenCalledExactlyOnceWith(2);
    expect(wrapper.emitted('update:modelValue')).toEqual([[1]]);
  });

  it('releases capture and removes global pointer cleanup when unmounted during a swipe', async () => {
    const { wrapper, releaseCapture } = renderGestures();
    const removeListener = vi.spyOn(window, 'removeEventListener');
    await wrapper.trigger('pointerdown', pointer);
    await wrapper.trigger('pointermove', { ...pointer, clientX: 100 });
    wrapper.unmount();
    expect(releaseCapture).toHaveBeenCalledExactlyOnceWith(1);
    expect(removeListener).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('pointercancel', expect.any(Function));
    removeListener.mockRestore();
  });
});
