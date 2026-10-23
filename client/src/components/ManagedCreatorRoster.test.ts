import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ManagedCreatorRoster from './ManagedCreatorRoster.vue';
import { fetchArchiveCatalog, fetchArchiveCatalogCreator } from '../api/gallery';
import { fetchAdmissionBatches } from '../api/local-admission';
import * as api from '../api/managed-creators';
import { RequestError } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { pinia } from '../stores/pinia';
import type { ArchiveCatalogCreatorDetail, ArchiveCatalogCreatorsPayload } from '../types/api';
import { creator,payload,destination,editingState,savedState,unusedCreator,deferred } from './creator-panel-test-fixtures';
vi.mock('../api/gallery',()=>({fetchArchiveCatalog:vi.fn(),fetchArchiveCatalogCreator:vi.fn()}));
vi.mock('../api/local-admission',()=>({fetchAdmissionBatches:vi.fn()}));
vi.mock('../api/managed-creators',()=>({createManagedCreator:vi.fn(),fetchManagedCreatorEditingState:vi.fn(),saveManagedCreatorProfile:vi.fn(),saveManagedCreatorDirectories:vi.fn(),updateManagedCreator:vi.fn(),addManagedAlias:vi.fn(),deleteManagedAlias:vi.fn(),setManagedCreatorActive:vi.fn(),previewManagedCreatorDeletion:vi.fn(),deleteUnusedManagedCreator:vi.fn(),linkManagedFolder:vi.fn(),unlinkManagedFolder:vi.fn(),fetchIngestDestination:vi.fn(),setIngestDestination:vi.fn()}));
const button=(wrapper:ReturnType<typeof mount>,text:string)=>wrapper.findAll('button').find(b=>b.text()===text)!;
const mountRoster=()=>mount(ManagedCreatorRoster,{global:{stubs:{FirstCollectionSelector:true,SourceEvidencePanel:true}}});
describe('managed roster UI',()=>{
  enableAutoUnmount(afterEach);
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
  beforeEach(()=>{
    vi.resetAllMocks();useAuthStore(pinia).$reset();useAuthStore(pinia).ready=true;
    HTMLDialogElement.prototype.show=function(){this.open=true;};HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
    vi.mocked(fetchArchiveCatalog).mockResolvedValue(structuredClone(payload));vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue(structuredClone(creator));
    vi.mocked(fetchAdmissionBatches).mockResolvedValue({items:[],total:0,page:1,pageSize:20,hasMore:false});
    vi.mocked(api.fetchManagedCreatorEditingState).mockResolvedValue(editingState());vi.mocked(api.fetchIngestDestination).mockResolvedValue(structuredClone(destination));
    vi.mocked(api.createManagedCreator).mockResolvedValue(structuredClone(creator));vi.mocked(api.saveManagedCreatorProfile).mockResolvedValue(savedState());vi.mocked(api.saveManagedCreatorDirectories).mockResolvedValue(savedState());
  });
  it('has two card actions and opens the modal read-only overview without writes or execution components',async()=>{
    const w=mountRoster();await flushPromises();expect(w.get('.creator-card').text()).toContain('平台作品');expect(w.get('.creator-card').text()).toContain('已关联');
    expect(w.get('.card-actions').findAll('button').map(item=>item.text())).toEqual(['资源目录','管理资料']);expect(w.get('.card-actions').findAll('a')).toHaveLength(0);
    await button(w,'管理资料').trigger('click');await flushPromises();expect(w.get('.creator-panel').attributes('aria-modal')).toBe('true');expect(w.get('#creator-tab-overview').attributes('aria-selected')).toBe('true');
    expect(w.find('.profile-form').exists()).toBe(false);expect(w.find('source-evidence-panel-stub').exists()).toBe(false);expect(api.fetchManagedCreatorEditingState).not.toHaveBeenCalled();expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();expect(w.emitted('plan-downloads')).toBeUndefined();
    await button(w,'关闭').trigger('click');await flushPromises();expect(w.find('.creator-panel').exists()).toBe(false);
  });
  it('uses paging and immediate combined filters, not an all-roster render',async()=>{
    const w=mountRoster();await flushPromises();expect(fetchArchiveCatalog).toHaveBeenCalledWith(expect.objectContaining({page:1,limit:50,active:'active'}));expect(w.findAll('.creator-card')).toHaveLength(1);expect(w.text()).toContain('593');
    const filters=w.get('.roster-filters');await filters.get('input').setValue('alias');await filters.findAll('select')[0]!.setValue('unset');await filters.findAll('select')[1]!.setValue('unclassified');await filters.findAll('select')[2]!.setValue('inactive');await filters.trigger('submit');await flushPromises();
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({query:'alias',preference:'unset',rating:'unclassified',active:'inactive',limit:50}));await button(w,'下一页').trigger('click');await flushPromises();expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:2}));
  });
  it('returns to list top on successful paging, but not background refresh or failed paging',async()=>{
    const w=mountRoster();await flushPromises();const list=w.get('.creator-cards').element as HTMLElement;const scroll=vi.fn();list.scrollIntoView=scroll;list.getClientRects=()=>[new DOMRect()] as unknown as DOMRectList;
    await button(w,'下一页').trigger('click');await flushPromises();expect(scroll).toHaveBeenCalledWith({block:'start',behavior:'auto'});await button(w,'上一页').trigger('click');await flushPromises();expect(scroll).toHaveBeenCalledTimes(2);
    await w.vm.refresh();await flushPromises();expect(scroll).toHaveBeenCalledTimes(2);vi.mocked(fetchArchiveCatalog).mockRejectedValueOnce(new Error('Unavailable'));await button(w,'下一页').trigger('click');await flushPromises();expect(scroll).toHaveBeenCalledTimes(2);
  });
  it('immediately applies all five selects, resets pagination, and resets filters once',async()=>{
    const w=mountRoster();await flushPromises();await button(w,'下一页').trigger('click');await flushPromises();const selects=w.get('.roster-filters').findAll('select'),values=['liked','R18','inactive','yes','no'];
    for(let index=0;index<values.length;index++){const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;await selects[index]!.setValue(values[index]);await flushPromises();expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count+1);expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:1}));}
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({preference:'liked',rating:'R18',active:'inactive',hasLocal:'yes',hasSource:'no'}));const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;await button(w,'重置筛选').trigger('click');await flushPromises();expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count+1);
    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith({page:1,limit:50,query:'',active:'active',preference:undefined,rating:undefined,hasLocal:undefined,hasSource:undefined,state:undefined});expect(w.text()).toContain('筛选结果');
  });
  it('preserves ledger state filters and absent-source check subgroups',async()=>{
    const w=mountRoster();await flushPromises();const selects=w.get('.roster-filters').findAll('select');for(const state of ['missing','complete','no-local','no-source','unresolved']){await selects[5]!.setValue(state);await flushPromises();expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({state,page:1}));}
    await button(w,'下一页').trigger('click');await flushPromises();for(const hasSource of ['no-unchecked','no-not-found','no','yes']){await selects[4]!.setValue(hasSource);await flushPromises();expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:1,hasSource}));}
    expect(selects[4]!.text()).toContain('无来源记录 · 尚无检查任务');expect(selects[4]!.text()).toContain('无来源记录 · 最近检查未找到合集');await button(w,'重置筛选').trigger('click');await flushPromises();expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({state:undefined}));
  });
  it('shows collections, missing and unresolved read-only, planning only from the source tab',async()=>{
    vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue({...structuredClone(creator),remoteWorks:2,missingWorks:1,unresolvedLocalWorks:1,collections:[{id:20,source:'costuan',sourceCollectionId:'20',title:'Alpha collection',url:'https://www.costuan.com/20.html',declaredWorkCount:2,observedAt:'2026-09-01T00:00:00Z',deliveries:[]}],missing:[{workId:30,source:'costuan',sourceCollectionId:'20',sourceOrder:2,sourceOrderLabel:'NO.002',title:'Second work'}],unresolved:[{folderName:'Uncertain album',relativePath:'Alpha/Uncertain album',parsedSourceOrder:null,status:'ambiguous'}]});
    const w=mountRoster();await flushPromises();await button(w,'管理资料').trigger('click');await flushPromises();expect(w.text()).toContain('Alpha collection');expect(w.text()).toContain('NO.002 · Second work');expect(w.text()).toContain('Alpha/Uncertain album');expect(w.text()).toContain('对应存在歧义');expect(w.get('a[href="https://www.costuan.com/20.html"]').attributes('rel')).toContain('noopener');expect(w.emitted('plan-downloads')).toBeUndefined();expect(button(w,'生成此博主的缺失获取任务')).toBeUndefined();
    await button(w,'来源与补齐').trigger('click');await flushPromises();await button(w,'生成此博主的缺失获取任务').trigger('click');expect(w.emitted('plan-downloads')).toEqual([[1]]);
  });
  it('debounces typing, flushes Enter once, and applies clearing immediately',async()=>{
    vi.useFakeTimers();const w=mountRoster();await flushPromises();const input=w.get('.roster-filters input');await input.setValue('a');await vi.advanceTimersByTimeAsync(200);await input.setValue('alpha');await vi.advanceTimersByTimeAsync(299);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(2);
    await input.setValue('beta');await input.trigger('keydown',{key:'Enter'});await w.get('.roster-filters').trigger('submit');await vi.advanceTimersByTimeAsync(300);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(3);await input.setValue('');expect(fetchArchiveCatalog).toHaveBeenCalledTimes(4);await vi.advanceTimersByTimeAsync(300);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(4);
  });
  it('waits for IME and cancels delayed searches on select changes and unmount',async()=>{
    vi.useFakeTimers();const w=mountRoster();await flushPromises();const input=w.get('.roster-filters input');await input.trigger('compositionstart');await input.setValue('中文');await input.trigger('keydown',{key:'Enter',isComposing:true});await vi.advanceTimersByTimeAsync(500);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(1);await input.trigger('compositionend');await vi.advanceTimersByTimeAsync(300);expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({query:'中文'}));
    await input.setValue('新名称');await w.get('.roster-filters select').setValue('liked');const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({query:'新名称',preference:'liked'}));await vi.advanceTimersByTimeAsync(300);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count);await input.setValue('unmounted');w.unmount();await vi.advanceTimersByTimeAsync(300);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count);
  });
  it('applies a pending search on page one when paging during debounce',async()=>{
    vi.useFakeTimers();const w=mountRoster();await flushPromises();await button(w,'下一页').trigger('click');await flushPromises();expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:2,query:''}));await w.get('.roster-filters input').setValue('new filter');await button(w,'下一页').trigger('click');await flushPromises();expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:1,query:'new filter'}));expect(w.get('.roster-paging').text()).toContain('第 1 页');const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;await vi.advanceTimersByTimeAsync(300);expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count);
  });
  it('prevents old requests replacing rows, total, errors or loading state',async()=>{
    const pending:ReturnType<typeof deferred<ArchiveCatalogCreatorsPayload>>[]=[];vi.mocked(fetchArchiveCatalog).mockImplementation(()=>{const request=deferred<ArchiveCatalogCreatorsPayload>();pending.push(request);return request.promise;});const w=mountRoster();await w.get('.roster-filters select').setValue('liked');pending[0]!.resolve({...payload,total:100,items:[{...creator,name:'Old'}]});await flushPromises();expect(button(w,'下一页').attributes('disabled')).toBeDefined();pending[1]!.resolve({...payload,total:7,items:[{...creator,name:'Newest'}]});await flushPromises();expect(w.get('.creator-cards').text()).toContain('Newest');expect(w.get('.roster-paging').text()).toContain('筛选结果 7 位');
    await w.get('.roster-filters select').setValue('kept');await w.get('.roster-filters select').setValue('unset');pending[3]!.resolve({...payload,total:2,items:[{...creator,name:'Final'}]});await flushPromises();pending[2]!.reject(new Error('stale error'));await flushPromises();expect(w.get('.creator-cards').text()).toContain('Final');expect(w.get('.roster-paging').text()).toContain('筛选结果 2 位');expect(w.text()).not.toContain('stale error');expect(button(w,'下一页').attributes('disabled')).toBeUndefined();
  });
  it('creates only on explicit save and prevents duplicate submissions',async()=>{
    const w=mountRoster();await flushPromises();await button(w,'新增博主').trigger('click');await flushPromises();expect(api.createManagedCreator).not.toHaveBeenCalled();await w.get('.profile-form input').setValue('New');const result=deferred<ArchiveCatalogCreatorDetail>();vi.mocked(api.createManagedCreator).mockReturnValue(result.promise);await w.get('.profile-form').trigger('submit');await w.get('.profile-form').trigger('submit');expect(api.createManagedCreator).toHaveBeenCalledExactlyOnceWith({name:'New',preference:null,rating:null,confirmDistinct:false});result.resolve(structuredClone(creator));await flushPromises();expect(w.emitted('changed')).toHaveLength(1);expect(w.find('.profile-form').exists()).toBe(false);expect(w.get('.creator-panel h2').text()).toBe('Alpha');expect(w.get('#creator-tab-overview').attributes('aria-selected')).toBe('true');
  });
  it('shows collision candidates and requires separate distinct-person confirmation before retry',async()=>{
    const w=mountRoster();await flushPromises();await button(w,'新增博主').trigger('click');await flushPromises();await w.get('.profile-form input').setValue('Alpha');vi.mocked(api.createManagedCreator).mockRejectedValueOnce(new RequestError('Identity conflict',409,{candidates:[{id:1,name:'Alpha'}]}));await w.get('.profile-form').trigger('submit');await flushPromises();expect(w.get('[role=alert]').text()).toContain('Identity conflict');expect(w.get('.warning').text()).toContain('#1 Alpha');await w.get('.warning input[type=checkbox]').setValue(true);await w.get('.profile-form').trigger('submit');await flushPromises();expect(api.createManagedCreator).toHaveBeenLastCalledWith(expect.objectContaining({confirmDistinct:true}));
  });
  it('keeps edits until save and refreshes the same roster page without moving it',async()=>{
    const w=mountRoster();await flushPromises();await button(w,'下一页').trigger('click');await flushPromises();await button(w,'管理资料').trigger('click');await flushPromises();await button(w,'资料').trigger('click');await flushPromises();const count=vi.mocked(fetchArchiveCatalog).mock.calls.length;await w.get('.profile-form input').setValue('Renamed');await w.get('.profile-form select').setValue('kept');await flushPromises();expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();expect(fetchArchiveCatalog).toHaveBeenCalledTimes(count);await w.get('.profile-form').trigger('submit');await flushPromises();expect(api.saveManagedCreatorProfile).toHaveBeenCalledWith(1,expect.objectContaining({name:'Renamed',preference:'kept',expectedRevision:'profile-1'}));expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({page:2}));expect(api.updateManagedCreator).not.toHaveBeenCalled();
  });
  it('closes the deleted panel and refreshes the same filtered roster without executing unrelated mutations',async()=>{
    vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue(structuredClone(unusedCreator));vi.mocked(api.fetchManagedCreatorEditingState).mockResolvedValue(editingState(unusedCreator));vi.mocked(api.previewManagedCreatorDeletion).mockResolvedValue({creatorId:1,name:'Alpha',eligible:true,blockers:[],confirmationToken:'approved',removableAliases:0,removalScope:[{kind:'creator',label:'博主身份',count:1}]});vi.mocked(api.deleteUnusedManagedCreator).mockResolvedValue({deleted:true,creatorId:1});
    const w=mountRoster();await flushPromises();await w.get('.roster-filters').findAll('select')[2]!.setValue('inactive');await flushPromises();await button(w,'管理资料').trigger('click');await flushPromises();await button(w,'资料').trigger('click');await flushPromises();await w.get('[data-test=preview-creator-deletion]').trigger('click');await flushPromises();vi.mocked(fetchArchiveCatalog).mockResolvedValue({...payload,items:[],total:0,hasMore:false});await w.get('[data-test=confirm-creator-deletion]').trigger('click');await flushPromises();
    expect(w.find('.creator-panel').exists()).toBe(false);expect(w.findAll('.creator-card')).toHaveLength(0);expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({active:'inactive'}));expect(w.text()).toContain('未删除本地文件');expect(w.emitted('changed')).toHaveLength(1);expect(api.deleteUnusedManagedCreator).toHaveBeenCalledExactlyOnceWith(1,'approved');expect(api.unlinkManagedFolder).not.toHaveBeenCalled();
  });
});
