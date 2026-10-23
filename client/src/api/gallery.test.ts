import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPostSummary, fetchReels, fetchReelPlayback, fetchGalleryVideoPlayback, addImageToCollection, fetchCosGalleryCreators, fetchCreatorGalleryLabels, updateCreatorGalleryLabels, fetchLocalIngestInboxCreators, fetchSharedImage, fetchSharedPost } from './gallery';

describe('post and image API namespaces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses media playback IDs and transports the opaque reels cursor',async()=>{
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:vi.fn().mockResolvedValue({items:[]})});vi.stubGlobal('fetch',fetchMock);
    await fetchReelPlayback(901,undefined,true);expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/reels/media/901/playback?fallback=1');
    await fetchReels(2,6,'recommended',42,{cursor:'opaque:value/next',lastFolder:'alpha'});
    const url=new URL(fetchMock.mock.calls[1]![0],'http://test.invalid');expect(url.searchParams.get('cursor')).toBe('opaque:value/next');expect(url.searchParams.get('lastFolder')).toBe('alpha');
  });

  it('fetches a parent post summary without loading all album media',async()=>{
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:vi.fn().mockResolvedValue({id:900,representation:'summary'})});vi.stubGlobal('fetch',fetchMock);
    await fetchPostSummary(900);expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/posts/900/summary');
  });

  it('resolves readable gallery media separately from the reels feed with cancellation and explicit fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await fetchGalleryVideoPlayback(901, controller.signal);
    await fetchGalleryVideoPlayback(901, controller.signal, true);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/gallery/media/901/playback', expect.objectContaining({ signal: controller.signal }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/gallery/media/901/playback?fallback=1', expect.objectContaining({ signal: controller.signal }));
  });

  it('encodes library joint filters and its sixty-item default in the request identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ items: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    await fetchCosGalleryCreators('R18', '  别名  ', 2, undefined, 'kept');
    const url = new URL(fetchMock.mock.calls[0]![0], 'http://test.invalid');
    expect(url.pathname).toBe('/api/cos-gallery/creators');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', limit: '60', contentRating: 'R18', preference: 'kept', q: '别名' });
  });

  it('does not send a content rating for a category and uses the existing trusted mutation client for label edits', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ galleryLabels: [], revision: 'revision-a' }) });
    vi.stubGlobal('fetch', fetchMock);
    await fetchCosGalleryCreators('R18', '  alias  ', 1, 60, undefined, 'cosplay');
    const url = new URL(fetchMock.mock.calls[0]![0], 'http://test.invalid');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '1', limit: '60', label: 'cosplay', q: 'alias' });
    await fetchCreatorGalleryLabels(12);
    await updateCreatorGalleryLabels(12, ['cosplay', 'selfie'], 'revision-a');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/admin/archive-catalog/creators/12/gallery-labels');
    const [path, init] = fetchMock.mock.calls[2]!;
    expect(path).toBe('/api/admin/archive-catalog/creators/12/gallery-labels');
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers.get('x-foldergram-intent')).toBe('1');
    expect(JSON.parse(init.body)).toEqual({ galleryLabels: ['cosplay', 'selfie'], expectedRevision: 'revision-a' });
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
