import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as galleryApi from '../api/gallery';
import type { FeedItem, FolderStoriesPayload } from '../types/api';
import { useFolderStoriesStore } from './folder-stories';

function createFeedItem(id: number): FeedItem {
  return {
    id,
    folderId: 14,
    folderSlug: 'beach-club',
    folderName: 'Beach Club',
    folderPath: 'albums/beach-club',
    folderBreadcrumb: null,
    filename: `story-${id}.jpg`,
    width: 1080,
    height: 1920,
    mediaType: 'image',
    durationMs: null,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_778_400_000_000 + id,
    takenAt: 1_778_400_000_000 + id
  };
}

function createStoriesPayload(): FolderStoriesPayload {
  const coverImage = createFeedItem(31);

  return {
    railKind: 'stories',
    railTitle: 'Stories',
    railDescription: 'Stories and highlights for Beach Club.',
    railSingularLabel: 'Story',
    hasAvatarStory: true,
    avatarStoryId: 'beach-club-story',
    items: [
      {
        id: 'beach-club-story',
        title: 'Beach Club',
        subtitle: 'Beach Club story set',
        dateContext: 'Latest Mar 28, 2026',
        latestActivityTimestamp: new Date('2026-03-28T12:00:00.000Z').getTime(),
        imageCount: 1,
        presentation: 'avatar',
        coverImage
      }
    ],
    highlights: []
  };
}

describe('folder stories store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('retries the same folder after a previous fetch failure', async () => {
    const fetchFolderStoriesSpy = vi
      .spyOn(galleryApi, 'fetchFolderStories')
      .mockRejectedValueOnce(new Error('Temporary stories failure'))
      .mockResolvedValueOnce(createStoriesPayload());

    const store = useFolderStoriesStore();

    await store.fetchStories('beach-club');
    expect(store.listError).toBe('Temporary stories failure');
    expect(store.items).toHaveLength(0);

    await store.fetchStories('beach-club');

    expect(fetchFolderStoriesSpy).toHaveBeenCalledTimes(2);
    expect(store.listError).toBeNull();
    expect(store.items).toHaveLength(1);
    expect(store.avatarStoryId).toBe('beach-club-story');
  });
});
