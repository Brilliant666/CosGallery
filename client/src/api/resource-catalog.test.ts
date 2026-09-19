import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportResourceCatalog,
  fetchResourceCatalog,
  fetchResourceDetail,
  findResourceCreators
} from './resource-catalog';
import { AUTH_REQUIRED_EVENT } from './http';
afterEach(() => vi.unstubAllGlobals());
describe('resource catalog reads', () => {
  it('encodes names and pins page/detail requests to the selected revision', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await findResourceCreators('中文 & alias');
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      'q=%E4%B8%AD%E6%96%87+%26+alias'
    );
    await fetchResourceCatalog(
      35,
      { q: 'NO.051', localState: 'indexed', source: 'linked' },
      2,
      'revision'
    );
    expect(String(fetcher.mock.calls[1]![0])).toContain(
      'page=2&pageSize=50&revision=revision'
    );
    await fetchResourceDetail(35, 77, 'r & 2');
    expect(String(fetcher.mock.calls[2]![0])).toContain(
      '/35/works/77?revision=r+%26+2'
    );
  });
  it('exports UTF-8 content using explicit all-pages scope, authenticated read and no-store', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('中文,"引用"\n', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(
      await exportResourceCatalog(
        35,
        { q: '筛选', localState: 'all', source: 'unlinked' },
        'revision',
        'filtered',
        'csv'
      )
    ).toBe('中文,"引用"\n');
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      'scope=filtered&format=csv'
    );
    expect(String(fetcher.mock.calls[0]![0])).not.toContain('page=');
    expect(fetcher.mock.calls[0]![1]).toEqual({
      credentials: 'same-origin',
      cache: 'no-store'
    });
  });
  it('does not download conflict or unauthorized responses and preserves auth signalling', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 409 }))
        .mockResolvedValueOnce(
          new Response('{}', {
            status: 401,
            headers: { 'x-foldergram-auth-required': '1' }
          })
        )
    );
    const args = [
      35,
      { q: '', localState: 'all', source: 'all' },
      'r',
      'all',
      'txt'
    ] as const;
    await expect(exportResourceCatalog(...args)).rejects.toMatchObject({
      status: 409
    });
    const auth = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, auth);
    await expect(exportResourceCatalog(...args)).rejects.toMatchObject({
      status: 401
    });
    expect(auth).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_REQUIRED_EVENT, auth);
  });
});
