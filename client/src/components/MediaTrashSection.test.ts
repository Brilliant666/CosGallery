import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTrashedMedia, restorePostMedia } from '../api/media-trash';
import MediaTrashSection from './MediaTrashSection.vue';
vi.mock('../api/media-trash', () => ({
  fetchTrashedMedia: vi.fn(),
  restorePostMedia: vi.fn(),
}));
vi.mock('../utils/refresh-library', () => ({
  refreshLibraryAfterRemoval: vi.fn().mockResolvedValue(undefined),
}));
describe('media trash restoration', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchTrashedMedia).mockResolvedValue({
      items: [
        {
          postId: 123,
          mediaId: 702,
          creatorId: 166,
          postTitle: 'Album',
          filename: 'second.mp4',
          mediaType: 'video',
          thumbnailUrl: null,
          trashedAt: '2026-09-29',
        },
      ],
      total: 1,
    });
  });
  it('restores the exact media and keeps the action separate from whole-post restore', async () => {
    vi.mocked(restorePostMedia).mockResolvedValue({
      ok: true,
      postId: 123,
      mediaId: 702,
      remainingMediaCount: 3,
      postTrashed: false,
    });
    const wrapper = mount(MediaTrashSection);
    await flushPromises();
    expect(wrapper.text()).toContain('second.mp4');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(restorePostMedia).toHaveBeenCalledExactlyOnceWith(123, 702);
    expect(wrapper.find('li').exists()).toBe(false);
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });
  it('keeps failed restoration visible for retry', async () => {
    vi.mocked(restorePostMedia).mockRejectedValue(
      new Error('Parent work is in Trash'),
    );
    const wrapper = mount(MediaTrashSection);
    await flushPromises();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Parent work');
    expect(wrapper.get('li').text()).toContain('second.mp4');
    expect(wrapper.emitted('changed')).toBeUndefined();
  });
});
