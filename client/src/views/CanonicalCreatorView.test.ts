import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchCanonicalCreatorWorks } from '../api/gallery';
import type { CanonicalCreatorWorksPayload, CosGalleryCreator, FeedItem } from '../types/api';
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

function work(id: number, folderId: number, folderSlug: string): FeedItem {
  return {
    ...workDetail(),
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
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchWorks.mockReset().mockImplementation(async (_id, page) => payload(page));
  });

  it('renders works from every linked Folder and preserves canonical navigation context', async () => {
    const router = galleryTestRouter();
    await router.push('/creators/166?returnTo=/library%3Fq%3Dlunananya%26page%3D2');
    const wrapper = mount(CanonicalCreatorView, {
      attachTo: document.body,
      props: { creatorId: '166' },
      global: { plugins: [router] }
    });
    await flushPromises();

    expect(fetchWorks).toHaveBeenCalledExactlyOnceWith(166, 1, 24);
    expect(wrapper.get('h1').text()).toBe('lunana');
    expect(wrapper.text()).toContain('25 套作品 · 2 个本地目录');
    expect(wrapper.findAll('section.grid a')).toHaveLength(2);
    expect(wrapper.get('a[href^="/library"]').attributes('href')).toBe('/library?q=lunananya&page=2');

    const creatorPagePath = router.currentRoute.value.fullPath;
    await wrapper.findAll('section.grid a')[1]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('canonical-work-gallery');
    expect(router.currentRoute.value.params).toMatchObject({ creatorId: '166', postId: '202' });
    expect(router.currentRoute.value.query.returnTo).toBe(creatorPagePath);
  });

  it('loads unified server pages and rejects an external return target', async () => {
    const router = galleryTestRouter();
    await router.push('/creators/166?returnTo=https://example.invalid');
    const wrapper = mount(CanonicalCreatorView, {
      attachTo: document.body,
      props: { creatorId: '166' },
      global: { plugins: [router] }
    });
    await flushPromises();

    expect(wrapper.get('a').attributes('href')).toBe('/library');
    await wrapper.findAll('button').find(button => button.text() === '下一页')!.trigger('click');
    await flushPromises();
    expect(fetchWorks).toHaveBeenLastCalledWith(166, 2, 24);
    expect(router.currentRoute.value.query).toEqual({ returnTo: 'https://example.invalid', page: '2' });
    expect(wrapper.text()).toContain('lunananya work 303');
  });
});
