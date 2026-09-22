import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as admission from './local-admission';
import * as review from './local-review';
const fetchMock=vi.fn<typeof fetch>();
describe('local admission and review managed HTTP contracts',()=>{
  beforeEach(()=>{vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset().mockResolvedValue(new Response('{}',{headers:{'content-type':'application/json'}}));});
  afterEach(()=>vi.unstubAllGlobals());
  it('requests directory discovery separately from explicitly edited scopes',async()=>{
    await admission.refreshAdmissionCollectionDirectories('集合 / 原批');const [url,options]=fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/admin/local-admission/collections/${encodeURIComponent('集合 / 原批')}/repreview`);
    expect(options?.method).toBe('POST');expect(JSON.parse(String(options?.body))).toEqual({refreshDirectories:true});
    expect(new Headers(options?.headers).get('x-foldergram-intent')).toBe('1');
  });
  it.each([
    [admission.previewRemainingAdmissionCollection,'remaining-preview'],
    [admission.cleanupAdmissionCollectionParents,'cleanup-empty-parents'],
  ] as const)('posts a scoped managed action without inventing execution or filesystem input (%s)',async(action,suffix)=>{
    await action('集合 / 原批');const [url,options]=fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/admin/local-admission/collections/${encodeURIComponent('集合 / 原批')}/${suffix}`);
    expect(options?.method).toBe('POST');expect(JSON.parse(String(options?.body))).toEqual({});
    expect(new Headers(options?.headers).get('x-foldergram-intent')).toBe('1');
  });
  it('encodes a selected single parent directory rather than constructing filesystem shell commands',async()=>{await admission.fetchAdmissionDirectories(17,'中文 & 空格');const url=new URL(String(fetchMock.mock.calls[0]?.[0]),'http://localhost');expect(url.pathname).toBe('/api/admin/local-admission/directories');expect(url.searchParams.get('creatorId')).toBe('17');expect(url.searchParams.get('parent')).toBe('中文 & 空格');expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();});
  it('posts the original explicit execution request with managed intent and same-origin auth',async()=>{const input={requestKey:'same-request',confirmed:true as const,acceptExistingVersion:true,actions:[{key:'中文 item',action:'existing' as const,workId:77,acceptSourceIds:[89],approvedAds:['确认广告.txt']}],adsConfirmed:true as const};await admission.executeAdmission('same-batch',input);const options=fetchMock.mock.calls[0]?.[1];expect(options?.method).toBe('POST');expect(options?.credentials).toBe('same-origin');expect(new Headers(options?.headers).get('x-foldergram-intent')).toBe('1');expect(JSON.parse(String(options?.body))).toEqual(input);});
  it('keeps work search scoped to one creator and a bounded page',async()=>{await admission.fetchAdmissionWorks(17,'NO.001 & 同名',2);const url=new URL(String(fetchMock.mock.calls[0]?.[0]),'http://localhost');expect(url.searchParams.get('q')).toBe('NO.001 & 同名');expect(url.searchParams.get('creatorId')).toBe('17');expect(url.searchParams.get('page')).toBe('2');expect(url.searchParams.get('pageSize')).toBe('20');});
  it('uses a saved plan and item for admission review, distinct from a Stage3 job',async()=>{await review.fetchLocalReviewTarget({kind:'admission',planId:'original plan',itemKey:'目录 & key'},17);const url=new URL(String(fetchMock.mock.calls[0]?.[0]),'http://localhost');expect(url.searchParams.get('kind')).toBe('admission');expect(url.searchParams.get('planId')).toBe('original plan');expect(url.searchParams.get('itemKey')).toBe('目录 & key');expect(url.searchParams.has('jobId')).toBe(false);expect(url.searchParams.has('path')).toBe(false);});
  it('reads only requested file page and does not start a task',async()=>{await review.fetchLocalReviewFiles('saved-session',4,false);expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/admin/local-review/sessions/saved-session/files?page=4&limit=50&issuesOnly=false');expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();});
  it('submits multi-creator work as one durable collection operation rather than individual batch posts',async()=>{
    const input={requestKey:'collection-request',confirmed:true as const,batches:[{batchId:'creator-a',acceptExistingVersion:true,actions:[{key:'a',action:'new' as const}]},{batchId:'creator-b',acceptExistingVersion:true,actions:[{key:'b',action:'defer' as const}]}]};
    await admission.executeAdmissionCollection('集合 / 原批',input);expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0]![0]).toBe('/api/admin/local-admission/collections/%E9%9B%86%E5%90%88%20%2F%20%E5%8E%9F%E6%89%B9/execute');const options=fetchMock.mock.calls[0]![1];expect(JSON.parse(String(options?.body))).toEqual(input);expect(new Headers(options?.headers).get('x-foldergram-intent')).toBe('1');
  });
});
