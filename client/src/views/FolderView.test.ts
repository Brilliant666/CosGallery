import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { galleryTestRouter, workDetail } from '../../test/work-gallery-fixtures';
import FolderGrid from '../components/FolderGrid.vue';
import { useFoldersStore } from '../stores/folders';
import { useFolderStoriesStore } from '../stores/folder-stories';
import type { FolderSummary } from '../types/api';
import FolderView from './FolderView.vue';
import { fetchFolder } from '../api/gallery';
vi.mock('../api/gallery', () => ({ fetchFolder: vi.fn().mockResolvedValue({ canonicalCreatorId: null }) }));

describe('FolderView work navigation opt-in', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchFolder).mockReset().mockResolvedValue({ canonicalCreatorId: null } as FolderSummary);
  });
  it('maps an old slug using the server canonical ID before fetching physical works or stories', async () => {
    vi.mocked(fetchFolder).mockResolvedValue({ id: 836, canonicalCreatorId: 2 } as FolderSummary);
    const load = vi.spyOn(useFoldersStore(), 'loadFolder').mockResolvedValue();
    const stories = vi.spyOn(useFolderStoriesStore(), 'fetchStories').mockResolvedValue();
    const router = galleryTestRouter();
    await router.push('/f/folder-10');
    mount(FolderView, { props: { slug: 'folder-10' }, global: { plugins: [router] } });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/library/2');
    expect(load).not.toHaveBeenCalled();
    expect(stories).not.toHaveBeenCalled();
  });
  it('ignores an old slug mapping when a later navigation resolves first', async () => {
    let old!: (folder: FolderSummary) => void;
    vi.mocked(fetchFolder).mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
    const router = galleryTestRouter();
    await router.push('/f/folder-10');
    const wrapper = mount(FolderView, { props: { slug: 'folder-10' }, global: { plugins: [router] } });
    vi.mocked(fetchFolder).mockResolvedValueOnce({ canonicalCreatorId: 166 } as FolderSummary);
    await wrapper.setProps({ slug: 'lunana' });
    await flushPromises();
    old({ canonicalCreatorId: 2 } as FolderSummary);
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/library/166');
  });
  it.each([undefined, 'post', 'work-gallery'] as const)('passes API mode %s explicitly, without inferring it from carousel items', async (mode) => {
    const folders = useFoldersStore();
    folders.currentFolder = {
      id: 7, slug: 'creator', name: 'Creator', description: null, folderPath: 'Creator', breadcrumb: null,
      contentRating: 'R15', imageCount: 1, videoCount: 0, workNavigationMode: mode
    } as FolderSummary;
    folders.currentImages = [workDetail()];
    folders.currentHasMore = false;
    const load = vi.spyOn(folders, 'loadFolder').mockResolvedValue();
    vi.spyOn(useFolderStoriesStore(), 'fetchStories').mockResolvedValue();
    const router = galleryTestRouter();
    await router.push('/f/creator');
    const wrapper = mount(FolderView, {
      props: { slug: 'creator' },
      global: { plugins: [router], stubs: { FolderGrid: true, FolderHeader: true, InfiniteLoader: true, StoriesModal: true } }
    });
    await flushPromises();
    expect(load).toHaveBeenCalledWith('creator', true, undefined);
    expect(wrapper.getComponent(FolderGrid).props('navigationMode')).toBe(mode ?? 'post');
  });
});
