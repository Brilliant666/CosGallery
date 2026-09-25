import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteUnusedManagedCreator, previewManagedCreatorDeletion, fetchManagedCreatorEditingState,
  saveManagedCreatorProfile, saveManagedCreatorDirectories } from './managed-creators';

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
  it('loads an edit revision without mutation and sends exactly one request per save scope',async()=>{
    const fetchMock=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({profileRevision:'profile',directoriesRevision:'directories'}),{status:200})));
    vi.stubGlobal('fetch',fetchMock);
    await fetchManagedCreatorEditingState(7);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/admin/archive-catalog/creators/7/editing-state');
    expect(fetchMock.mock.calls[0]![1].headers.has('x-foldergram-intent')).toBe(false);
    const profile={name:'Name',preference:'liked' as const,rating:'R15' as const,manualAliases:['Alias'],confirmDistinct:false,expectedRevision:'profile'};
    await saveManagedCreatorProfile(7,profile);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/admin/archive-catalog/creators/7/profile-settings');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual(profile);
    const directories={linkedFolderIds:[11,22],preferredGalleryFolderId:22,expectedRevision:'directories'};
    await saveManagedCreatorDirectories(7,directories);
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/admin/archive-catalog/creators/7/directory-settings');
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual(directories);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.slice(1).every(call=>call[1].method==='PUT'&&call[1].headers.get('x-foldergram-intent')==='1')).toBe(true);
  });
});
