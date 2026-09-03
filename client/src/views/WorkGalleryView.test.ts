import { readFileSync } from 'node:fs';
import path from 'node:path';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchImage } from '../api/gallery';
import { useAppStore } from '../stores/app';
import { galleryTestRouter, mediaItem, workDetail } from '../../test/work-gallery-fixtures';
import WorkGalleryView from './WorkGalleryView.vue';

vi.mock('../api/gallery', () => ({ fetchImage: vi.fn() }));
const fetchMock = vi.mocked(fetchImage);
const source = readFileSync(path.resolve(process.cwd(), 'src/views/WorkGalleryView.vue'), 'utf8');

describe('WorkGalleryView', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchMock.mockReset().mockResolvedValue(workDetail());
  });

  async function render(postId = '123', slug = 'creator') {
    const router = galleryTestRouter();
    await router.push(`/f/${slug}/works/${postId}`);
    const wrapper = mount(WorkGalleryView, { props: { postId, slug }, global: { plugins: [router] } });
    await flushPromises();
    return { wrapper, router };
  }

  it('renders all media by position, not API input order, type or aspect ratio', async () => {
    const detail = workDetail();
    detail.mediaItems!.reverse();
    fetchMock.mockResolvedValue(detail);
    const { wrapper } = await render();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(123);
    expect(wrapper.get('h1').text()).toBe('Creator NO.033 Work');
    expect(wrapper.get('.work-gallery__counts').text()).toBe('3 images · 2 videos · 5 items');
    expect(wrapper.findAll('article').map((card) => card.attributes('data-position'))).toEqual(['1', '2', '3', '4', '5']);
    expect(wrapper.findAll('img').every((img) => img.attributes('loading') === 'lazy')).toBe(true);
    expect(wrapper.findAll('a[aria-label]').every((link) => /Open item \d+, (image|video):/.test(link.attributes('aria-label')))).toBe(true);
    expect(wrapper.findAll('.work-media-card__video')).toHaveLength(2);
    expect(wrapper.findAll('.work-media-card__link')).toHaveLength(5);
    expect(wrapper.findAll('.work-media-card__duration').map((label) => label.text())).toEqual(['1:02', '1:02']);
    expect(wrapper.find('video, media-player, video-media-player').exists()).toBe(false);
    expect(wrapper.find('img.object-cover').exists()).toBe(false);
    expect(wrapper.get('.work-gallery__back').attributes('href')).toBe('/f/creator');
  });

  it('uses the same compact 1px gap as the creator cover grid', () => {
    const gridRule = source.match(/\.work-gallery__grid\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';
    expect(gridRule).toMatch(/gap:\s*1px/);
  });

  it.each([1, 2, 3, 5])('opens media %i with its Image ID and keeps the Post ID and background', async (position) => {
    const { wrapper, router } = await render();
    await wrapper.get(`[data-position="${position}"] a`).trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.params.id).toBe('123');
    expect(router.currentRoute.value.query).toEqual({ media: String(700 + position), context: 'work' });
    expect(useAppStore().imageModalBackgroundPath).toBe('/f/creator/works/123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll('article')).toHaveLength(5);
  });

  it('renders one-media works without skipping the gallery', async () => {
    fetchMock.mockResolvedValue(workDetail([mediaItem(1)]));
    const { wrapper, router } = await render();
    expect(wrapper.findAll('article')).toHaveLength(1);
    expect(router.currentRoute.value.name).toBe('work-gallery');
    expect(wrapper.get('.work-gallery__counts').text()).toBe('1 images · 0 videos · 1 items');
  });

  it('does not show a work belonging to a different creator', async () => {
    const { wrapper, router } = await render('123', 'wrong-creator');
    expect(wrapper.get('[role="alert"]').text()).toContain('does not exist or does not belong');
    expect(wrapper.find('article').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Creator NO.033 Work');
    expect(router.currentRoute.value.params.slug).toBe('wrong-creator');
  });

  it.each(['0', '-1', '1.5', 'abc', '9007199254740993'])('rejects malformed Post ID %s before fetching', async (id) => {
    const { wrapper } = await render(id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  it.each(['Post not found', 'Post is trashed', 'Post is deleted', 'Network unavailable'])('handles %s without repair or scanning', async (message) => {
    fetchMock.mockRejectedValueOnce(new Error(message));
    const { wrapper } = await render();
    expect(wrapper.get('[role="alert"]').text()).toContain(message);
    expect(wrapper.find('article').exists()).toBe(false);
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('article')).toHaveLength(5);
  });

  it('reports an empty work instead of rendering a successful gallery', async () => {
    fetchMock.mockResolvedValue(workDetail([]));
    const { wrapper } = await render();
    expect(wrapper.get('[role="alert"]').text()).toContain('no media to display');
    expect(wrapper.find('.work-gallery__grid').exists()).toBe(false);
  });

  it('does not fetch when storage is unavailable', async () => {
    vi.spyOn(useAppStore(), 'isLibraryUnavailable', 'get').mockReturnValue(true);
    const { wrapper } = await render();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('storage');
  });

  it('isolates a failed thumbnail, falls back once, and retries without replacing other cards', async () => {
    const { wrapper } = await render();
    const unaffected = wrapper.get('[data-position="3"] img').element;
    await wrapper.get('[data-position="1"] img').trigger('error');
    expect(wrapper.get('[data-position="1"] img').attributes('src')).toBe('/previews/701.webp');
    await wrapper.get('[data-position="1"] img').trigger('error');
    expect(wrapper.find('[data-position="1"] img').exists()).toBe(false);
    await wrapper.get('[data-position="1"] button').trigger('click');
    expect(wrapper.get('[data-position="1"] img').attributes('src')).toBe('/thumbnails/701.webp');
    expect(wrapper.get('[data-position="3"] img').element).toBe(unaffected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never falls back to video previews or image originals in the grid', async () => {
    const detail = workDetail();
    detail.mediaItems![0]!.previewUrl = detail.mediaItems![0]!.originalUrl!;
    fetchMock.mockResolvedValue(detail);
    const { wrapper } = await render();
    for (const position of [1, 2]) {
      await wrapper.get(`[data-position="${position}"] img`).trigger('error');
      expect(wrapper.find(`[data-position="${position}"] img`).exists()).toBe(false);
      expect(wrapper.find(`[data-position="${position}"] button`).exists()).toBe(true);
    }
    expect(wrapper.findAll('img').every((img) => img.attributes('src').startsWith('/thumbnails/'))).toBe(true);
  });

  it('keeps all 500 mixed portrait/landscape items accessible with thumbnails only', async () => {
    fetchMock.mockResolvedValue(workDetail(Array.from({ length: 500 }, (_, i) => mediaItem(i + 1))));
    const { wrapper } = await render();
    expect(wrapper.findAll('article')).toHaveLength(500);
    expect(wrapper.findAll('article').map((node) => Number(node.attributes('data-position')))).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(wrapper.findAll('img')).toHaveLength(500);
    expect(wrapper.findAll('img').every((img) => img.attributes('src').startsWith('/thumbnails/') && img.attributes('loading') === 'lazy')).toBe(true);
    expect(wrapper.findAll('video, media-player, audio')).toHaveLength(0);
    expect(wrapper.findAll('a[aria-label]')).toHaveLength(500);
  });

  it('ignores stale detail responses after changing Post route', async () => {
    let resolveFirst!: (value: ReturnType<typeof workDetail>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const { wrapper } = await render();
    fetchMock.mockResolvedValueOnce({ ...workDetail(), id: 124 });
    await wrapper.setProps({ postId: '124' });
    await flushPromises();
    resolveFirst(workDetail());
    await flushPromises();
    expect(wrapper.get('[data-position="1"] a').attributes('href')).toContain('/post/124?');
  });
});
