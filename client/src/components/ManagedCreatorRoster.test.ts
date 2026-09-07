import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ManagedCreatorRoster from './ManagedCreatorRoster.vue';
import { fetchArchiveCatalog, fetchArchiveCatalogCreator } from '../api/gallery';
import * as api from '../api/managed-creators';
import { RequestError } from '../api/http';
import type { ArchiveCatalogCreatorDetail, ArchiveCatalogCreatorsPayload, LocalIngestDestinationPreference } from '../types/api';

vi.mock('../api/gallery',()=>({fetchArchiveCatalog:vi.fn(),fetchArchiveCatalogCreator:vi.fn()}));
vi.mock('../api/managed-creators',()=>({createManagedCreator:vi.fn(),updateManagedCreator:vi.fn(),addManagedAlias:vi.fn(),deleteManagedAlias:vi.fn(),setManagedCreatorActive:vi.fn(),linkManagedFolder:vi.fn(),unlinkManagedFolder:vi.fn(),fetchIngestDestination:vi.fn(),setIngestDestination:vi.fn()}));
const creator:ArchiveCatalogCreatorDetail={id:1,name:'Alpha',isActive:true,seedSource:'hentaiclub',seedSourceCreatorId:'historical',createdAt:'fixed',updatedAt:'2026-09-04',deactivatedAt:null,
  preference:'liked',rating:'R18',aliasCount:1,sourceCount:1,localFolderCount:1,sourceCollections:0,remoteWorks:0,localWorks:1,matchedWorks:1,missingWorks:0,unresolvedLocalWorks:0,latestSourceObservation:null,
  aliases:[{id:'source-alias',alias:'Alpha',source:'hentaiclub',editable:false}],sources:[{source:'hentaiclub',sourceCreatorId:'historical',displayName:'Alpha',url:null,firstSeenAt:'first',lastSeenAt:'last'}],collections:[],missing:[],unresolved:[],
  impact:{sources:1,collections:0,remoteWorks:0,localWorks:1,unfinishedDownloadTasks:0,localFolders:1},
  localFolders:[{id:11,catalogFolderId:9,name:'Directory',folderPath:'Directory',creatorId:1,matchStatus:'matched',matchMethod:'manual',workCount:1}],
  unlinkedLocalFolders:[{id:12,catalogFolderId:null,name:'Unknown',folderPath:'Unknown',creatorId:null,matchStatus:'unmatched',matchMethod:null,workCount:1}]};
const payload:ArchiveCatalogCreatorsPayload={summary:{creators:593,activeCreators:593,inactiveCreators:0,unsetPreference:0,unclassified:0,creatorsWithoutLocalWorks:560,unlinkedLocalFolders:1,liked:201,kept:392,r15:259,r18:334,creatorsWithSources:35,creatorsWithLocalWorks:33,sourceCollections:35,remoteWorks:2342,localWorks:1836,matchedWorks:1836,missingWorks:1,unresolvedCreatorFolders:0,unresolvedLocalWorks:0},items:[creator],page:1,limit:50,total:593,hasMore:true};
const destination:LocalIngestDestinationPreference={creatorId:1,creatorName:'Alpha',preferredLocalCreatorFolderId:null,mode:'single-linked',resolvedLocalCreatorFolderId:9,resolvedGalleryFolderId:11,resolvedCreatorDirectory:'G:\\cos图集\\Directory',message:'未显式选择；自动沿用唯一有效的已关联目录',candidates:[{localCreatorFolderId:9,galleryFolderId:11,name:'Directory',folderPath:'Directory',absolutePath:'G:\\cos图集\\Directory',workCount:1,valid:true,unavailableReason:null}]};
const button=(wrapper:ReturnType<typeof mount>,text:string)=>wrapper.findAll('button').find(b=>b.text()===text)!;
describe('managed roster UI',()=>{
  enableAutoUnmount(afterEach);
  beforeEach(()=>{
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal=function(){this.open=true;};
    HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
    vi.mocked(fetchArchiveCatalog).mockResolvedValue(structuredClone(payload));
    vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue(structuredClone(creator));
    vi.mocked(api.fetchIngestDestination).mockResolvedValue(structuredClone(destination));
    vi.mocked(api.setIngestDestination).mockResolvedValue(structuredClone(destination));
    for(const fn of [api.createManagedCreator,api.updateManagedCreator,api.addManagedAlias,api.deleteManagedAlias,api.setManagedCreatorActive,api.linkManagedFolder]) vi.mocked(fn).mockResolvedValue(structuredClone(creator));
    vi.mocked(api.unlinkManagedFolder).mockResolvedValue({folderId:11,creatorId:null});
  });
  it('uses paging and explicit combined filters, not an all-roster render',async()=>{
    const w=mount(ManagedCreatorRoster);await flushPromises();
    expect(fetchArchiveCatalog).toHaveBeenCalledWith(expect.objectContaining({page:1,limit:50,active:'active'}));
    expect(w.findAll('tbody tr')).toHaveLength(1);expect(w.text()).toContain('593');
    const filters=w.get('.roster-filters');await filters.get('input').setValue('alias');
    await filters.findAll('select')[0].setValue('unset');await filters.findAll('select')[1].setValue('unclassified');
    await filters.findAll('select')[2].setValue('inactive');await filters.trigger('submit');await flushPromises();
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({query:'alias',preference:'unset',rating:'unclassified',active:'inactive',limit:50}));
    await button(w,'下一页').trigger('click');await flushPromises();expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:2}));
  });
  it('creates a nullable creator only on explicit save and prevents duplicate submissions',async()=>{
    const w=mount(ManagedCreatorRoster);await flushPromises();await button(w,'新增博主').trigger('click');
    expect(api.createManagedCreator).not.toHaveBeenCalled();
    await w.get('.roster-edit input').setValue('New');
    let resolve!:(value:ArchiveCatalogCreatorDetail)=>void;
    vi.mocked(api.createManagedCreator).mockReturnValue(new Promise(r=>{resolve=r;}));
    await w.get('.roster-edit').trigger('submit');await w.get('.roster-edit').trigger('submit');
    expect(api.createManagedCreator).toHaveBeenCalledTimes(1);expect(api.createManagedCreator).toHaveBeenCalledWith({name:'New',preference:null,rating:null,confirmDistinct:false});
    resolve(structuredClone(creator));await flushPromises();expect(w.emitted('changed')).toHaveLength(1);
  });
  it('shows collision candidates and requires a separate confirmation before retry',async()=>{
    const w=mount(ManagedCreatorRoster);await flushPromises();await button(w,'新增博主').trigger('click');
    await w.get('.roster-edit input').setValue('Alpha');
    vi.mocked(api.createManagedCreator).mockRejectedValueOnce(new RequestError('Identity conflict',409,{candidates:[{id:1,name:'Alpha'}]}));
    await w.get('.roster-edit').trigger('submit');await flushPromises();
    expect(w.get('[role=alert]').text()).toContain('Identity conflict');expect(w.get('.collision').text()).toContain('#1 Alpha');
    await w.get('.collision input[type=checkbox]').setValue(true);await w.get('.roster-edit').trigger('submit');await flushPromises();
    expect(api.createManagedCreator).toHaveBeenLastCalledWith(expect.objectContaining({confirmDistinct:true}));
  });
  it('keeps historical sources readonly, supports aliases and explicit directory linking',async()=>{
    const w=mount(ManagedCreatorRoster);await flushPromises();await button(w,'管理').trigger('click');await flushPromises();
    expect(w.text()).toContain('历史种子');expect(w.findAll('button').some(b=>b.text()==='删除别名')).toBe(false);
    const forms=w.findAll('.inline-form');await forms[0].get('input').setValue('New alias');await forms[0].trigger('submit');await flushPromises();
    expect(api.addManagedAlias).toHaveBeenCalledWith(1,'New alias',false);
    await forms[1].get('select').setValue('12');await forms[1].trigger('submit');await flushPromises();expect(api.linkManagedFolder).toHaveBeenCalledWith(12,1);
    await button(w,'解除关联').trigger('click');expect(api.unlinkManagedFolder).not.toHaveBeenCalled();
    await button(w,'确认变更').trigger('click');await flushPromises();expect(api.unlinkManagedFolder).toHaveBeenCalledWith(11);
  });
  it('saves and clears an explicit bridge ID without triggering linking or task actions',async()=>{
    const multiple:LocalIngestDestinationPreference={
      ...destination,mode:'selection-required',resolvedLocalCreatorFolderId:null,resolvedGalleryFolderId:null,resolvedCreatorDirectory:null,
      message:'存在多个有效本地目录；请先选择首选入库目录',
      candidates:[
        destination.candidates[0]!,
        {localCreatorFolderId:1004,galleryFolderId:2290,name:'lunana',folderPath:'lunana',absolutePath:'G:\\cos图集\\lunana',workCount:41,valid:true,unavailableReason:null}
      ]
    };
    const explicit:LocalIngestDestinationPreference={
      ...multiple,preferredLocalCreatorFolderId:1004,mode:'explicit',resolvedLocalCreatorFolderId:1004,resolvedGalleryFolderId:2290,
      resolvedCreatorDirectory:'G:\\cos图集\\lunana',message:'使用显式选择的本地目录'
    };
    vi.mocked(api.fetchIngestDestination).mockResolvedValueOnce(structuredClone(multiple));
    vi.mocked(api.setIngestDestination).mockResolvedValueOnce(structuredClone(explicit)).mockResolvedValueOnce(structuredClone(multiple));
    const w=mount(ManagedCreatorRoster);await flushPromises();await button(w,'管理').trigger('click');await flushPromises();
    const destinationForm=w.findAll('.inline-form')[2]!;
    await destinationForm.get('select').setValue('1004');
    await destinationForm.trigger('submit');await flushPromises();
    expect(api.setIngestDestination).toHaveBeenCalledWith(1,1004);
    expect(w.text()).toContain('G:\\cos图集\\lunana');
    expect(api.linkManagedFolder).not.toHaveBeenCalled();
    expect(api.createManagedCreator).not.toHaveBeenCalled();

    await destinationForm.get('select').setValue('');
    await destinationForm.trigger('submit');await flushPromises();
    expect(api.setIngestDestination).toHaveBeenLastCalledWith(1,null);
  });
  it('shows impact before deactivation and never queues work on restore',async()=>{
    const w=mount(ManagedCreatorRoster);await flushPromises();await button(w,'管理').trigger('click');await flushPromises();
    await button(w,'停用').trigger('click');expect(api.setManagedCreatorActive).not.toHaveBeenCalled();expect(w.text()).toContain('未完成下载任务 0');
    vi.mocked(api.setManagedCreatorActive).mockResolvedValueOnce({...creator,isActive:false});
    await button(w,'确认变更').trigger('click');await flushPromises();expect(api.setManagedCreatorActive).toHaveBeenCalledWith(1,false);
    await button(w,'恢复').trigger('click');await button(w,'确认变更').trigger('click');await flushPromises();expect(api.setManagedCreatorActive).toHaveBeenLastCalledWith(1,true);
    expect(w.text()).not.toMatch(/上传 JSON|重新导入|硬删除/);
  });
});
