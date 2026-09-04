import { readFileSync } from 'node:fs';
import path from 'node:path';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { galleryTestRouter, mixedOrientationItems } from '../../test/work-gallery-fixtures';
import WorkMediaCard from './WorkMediaCard.vue';

const source = readFileSync(path.resolve(process.cwd(), 'src/components/WorkMediaCard.vue'), 'utf8');
const linkRule = source.match(/\.work-media-card__link\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';
const imageRule = source.match(/\.work-media-card__image\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';

describe('WorkMediaCard visual contract', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => setActivePinia(createPinia()));
  it('uses one borderless square-edged container for both media types', () => {
    expect(linkRule).not.toMatch(/\bborder\s*:/);
    expect(linkRule).not.toMatch(/\bborder-radius\s*:/);
    expect(linkRule).not.toMatch(/\bbox-shadow\s*:/);
    expect(source.match(/<a\b/g)).toHaveLength(1);
    expect(source).not.toMatch(/item\.mediaType[^\n]*work-media-card__link/);
  });

  it('uses CSS-only center cover for previews, lazy loading, and lightweight video posters', () => {
    expect(linkRule).toMatch(/aspect-ratio:\s*3\s*\/\s*4/);
    expect(linkRule).toMatch(/overflow:\s*hidden/);
    expect(imageRule).toMatch(/object-fit:\s*cover/);
    expect(imageRule).toMatch(/object-position:\s*center center/);
    expect(imageRule).not.toMatch(/transform:|rotate\(/);
    expect(source).toContain('loading="lazy"');
    expect(source).toContain('decoding="async"');
    expect(source).toContain("item.mediaType === 'video'");
    expect(source).not.toMatch(/<video\b|<media-player\b/);
  });

  it('retains an accessibility outline without adding a persistent focus border', () => {
    expect(source).toMatch(/\.work-media-card__link:focus-visible\s*\{[^}]*outline:/s);
  });

  it.each(mixedOrientationItems(8))('center-crops $width × $height $mediaType and opens its Image ID', async (item) => {
    const router = galleryTestRouter();
    await router.push('/f/creator/works/123');
    const wrapper = mount(WorkMediaCard, {
      attachTo: document.body,
      props: { item, postId: 123, ordinal: item.position, backgroundPath: '/f/creator/works/123' },
      global: { plugins: [router] }
    });
    const img = wrapper.get('img');
    const link = wrapper.get('.work-media-card__link');
    const style = getComputedStyle(img.element);
    const container = getComputedStyle(link.element);
    expect(style.objectFit).toBe('cover');
    expect(style.objectPosition).toBe('center center');
    expect(container.aspectRatio).toBe('3 / 4');
    expect(container.overflow).toBe('hidden');
    for (const value of [container.borderTopWidth, container.borderRadius, container.padding, container.margin]) {
      expect(['', '0px']).toContain(value);
    }
    expect(['', 'none']).toContain(container.boxShadow);
    expect(img.attributes()).toMatchObject({ src: item.thumbnailUrl, loading: 'lazy', decoding: 'async' });
    expect(wrapper.find('video, media-player, video-media-player').exists()).toBe(false);
    if (item.mediaType === 'video') {
      expect(wrapper.find('.work-media-card__video').exists()).toBe(true);
      expect(wrapper.get('.work-media-card__duration').text()).toBe('1:02');
    }
    await link.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ media: String(item.imageId), context: 'work' });
  });

  it('uses the same cropped thumbnail and borderless fallback for animated images', async () => {
    const router = galleryTestRouter();
    const wrapper = mount(WorkMediaCard, {
      attachTo: document.body,
      props: { item: { ...mixedOrientationItems()[1]!, isAnimated: true, previewUrl: '/previews/animation.gif' }, postId: 123, ordinal: 2, backgroundPath: '/f/creator/works/123' },
      global: { plugins: [router] }
    });
    expect(wrapper.get('img').attributes('src')).toBe('/thumbnails/702.webp');
    expect(getComputedStyle(wrapper.get('img').element).objectFit).toBe('cover');
    await wrapper.get('img').trigger('error');
    await wrapper.get('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.get('button').text()).toContain('Retry');
    expect(wrapper.get('.work-media-card__placeholder').text()).toContain('Thumbnail');
    expect(['', '0px']).toContain(getComputedStyle(wrapper.get('a').element).borderTopWidth);
  });
});
