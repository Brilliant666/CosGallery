import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreatorManagementPanel, { type CreatorPanelTab } from './CreatorManagementPanel.vue';
import { fetchArchiveCatalogCreator } from '../api/gallery';
import { fetchAdmissionBatches } from '../api/local-admission';
import * as api from '../api/managed-creators';
import { RequestError } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useCreatorReadingStore } from '../stores/creator-reading';
import { pinia } from '../stores/pinia';
import type { ArchiveCatalogCreatorDetail } from '../types/api';
import { creator,destination,editingState,savedState,unusedCreator,deferred } from './creator-panel-test-fixtures';
vi.mock('../api/gallery',()=>({fetchArchiveCatalogCreator:vi.fn()}));
vi.mock('../api/local-admission',()=>({fetchAdmissionBatches:vi.fn()}));
vi.mock('../api/managed-creators',()=>({createManagedCreator:vi.fn(),fetchManagedCreatorEditingState:vi.fn(),saveManagedCreatorProfile:vi.fn(),saveManagedCreatorDirectories:vi.fn(),updateManagedCreator:vi.fn(),addManagedAlias:vi.fn(),deleteManagedAlias:vi.fn(),setManagedCreatorActive:vi.fn(),previewManagedCreatorDeletion:vi.fn(),deleteUnusedManagedCreator:vi.fn(),linkManagedFolder:vi.fn(),unlinkManagedFolder:vi.fn(),fetchIngestDestination:vi.fn(),setIngestDestination:vi.fn()}));
const button=(w:ReturnType<typeof mount>,text:string)=>w.findAll('button').find(item=>item.text()===text)!;
const panel=(tab:CreatorPanelTab='overview',creatorId:number|null=1)=>mount(CreatorManagementPanel,{props:{creatorId,tab},global:{stubs:{FirstCollectionSelector:{name:'FirstCollectionSelector',props:['active'],template:'<div data-test="source-check" :data-active="active" />'},SourceEvidencePanel:{name:'SourceEvidencePanel',data:()=>({hasUnsavedChanges:false,isBusy:false}),template:'<div data-test="source-evidence" />'}}}});
const preview:api.ManagedCreatorDeletionPreview={creatorId:1,name:'Alpha',eligible:true,blockers:[],confirmationToken:'preview-v1',removableAliases:2};
const chooseIdentity=(value:ArchiveCatalogCreatorDetail)=>{vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue(structuredClone(value));vi.mocked(api.fetchManagedCreatorEditingState).mockResolvedValue(editingState(value));};
describe('creator management panel lifecycle and save scopes',()=>{
  enableAutoUnmount(afterEach);
  afterEach(()=>vi.restoreAllMocks());
  beforeEach(()=>{
    vi.resetAllMocks();useAuthStore(pinia).$reset();useAuthStore(pinia).ready=true;useCreatorReadingStore(pinia).$reset();
    HTMLDialogElement.prototype.show=function(){this.open=true;};HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
    chooseIdentity(creator);vi.mocked(fetchAdmissionBatches).mockResolvedValue({items:[],total:0,page:1,pageSize:20,hasMore:false});
    vi.mocked(api.saveManagedCreatorProfile).mockResolvedValue(savedState());vi.mocked(api.saveManagedCreatorDirectories).mockResolvedValue(savedState());
    vi.mocked(api.fetchIngestDestination).mockResolvedValue(structuredClone(destination));vi.mocked(api.setManagedCreatorActive).mockResolvedValue(structuredClone(creator));
    vi.mocked(api.previewManagedCreatorDeletion).mockResolvedValue(structuredClone(preview));vi.mocked(api.deleteUnusedManagedCreator).mockResolvedValue({deleted:true,creatorId:1});
  });
  it('opens a read-only overview, keeps source task components lazy and inactive when hidden',async()=>{
    const w=panel();await flushPromises();expect(w.get('.creator-panel').attributes('aria-modal')).toBe('true');expect(w.text()).toContain('尚无来源记录，不能据此判断已全部收齐');
    expect(api.fetchManagedCreatorEditingState).not.toHaveBeenCalled();expect(w.find('[data-test=source-check]').exists()).toBe(false);expect(w.find('[data-test=source-evidence]').exists()).toBe(false);expect(w.find('.save-bar').exists()).toBe(false);
    await w.setProps({tab:'sources'});await flushPromises();expect(w.get('[data-test=source-check]').attributes('data-active')).toBe('true');expect(w.find('[data-test=source-evidence]').exists()).toBe(true);
    await w.setProps({tab:'overview'});expect(w.get('[data-test=source-check]').attributes('data-active')).toBe('false');expect(w.get('#creator-content-sources').isVisible()).toBe(false);expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();
  });
  it.each([1440,1920,390])('opens a true modal without moving the background at width %i',async(width)=>{
    vi.spyOn(window,'innerWidth','get').mockReturnValue(width);
    const scroll=vi.fn(),show=vi.spyOn(HTMLDialogElement.prototype,'show');
    const modal=vi.spyOn(HTMLDialogElement.prototype,'showModal').mockImplementation(function(){this.open=true;this.scrollIntoView=scroll;});
    const w=panel();await flushPromises();
    expect(modal).toHaveBeenCalledTimes(1);expect(show).not.toHaveBeenCalled();
    expect(w.get('.creator-panel').attributes('aria-modal')).toBe('true');expect(document.body.style.overflow).toBe('hidden');
    await w.setProps({tab:'profile'});await flushPromises();await w.get('.profile-form input').setValue('Renamed');
    vi.mocked(api.saveManagedCreatorProfile).mockResolvedValue(savedState({...creator,name:'Renamed'}));
    await w.get('.profile-form').trigger('submit');await flushPromises();
    await w.setProps({tab:'sources'});await flushPromises();
    vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue({...creator,name:'Background saved name'});
    w.getComponent({name:'FirstCollectionSelector'}).vm.$emit('planned',[1]);await flushPromises();
    expect(modal).toHaveBeenCalledTimes(1);expect(scroll).not.toHaveBeenCalled();
  });
  it('restores the previous scroll lock and opener focus without scrolling when closed',async()=>{
    const opener=document.createElement('button');document.body.append(opener);opener.focus();
    const previousOverflow=document.body.style.overflow;document.body.style.overflow='clip';
    const focus=vi.spyOn(opener,'focus');const w=panel('profile');await flushPromises();
    document.body.append(w.element);w.get('.profile-form input').element.focus();
    expect(document.activeElement).not.toBe(opener);expect(document.body.style.overflow).toBe('hidden');
    w.unmount();expect(document.body.style.overflow).toBe('clip');expect(document.activeElement).toBe(opener);
    expect(focus).toHaveBeenLastCalledWith({preventScroll:true});opener.remove();document.body.style.overflow=previousOverflow;
  });
  it('does not let Escape on the nested unsaved dialog request closing the parent modal',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Draft');
    const leaving=w.vm.requestLeave();await flushPromises();await w.get('.leave-dialog').trigger('cancel');
    expect(await leaving).toBe(false);expect(w.get('.creator-panel').element.open).toBe(true);
    expect(w.emitted('close')).toBeUndefined();expect(w.vm.dirtyTabs).toEqual(['profile']);
    await w.get('.creator-panel').trigger('cancel');expect(w.emitted('close')).toEqual([[]]);
  });
  it('handles consecutive Escape keys before native dialog closing and preserves the dirty parent',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Draft');
    let leaving:Promise<boolean>|undefined;
    for(let index=0;index<6;index++){
      const target=index%2===0?w.get('.profile-form input'):w.get('.leave-dialog button');
      const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});
      target.element.dispatchEvent(event);await flushPromises();expect(event.defaultPrevented).toBe(true);
      if(index%2===0){
        expect(w.emitted('close')).toHaveLength(Math.floor(index/2)+1);
        // The owning view uses this same leave guard for the emitted close.
        leaving=w.vm.requestLeave();await flushPromises();expect(w.get('.leave-dialog').element.open).toBe(true);
      }else{expect(await leaving).toBe(false);expect(w.get('.leave-dialog').element.open).toBe(false);}
      expect(w.get('.creator-panel').element.open).toBe(true);
      expect(w.get('.profile-form input').element.value).toBe('Draft');expect(w.vm.dirtyTabs).toEqual(['profile']);
    }
    const finalLeave=w.vm.requestLeave();await flushPromises();await button(w,'放弃更改并继续').trigger('click');expect(await finalLeave).toBe(true);
    expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();
  });
  it('does not repeat close requests for a held Escape key or intercept another nested dialog',async()=>{
    const w=panel('profile');await flushPromises();
    const held=new KeyboardEvent('keydown',{key:'Escape',repeat:true,bubbles:true,cancelable:true});w.get('.profile-form input').element.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);expect(w.emitted('close')).toBeUndefined();
    const composing=new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true});w.get('.profile-form input').element.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);expect(w.emitted('close')).toBeUndefined();
    const nested=document.createElement('dialog'),input=document.createElement('input');nested.append(input);w.get('.creator-panel').element.append(nested);
    const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);expect(w.emitted('close')).toBeUndefined();nested.remove();
  });
  it('stages name, classification and manual aliases then submits one atomic profile save',async()=>{
    const value=structuredClone(creator);value.aliases.push({id:'manual-old',alias:'Previous alias',source:'manual',editable:true});chooseIdentity(value);
    const w=panel('profile');await flushPromises();const form=w.get('.profile-form');await form.get('input').setValue('Renamed');await form.findAll('select')[0]!.setValue('kept');await form.findAll('select')[1]!.setValue('R15');
    await button(w,'移除').trigger('click');await form.get('.inline-input input').setValue('New alias');await button(w,'添加').trigger('click');
    expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();expect(api.addManagedAlias).not.toHaveBeenCalled();expect(api.deleteManagedAlias).not.toHaveBeenCalled();expect(form.text()).toContain('Alpha');expect(form.get('.records').findAll('button')).toHaveLength(0);
    const pending=deferred<api.ManagedCreatorSavedState>();vi.mocked(api.saveManagedCreatorProfile).mockReturnValue(pending.promise);
    await form.trigger('submit');await form.trigger('submit');expect(api.saveManagedCreatorProfile).toHaveBeenCalledExactlyOnceWith(1,{name:'Renamed',preference:'kept',rating:'R15',confirmDistinct:false,manualAliases:['New alias'],expectedRevision:'profile-1'});
    expect(await w.vm.requestLeave()).toBe(false);expect(w.text()).toContain('当前操作正在提交');
    pending.resolve(savedState({...value,name:'Renamed',preference:'kept',rating:'R15',aliases:[value.aliases[0]!,{id:'new',alias:'New alias',source:'manual',editable:true}]}));await flushPromises();
    expect(w.text()).toContain('资料已保存');expect(w.vm.dirtyTabs).toEqual([]);expect(useCreatorReadingStore(pinia).generation).toBe(1);expect(api.updateManagedCreator).not.toHaveBeenCalled();
  });
  it('retains the exact profile draft and collision confirmation after a failed atomic save',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Other');await w.get('.inline-input input').setValue('Uncommitted alias');
    vi.mocked(api.saveManagedCreatorProfile).mockRejectedValueOnce(new RequestError('停用身份仍参与重名检查',409,{candidates:[{id:9,name:'Other'}]}));await w.get('.profile-form').trigger('submit');await flushPromises();
    expect(w.get('[role=alert]').text()).toContain('停用身份仍参与重名检查');expect(w.get('.profile-form input').element.value).toBe('Other');expect(w.text()).toContain('Uncommitted alias');expect(w.text()).not.toContain('资料已保存');expect(w.vm.dirtyTabs).toContain('profile');expect(w.emitted('changed')).toBeUndefined();
    await w.get('.warning input[type=checkbox]').setValue(true);await w.get('.profile-form').trigger('submit');await flushPromises();expect(api.saveManagedCreatorProfile).toHaveBeenLastCalledWith(1,expect.objectContaining({confirmDistinct:true,manualAliases:['Uncommitted alias']}));
  });
  it('keeps profile and directory drafts independent across tabs and saves only the selected scope',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Unsaved name');await w.setProps({tab:'directories'});await flushPromises();
    await w.get('#creator-content-directories .inline-input select').setValue('12');await button(w,'拟关联').trigger('click');expect(w.vm.dirtyTabs).toEqual(['profile','directories']);expect(api.fetchManagedCreatorEditingState).toHaveBeenCalledTimes(1);
    const linked={...structuredClone(creator),localFolders:[...creator.localFolders,{...creator.unlinkedLocalFolders[0]!,creatorId:1,catalogFolderId:10,matchStatus:'matched'}],unlinkedLocalFolders:[]};
    vi.mocked(api.saveManagedCreatorDirectories).mockResolvedValue(savedState(linked));vi.mocked(api.fetchManagedCreatorEditingState).mockResolvedValue(editingState(linked));
    await w.get('#creator-content-directories').trigger('submit');await flushPromises();expect(api.saveManagedCreatorDirectories).toHaveBeenCalledExactlyOnceWith(1,{linkedFolderIds:[11,12],preferredGalleryFolderId:null,expectedRevision:'directories-1'});expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();
    await w.setProps({tab:'profile'});expect(w.get('.profile-form input').element.value).toBe('Unsaved name');expect(w.vm.dirtyTabs).toEqual(['profile']);
    await w.setProps({tab:'directories'});await button(w,'拟解除').trigger('click');await w.setProps({tab:'profile'});vi.mocked(api.saveManagedCreatorProfile).mockResolvedValue(savedState({...linked,name:'Unsaved name'}));await w.get('.profile-form').trigger('submit');await flushPromises();
    expect(w.vm.dirtyTabs).toEqual(['directories']);await w.setProps({tab:'directories'});expect(w.text()).toContain('解除关联：Directory');
  });
  it('uses one directory transaction, includes newly linked preferred folder, and never calls legacy independent writes',async()=>{
    const w=panel('directories');await flushPromises();await w.get('.inline-input select').setValue('12');await button(w,'拟关联').trigger('click');
    const selects=w.get('#creator-content-directories').findAll('select');await selects[1]!.setValue('12');expect(w.text()).toContain('新增关联：Unknown');expect(w.text()).toContain('首选目录将变更为：Unknown');
    const pending=deferred<api.ManagedCreatorSavedState>();vi.mocked(api.saveManagedCreatorDirectories).mockReturnValue(pending.promise);await w.get('#creator-content-directories').trigger('submit');await w.get('#creator-content-directories').trigger('submit');
    expect(api.saveManagedCreatorDirectories).toHaveBeenCalledExactlyOnceWith(1,{linkedFolderIds:[11,12],preferredGalleryFolderId:12,expectedRevision:'directories-1'});expect(api.linkManagedFolder).not.toHaveBeenCalled();expect(api.setIngestDestination).not.toHaveBeenCalled();expect(api.unlinkManagedFolder).not.toHaveBeenCalled();
    pending.reject(new Error('关联已由另一身份占用'));await flushPromises();expect(w.text()).toContain('关联已由另一身份占用');expect(w.vm.dirtyTabs).toEqual(['directories']);expect(selects[1]!.element.value).toBe('12');expect(w.emitted('changed')).toBeUndefined();
  });
  it('does not leave a preferred folder dangling after a proposed unlink, and clears preference explicitly',async()=>{
    const state=editingState();state.preferredLocalCreatorFolderId=9;vi.mocked(api.fetchManagedCreatorEditingState).mockResolvedValue(state);
    const w=panel('directories');await flushPromises();await button(w,'拟解除').trigger('click');expect(w.text()).toContain('首选目录不在保存后的有效关联范围');await w.get('#creator-content-directories').trigger('submit');expect(api.saveManagedCreatorDirectories).not.toHaveBeenCalled();
    const preferred=w.get('#creator-content-directories').findAll('select')[1]!;preferred.element.selectedIndex=0;await preferred.trigger('change');await w.get('#creator-content-directories').trigger('submit');await flushPromises();expect(api.saveManagedCreatorDirectories).toHaveBeenCalledWith(1,{linkedFolderIds:[],preferredGalleryFolderId:null,expectedRevision:'directories-1'});
  });
  it('offers explicit cancel, return to the dirty tab, or discard without saving',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Draft');await w.setProps({tab:'overview'});
    const canceled=w.vm.requestLeave();await flushPromises();expect(w.get('.leave-dialog').element.open).toBe(true);expect(w.get('.leave-dialog').text()).toContain('资料尚未保存');await button(w,'取消跳转').trigger('click');expect(await canceled).toBe(false);expect(w.vm.dirtyTabs).toEqual(['profile']);
    const returnToSave=w.vm.requestLeave();await flushPromises();await button(w,'返回保存').trigger('click');expect(await returnToSave).toBe(false);expect(w.emitted('tab')?.at(-1)).toEqual(['profile']);
    const discarded=w.vm.requestLeave();await flushPromises();await button(w,'放弃更改并继续').trigger('click');expect(await discarded).toBe(true);expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();
  });
  it('does not prompt when clean and does not repeatedly prompt when switching tabs',async()=>{
    const w=panel('profile');await flushPromises();expect(await w.vm.requestLeave()).toBe(true);await w.get('.profile-form input').setValue('Draft');await w.setProps({tab:'directories'});await w.setProps({tab:'overview'});await w.setProps({tab:'profile'});expect(w.get('.profile-form input').element.value).toBe('Draft');expect(w.get('.leave-dialog').element.open).toBe(false);
  });
  it('isolates late A detail and edit responses from B and ignores completion after close',async()=>{
    const late=deferred<ArchiveCatalogCreatorDetail>();vi.mocked(fetchArchiveCatalogCreator).mockImplementation(id=>id===1?late.promise:Promise.resolve({...creator,id,name:id===2?'Beta':'Gamma'}));
    const w=panel();await w.setProps({creatorId:2});await flushPromises();late.resolve(creator);await flushPromises();expect(w.get('h2').text()).toBe('Beta');expect(fetchAdmissionBatches).toHaveBeenCalledExactlyOnceWith(2);
    const oldEditing=deferred<api.ManagedCreatorEditingState>();vi.mocked(api.fetchManagedCreatorEditingState).mockImplementation(id=>id===2?oldEditing.promise:Promise.resolve(editingState({...creator,id:3,name:'Gamma'})));
    await w.setProps({tab:'profile'});await w.setProps({creatorId:3});await flushPromises();oldEditing.resolve(editingState({...creator,id:2,name:'Beta old'}));await flushPromises();expect(w.get('h2').text()).toBe('Gamma');expect(w.get('.profile-form input').element.value).toBe('Gamma');w.unmount();expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();
  });
  it('binds in-flight saves to A and does not publish their result under B',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Alpha changed');const pending=deferred<api.ManagedCreatorSavedState>();vi.mocked(api.saveManagedCreatorProfile).mockReturnValue(pending.promise);await w.get('.profile-form').trigger('submit');
    chooseIdentity({...creator,id:2,name:'Beta'});await w.setProps({creatorId:2});await flushPromises();pending.resolve(savedState({...creator,name:'Alpha changed'}));await flushPromises();expect(api.saveManagedCreatorProfile.mock.calls[0]?.[0]).toBe(1);expect(w.get('h2').text()).toBe('Beta');expect(w.get('.profile-form input').element.value).toBe('Beta');expect(w.emitted('changed')).toBeUndefined();
  });
  it('preserves both drafts on conflict and only discards the explicitly reloaded tag',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Draft');await w.setProps({tab:'directories'});await button(w,'拟解除').trigger('click');await w.setProps({tab:'profile'});
    vi.mocked(api.saveManagedCreatorProfile).mockRejectedValueOnce(new RequestError('资料已变化',409,{code:'CREATOR_EDIT_CONFLICT'}));await w.get('.profile-form').trigger('submit');await flushPromises();expect(w.vm.dirtyTabs).toEqual(['profile','directories']);expect(w.get('.profile-form input').element.value).toBe('Draft');
    vi.mocked(api.fetchManagedCreatorEditingState).mockResolvedValue(editingState({...creator,name:'Remote saved'}));await button(w,'放弃当前标签改动并重新读取').trigger('click');await flushPromises();expect(w.get('.profile-form input').element.value).toBe('Remote saved');expect(w.vm.dirtyTabs).toEqual(['directories']);
  });
  it('keeps source aliases read-only, renders only supported source links, and preserves their evidence',async()=>{
    const value=structuredClone(creator);value.aliases.push({id:'old-name',alias:'Old Alpha',source:'hentaiclub',editable:false});value.sources.push({source:'costuan',sourceCreatorId:'collection:588',displayName:'Alpha',url:'https://www.costuan.com/588.html',firstSeenAt:'first',lastSeenAt:'last'});chooseIdentity(value);const before=JSON.stringify(value);
    const w=panel('profile');await flushPromises();expect(w.text()).toContain('Old Alpha');expect(w.get('.profile-form .records').findAll('button')).toHaveLength(0);await w.setProps({tab:'sources'});expect(w.get('#creator-content-sources').text()).toContain('Costuan');expect(w.get('#creator-content-sources').text()).not.toContain('historical');expect(w.get('a[href="https://www.costuan.com/588.html"]').attributes('rel')).toContain('noopener');expect(JSON.stringify(value)).toBe(before);expect(api.deleteManagedAlias).not.toHaveBeenCalled();
  });
  it('keeps local admission as a navigation link, never creating a plan or writing a directory',async()=>{
    const w=panel('directories');await flushPromises();expect(w.get('a[href="/creator-admission/local/1"]').text()).toBe('为该博主入库');expect(api.saveManagedCreatorDirectories).not.toHaveBeenCalled();expect(w.emitted('plan-downloads')).toBeUndefined();expect(api.createManagedCreator).not.toHaveBeenCalled();
  });
  it('keeps unavailable preferred destinations visible instead of silently choosing another directory',async()=>{
    const value=editingState();value.preferredLocalCreatorFolderId=9;value.destination={...destination,preferredLocalCreatorFolderId:9,mode:'preferred-unavailable',resolvedLocalCreatorFolderId:null,resolvedGalleryFolderId:null,resolvedCreatorDirectory:null,message:'首选目录不可用',candidates:[{...destination.candidates[0]!,valid:false,unavailableReason:'目录不在当前图库范围'}]};vi.mocked(api.fetchManagedCreatorEditingState).mockResolvedValue(value);
    const w=panel('directories');await flushPromises();expect(w.text()).toContain('首选目录不可用');expect(w.text()).toContain('目录不在当前图库范围');expect(w.get('#creator-content-directories').findAll('select')[1]!.findAll('option')[1]!.attributes('disabled')).toBeDefined();expect(button(w,'保存目录设置').attributes('disabled')).toBeDefined();expect(api.saveManagedCreatorDirectories).not.toHaveBeenCalled();
  });
  it('refreshes saved facts after source work without overwriting either unsaved editor draft',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('My draft');await w.setProps({tab:'directories'});await button(w,'拟解除').trigger('click');await w.setProps({tab:'sources'});vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue({...creator,name:'Background saved name',remoteWorks:4});w.findComponent({name:'FirstCollectionSelector'}).vm.$emit('planned',[1]);await flushPromises();expect(w.get('h2').text()).toBe('Background saved name');expect(w.vm.dirtyTabs).toEqual(['profile','directories']);await w.setProps({tab:'profile'});expect(w.get('.profile-form input').element.value).toBe('My draft');await w.setProps({tab:'directories'});expect(w.text()).toContain('解除关联：Directory');expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();expect(api.saveManagedCreatorDirectories).not.toHaveBeenCalled();
  });
  it('blocks state changes with unsaved data and refreshes clean revisions after explicit deactivate and restore',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Draft');expect(button(w,'停用博主').attributes('disabled')).toBeDefined();await w.get('.profile-form input').setValue('Alpha');await button(w,'停用博主').trigger('click');expect(api.setManagedCreatorActive).not.toHaveBeenCalled();expect(w.text()).toContain('未完成下载 0');
    vi.mocked(api.setManagedCreatorActive).mockResolvedValueOnce({...creator,isActive:false});vi.mocked(api.fetchManagedCreatorEditingState).mockResolvedValueOnce({...editingState({...creator,isActive:false}),profileRevision:'after-deactivate'});await button(w,'确认变更').trigger('click');await flushPromises();expect(api.setManagedCreatorActive).toHaveBeenCalledWith(1,false);
    await button(w,'恢复博主').trigger('click');await button(w,'确认变更').trigger('click');await flushPromises();expect(api.setManagedCreatorActive).toHaveBeenLastCalledWith(1,true);expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();expect(w.emitted('plan-downloads')).toBeUndefined();
  });
  it.each([{seedSource:'manual',isActive:true},{seedSource:'hentaiclub',isActive:false},{seedSource:'costuan',isActive:false}])('does not offer deletion for $seedSource active=$isActive',async state=>{
    chooseIdentity({...unusedCreator,...state});const w=panel('profile');await flushPromises();expect(w.find('[data-test=unused-creator-deletion]').exists()).toBe(false);expect(api.previewManagedCreatorDeletion).not.toHaveBeenCalled();expect(api.deleteUnusedManagedCreator).not.toHaveBeenCalled();
  });
  it('keeps deletion outside overview, previews blockers, and never deletes blocked identities',async()=>{
    chooseIdentity(unusedCreator);vi.mocked(api.previewManagedCreatorDeletion).mockResolvedValue({...preview,eligible:false,blockers:[{code:'works',label:'本地作品',count:2},{code:'plans',label:'接纳计划',count:1}]});const w=panel();await flushPromises();expect(w.find('[data-test=unused-creator-deletion]').exists()).toBe(false);await w.setProps({tab:'profile'});await flushPromises();expect(api.previewManagedCreatorDeletion).not.toHaveBeenCalled();await w.get('[data-test=preview-creator-deletion]').trigger('click');await flushPromises();expect(api.previewManagedCreatorDeletion).toHaveBeenCalledExactlyOnceWith(1);expect(w.get('[data-test=creator-deletion-preview]').text()).toContain('本地作品 · 2');expect(w.get('[data-test=creator-deletion-preview]').text()).toContain('接纳计划 · 1');expect(w.find('[data-test=confirm-creator-deletion]').exists()).toBe(false);await button(w,'取消删除').trigger('click');expect(w.find('[data-test=creator-deletion-preview]').exists()).toBe(false);expect(api.deleteUnusedManagedCreator).not.toHaveBeenCalled();
  });
  it('requires explicit token confirmation and issues one delete despite repeated clicks',async()=>{
    chooseIdentity(unusedCreator);const pending=deferred<{deleted:true;creatorId:number}>();vi.mocked(api.deleteUnusedManagedCreator).mockReturnValue(pending.promise);const w=panel('profile');await flushPromises();await w.get('[data-test=preview-creator-deletion]').trigger('click');await flushPromises();expect(w.get('[data-test=creator-deletion-preview]').text()).toContain('2 条手工别名');expect(api.deleteUnusedManagedCreator).not.toHaveBeenCalled();const confirm=w.get('[data-test=confirm-creator-deletion]');await confirm.trigger('click');await confirm.trigger('click');expect(api.deleteUnusedManagedCreator).toHaveBeenCalledExactlyOnceWith(1,'preview-v1');pending.resolve({deleted:true,creatorId:1});await flushPromises();expect(w.emitted('deleted')).toHaveLength(1);expect(w.emitted('changed')).toHaveLength(1);expect(api.setManagedCreatorActive).not.toHaveBeenCalled();expect(api.unlinkManagedFolder).not.toHaveBeenCalled();
  });
  it('discards stale delete confirmation and requires a fresh preview after a failed delete',async()=>{
    chooseIdentity(unusedCreator);vi.mocked(api.deleteUnusedManagedCreator).mockRejectedValueOnce(new RequestError('引用已变化，不能使用旧确认',409));const w=panel('profile');await flushPromises();await w.get('[data-test=preview-creator-deletion]').trigger('click');await flushPromises();await w.get('[data-test=confirm-creator-deletion]').trigger('click');await flushPromises();expect(w.get('[role=alert]').text()).toContain('重新检查删除条件');expect(w.find('[data-test=confirm-creator-deletion]').exists()).toBe(false);expect(api.deleteUnusedManagedCreator).toHaveBeenCalledTimes(1);
    vi.mocked(api.previewManagedCreatorDeletion).mockResolvedValue({...preview,confirmationToken:'preview-v2'});await w.get('[data-test=preview-creator-deletion]').trigger('click');await flushPromises();expect(api.deleteUnusedManagedCreator).toHaveBeenCalledTimes(1);await w.get('[data-test=confirm-creator-deletion]').trigger('click');await flushPromises();expect(api.deleteUnusedManagedCreator).toHaveBeenLastCalledWith(1,'preview-v2');
  });
  it('invalidates an existing delete preview when the user starts changing profile data',async()=>{
    chooseIdentity(unusedCreator);const w=panel('profile');await flushPromises();await w.get('[data-test=preview-creator-deletion]').trigger('click');await flushPromises();await w.get('.profile-form input').setValue('Other');expect(w.find('[data-test=confirm-creator-deletion]').exists()).toBe(false);expect(w.get('[data-test=preview-creator-deletion]').attributes('disabled')).toBeDefined();expect(api.deleteUnusedManagedCreator).not.toHaveBeenCalled();
  });
  it('invalidates delete confirmation for an unsaved source draft and refuses to leave during source submission',async()=>{
    chooseIdentity(unusedCreator);const w=panel('sources');await flushPromises();const source=w.getComponent({name:'SourceEvidencePanel'});await w.setProps({tab:'profile'});await flushPromises();await w.get('[data-test=preview-creator-deletion]').trigger('click');await flushPromises();source.vm.hasUnsavedChanges=true;await flushPromises();expect(w.vm.dirtyTabs).toEqual(['sources']);expect(w.find('[data-test=confirm-creator-deletion]').exists()).toBe(false);expect(w.get('[data-test=preview-creator-deletion]').attributes('disabled')).toBeDefined();source.vm.isBusy=true;expect(await w.vm.requestLeave()).toBe(false);expect(api.deleteUnusedManagedCreator).not.toHaveBeenCalled();
  });
  it('does not keep failed or late deletion previews after closing',async()=>{
    chooseIdentity(unusedCreator);vi.mocked(api.previewManagedCreatorDeletion).mockRejectedValueOnce(new Error('检查暂不可用'));const w=panel('profile');await flushPromises();await w.get('[data-test=preview-creator-deletion]').trigger('click');await flushPromises();expect(w.get('[role=alert]').text()).toContain('检查暂不可用');expect(w.find('[data-test=confirm-creator-deletion]').exists()).toBe(false);
    const pending=deferred<api.ManagedCreatorDeletionPreview>();vi.mocked(api.previewManagedCreatorDeletion).mockReturnValue(pending.promise);await w.get('[data-test=preview-creator-deletion]').trigger('click');w.unmount();pending.resolve(preview);await flushPromises();expect(w.emitted('deleted')).toBeUndefined();expect(api.deleteUnusedManagedCreator).not.toHaveBeenCalled();
  });
  it('honors read-only capability and discards privileged responses on permission loss',async()=>{
    useAuthStore(pinia).capabilities.canManageLibrary=false;const w=panel('profile');await flushPromises();expect(button(w,'保存资料').attributes('disabled')).toBeDefined();await w.get('.profile-form').trigger('submit');expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();useAuthStore(pinia).capabilities.canAccessSettings=false;await flushPromises();expect(w.emitted('close')).toHaveLength(1);expect(w.find('.profile-form').exists()).toBe(false);
  });
  it('allows leaving after permission loss during an in-flight save and ignores its late result',async()=>{
    const w=panel('profile');await flushPromises();await w.get('.profile-form input').setValue('Private draft');const pending=deferred<api.ManagedCreatorSavedState>();vi.mocked(api.saveManagedCreatorProfile).mockReturnValue(pending.promise);await w.get('.profile-form').trigger('submit');expect(await w.vm.requestLeave()).toBe(false);
    useAuthStore(pinia).capabilities.canAccessSettings=false;await flushPromises();expect(w.emitted('close')).toHaveLength(1);expect(await w.vm.requestLeave()).toBe(true);expect(w.find('.profile-form').exists()).toBe(false);
    pending.resolve(savedState({...creator,name:'Late private result'}));await flushPromises();expect(w.text()).not.toContain('Late private result');expect(w.emitted('changed')).toBeUndefined();expect(useCreatorReadingStore(pinia).generation).toBe(0);
  });
});
