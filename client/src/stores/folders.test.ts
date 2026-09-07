import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFolders } from '../api/gallery';
import type { FolderSummary } from '../types/api';
import { useFoldersStore } from './folders';

vi.mock('../api/gallery', async () => ({ ...await vi.importActual('../api/gallery'), fetchFolders: vi.fn() }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const folder = (id: number) => ({ id, slug: String(id) } as FolderSummary);

describe('folder list initialization ownership', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.mocked(fetchFolders).mockReset(); });

  it('all concurrent callers wait for one request, including a valid empty result', async () => {
    const response = deferred<FolderSummary[]>();
    vi.mocked(fetchFolders).mockReturnValue(response.promise);
    const store = useFoldersStore();
    const first = store.fetchFolders();
    let secondFinished = false;
    const second = store.fetchFolders().then(() => { secondFinished = true; });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    expect(fetchFolders).toHaveBeenCalledTimes(1);
    response.resolve([]);
    await Promise.all([first, second]);
    expect(store.hasLoadedList).toBe(true);
    expect(store.loadingList).toBe(false);
    await store.fetchFolders();
    expect(fetchFolders).toHaveBeenCalledTimes(1);
  });

  it('coalesces real force invalidations and waits for the follow-up refresh', async () => {
    const firstResponse = deferred<FolderSummary[]>();
    const refreshResponse = deferred<FolderSummary[]>();
    vi.mocked(fetchFolders).mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(refreshResponse.promise);
    const store = useFoldersStore();
    let done = false;
    const calls = [store.fetchFolders(), store.fetchFolders(true), store.fetchFolders(true)];
    const completion = Promise.all(calls).then(() => { done = true; });
    firstResponse.resolve([folder(1)]);
    await Promise.resolve(); await Promise.resolve();
    expect(fetchFolders).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    refreshResponse.resolve([folder(2)]);
    await completion;
    expect(store.items.map(item => item.id)).toEqual([2]);
    expect(store.pendingListRefresh).toBe(false);
  });

  it('releases failed requests and allows retry', async () => {
    vi.mocked(fetchFolders).mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce([]);
    const store = useFoldersStore();
    await store.fetchFolders();
    expect(store.listError).toBe('Unavailable');
    expect(store.hasLoadedList).toBe(false);
    await store.fetchFolders();
    expect(store.listError).toBeNull();
    expect(store.hasLoadedList).toBe(true);
  });

  it('reset detaches old requests without canceling other callers or overwriting a new context', async () => {
    const old = deferred<FolderSummary[]>();
    const fresh = deferred<FolderSummary[]>();
    vi.mocked(fetchFolders).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const store = useFoldersStore();
    const prior = store.fetchFolders();
    store.resetForRebuild();
    const next = store.fetchFolders();
    old.resolve([folder(1)]);
    await prior;
    expect(store.items).toEqual([]);
    expect(store.loadingList).toBe(true);
    fresh.resolve([folder(2)]);
    await next;
    expect(store.items.map(item => item.id)).toEqual([2]);
  });
});
