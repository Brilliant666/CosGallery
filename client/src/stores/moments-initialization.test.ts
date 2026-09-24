import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchMoments } from '../api/gallery';
import { useAuthStore } from './auth';
import { useMomentsStore } from './moments';

vi.mock('../api/gallery', () => ({ fetchMoments: vi.fn(), fetchMomentFeed: vi.fn() }));

function deferred() {
  let resolve!: (value: Awaited<ReturnType<typeof fetchMoments>>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Awaited<ReturnType<typeof fetchMoments>>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const payload = (title: string): Awaited<ReturnType<typeof fetchMoments>> => ({
  railKind: 'highlights', railTitle: title, railDescription: '', railSingularLabel: '', items: []
});

describe('homepage rail request ownership', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.mocked(fetchMoments).mockReset(); });

  it('ignores the pre-reset request without clearing the newer loading state', async () => {
    const old = deferred(); const next = deferred();
    vi.mocked(fetchMoments).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const store = useMomentsStore();
    const first = store.fetchMoments();
    store.resetForRebuild();
    const second = store.fetchMoments();
    old.resolve(payload('old')); await first;
    expect(store.railTitle).toBe('Moments'); expect(store.loadingList).toBe(true);
    next.resolve(payload('new')); await second;
    expect(store.railTitle).toBe('new'); expect(store.loadingList).toBe(false);
  });

  it('does not publish an old permission context and permits a fresh retry', async () => {
    const old = deferred();
    vi.mocked(fetchMoments).mockReturnValueOnce(old.promise).mockResolvedValueOnce(payload('current'));
    const store = useMomentsStore(); const auth = useAuthStore();
    const first = store.fetchMoments(); auth.role = 'viewer';
    old.resolve(payload('private')); await first;
    expect(store.railTitle).toBe('Moments'); expect(store.loadingList).toBe(false);
    await store.fetchMoments(); expect(store.railTitle).toBe('current');
  });

  it('force refresh supersedes a pending read, and failures do not occupy the request', async () => {
    const old = deferred(); const next = deferred();
    vi.mocked(fetchMoments).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
      .mockResolvedValueOnce(payload('retry'));
    const store = useMomentsStore();
    const first = store.fetchMoments(); const second = store.fetchMoments(true);
    old.reject(new Error('obsolete')); await first;
    expect(store.listError).toBeNull(); expect(store.loadingList).toBe(true);
    next.reject(new Error('current')); await second;
    expect(store.listError).toBe('current'); expect(store.loadingList).toBe(false);
    await store.fetchMoments(); expect(store.railTitle).toBe('retry'); expect(store.listError).toBeNull();
  });
});
