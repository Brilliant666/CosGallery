import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as galleryApi from '../api/gallery';
import type { AppStatus, ReelItem } from '../types/api';
import { useAppStore } from './app';
import { useReelsStore } from './reels';

function createAppStatus(defaultReelsFeedMode: AppStatus['preferences']['defaultReelsFeedMode'] = 'random'): AppStatus {
  return {
    folders: 2,
    indexedImages: 12,
    indexedVideos: 4,
    scan: {
      isScanning: false,
      scanReason: null,
      phase: 'idle',
      startedAt: null,
      runId: null,
      migrationTotalRows: 0,
      processedMigrationRows: 0,
      migratedDerivativeFiles: 0,
      missingDerivativeFiles: 0,
      discoveredFolders: 0,
      processedFolders: 0,
      discoveredImages: 0,
      processedImages: 0,
      queuedDerivativeJobs: 0,
      processedDerivativeJobs: 0,
      generatedThumbnails: 0,
      generatedPreviews: 0,
      currentFolder: null,
      lastCompletedScan: null
    },
    storage: {
      available: true,
      reason: null
    },
    libraryIndex: {
      rebuildRequired: false,
      reason: null,
      ignoredRootMediaCount: 0
    },
    preferences: {
      defaultHomeFeedMode: 'random',
      defaultReelsFeedMode
    }
  };
}

function createReelItem(id: number): ReelItem {
  return {
    id,
    mediaId: id,
    postId: id + 1000,
    mediaPosition: 1,
    creatorId: null,
    mimeType: 'video/mp4',
    fileSize: 24 * 1024 * 1024,
    originalDownloadUrl: `/api/reels/media/${id}/original?v=fixed&download=1`,
    folderId: 1,
    folderSlug: 'reels-alpha',
    folderName: 'Reels Alpha',
    folderPath: 'reels/alpha',
    folderBreadcrumb: null,
    filename: `reel-${id}.mp4`,
    width: 1080,
    height: 1920,
    mediaType: 'video',
    durationMs: 18_000,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_778_400_000_000 + id,
    takenAt: 1_778_400_000_000 + id
  };
}

describe('reels store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('uses the configured random default and passes a session seed to the reels API', async () => {
    const appStore = useAppStore();
    appStore.$patch({
      stats: createAppStatus('random')
    });

    const fetchReelsSpy = vi.spyOn(galleryApi, 'fetchReels').mockResolvedValue({
      mode: 'random',
      items: [createReelItem(11)],
      page: 1,
      limit: 6,
      total: 1,
      hasMore: false
    });

    const reelsStore = useReelsStore();
    await reelsStore.loadInitial();

    expect(reelsStore.mode).toBe('random');
    expect(fetchReelsSpy).toHaveBeenCalledWith(1, 6, 'random', expect.any(Number), {});
    expect(reelsStore.seed).toEqual(expect.any(Number));
    expect(reelsStore.items.map((item) => item.id)).toEqual([11]);
  });

  it('uses the configured app-wide reels default automatically', async () => {
    const appStore = useAppStore();
    appStore.$patch({
      stats: createAppStatus('recent')
    });

    const fetchReelsSpy = vi.spyOn(galleryApi, 'fetchReels').mockResolvedValue({
      mode: 'recent',
      items: [createReelItem(7)],
      page: 1,
      limit: 6,
      total: 1,
      hasMore: false
    });

    const reelsStore = useReelsStore();
    await reelsStore.loadInitial();

    expect(reelsStore.mode).toBe('recent');
    expect(fetchReelsSpy).toHaveBeenCalledWith(1, 6, 'recent', undefined, {});
    expect(reelsStore.items.map((item) => item.id)).toEqual([7]);
  });

  it('reloads initialized reels when the cached queue was not loaded with the active mode', async () => {
    const appStore = useAppStore();
    appStore.$patch({
      stats: createAppStatus('random')
    });

    const fetchReelsSpy = vi.spyOn(galleryApi, 'fetchReels').mockResolvedValue({
      mode: 'random',
      items: [createReelItem(21)],
      page: 1,
      limit: 6,
      total: 1,
      hasMore: false
    });

    const reelsStore = useReelsStore();
    reelsStore.$patch({
      mode: 'random',
      loadedMode: null,
      items: [createReelItem(5)],
      page: 2,
      hasMore: true,
      initialized: true,
      seed: null
    });

    await reelsStore.loadInitial();

    expect(fetchReelsSpy).toHaveBeenCalledWith(1, 6, 'random', expect.any(Number), {});
    expect(reelsStore.items.map((item) => item.id)).toEqual([21]);
    expect(reelsStore.loadedMode).toBe('random');
  });
  it('keeps multiple videos from one album and applies parent caption changes to each',async()=>{
    const items=[{...createReelItem(31),postId:500},{...createReelItem(32),postId:500},{...createReelItem(500),postId:600}];
    const store=useReelsStore();store.items=items;store.setActiveReel(32);expect(store.activeItem?.mediaId).toBe(32);
    store.updateImageCaption(500,'Album caption');expect(store.items.map(item=>item.caption)).toEqual(['Album caption','Album caption',undefined]);
  });
  it('passes opaque continuation cursors and only resets the queue after explicit reload',async()=>{
    const spy=vi.spyOn(galleryApi,'fetchReels').mockResolvedValueOnce({mode:'random',items:[{...createReelItem(1),postId:501}],page:1,limit:6,total:2,hasMore:true,nextCursor:'opaque:page2'})
      .mockResolvedValueOnce({mode:'random',items:[{...createReelItem(2),postId:501}],page:2,limit:6,total:2,hasMore:true,nextCursor:'opaque:page3'});
    const store=useReelsStore();await store.loadInitial();const seed=store.seed;await store.loadMore();
    expect(spy).toHaveBeenLastCalledWith(2,6,'random',seed,{cursor:'opaque:page2'});expect(store.items.map(item=>item.mediaId)).toEqual([1,2]);expect(store.cursor).toBe('opaque:page3');
    spy.mockRejectedValueOnce(new Error('短片队列已过期，请重新加载短片。'));await store.loadMore();expect(store.error).toContain('已过期');expect(store.items.map(item=>item.id)).toEqual([1,2]);expect(store.cursor).toBe('opaque:page3');expect(spy).toHaveBeenCalledTimes(3);
    spy.mockResolvedValueOnce({mode:'random',items:[createReelItem(3)],page:1,limit:6,total:1,hasMore:false,nextCursor:null});await store.loadInitial(true);
    expect(spy).toHaveBeenLastCalledWith(1,6,'random',expect.any(Number),{});expect(store.items.map(item=>item.id)).toEqual([3]);expect(store.cursor).toBeNull();expect(store.error).toBeNull();
    store.cursor='cursor';store.reset();expect(store.cursor).toBeNull();
  });

});
