import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workDetail } from '../../test/work-gallery-fixtures';
import { fetchImage } from '../api/gallery';
import { useViewerStore } from './viewer';

vi.mock('../api/gallery', () => ({ fetchImage: vi.fn(), deleteImage: vi.fn(), trashImage: vi.fn() }));

describe('viewer store loads', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.mocked(fetchImage).mockReset(); });
  it('loads full ordered-media metadata with Post identity', async () => {
    const store = useViewerStore();
    vi.mocked(fetchImage).mockResolvedValue(workDetail());
    await store.loadImage(123);
    expect(fetchImage).toHaveBeenCalledWith(123, undefined);
    expect(store.image?.id).toBe(123);
    expect(store.image?.mediaItems).toHaveLength(5);
  });
  it('does not let a stale request replace the current Post', async () => {
    const store = useViewerStore();
    let resolveFirst!: (image: ReturnType<typeof workDetail>) => void;
    vi.mocked(fetchImage).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const first = store.loadImage(123);
    vi.mocked(fetchImage).mockResolvedValueOnce({ ...workDetail(), id: 124 });
    await store.loadImage(124);
    resolveFirst(workDetail());
    await first;
    expect(store.image?.id).toBe(124);
    expect(store.loading).toBe(false);
  });
  it('clears a missing Post without triggering repair', async () => {
    const store = useViewerStore();
    store.image = workDetail();
    vi.mocked(fetchImage).mockRejectedValue(new Error('Not found'));
    await store.loadImage(124);
    expect(store.image).toBeNull();
    expect(store.error).toBe('Not found');
    expect(store.loading).toBe(false);
  });
});
