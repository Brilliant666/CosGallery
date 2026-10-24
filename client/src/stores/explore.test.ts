import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFeed, fetchFeedSearch } from '../api/gallery';
import type { FeedItem } from '../types/api';
import { useExploreStore } from './explore';

vi.mock('../api/gallery', () => ({ fetchFeed: vi.fn(), fetchFeedSearch: vi.fn() }));
const item = (id: number) => ({ id } as FeedItem);
const page = (ids: number[], hasMore = true) => ({ items: ids.map(item), page: 1, limit: 30, total: 60, hasMore });

describe('explore request recovery', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); });

  it('retries the failed search page without dropping earlier results or duplicating concurrent retries', async () => {
    const store = useExploreStore();
    vi.mocked(fetchFeedSearch).mockResolvedValueOnce(page([1])).mockRejectedValueOnce(new Error('Offline'));
    await store.loadSearch('sample');
    await store.loadMoreSearch();
    expect(store.searchItems.map(entry => entry.id)).toEqual([1]);
    expect(store.searchPage).toBe(2);
    let finish!: (value: ReturnType<typeof page>) => void;
    vi.mocked(fetchFeedSearch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const retry = store.retrySearch();
    await store.retrySearch();
    expect(fetchFeedSearch).toHaveBeenCalledTimes(3);
    expect(fetchFeedSearch).toHaveBeenLastCalledWith('sample', 2, 30);
    finish(page([2], false));
    await retry;
    expect(store.searchItems.map(entry => entry.id)).toEqual([1, 2]);
    expect(store.searchError).toBeNull();
    expect(store.searchHasMore).toBe(false);
  });

  it('does not accept a retried old query after a newer search starts', async () => {
    const store = useExploreStore();
    vi.mocked(fetchFeedSearch).mockRejectedValueOnce(new Error('Offline'));
    await store.loadSearch('old');
    let finish!: (value: ReturnType<typeof page>) => void;
    vi.mocked(fetchFeedSearch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(page([2], false));
    const retry = store.retrySearch();
    await store.loadSearch('new');
    finish(page([1]));
    await retry;
    expect(store.searchQuery).toBe('new');
    expect(store.searchItems.map(entry => entry.id)).toEqual([2]);
    expect(store.searchLoading).toBe(false);
    expect(store.searchError).toBeNull();
  });

  it('retries a random-feed page using the same seed and earlier results', async () => {
    const store = useExploreStore();
    vi.mocked(fetchFeed).mockResolvedValueOnce(page([1])).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(page([2], false));
    await store.loadInitial();
    const seed = store.randomSeed;
    await store.loadMore();
    await store.loadMore();
    expect(fetchFeed).toHaveBeenLastCalledWith(2, 30, 'random', seed);
    expect(store.items.map(entry => entry.id)).toEqual([1, 2]);
    expect(store.error).toBeNull();
  });
});
