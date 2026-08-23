import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollectionSummary, FeedItem } from '../types/api';
import { useAuthStore } from './auth';
import { useCollectionsStore } from './collections';

const {
  addImageToCollectionMock,
  createCollectionMock,
  deleteCollectionMock,
  fetchCollectionImagesMock,
  fetchCollectionsMock,
  fetchImageCollectionsMock,
  removeImageFromCollectionMock,
  saveImageMock,
  unsaveImageMock,
  updateCollectionMock
} = vi.hoisted(() => ({
  addImageToCollectionMock: vi.fn(),
  createCollectionMock: vi.fn(),
  deleteCollectionMock: vi.fn(),
  fetchCollectionImagesMock: vi.fn(),
  fetchCollectionsMock: vi.fn(),
  fetchImageCollectionsMock: vi.fn(),
  removeImageFromCollectionMock: vi.fn(),
  saveImageMock: vi.fn(),
  unsaveImageMock: vi.fn(),
  updateCollectionMock: vi.fn()
}));

vi.mock('../api/gallery', () => ({
  addImageToCollection: addImageToCollectionMock,
  createCollection: createCollectionMock,
  deleteCollection: deleteCollectionMock,
  fetchCollectionImages: fetchCollectionImagesMock,
  fetchCollections: fetchCollectionsMock,
  fetchImageCollections: fetchImageCollectionsMock,
  removeImageFromCollection: removeImageFromCollectionMock,
  saveImage: saveImageMock,
  unsaveImage: unsaveImageMock,
  updateCollection: updateCollectionMock
}));

function createFeedItem(id: number): FeedItem {
  return {
    id,
    folderId: 11,
    folderSlug: 'album',
    folderName: 'Album',
    folderPath: 'album',
    folderBreadcrumb: null,
    filename: `photo-${id}.jpg`,
    width: 1200,
    height: 1500,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_800_000_000_000 + id,
    takenAt: 1_800_000_000_000 + id,
    isSaved: false
  };
}

function createCollection(slug: string, name: string, isDefault = false): CollectionSummary {
  return {
    id: isDefault ? 1 : Math.abs(slug.length * 17),
    slug,
    name,
    isDefault,
    itemCount: 0,
    coverImage: null,
    previewImages: [],
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z'
  };
}

function useLocalCollectionsMode() {
  const authStore = useAuthStore();
  authStore.$patch({
    role: 'anonymous',
    likesMode: 'local',
    capabilities: {
      canManageLibrary: false,
      canDeleteMedia: false,
      canAccessSettings: false,
      canUseSharedLikes: false,
      canUseLocalFavorites: true,
      canUseSharedCollections: false,
      canUseLocalCollections: true
    }
  });
}

describe('collections store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    addImageToCollectionMock.mockReset();
    createCollectionMock.mockReset();
    deleteCollectionMock.mockReset();
    fetchCollectionImagesMock.mockReset();
    fetchCollectionsMock.mockReset();
    fetchImageCollectionsMock.mockReset();
    removeImageFromCollectionMock.mockReset();
    saveImageMock.mockReset();
    unsaveImageMock.mockReset();
    updateCollectionMock.mockReset();
  });

  it('adds local custom collections on top of the Saved source of truth', async () => {
    useLocalCollectionsMode();
    const collectionsStore = useCollectionsStore();
    const item = createFeedItem(42);

    await collectionsStore.initialize();
    expect(collectionsStore.items).toMatchObject([{ slug: 'saved', name: 'Saved', isDefault: true, itemCount: 0 }]);

    await collectionsStore.createAndAdd('Travel', item);

    expect(collectionsStore.items.find((collection) => collection.slug === 'travel')?.itemCount).toBe(1);
    expect(collectionsStore.defaultCollection?.itemCount).toBe(1);
    expect(collectionsStore.isSaved(item.id)).toBe(true);
    expect(collectionsStore.isBookmarked(item.id)).toBe(true);

    await collectionsStore.loadCollection('saved');
    expect(collectionsStore.currentImages.map((entry) => entry.id)).toEqual([item.id]);
  });

  it('removes local custom memberships when a post is unsaved', async () => {
    useLocalCollectionsMode();
    const collectionsStore = useCollectionsStore();
    const item = createFeedItem(43);

    await collectionsStore.initialize();
    await collectionsStore.createAndAdd('Travel', item);
    await collectionsStore.toggleDefaultSave(item);

    expect(collectionsStore.isSaved(item.id)).toBe(false);
    expect(collectionsStore.isBookmarked(item.id)).toBe(false);
    expect(collectionsStore.items.find((collection) => collection.slug === 'saved')?.itemCount).toBe(0);
    expect(collectionsStore.items.find((collection) => collection.slug === 'travel')?.itemCount).toBe(0);

    const storedValue = window.localStorage.getItem('foldergram-local-collections-v1');
    expect(storedValue).toContain('"slug":"travel"');
    expect(storedValue).not.toContain('"id":43');
  });

  it('removing a local custom membership keeps the post saved', async () => {
    useLocalCollectionsMode();
    const collectionsStore = useCollectionsStore();
    const item = createFeedItem(44);

    await collectionsStore.initialize();
    await collectionsStore.createAndAdd('Travel', item);
    await collectionsStore.toggleCollectionMembership('travel', item);

    expect(collectionsStore.isSaved(item.id)).toBe(true);
    expect(collectionsStore.isBookmarked(item.id)).toBe(true);
    expect(collectionsStore.defaultCollection?.itemCount).toBe(1);
    expect(collectionsStore.items.find((collection) => collection.slug === 'travel')?.itemCount).toBe(0);
  });

  it('repairs custom-only local storage data into the Saved collection on initialize', async () => {
    const item = createFeedItem(55);
    window.localStorage.setItem(
      'foldergram-local-collections-v1',
      JSON.stringify({
        collections: [
          {
            slug: 'saved',
            name: 'Saved',
            isDefault: true,
            createdAt: '2026-04-28T00:00:00.000Z',
            updatedAt: '2026-04-28T00:00:00.000Z',
            items: []
          },
          {
            slug: 'travel',
            name: 'Travel',
            isDefault: false,
            createdAt: '2026-04-28T00:00:00.000Z',
            updatedAt: '2026-04-28T00:00:00.000Z',
            items: [item]
          }
        ]
      })
    );

    useLocalCollectionsMode();
    const collectionsStore = useCollectionsStore();
    await collectionsStore.initialize();

    expect(collectionsStore.defaultCollection?.itemCount).toBe(1);
    expect(collectionsStore.isSaved(item.id)).toBe(true);
    expect(collectionsStore.isBookmarked(item.id)).toBe(true);

    await collectionsStore.loadCollection('saved');
    expect(collectionsStore.currentImages.map((entry) => entry.id)).toEqual([item.id]);
  });

  it('renames and deletes local custom collections while keeping their posts saved', async () => {
    useLocalCollectionsMode();
    const collectionsStore = useCollectionsStore();
    const item = createFeedItem(56);

    await collectionsStore.initialize();
    await collectionsStore.createAndAdd('Travel', item);

    await collectionsStore.updateCollectionName('travel', 'Trips');
    expect(collectionsStore.items.find((collection) => collection.slug === 'travel')?.name).toBe('Trips');

    await collectionsStore.deleteCollection('travel');
    expect(collectionsStore.items.some((collection) => collection.slug === 'travel')).toBe(false);
    expect(collectionsStore.defaultCollection?.itemCount).toBe(1);
    expect(collectionsStore.isSaved(item.id)).toBe(true);
    expect(collectionsStore.isBookmarked(item.id)).toBe(true);
  });

  it('does not call shared collection APIs in anonymous local mode', async () => {
    useLocalCollectionsMode();
    const collectionsStore = useCollectionsStore();
    const item = createFeedItem(57);

    await collectionsStore.initialize();
    await collectionsStore.createAndAdd('Travel', item);
    await collectionsStore.toggleCollectionMembership('travel', item);
    await collectionsStore.toggleDefaultSave(item);

    expect(createCollectionMock).not.toHaveBeenCalled();
    expect(addImageToCollectionMock).not.toHaveBeenCalled();
    expect(removeImageFromCollectionMock).not.toHaveBeenCalled();
    expect(saveImageMock).not.toHaveBeenCalled();
    expect(unsaveImageMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate collection names before calling the shared create endpoint', async () => {
    fetchCollectionsMock.mockResolvedValue({
      items: [
        createCollection('saved', 'Saved', true),
        createCollection('travel', 'Travel')
      ]
    });

    const collectionsStore = useCollectionsStore();
    await collectionsStore.initialize();

    await expect(collectionsStore.createAndAdd(' travel ', createFeedItem(7))).rejects.toThrow('Collection name already exists.');
    expect(createCollectionMock).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic saved state when a shared save fails', async () => {
    fetchCollectionsMock.mockResolvedValue({
      items: [createCollection('saved', 'Saved', true)]
    });
    saveImageMock.mockRejectedValue(new Error('Save failed'));

    const collectionsStore = useCollectionsStore();
    const item = createFeedItem(9);
    await collectionsStore.initialize();

    await collectionsStore.toggleDefaultSave(item);

    expect(collectionsStore.isSaved(item.id)).toBe(false);
    expect(collectionsStore.isBookmarked(item.id)).toBe(false);
    expect(collectionsStore.error).toBe('Save failed');
  });

  it('rejects shared custom membership failures so the popover can keep the inline error visible', async () => {
    const savedCollection = createCollection('saved', 'Saved', true);
    const travelCollection = createCollection('travel', 'Travel');
    const item = createFeedItem(12);

    fetchCollectionsMock.mockResolvedValue({
      items: [savedCollection, travelCollection]
    });
    fetchImageCollectionsMock.mockResolvedValue({
      imageId: item.id,
      isSaved: true,
      items: [
        { ...savedCollection, containsImage: true },
        { ...travelCollection, containsImage: false }
      ]
    });
    addImageToCollectionMock.mockRejectedValue(new Error('Add failed'));

    const collectionsStore = useCollectionsStore();
    await collectionsStore.initialize();

    await expect(collectionsStore.toggleCollectionMembership('travel', item)).rejects.toThrow('Add failed');
    expect(collectionsStore.error).toBe('Add failed');
    expect(collectionsStore.pendingCollectionKeys).toEqual([]);
  });
});
