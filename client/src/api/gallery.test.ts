import { afterEach, describe, expect, it, vi } from 'vitest';

import { addImageToCollection, fetchCosGalleryCreators, fetchLocalIngestInboxCreators, fetchSharedImage, fetchSharedPost } from './gallery';

describe('post and image API namespaces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('encodes library joint filters and its sixty-item default in the request identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ items: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    await fetchCosGalleryCreators('R18', '  别名  ', 2, undefined, 'kept');
    const url = new URL(fetchMock.mock.calls[0]![0], 'http://test.invalid');
    expect(url.pathname).toBe('/api/cos-gallery/creators');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', limit: '60', contentRating: 'R18', preference: 'kept', q: '别名' });
  });

  it('uses the canonical shared-post endpoint for new shared links and preserves the legacy image endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 42 })
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchSharedPost(42);
    await fetchSharedImage(17);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/share/posts/42');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/share/images/17');
  });

  it('uses canonical post IDs for collection membership mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 42, isSaved: true })
    });
    vi.stubGlobal('fetch', fetchMock);

    await addImageToCollection('trip-picks', 42);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/collections/trip-picks/posts/42',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('uses a read-only request for pending inbox creator discovery', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ detected: [], unmapped: [], summary: {} })
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchLocalIngestInboxCreators();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/local-ingest/inbox-creators',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' })
    );
  });
});
