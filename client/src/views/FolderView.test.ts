import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { galleryTestRouter, workDetail } from '../../test/work-gallery-fixtures';
import FolderGrid from '../components/FolderGrid.vue';
import { useFoldersStore } from '../stores/folders';
import { useFolderStoriesStore } from '../stores/folder-stories';
import type { FolderSummary } from '../types/api';
import FolderView from './FolderView.vue';

describe('FolderView work navigation opt-in', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => setActivePinia(createPinia()));
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
