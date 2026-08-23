import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestJson } from './http';

describe('requestJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses no-store caching for safe reads by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true })
    });
    vi.stubGlobal('fetch', fetchMock);

    await requestJson('/api/feed');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/feed',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin'
      })
    );
  });

  it('preserves an explicit cache mode when one is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true })
    });
    vi.stubGlobal('fetch', fetchMock);

    await requestJson('/api/feed', {
      cache: 'reload'
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/feed',
      expect.objectContaining({
        cache: 'reload'
      })
    );
  });
});
