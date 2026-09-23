import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteUnusedManagedCreator, previewManagedCreatorDeletion } from './managed-creators';

describe('unused managed creator deletion API',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('reads a preview without mutation and sends the exact explicit confirmation token when deleting',async()=>{
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({creatorId:7,eligible:true,blockers:[],name:'Sample',confirmationToken:'fixed-preview',removableAliases:1}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    const preview=await previewManagedCreatorDeletion(7);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/archive-catalog/creators/7/deletion-preview',expect.objectContaining({credentials:'same-origin',cache:'no-store'}));
    expect(fetchMock.mock.calls[0]![1].headers.has('x-foldergram-intent')).toBe(false);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({deleted:true,creatorId:7}),{status:200}));
    await deleteUnusedManagedCreator(7,preview.confirmationToken);
    const [url,request]=fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/admin/archive-catalog/creators/7');expect(request.method).toBe('DELETE');
    expect(JSON.parse(request.body)).toEqual({confirm:true,confirmationToken:'fixed-preview'});
    expect(request.headers.get('x-foldergram-intent')).toBe('1');
  });
});
