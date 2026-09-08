import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCreatorSyncRoster, fetchCreatorSyncStats, fetchDownloadCreators, fetchDownloadTaskPage } from './creator-sync';
describe('shared creator sync reads',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('uses only authenticated no-store GETs and passes the same filters to summary and scoped details',async()=>{
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({})});vi.stubGlobal('fetch',fetch);
    const filters={q:'旧别名',enabled:'all' as const,local:'present' as const,source:'absent' as const,preference:'liked' as const,rating:'R15' as const};
    await fetchCreatorSyncRoster({...filters,page:2,limit:50});await fetchCreatorSyncStats(filters);await fetchDownloadCreators({...filters,status:'ingested',page:2,limit:20});await fetchDownloadTaskPage({...filters,status:'ingested',creatorId:166,page:3,limit:50});
    const calls=fetch.mock.calls;expect(calls).toHaveLength(4);
    for(const [url,init] of calls){const query=new URL(url,'http://local').searchParams;expect(query.get('q')).toBe('旧别名');expect(query.get('source')).toBe('absent');expect(init.method).toBeUndefined();expect(init.body).toBeUndefined();expect(init.cache).toBe('no-store');expect(init.credentials).toBe('same-origin');}
    expect(calls[3]![0]).toContain('/download-task-page?');expect(new URL(calls[3]![0],'http://local').searchParams.get('creatorId')).toBe('166');
  });
  it('rejects unscoped detail access before any request',async()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(fetchDownloadTaskPage({creatorId:0})).rejects.toThrow('规范博主');expect(fetch).not.toHaveBeenCalled();});
});
