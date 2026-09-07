import { readFileSync } from 'node:fs';
import path from 'node:path';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCanonicalCreator, fetchCanonicalCreatorWork, fetchImage, fetchFolder } from '../api/gallery';
import { useAppStore } from '../stores/app';
import { galleryTestRouter, mediaItem, mixedOrientationItems, workDetail } from '../../test/work-gallery-fixtures';
import WorkGalleryView from './WorkGalleryView.vue';
import PostView from './PostView.vue';
import { useAuthStore } from '../stores/auth';
import type { AppStatus } from '../types/api';

vi.mock('../api/gallery', () => ({
  fetchFolder: vi.fn().mockResolvedValue({ canonicalCreatorId: null }),
  fetchImage: vi.fn(),
  fetchCanonicalCreator: vi.fn(),
  fetchCanonicalCreatorWork: vi.fn()
}));
const fetchMock = vi.mocked(fetchImage);
const fetchCanonicalCreatorMock = vi.mocked(fetchCanonicalCreator);
const fetchCanonicalWorkMock = vi.mocked(fetchCanonicalCreatorWork);
const source = readFileSync(path.resolve(process.cwd(), 'src/views/WorkGalleryView.vue'), 'utf8');

describe('WorkGalleryView', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchMock.mockReset().mockResolvedValue(workDetail());
    vi.mocked(fetchFolder).mockReset().mockResolvedValue({ canonicalCreatorId: null } as Awaited<ReturnType<typeof fetchFolder>>);
    fetchCanonicalCreatorMock.mockReset().mockResolvedValue({
      creator: {
        id: 166,
        key: 'creator:166',
        identityType: 'creator',
        canonicalCreatorId: 166,
        canonicalName: 'lunana',
        name: 'lunana'
      }
    } as Awaited<ReturnType<typeof fetchCanonicalCreator>>);
    fetchCanonicalWorkMock.mockReset().mockResolvedValue(workDetail());
  });

  async function render(postId = '123', slug = 'creator') {
    const router = galleryTestRouter();
    await router.push(`/f/${slug}/works/${postId}`);
    const wrapper = mount(WorkGalleryView, { attachTo: document.body, props: { postId, slug }, global: { plugins: [router] } });
    await flushPromises();
    return { wrapper, router };
  }

  async function renderCanonical(returnTo = '/library/166?loaded=2') {
    const router = galleryTestRouter();
    await router.push({
      name: 'canonical-work-gallery',
      params: { creatorId: '166', postId: '123' },
      query: { returnTo }
    });
    const wrapper = mount(WorkGalleryView, {
      attachTo: document.body,
      props: { creatorId: '166', postId: '123' },
      global: { plugins: [router] }
    });
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
    expect(wrapper.findAll('a[aria-label]').every((link) => /Open item \d+, (image|video):/.test(link.attributes('aria-label') ?? ''))).toBe(true);
    expect(wrapper.findAll('.work-media-card__video')).toHaveLength(2);
    expect(wrapper.findAll('.work-media-card__link')).toHaveLength(5);
    expect(wrapper.findAll('.work-media-card__duration').map((label) => label.text())).toEqual(['1:02', '1:02']);
    expect(wrapper.find('video, media-player, video-media-player').exists()).toBe(false);
    expect(wrapper.findAll('img').every(img => getComputedStyle(img.element).objectFit === 'cover')).toBe(true);
    expect(wrapper.get('.work-gallery__back').attributes('href')).toBe('/f/creator');
  });

  it('redirects a valid legacy work to its canonical route only after physical owner verification', async () => {
    vi.mocked(fetchFolder).mockResolvedValue({ canonicalCreatorId: 166 } as Awaited<ReturnType<typeof fetchFolder>>);
    const { router } = await render();
    expect(router.currentRoute.value.fullPath).toBe('/library/166/works/123');
  });

  it('does not broaden a legacy wrong-Folder work to another directory of the same creator', async () => {
    fetchMock.mockResolvedValue({ ...workDetail(), folderSlug: 'other-physical-folder' });
    vi.mocked(fetchFolder).mockResolvedValue({ canonicalCreatorId: 166 } as Awaited<ReturnType<typeof fetchFolder>>);
    const { router, wrapper } = await render();
    expect(router.currentRoute.value.fullPath).toBe('/f/creator/works/123');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(fetchFolder).not.toHaveBeenCalled();
  });

  it('loads a canonical-owned work and carries its aggregated creator return path into the viewer', async () => {
    const { wrapper, router } = await renderCanonical();
    expect(fetchCanonicalWorkMock).toHaveBeenCalledExactlyOnceWith(166, 123);
    expect(fetchCanonicalCreatorMock).toHaveBeenCalledExactlyOnceWith(166);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.get('.work-gallery__creator').text()).toBe('lunana');
    expect(wrapper.get('.work-gallery__back').attributes('href')).toBe('/library/166?loaded=2');

    const grid = wrapper.get('.work-gallery__grid').element;
    await wrapper.get('[data-position="2"] a').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('canonical-work-gallery');
    expect(router.currentRoute.value.params.postId).toBe('123');
    expect(router.currentRoute.value.query).toEqual({ media: '702' });
    expect(useAppStore().imageModalBackgroundPath).toBeNull();
    expect(wrapper.get('.work-gallery__grid').element).toBe(grid);
    expect(fetchCanonicalWorkMock).toHaveBeenCalledTimes(1);
  });

  it('does not accept a canonical return path for a different creator', async () => {
    const { wrapper } = await renderCanonical('/library/999?page=4');
    expect(wrapper.get('.work-gallery__back').attributes('href')).toBe('/library/166');
  });

  it('does not reload for initial stats hydration but does reload for a later completed scan', async () => {
    await renderCanonical();
    const app = useAppStore();
    app.stats = { indexedPosts: 100, storage: { available: true }, scan: { lastCompletedScan: { id: 1 } } } as AppStatus;
    await flushPromises();
    expect(fetchCanonicalWorkMock).toHaveBeenCalledTimes(1);
    app.stats = { ...app.stats, scan: { ...app.stats.scan, lastCompletedScan: { ...app.stats.scan.lastCompletedScan!, id: 2 } } };
    await flushPromises();
    expect(fetchCanonicalWorkMock).toHaveBeenCalledTimes(2);
  });

  it('revalidates retained canonical data after authorization changes and removes unauthorized media', async () => {
    const { wrapper } = await renderCanonical();
    await wrapper.get('[data-position="2"] a').trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(PostView).exists()).toBe(true);
    fetchCanonicalWorkMock.mockRejectedValueOnce(new Error('Access revoked'));
    useAuthStore().authenticated = !useAuthStore().authenticated;
    await flushPromises();
    expect(fetchCanonicalWorkMock).toHaveBeenCalledTimes(2);
    expect(wrapper.findComponent(PostView).exists()).toBe(false);
    expect(wrapper.text()).toContain('Access revoked');
  });

  it('retains caption changes and revalidates deleted work instead of re-adopting a stale detail', async () => {
    const { wrapper } = await renderCanonical();
    await wrapper.get('[data-position="2"] a').trigger('click');
    await flushPromises();
    wrapper.getComponent(PostView).vm.$emit('updatedWork', { ...workDetail(), caption: 'Edited caption' });
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe('Edited caption');
    fetchCanonicalWorkMock.mockRejectedValueOnce(new Error('Post is trashed'));
    wrapper.getComponent(PostView).vm.$emit('removedWork');
    await flushPromises();
    expect(fetchCanonicalWorkMock).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.work-gallery__grid').exists()).toBe(false);
    expect(wrapper.text()).toContain('Post is trashed');
  });

  it('uses the same compact 1px gap as the creator cover grid', () => {
    const gridRule = source.match(/\.work-gallery__grid\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';
    expect(gridRule).toMatch(/gap:\s*1px/);
  });

  it('keeps portrait, landscape, square, video, portrait in five identical 2:3 slots', async () => {
    fetchMock.mockResolvedValue(workDetail(mixedOrientationItems().reverse()));
    const { wrapper } = await render();
    expect(wrapper.findAll('article').map(card => card.attributes('data-position'))).toEqual(['1', '2', '3', '4', '5']);
    expect(wrapper.findAll('img').map(img => [img.attributes('width'), img.attributes('height')])).toEqual([
      ['4000', '6000'], ['6000', '4000'], ['4000', '4000'], ['1920', '1080'], ['4000', '6000']
    ]);
    expect(wrapper.findAll('.work-media-card__video')).toHaveLength(1);
    expect(wrapper.find('[data-position="4"] .work-media-card__video').exists()).toBe(true);
    for (const link of wrapper.findAll('.work-media-card__link')) {
      const style = getComputedStyle(link.element);
      expect(style.aspectRatio).toBe('2 / 3');
      expect(['', '0px']).toContain(style.borderTopWidth);
      expect(['', '0px']).toContain(style.borderRadius);
      expect(['', 'none']).toContain(style.boxShadow);
    }
    for (const img of wrapper.findAll('img')) expect(getComputedStyle(img.element).objectFit).toBe('cover');
    const grid = getComputedStyle(wrapper.get('.work-gallery__grid').element);
    expect(grid.display).toBe('grid');
    expect(grid.gap).toBe('1px');
    expect(['', 'auto']).toContain(grid.columnCount);
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
    expect(wrapper.findAll('img').every((img) => img.attributes('src')?.startsWith('/thumbnails/'))).toBe(true);
  });

  it('keeps 500 standard/near-2:3, 4:5, 9:16, landscape, square and video items accessible with thumbnails only', async () => {
    fetchMock.mockResolvedValue(workDetail(mixedOrientationItems(500)));
    const { wrapper } = await render();
    expect(wrapper.findAll('article')).toHaveLength(500);
    expect(wrapper.findAll('article').map((node) => Number(node.attributes('data-position')))).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(wrapper.findAll('img')).toHaveLength(500);
    expect(wrapper.findAll('img').every((img) => img.attributes('src')?.startsWith('/thumbnails/') && img.attributes('loading') === 'lazy')).toBe(true);
    expect(wrapper.findAll('video, media-player, audio')).toHaveLength(0);
    expect(wrapper.findAll('a[aria-label]')).toHaveLength(500);
    expect(wrapper.findAll('.work-media-card__link').every(link => getComputedStyle(link.element).aspectRatio === '2 / 3')).toBe(true);
    expect(wrapper.findAll('img').every(img => getComputedStyle(img.element).objectFit === 'cover')).toBe(true);
    const dimensions = wrapper.findAll('img').map(img => `${img.attributes('width')}/${img.attributes('height')}`);
    for (const expected of ['4000/6000', '5600/8402', '4000/5000', '1080/1920', '6000/4000', '4000/4000', '1920/1080']) {
      expect(dimensions).toContain(expected);
    }
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
