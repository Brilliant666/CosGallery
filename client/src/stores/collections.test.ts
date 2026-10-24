import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollectionSummary, FeedItem } from '../types/api';
import { useAuthStore } from './auth';
import { useCollectionsStore } from './collections';
import { i18n } from '../locales';

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

    expect(await collectionsStore.toggleDefaultSave(item)).toBe('Save failed');

    expect(collectionsStore.isSaved(item.id)).toBe(false);
    expect(collectionsStore.isBookmarked(item.id)).toBe(false);
    expect(collectionsStore.error).toBe('Save failed');
    expect(collectionsStore.isPending(item.id)).toBe(false);
  });

  it.each(['local', 'shared'] as const)('rejects %s creation before creating an empty collection when the media is busy', async mode => {
    if (mode === 'local') useLocalCollectionsMode();
    const saved = createCollection('saved', 'Saved', true);
    const travel = createCollection('travel', 'Travel');
    fetchCollectionsMock.mockResolvedValue({ items: [saved] });
    createCollectionMock.mockResolvedValue({ collection: travel });
    const store = useCollectionsStore();
    await store.initialize();
    store.pendingImageIds = [42];
    const before = window.localStorage.getItem('foldergram-local-collections-v1');
    await expect(store.createAndAdd('Travel', createFeedItem(42))).rejects.toThrow(i18n.global.t('collections.bookmark.errors.busy'));
    expect(createCollectionMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('foldergram-local-collections-v1')).toBe(before);
    expect(store.pendingImageIds).toEqual([42]);
  });

  it.each(['local', 'shared'] as const)('locks the complete %s create-and-add operation from initialization through readback', async mode => {
    if (mode === 'local') useLocalCollectionsMode();
    const saved = createCollection('saved', 'Saved', true);
    const travel = createCollection('travel', 'Travel');
    fetchCollectionsMock.mockResolvedValue({ items: [saved, travel] });
    let created!: () => void;
    createCollectionMock.mockImplementation(() => new Promise(resolve => { created = () => resolve({ collection: travel }); }));
    addImageToCollectionMock.mockResolvedValue({ ok: true, isSaved: true });
    fetchImageCollectionsMock.mockResolvedValue({ imageId: 43, isSaved: false, items: [{ ...saved, containsImage: false }] });
    const store = useCollectionsStore();
    store.mode = mode; store.initialized = true; store.items = [saved];
    let initialized!: () => void;
    vi.spyOn(store, 'initialize').mockResolvedValue().mockImplementationOnce(() => new Promise(resolve => { initialized = resolve; }));
    let refreshed!: () => void;
    vi.spyOn(store, 'refreshAfterMembershipChange').mockImplementation(() => new Promise(resolve => { refreshed = resolve; }));
    const pending = store.createAndAdd('Travel', createFeedItem(43));
    expect(store.isPending(43)).toBe(true);
    await expect(store.createAndAdd('Other', createFeedItem(43))).rejects.toThrow(i18n.global.t('collections.bookmark.errors.busy'));
    await store.toggleDefaultSave(createFeedItem(43));
    await store.toggleCollectionMembership('other', createFeedItem(43));
    expect(saveImageMock).not.toHaveBeenCalled();
    expect(addImageToCollectionMock).not.toHaveBeenCalled();
    initialized();
    if (mode === 'shared') {
      await vi.waitFor(() => expect(created).toBeTypeOf('function'));
      expect(store.isPending(43)).toBe(true);
      await store.toggleDefaultSave(createFeedItem(43));
      await store.toggleCollectionMembership('other', createFeedItem(43));
      expect(saveImageMock).not.toHaveBeenCalled();
      expect(addImageToCollectionMock).not.toHaveBeenCalled();
      created();
    }
    await vi.waitFor(() => expect(refreshed).toBeTypeOf('function'));
    expect(store.isPending(43)).toBe(true);
    expect(store.membershipByImageId[43].items.find(entry => entry.slug === 'travel')?.containsImage).toBe(true);
    await store.toggleDefaultSave(createFeedItem(43));
    expect(saveImageMock).not.toHaveBeenCalled();
    refreshed(); await pending;
    expect(store.pendingImageIds).toEqual([]);
    expect(store.pendingCollectionKeys).toEqual([]);
    expect(addImageToCollectionMock).toHaveBeenCalledTimes(mode === 'shared' ? 1 : 0);
  });

  it('keeps a newly created shared collection and committed membership when the list readback fails', async () => {
    const saved = createCollection('saved', 'Saved', true);
    const travel = createCollection('travel', 'Travel');
    const store = useCollectionsStore(); store.initialized = true; store.items = [saved];
    store.membershipByImageId[44] = { imageId: 44, isSaved: false, items: [{ ...saved, containsImage: false }] };
    createCollectionMock.mockResolvedValue({ collection: travel });
    addImageToCollectionMock.mockResolvedValue({ ok: true, isSaved: true });
    fetchCollectionsMock.mockRejectedValue(new Error('Readback unavailable'));
    await expect(store.createAndAdd('Travel', createFeedItem(44))).rejects.toThrow(i18n.global.t('collections.bookmark.errors.refreshAfterSave'));
    expect(createCollectionMock).toHaveBeenCalledOnce();
    expect(addImageToCollectionMock).toHaveBeenCalledExactlyOnceWith('travel', 44);
    expect(store.items.some(collection => collection.slug === 'travel')).toBe(true);
    expect(store.isSaved(44)).toBe(true);
    expect(store.membershipByImageId[44].items.find(entry => entry.slug === 'travel')?.containsImage).toBe(true);
    expect(store.membershipRefreshRequired).toContain(44);
    expect(store.isPending(44)).toBe(false);
  });

  it('keeps local saved state and storage after create-and-add commits but readback fails', async () => {
    useLocalCollectionsMode();
    const store = useCollectionsStore(); await store.initialize();
    vi.spyOn(store, 'refreshAfterMembershipChange').mockRejectedValue(new Error('Storage readback failed'));
    await expect(store.createAndAdd('Travel', createFeedItem(45))).rejects.toThrow(i18n.global.t('collections.bookmark.errors.refreshAfterSave'));
    expect(store.isSaved(45)).toBe(true);
    expect(store.membershipByImageId[45].items.find(entry => entry.slug === 'travel')?.containsImage).toBe(true);
    const persisted = JSON.parse(window.localStorage.getItem('foldergram-local-collections-v1')!);
    expect(persisted.collections.find((collection: {slug: string}) => collection.slug === 'travel').items[0].id).toBe(45);
    expect(store.isPending(45)).toBe(false);
    expect(createCollectionMock).not.toHaveBeenCalled();
  });

  it('retains a created collection after adding fails so its row can retry without creating a duplicate', async () => {
    const saved = createCollection('saved', 'Saved', true);
    const travel = createCollection('travel', 'Travel');
    const store = useCollectionsStore(); store.initialized = true; store.items = [saved];
    store.membershipByImageId[46] = { imageId: 46, isSaved: false, items: [{ ...saved, containsImage: false }] };
    createCollectionMock.mockResolvedValue({ collection: travel });
    fetchCollectionsMock.mockResolvedValue({ items: [saved, travel] });
    addImageToCollectionMock.mockRejectedValueOnce(new Error('Add failed')).mockResolvedValue({ ok: true, isSaved: true });
    const expected = i18n.global.t('collections.bookmark.errors.createdWithoutMedia', { name: 'Travel', error: 'Add failed' });
    await expect(store.createAndAdd('Travel', createFeedItem(46))).rejects.toThrow(expected);
    expect(store.items.some(collection => collection.slug === 'travel')).toBe(true);
    expect(store.membershipByImageId[46].items.find(entry => entry.slug === 'travel')?.containsImage).toBe(false);
    expect(store.pendingImageIds).toEqual([]);
    fetchImageCollectionsMock.mockResolvedValue({ imageId: 46, isSaved: true,
      items: [{...saved, containsImage: true}, {...travel, containsImage: true}] });
    await store.toggleCollectionMembership('travel', createFeedItem(46));
    expect(createCollectionMock).toHaveBeenCalledOnce();
    expect(addImageToCollectionMock).toHaveBeenCalledTimes(2);
    expect(store.isSaved(46)).toBe(true);
  });

  it('releases the media lock and preserves the list when collection creation itself fails', async () => {
    const saved = createCollection('saved', 'Saved', true);
    const store = useCollectionsStore(); store.initialized = true; store.items = [saved];
    createCollectionMock.mockRejectedValue(new Error('Create failed'));
    await expect(store.createAndAdd('Travel', createFeedItem(47))).rejects.toThrow('Create failed');
    expect(store.pendingImageIds).toEqual([]);
    expect(store.pendingCollectionKeys).toEqual([]);
    expect(store.items).toEqual([saved]);
    expect(addImageToCollectionMock).not.toHaveBeenCalled();
  });

  it('keeps a committed save when refreshing the list fails and explains the partial success', async () => {
    fetchCollectionsMock.mockResolvedValueOnce({ items: [createCollection('saved', 'Saved', true)] }).mockRejectedValueOnce(new Error('Refresh failed'));
    saveImageMock.mockResolvedValue({ ok: true });
    const store = useCollectionsStore();
    await store.initialize();
    const error = await store.toggleDefaultSave(createFeedItem(19));
    expect(store.isSaved(19)).toBe(true);
    expect(store.isPending(19)).toBe(false);
    expect(error).toBe(i18n.global.t('collections.bookmark.errors.refreshAfterSave'));
    expect(error).not.toBe('Refresh failed');
    expect(saveImageMock).toHaveBeenCalledOnce();
  });

  it('requires a successful membership readback before another toggle after a committed custom save failed to refresh', async () => {
    const saved = createCollection('saved', 'Saved', true);
    const travel = createCollection('travel', 'Travel');
    fetchCollectionsMock.mockResolvedValueOnce({ items: [saved, travel] }).mockRejectedValueOnce(new Error('List unavailable'));
    fetchImageCollectionsMock.mockResolvedValueOnce({ imageId: 20, isSaved: false, items: [{ ...saved, containsImage: false }, { ...travel, containsImage: false }] });
    addImageToCollectionMock.mockResolvedValue({ ok: true, imageId: 20, isSaved: true });
    const store = useCollectionsStore();
    await store.initialize();
    await expect(store.toggleCollectionMembership('travel', createFeedItem(20))).rejects.toThrow(i18n.global.t('collections.bookmark.errors.refreshAfterSave'));
    expect(store.isSaved(20)).toBe(true);
    expect(store.membershipByImageId[20].items.find(entry => entry.slug === 'travel')?.containsImage).toBe(true);
    fetchImageCollectionsMock.mockRejectedValueOnce(new Error('Readback unavailable'));
    await expect(store.toggleCollectionMembership('travel', createFeedItem(20))).rejects.toThrow('Readback unavailable');
    expect(addImageToCollectionMock).toHaveBeenCalledOnce();
    expect(removeImageFromCollectionMock).not.toHaveBeenCalled();
    expect(fetchImageCollectionsMock).toHaveBeenCalledTimes(2);
    expect(store.pendingCollectionKeys).toEqual([]);
  });

  it.each(['default', 'custom'] as const)('serializes %s saves against other collection actions for the same media, from initialization through refresh', async firstAction => {
    const store = useCollectionsStore();
    const travel = createCollection('travel', 'Travel');
    store.membershipByImageId[30] = { imageId: 30, isSaved: false, items: [{ ...travel, containsImage: false }] };
    store.membershipByImageId[31] = { imageId: 31, isSaved: false, items: [{ ...travel, containsImage: false }] };
    let initialized!: () => void;
    vi.spyOn(store, 'initialize').mockResolvedValue().mockImplementationOnce(() => new Promise(resolve => { initialized = resolve; }));
    let refreshed!: () => void;
    vi.spyOn(store, 'refreshAfterMembershipChange').mockImplementation(async id => {
      if (id === 30) await new Promise<void>(resolve => { refreshed = resolve; });
    });
    saveImageMock.mockResolvedValue({ ok: true, imageId: 30, isSaved: true });
    addImageToCollectionMock.mockResolvedValue({ ok: true, imageId: 30, isSaved: true });
    const first = firstAction === 'default' ? store.toggleDefaultSave(createFeedItem(30)) : store.toggleCollectionMembership('travel', createFeedItem(30));
    expect(store.isPending(30)).toBe(true);
    expect(store.isCollectionPending('another-collection', 30)).toBe(true);
    await store.toggleDefaultSave(createFeedItem(30));
    await store.toggleCollectionMembership('another-collection', createFeedItem(30));
    expect(saveImageMock).not.toHaveBeenCalled();
    expect(addImageToCollectionMock).not.toHaveBeenCalled();
    await store.toggleCollectionMembership('travel', createFeedItem(31));
    expect(addImageToCollectionMock).toHaveBeenCalledExactlyOnceWith('travel', 31);
    initialized();
    await vi.waitFor(() => expect(refreshed).toBeTypeOf('function'));
    await store.toggleDefaultSave(createFeedItem(30));
    await store.toggleCollectionMembership('another-collection', createFeedItem(30));
    expect(saveImageMock).toHaveBeenCalledTimes(firstAction === 'default' ? 1 : 0);
    expect(addImageToCollectionMock).toHaveBeenCalledTimes(firstAction === 'custom' ? 2 : 1);
    refreshed(); await first;
    expect(store.pendingImageIds).toEqual([]);
    expect(store.pendingCollectionKeys).toEqual([]);
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
