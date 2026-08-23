import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTrashStore } from './trash';

const { fetchTrashImagesMock } = vi.hoisted(() => ({
  fetchTrashImagesMock: vi.fn()
}));

vi.mock('../api/gallery', () => ({
  fetchTrashImages: fetchTrashImagesMock
}));

function createDeferred<T>() {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve(value: T) {
      resolve?.(value);
    }
  };
}

describe('trash store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchTrashImagesMock.mockReset();
  });

  it('keeps initialized empty state visible during a forced refresh', async () => {
    const trashStore = useTrashStore();
    const deferred = createDeferred<{
      items: [];
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    }>();

    trashStore.$patch({
      items: [],
      page: 2,
      hasMore: false,
      loading: false,
      error: null,
      initialized: true
    });

    fetchTrashImagesMock.mockReturnValue(deferred.promise);

    const refreshPromise = trashStore.loadInitial(true);

    expect(trashStore.loading).toBe(true);
    expect(trashStore.initialized).toBe(true);
    expect(trashStore.items).toEqual([]);

    deferred.resolve({
      items: [],
      page: 1,
      limit: trashStore.limit,
      total: 0,
      hasMore: false
    });

    await refreshPromise;

    expect(trashStore.loading).toBe(false);
    expect(trashStore.initialized).toBe(true);
    expect(trashStore.items).toEqual([]);
    expect(trashStore.hasMore).toBe(false);
    expect(trashStore.page).toBe(2);
  });
});
