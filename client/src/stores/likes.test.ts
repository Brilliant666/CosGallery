import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../locales';
import type { FeedItem } from '../types/api';
import { useLikesStore } from './likes';
import { useAuthStore } from './auth';
import * as galleryApi from '../api/gallery';

function createFeedItem(id: number): FeedItem {
  return {
    id,
    folderId: 1,
    folderSlug: 'animal-planet',
    folderName: 'Animal Planet',
    folderPath: 'animal-planet',
    folderBreadcrumb: null,
    filename: `post-${id}.jpg`,
    width: 1080,
    height: 1350,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbs/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_777_000_000_000 + id,
    takenAt: 1_777_000_000_000 + id
  };
}

describe('useLikesStore localization', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
  });

  it('reacts to locale changes for shared and local saved-item labels', () => {
    const store = useLikesStore();

    store.syncFromItems([createFeedItem(1)], 'shared');

    expect(store.collectionLabel).toBe('Likes');
    expect(store.collectionSectionLabel).toBe('Liked posts');

    i18n.global.locale.value = 'zh';

    expect(store.collectionLabel).toBe('赞过');
    expect(store.collectionSectionLabel).toBe('已赞帖子');
    expect(store.toggleAriaLabel(false)).toBe('点赞帖子');

    store.syncFromItems([createFeedItem(2)], 'local');

    expect(store.collectionLabel).toBe('收藏');
    expect(store.collectionSectionLabel).toBe('收藏帖子');
    expect(store.toggleAriaLabel(true)).toBe('取消收藏帖子');
  });
});

describe('like action recovery', () => {
  beforeEach(() => { setActivePinia(createPinia()); window.localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('rolls back failed add/remove requests, keeps errors per item and clears an error on retry', async () => {
    useAuthStore().$patch({ likesMode: 'shared', capabilities: { canUseSharedLikes: true } });
    const store = useLikesStore();
    const like = vi.spyOn(galleryApi, 'likeImage').mockRejectedValueOnce(new Error('Add failed')).mockResolvedValue({ id: 1, liked: true, ok: true });
    const unlike = vi.spyOn(galleryApi, 'unlikeImage').mockRejectedValueOnce(new Error('Remove failed'));
    await store.toggleLike(createFeedItem(1));
    expect(store.isLiked(1)).toBe(false);
    expect(store.actionError(1)).toBe('Add failed');
    expect(store.actionError(2)).toBeNull();
    expect(store.error).toBeNull();
    await store.toggleLike(createFeedItem(2));
    expect(store.actionError(1)).toBe('Add failed');
    await store.toggleLike(createFeedItem(1));
    expect(store.isLiked(1)).toBe(true);
    expect(store.actionError(1)).toBeNull();
    await store.toggleLike(createFeedItem(1));
    expect(unlike).toHaveBeenCalledOnce();
    expect(like).toHaveBeenCalledTimes(3);
    expect(store.isLiked(1)).toBe(true);
    expect(store.actionError(1)).toBe('Remove failed');
    expect(store.pendingIds).toEqual([]);
  });

  it('does not repeat a failed localStorage write or leave the favorite button pending', async () => {
    useAuthStore().$patch({ likesMode: 'local', capabilities: { canUseSharedLikes: false, canUseLocalFavorites: true } });
    const store = useLikesStore();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('Storage full'); });
    await expect(store.toggleLike(createFeedItem(1))).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledOnce();
    expect(store.isLiked(1)).toBe(false);
    expect(store.isPending(1)).toBe(false);
    expect(store.actionError(1)).toBe('Storage full');
    await store.toggleLike(createFeedItem(1));
    expect(store.isLiked(1)).toBe(true);
    expect(store.actionError(1)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('foldergram-local-favorites')!)[0].id).toBe(1);
  });
});
