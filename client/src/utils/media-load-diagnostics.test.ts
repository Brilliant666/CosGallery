import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/auth';
import { clearMediaDiagnostics, diagnoseMediaFailure, mediaLoadNotice, reportMediaLoadIssue } from './media-load-diagnostics';

const mismatch = () => new Response(JSON.stringify({ code: 'SOURCE_INDEX_OUTDATED' }), { status: 409, headers: { 'content-type': 'application/json' } });
describe('bounded media failure diagnostics', () => {
  beforeEach(() => { setActivePinia(createPinia()); clearMediaDiagnostics(); });
  afterEach(() => { clearMediaDiagnostics(); vi.unstubAllGlobals(); });
  it('deduplicates concurrent output/version requests including retry suffix and retains a short result', async () => {
    const fetch = vi.fn().mockImplementation(async () => mismatch()); vi.stubGlobal('fetch', fetch);
    expect(await Promise.all([diagnoseMediaFailure('/thumbnails/a.webp?v=A'), diagnoseMediaFailure('/thumbnails/a.webp?v=A&retry=2')])).toEqual(['SOURCE_INDEX_OUTDATED', 'SOURCE_INDEX_OUTDATED']);
    expect(await diagnoseMediaFailure('/thumbnails/a.webp?v=A')).toBe('SOURCE_INDEX_OUTDATED');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', headers: { Range: 'bytes=0-0' } });
    await diagnoseMediaFailure('/thumbnails/a.webp?v=B');
    expect(fetch).toHaveBeenCalledTimes(2);
    useAuthStore().role = 'viewer';
    await diagnoseMediaFailure('/thumbnails/a.webp?v=A');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('does not inspect originals, external URLs, arbitrary API paths or data URLs', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const source of ['/api/originals/1','https://example.com/previews/a.webp','/api/admin/previews/fake','data:image/png;base64,x']) expect(await diagnoseMediaFailure(source)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('supports actual protected share derivative URLs without modifying their query', async () => {
    const fetch = vi.fn().mockImplementation(async () => mismatch()); vi.stubGlobal('fetch', fetch);
    expect(await diagnoseMediaFailure('/api/share/images/22/preview?share=fixture')).toBe('SOURCE_INDEX_OUTDATED');
    expect(fetch.mock.calls[0]![0]).toContain('/api/share/images/22/preview?share=fixture');
  });
  it('never turns forbidden, missing, network or unrecognized failures into index mismatch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const [i,status] of [401,403,404,500].entries()) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code:'SOURCE_INDEX_OUTDATED' }), { status, headers: {'content-type':'application/json'} }));
      expect(await diagnoseMediaFailure(`/previews/error${i}.webp`)).toBeNull();
    }
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    expect(await diagnoseMediaFailure('/previews/offline.webp')).toBeNull();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({code:'BUSINESS_ERROR'}),{status:409,headers:{'content-type':'application/json'}}));
    expect(await diagnoseMediaFailure('/previews/unknown.webp')).toBeNull();
  });
  it('caps concurrency and pending requests, and cancels successful/oversized response bodies', async () => {
    let active = 0, peak = 0;
    const completes: Array<() => void> = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => {
      peak = Math.max(peak, ++active);
      completes.push(() => { active -= 1; resolve(mismatch()); });
    }));
    vi.stubGlobal('fetch', fetch);
    const requests = Array.from({length:40},(_,i)=>diagnoseMediaFailure(`/previews/limit${i}.mp4`));
    expect(fetch).toHaveBeenCalledTimes(2);
    for(let i=0;i<30;i++) { for(const done of completes.splice(0))done(); await new Promise(resolve=>setTimeout(resolve,0)); }
    const results = await Promise.all(requests);
    expect(peak).toBe(2); expect(fetch).toHaveBeenCalledTimes(26); expect(results.filter(x=>x===null)).toHaveLength(14);
    const cancel=vi.fn();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(new ReadableStream({cancel}),{status:206})));
    expect(await diagnoseMediaFailure('/previews/good.mp4')).toBeNull(); expect(cancel).toHaveBeenCalledOnce();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('x'.repeat(4097),{status:409,headers:{'content-type':'application/json'}})));
    expect(await diagnoseMediaFailure('/previews/oversized.webp')).toBeNull();
  });
  it('aggregates transient notices and clears them without navigation or persistence', () => {
    reportMediaLoadIssue('/thumbnails/a.webp','SOURCE_INDEX_OUTDATED');
    reportMediaLoadIssue('/thumbnails/a.webp','SOURCE_INDEX_OUTDATED');
    reportMediaLoadIssue('/thumbnails/b.webp','DERIVATIVE_VERSION_CHANGED');
    expect(mediaLoadNotice.value).toEqual({ code:'SOURCE_INDEX_OUTDATED',count:2 });
    clearMediaDiagnostics(); expect(mediaLoadNotice.value).toBeNull();
  });
  it('discards an in-flight diagnosis after the access or notice generation is cleared', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = diagnoseMediaFailure('/thumbnails/late.webp?v=A');
    clearMediaDiagnostics();
    finish(mismatch());
    expect(await pending).toBeNull();
    expect(mediaLoadNotice.value).toBeNull();
  });
});
