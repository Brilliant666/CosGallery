import { afterEach, describe, expect, it, vi } from 'vitest';
import { planFirstCollection, sourceStateLabel } from './first-collection';

describe('first collection transport',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('rejects empty and invalid scopes before fetch, sends deduplicated IDs with CSRF intent',async()=>{
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({items:[],taskIds:[]})});vi.stubGlobal('fetch',fetch);
    await expect(planFirstCollection([])).rejects.toThrow('空范围');await expect(planFirstCollection([0])).rejects.toThrow('合法');
    expect(fetch).not.toHaveBeenCalled();await planFirstCollection([2,2,3]);
    expect(fetch).toHaveBeenCalledTimes(1);const [url,init]=fetch.mock.calls[0]!;
    expect(url).toBe('/api/admin/archive-catalog/metadata-tasks/plan-selected');expect(JSON.parse(init.body)).toEqual({creatorIds:[2,3],retry:false});
    expect(init.headers.get('x-foldergram-intent')).toBe('1');expect(init.credentials).toBe('same-origin');
  });
  it('labels old source evidence as historical, not a live verification',()=>{
    expect(sourceStateLabel()).toBe('历史记录，尚未核验');
    expect(sourceStateLabel({metadataAccepted:true,deliveryReady:true,deliveryEvidence:'historical',missing:[]})).toContain('尚未实时核验');
  });
});
