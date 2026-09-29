import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  galleryTestRouter,
  workDetail,
} from '../../test/work-gallery-fixtures';
import { trashPostMedia } from '../api/media-trash';
import { useViewerStore } from '../stores/viewer';
import PostView from './PostView.vue';
import PostViewer from '../components/PostViewer.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
vi.mock('../api/media-trash', () => ({ trashPostMedia: vi.fn() }));
vi.mock('../utils/refresh-library', () => ({
  refreshLibraryAfterRemoval: vi.fn().mockResolvedValue(undefined),
}));
describe('single-media trash scope', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });
  async function render(last = false) {
    const router = galleryTestRouter();
    const detail = workDetail();
    if (last) detail.mediaItems = [detail.mediaItems![1]!];
    const mediaId = detail.mediaItems![last ? 0 : 1]!.imageId;
    await router.push(`/library/166/works/123?media=${mediaId}`);
    const wrapper = mount(PostView, {
      props: { id: '123', authorizedWork: detail, modal: true },
      global: {
        plugins: [router],
        stubs: { PostViewer: true, ConfirmDialog: true },
      },
    });
    await flushPromises();
    return { wrapper, router, mediaId };
  }
  it('trashes the selected media without calling the old whole-post deletion', async () => {
    const { wrapper, mediaId } = await render();
    const legacy = vi.spyOn(useViewerStore(), 'deleteImage');
    vi.mocked(trashPostMedia).mockResolvedValue({
      ok: true,
      postId: 123,
      mediaId,
      remainingMediaCount: 2,
      postTrashed: false,
    });
    wrapper.getComponent(PostViewer).vm.$emit('delete', mediaId);
    await flushPromises();
    wrapper.getComponent(ConfirmDialog).vm.$emit('confirm');
    await flushPromises();
    expect(trashPostMedia).toHaveBeenCalledExactlyOnceWith(123, mediaId, false);
    expect(legacy).not.toHaveBeenCalled();
    expect(wrapper.emitted('removedWork')).toHaveLength(1);
  });
  it('rejects foreign media and discards confirmation after route selection changes', async () => {
    const { wrapper, router, mediaId } = await render();
    wrapper.getComponent(PostViewer).vm.$emit('delete', 999999);
    await flushPromises();
    expect(wrapper.findComponent(ConfirmDialog).exists()).toBe(false);
    wrapper.getComponent(PostViewer).vm.$emit('delete', mediaId);
    await flushPromises();
    await router.replace({ query: { media: '705' } });
    await flushPromises();
    expect(wrapper.findComponent(ConfirmDialog).exists()).toBe(false);
    expect(trashPostMedia).not.toHaveBeenCalled();
  });
  it('explicitly confirms last media and returns to its creator', async () => {
    const { wrapper, router, mediaId } = await render(true);
    vi.mocked(trashPostMedia).mockResolvedValue({
      ok: true,
      postId: 123,
      mediaId,
      remainingMediaCount: 0,
      postTrashed: true,
    });
    wrapper.getComponent(PostViewer).vm.$emit('delete', mediaId);
    await flushPromises();
    expect(wrapper.getComponent(ConfirmDialog).props('message')).toContain(
      'last media',
    );
    wrapper.getComponent(ConfirmDialog).vm.$emit('confirm');
    await flushPromises();
    expect(trashPostMedia).toHaveBeenCalledExactlyOnceWith(123, mediaId, true);
    expect(router.currentRoute.value.name).toBe('canonical-creator');
  });
  it('does not navigate a changed route when an earlier trash request completes', async () => {
    const { wrapper, router, mediaId } = await render();
    let finish!: (value: Awaited<ReturnType<typeof trashPostMedia>>) => void;
    vi.mocked(trashPostMedia).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    wrapper.getComponent(PostViewer).vm.$emit('delete', mediaId);
    await flushPromises();
    wrapper.getComponent(ConfirmDialog).vm.$emit('confirm');
    await flushPromises();
    await router.replace('/library/166/works/123?media=705');
    finish({
      ok: true,
      postId: 123,
      mediaId,
      remainingMediaCount: 0,
      postTrashed: true,
    });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe(
      '/library/166/works/123?media=705',
    );
  });
});
