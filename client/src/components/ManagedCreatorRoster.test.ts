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
  afterEach(() => { vi.useRealTimers(); });
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
  it('uses paging and immediate combined filters, not an all-roster render',async()=>{
    const w=mount(ManagedCreatorRoster);await flushPromises();
    expect(fetchArchiveCatalog).toHaveBeenCalledWith(expect.objectContaining({page:1,limit:50,active:'active'}));
    expect(w.findAll('tbody tr')).toHaveLength(1);expect(w.text()).toContain('593');
    const filters=w.get('.roster-filters');await filters.get('input').setValue('alias');
    await filters.findAll('select')[0].setValue('unset');await filters.findAll('select')[1].setValue('unclassified');
    await filters.findAll('select')[2].setValue('inactive');await filters.trigger('submit');await flushPromises();
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({query:'alias',preference:'unset',rating:'unclassified',active:'inactive',limit:50}));
    await button(w,'下一页').trigger('click');await flushPromises();expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:2}));
  });
  it('immediately applies all five selects, resets pagination, and resets filters once',async()=>{
    const w=mount(ManagedCreatorRoster);await flushPromises();
    await button(w,'下一页').trigger('click');await flushPromises();
    const selects=w.get('.roster-filters').findAll('select');
    const values=['liked','R18','inactive','yes','no'];
    for(let index=0;index<values.length;index++) {
      const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;
      await selects[index]!.setValue(values[index]);await flushPromises();
      expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count+1);
      expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:1}));
    }
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({preference:'liked',rating:'R18',active:'inactive',hasLocal:'yes',hasSource:'no'}));
    const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;
    await button(w,'重置筛选').trigger('click');await flushPromises();
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count+1);
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith({page:1,limit:50,query:'',active:'active',preference:undefined,rating:undefined,hasLocal:undefined,hasSource:undefined});
    expect(w.text()).toContain('全库总数');expect(w.text()).toContain('筛选结果');
  });
  it('debounces typing, flushes Enter once, and applies clearing immediately',async()=>{
    vi.useFakeTimers();
    const w=mount(ManagedCreatorRoster);await flushPromises();
    const input=w.get('.roster-filters input');
    await input.setValue('a');await vi.advanceTimersByTimeAsync(200);
    await input.setValue('alpha');await vi.advanceTimersByTimeAsync(299);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(2);
    await input.setValue('beta');await input.trigger('keydown',{key:'Enter'});
    await w.get('.roster-filters').trigger('submit');await vi.advanceTimersByTimeAsync(300);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(3);
    await input.setValue('');expect(fetchArchiveCatalog).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(300);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(4);
  });
  it('waits for IME composition and cancels delayed searches on select changes and unmount',async()=>{
    vi.useFakeTimers();
    const w=mount(ManagedCreatorRoster);await flushPromises();
    const input=w.get('.roster-filters input');
    await input.trigger('compositionstart');await input.setValue('中文');
    await input.trigger('keydown',{key:'Enter',isComposing:true});await vi.advanceTimersByTimeAsync(500);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(1);
    await input.trigger('compositionend');await vi.advanceTimersByTimeAsync(300);
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({query:'中文'}));
    await input.setValue('新名称');await w.get('.roster-filters select').setValue('liked');
    const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({query:'新名称',preference:'liked'}));
    await vi.advanceTimersByTimeAsync(300);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count);
    await input.setValue('unmounted');w.unmount();await vi.advanceTimersByTimeAsync(300);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count);
  });
  it('applies a pending search on page one when paging is clicked during the debounce',async()=>{
    vi.useFakeTimers();
    const w=mount(ManagedCreatorRoster);await flushPromises();
    await button(w,'下一页').trigger('click');await flushPromises();
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:2,query:''}));
    await w.get('.roster-filters input').setValue('new filter');
    await button(w,'下一页').trigger('click');await flushPromises();
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:1,query:'new filter'}));
    expect(w.get('.roster-paging').text()).toContain('第 1 页');
    const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count);
  });
  it('prevents old requests from replacing new rows, totals, errors, or loading state',async()=>{
    const pending:Array<{resolve:(value:ArchiveCatalogCreatorsPayload)=>void;reject:(error:Error)=>void}>=[];
    vi.mocked(fetchArchiveCatalog).mockImplementation(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));
    const w=mount(ManagedCreatorRoster);
    await w.get('.roster-filters select').setValue('liked');
    pending[0]!.resolve({...payload,total:100,items:[{...creator,name:'Old'}]});await flushPromises();
    expect(button(w,'下一页').attributes('disabled')).toBeDefined();
    pending[1]!.resolve({...payload,total:7,items:[{...creator,name:'Newest'}]});await flushPromises();
    expect(w.get('tbody').text()).toContain('Newest');expect(w.get('.roster-paging').text()).toContain('筛选结果 7 位');
    await w.get('.roster-filters select').setValue('kept');
    await w.get('.roster-filters select').setValue('unset');
    pending[3]!.resolve({...payload,total:2,items:[{...creator,name:'Final'}]});await flushPromises();
    pending[2]!.reject(new Error('stale error'));await flushPromises();
    expect(w.get('tbody').text()).toContain('Final');expect(w.get('.roster-paging').text()).toContain('筛选结果 2 位');
    expect(w.text()).not.toContain('stale error');expect(button(w,'下一页').attributes('disabled')).toBeUndefined();
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
  it('keeps dialog edits pending until explicit save',async()=>{
    const w=mount(ManagedCreatorRoster);await flushPromises();
    await button(w,'管理').trigger('click');await flushPromises();
    const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;
    await w.get('.roster-edit input').setValue('Renamed');
    await w.get('.roster-edit select').setValue('kept');await flushPromises();
    expect(api.updateManagedCreator).not.toHaveBeenCalled();
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count);
    await w.get('.roster-edit').trigger('submit');await flushPromises();
    expect(api.updateManagedCreator).toHaveBeenCalledWith(1,expect.objectContaining({name:'Renamed',preference:'kept'}));
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
    expect(w.text()).not.toContain('历史种子');expect(w.text()).not.toContain('已退役');
    expect(w.text()).toContain('稳定 ID #1 · 启用');expect(w.text()).toContain('暂无其他别名');
    expect(w.text()).toContain('暂无作品来源');expect(w.findAll('button').some(b=>b.text()==='删除别名')).toBe(false);
    const forms=w.findAll('.inline-form');await forms[0].get('input').setValue('New alias');await forms[0].trigger('submit');await flushPromises();
    expect(api.addManagedAlias).toHaveBeenCalledWith(1,'New alias',false);
    await forms[1].get('select').setValue('12');await forms[1].trigger('submit');await flushPromises();expect(api.linkManagedFolder).toHaveBeenCalledWith(12,1);
    await button(w,'解除关联').trigger('click');expect(api.unlinkManagedFolder).not.toHaveBeenCalled();
    await button(w,'确认变更').trigger('click');await flushPromises();expect(api.unlinkManagedFolder).toHaveBeenCalledWith(11);
  });
  it('hides legacy provenance but preserves distinct aliases and current source links without mutations',async()=>{
    const value=structuredClone(creator);
    value.aliases.push({id:'old-name',alias:'Old Alpha',source:'hentaiclub',editable:false});
    value.sources.push({source:'costuan',sourceCreatorId:'collection:588',displayName:'Alpha',url:'https://www.costuan.com/588.html',firstSeenAt:'first',lastSeenAt:'last'});
    vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue(value);
    const before=JSON.stringify(value);
    const w=mount(ManagedCreatorRoster);await flushPromises();await button(w,'管理').trigger('click');await flushPromises();
    expect(w.get('.source-list').text()).toContain('Costuan');
    expect(w.get('.source-list').text()).not.toContain('historical');
    expect(w.get('.source-list a').attributes('href')).toBe('https://www.costuan.com/588.html');
    expect(w.get('.alias-list').text()).toContain('Old Alpha');
    expect(w.get('.alias-list').findAll('li')).toHaveLength(1);
    expect(JSON.stringify(value)).toBe(before);
    expect(api.deleteManagedAlias).not.toHaveBeenCalled();expect(api.updateManagedCreator).not.toHaveBeenCalled();
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
