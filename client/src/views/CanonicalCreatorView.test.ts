import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount } from '@vue/test-utils';
import InfiniteLoader from '../components/InfiniteLoader.vue';
import CreatorFolderActions from '../components/CreatorFolderActions.vue';
import { useCreatorReadingStore } from '../stores/creator-reading';

import { fetchCanonicalCreatorWorks } from '../api/gallery';
import type { CanonicalCreatorWorksPayload, CanonicalWorkSummary, CosGalleryCreator } from '../types/api';
import { galleryTestRouter, workDetail } from '../../test/work-gallery-fixtures';
import CanonicalCreatorView from './CanonicalCreatorView.vue';

vi.mock('../api/gallery', () => ({ fetchCanonicalCreatorWorks: vi.fn() }));

const fetchWorks = vi.mocked(fetchCanonicalCreatorWorks);

function creator(): CosGalleryCreator {
  return {
    key: 'creator:166',
    identityType: 'creator',
    canonicalCreatorId: 166,
    canonicalName: 'lunana',
    rosterStatus: 'active',
    linkStatus: 'linked',
    id: 166,
    slug: 'lunana',
    name: 'lunana',
    folderPath: 'lunana',
    folderIds: [1, 2290],
    folderNames: ['lunananya', 'lunana'],
    aliases: ['lunananya'],
    preference: 'liked',
    workCount: 50,
    latestWorkAt: 10,
    contentRating: 'R15',
    ratingSourceCount: 1,
    ratingConflict: false,
    coverImageId: 701,
    coverUrl: '/thumbnails/701.webp',
    coverWidth: 800,
    coverHeight: 1200
  };
}

function work(id: number, folderId: number, folderSlug: string): CanonicalWorkSummary {
  const { mediaItems, ...cover } = workDetail();
  return {
    ...cover,
    representation: 'summary',
    postType: 'carousel',
    itemCount: mediaItems?.length ?? 0,
    imageCount: mediaItems?.filter(item => item.mediaType === 'image').length ?? 0,
    videoCount: mediaItems?.filter(item => item.mediaType === 'video').length ?? 0,
    id,
    folderId,
    folderSlug,
    folderName: folderSlug,
    folderPath: folderSlug,
    sourcePath: `${folderSlug}/work-${id}`,
    caption: `${folderSlug} work ${id}`
  };
}

function payload(page: number): CanonicalCreatorWorksPayload {
  const items = page === 1
    ? [work(101, 1, 'lunananya'), work(202, 2290, 'lunana')]
    : [work(303, 1, 'lunananya')];
  return {
    creator: creator(),
    items,
    page,
    limit: 24,
    total: 25,
    hasMore: page === 1
  };
}

describe('CanonicalCreatorView', () => {
  enableAutoUnmount(afterEach);
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    vi.stubGlobal('scrollTo', vi.fn());
    setActivePinia(createPinia());
    fetchWorks.mockReset().mockImplementation(async (_id, page = 1) => payload(page));
  });

  it('reloads a genuinely invalidated active creator and rejects the previous response', async () => {
    let resolveOld!: (value: CanonicalCreatorWorksPayload) => void;
    fetchWorks.mockImplementationOnce(() => new Promise(done => { resolveOld = done; }));
    const router = galleryTestRouter();
    await router.push('/library/166');
    const wrapper = mount(CanonicalCreatorView, { props: { creatorId: '166' }, global: { plugins: [router] } });
    await flushPromises();
    useCreatorReadingStore().invalidate();
    await flushPromises();
    expect(fetchWorks).toHaveBeenCalledTimes(2);
    resolveOld({ ...payload(1), creator: { ...creator(), name: 'Stale creator' } });
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe('lunana');
  });

  it('explains unavailable explicit primary copies without offering an automatic replacement', async () => {
    fetchWorks.mockResolvedValue({ ...payload(1), items: [], total: 0, hasMore: false,
      creator: { ...creator(), workCount: 0, unavailablePrimaryWorks: [{ workId: 10, postId: 101,
        title: 'Local album', reason: '主副本未索引或不可用，未自动切换其他副本' }] } });
    const router = galleryTestRouter();
    await router.push('/library/166');
    const wrapper = mount(CanonicalCreatorView, { props: { creatorId: '166' }, global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain('Local album');
    expect(wrapper.get('[role="status"]').text()).toContain('未自动切换');
    expect(wrapper.findAll('[role="status"] button')).toHaveLength(0);
  });

  it('renders works from every linked Folder and preserves canonical navigation context', async () => {
    const router = galleryTestRouter();
    await router.push('/library/166?returnTo=/library%3Fq%3Dlunananya%26page%3D2');
    const wrapper = mount(CanonicalCreatorView, {
      attachTo: document.body,
      props: { creatorId: '166' },
      global: { plugins: [router] }
    });
    await flushPromises();

    expect(fetchWorks).toHaveBeenCalledExactlyOnceWith(166, 1, 24);
    expect(wrapper.get('h1').text()).toBe('lunana');
    expect(wrapper.text()).toContain('25 套作品');
    expect(wrapper.text()).not.toContain('规范博主 #');
    expect(wrapper.findAll('section.grid a')).toHaveLength(2);
    expect(wrapper.findAll('section.grid img')).toHaveLength(2);
    expect(payload(1).items.every(item => !('mediaItems' in item))).toBe(true);
    expect(wrapper.get('a[href^="/library"]').attributes('href')).toBe('/library?q=lunananya&page=2');

    await wrapper.findAll('section.grid a')[1]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('canonical-work-gallery');
    expect(router.currentRoute.value.params).toMatchObject({ creatorId: '166', postId: '202' });
    expect(router.currentRoute.value.query).toEqual({ q: 'lunananya', libraryPage: '2' });
  });

  it('loads unified server pages and rejects an external return target', async () => {
    const router = galleryTestRouter();
    await router.push('/library/166?returnTo=https://example.invalid');
    const wrapper = mount(CanonicalCreatorView, {
      attachTo: document.body,
      props: { creatorId: '166' },
      global: { plugins: [router] }
    });
    await flushPromises();

    expect(wrapper.get('a').attributes('href')).toBe('/library');
    wrapper.getComponent(InfiniteLoader).vm.$emit('load-more');
    await flushPromises();
    expect(fetchWorks).toHaveBeenLastCalledWith(166, 2, 24);
    expect(router.currentRoute.value.query.loaded).toBe('2');
    expect(wrapper.findAll('section.grid a')).toHaveLength(3);
    expect(wrapper.text()).toContain('lunananya work 303');
  });

  it('serializes repeated loader events and deduplicates overlapping server pages', async () => {
    const router = galleryTestRouter();
    await router.push('/library/166');
    const wrapper = mount(CanonicalCreatorView, { props: { creatorId: '166' }, global: { plugins: [router] } });
    await flushPromises();
    fetchWorks.mockResolvedValueOnce({ ...payload(2), items: [work(202, 2290, 'lunana'), work(303, 1, 'lunananya')] });
    wrapper.getComponent(InfiniteLoader).vm.$emit('load-more');
    wrapper.getComponent(InfiniteLoader).vm.$emit('load-more');
    await flushPromises();
    expect(fetchWorks).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('section.grid a')).toHaveLength(3);
  });

  it('ignores a previous creator response after a fast route switch', async () => {
    let resolveOld!: (result: CanonicalCreatorWorksPayload) => void;
    fetchWorks.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const router = galleryTestRouter();
    await router.push('/library/166');
    const wrapper = mount(CanonicalCreatorView, { props: { creatorId: '166' }, global: { plugins: [router] } });
    fetchWorks.mockResolvedValueOnce({ ...payload(1), creator: { ...creator(), id: 2, name: '桜桃喵' } });
    await wrapper.setProps({ creatorId: '2' });
    await flushPromises();
    resolveOld(payload(1));
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe('桜桃喵');
  });

  it('restores loaded works and scroll without requesting the same page again', async () => {
    useCreatorReadingStore().save('166', { creator: creator(), items: payload(1).items, total: 50, nextPage: 3, hasMore: true, scrollY: 1500 });
    const router = galleryTestRouter();
    await router.push('/library/166?loaded=2');
    const wrapper = mount(CanonicalCreatorView, { props: { creatorId: '166' }, global: { plugins: [router] } });
    await flushPromises();
    expect(fetchWorks).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 1500 });
    expect(useCreatorReadingStore().pages['166']?.items.every(item => item.representation === 'summary' && !('mediaItems' in item))).toBe(true);
    wrapper.getComponent(InfiniteLoader).vm.$emit('load-more');
    await flushPromises();
    expect(fetchWorks).toHaveBeenLastCalledWith(166, 3, 24);
  });

  it('updates only selected directory metadata while preserving canonical profile, grid and route', async () => {
    const localFolders = [
      { id: 1, slug: 'first', name: 'First', path: 'Photos/First', workCount: 12 },
      { id: 2290, slug: 'second', name: 'Second', path: 'Photos/Second', workCount: 13 }
    ];
    fetchWorks.mockResolvedValueOnce({ ...payload(1), creator: { ...creator(), description: 'Canonical description', localFolders } });
    const router = galleryTestRouter();
    await router.push('/library/166?q=lunana');
    const wrapper = mount(CanonicalCreatorView, { props: { creatorId: '166' }, global: { plugins: [router] } });
    await flushPromises();
    const gridBefore = wrapper.findAll('section.grid a').map(link => link.element);
    const routeBefore = router.currentRoute.value.fullPath;
    wrapper.getComponent(CreatorFolderActions).vm.$emit('updated', { id: 2290, name: 'Updated directory', description: 'Directory description' });
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe('lunana');
    expect(wrapper.text()).toContain('Canonical description');
    expect(wrapper.getComponent(CreatorFolderActions).props('folders')).toEqual([localFolders[0], { ...localFolders[1], name: 'Updated directory' }]);
    expect(wrapper.findAll('section.grid a').map(link => link.element)).toEqual(gridBefore);
    expect(router.currentRoute.value.fullPath).toBe(routeBefore);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(fetchWorks).toHaveBeenCalledTimes(1);
    expect(useCreatorReadingStore().pages['166']?.creator.localFolders?.[1]?.name).toBe('Updated directory');
  });
});
