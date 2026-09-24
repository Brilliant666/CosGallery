import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { setActivePinia } from 'pinia';
import ArchiveCatalogView from './ArchiveCatalogView.vue';
import { fetchArchiveCatalog, fetchArchiveCatalogCreator } from '../api/gallery';
import { fetchAdmissionBatches } from '../api/local-admission';
import * as api from '../api/managed-creators';
import { useAuthStore } from '../stores/auth';
import { pinia } from '../stores/pinia';
import { creator,payload,editingState } from '../components/creator-panel-test-fixtures';
vi.mock('../api/gallery',()=>({fetchArchiveCatalog:vi.fn(),fetchArchiveCatalogCreator:vi.fn(),planArchiveDownloadTasks:vi.fn(),fetchLocalIngestSettings:vi.fn()}));
vi.mock('../api/local-admission',()=>({fetchAdmissionBatches:vi.fn()}));
vi.mock('../api/managed-creators',()=>({fetchManagedCreatorEditingState:vi.fn(),saveManagedCreatorProfile:vi.fn(),saveManagedCreatorDirectories:vi.fn()}));
const button=(w:ReturnType<typeof mount>,text:string)=>w.findAll('button').find(item=>item.text()===text)!;
async function setup(query='manageCreator=1&manageTab=profile&rosterPage=2&rosterPreference=liked') {
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/archive-catalog',component:ArchiveCatalogView},{path:'/creator-admission/local/:id',component:{template:'<p>Local admission destination</p>'}}]});
  await router.push('/archive-catalog?'+query);await router.isReady();
  const w=mount(RouterView,{global:{plugins:[router,pinia],stubs:{ResourceCatalog:{template:'<div data-test="resource-catalog" />'},FirstCollectionSelector:true,SourceEvidencePanel:true}}});await flushPromises();return{w,router};
}
describe('management panel real router context and draft guards',()=>{
  enableAutoUnmount(afterEach);
  beforeEach(()=>{
    vi.resetAllMocks();setActivePinia(pinia);useAuthStore(pinia).$reset();useAuthStore(pinia).ready=true;sessionStorage.clear();
    HTMLDialogElement.prototype.show=function(){this.open=true;};HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
    vi.mocked(fetchArchiveCatalog).mockResolvedValue({...payload,items:[creator,{...creator,id:2,name:'Beta'}]});vi.mocked(fetchArchiveCatalogCreator).mockImplementation(async id=>({...creator,id,name:id===1?'Alpha':'Beta'}));vi.mocked(api.fetchManagedCreatorEditingState).mockImplementation(async id=>editingState({...creator,id,name:id===1?'Alpha':'Beta'}));vi.mocked(fetchAdmissionBatches).mockResolvedValue({items:[],total:0,page:1,pageSize:20,hasMore:false});
  });
  it('restores selected creator/tab and preserves roster filter/page when a clean panel closes',async()=>{
    const {w,router}=await setup();expect(w.get('.creator-panel h2').text()).toBe('Alpha');expect(w.get('#creator-tab-profile').attributes('aria-selected')).toBe('true');expect(fetchArchiveCatalog).toHaveBeenCalledWith(expect.objectContaining({page:2,preference:'liked'}));await button(w,'关闭').trigger('click');await flushPromises();
    expect(w.find('.creator-panel').exists()).toBe(false);expect(router.currentRoute.value.query).toMatchObject({rosterPage:'2',rosterPreference:'liked'});expect(router.currentRoute.value.query.manageCreator).toBeUndefined();expect(router.currentRoute.value.query.manageTab).toBeUndefined();
    router.back();await flushPromises();expect(w.get('.creator-panel h2').text()).toBe('Alpha');expect(w.get('#creator-tab-profile').attributes('aria-selected')).toBe('true');
  });
  it('cancels changing workspace without hiding the dirty panel, then discards only by explicit choice',async()=>{
    const {w,router}=await setup();await w.get('.profile-form input').setValue('Uncommitted name');await w.get('[data-test=workspace-resources]').trigger('click');await flushPromises();expect(w.get('.leave-dialog').element.open).toBe(true);expect(w.find('[data-test=resource-catalog]').exists()).toBe(false);await button(w,'取消跳转').trigger('click');await flushPromises();expect(w.get('.creator-panel').isVisible()).toBe(true);expect(w.get('.profile-form input').element.value).toBe('Uncommitted name');expect(router.currentRoute.value.query.workspace).toBeUndefined();
    await w.get('[data-test=workspace-resources]').trigger('click');await flushPromises();await button(w,'放弃更改并继续').trigger('click');await flushPromises();expect(router.currentRoute.value.query.workspace).toBe('resources');expect(w.find('.creator-panel').exists()).toBe(false);expect(w.get('[data-test=resource-catalog]').isVisible()).toBe(true);expect(api.saveManagedCreatorProfile).not.toHaveBeenCalled();
  });
  it('leaves the list interactive but guards switching identity while retaining unsaved draft on cancel',async()=>{
    const {w,router}=await setup();await w.get('.profile-form input').setValue('A draft');await w.get('button[aria-label="管理 Beta"]').trigger('click');await flushPromises();await button(w,'取消跳转').trigger('click');await flushPromises();expect(router.currentRoute.value.query.manageCreator).toBe('1');expect(w.get('.profile-form input').element.value).toBe('A draft');
    await w.get('button[aria-label="管理 Beta"]').trigger('click');await flushPromises();await button(w,'放弃更改并继续').trigger('click');await flushPromises();expect(router.currentRoute.value.query.manageCreator).toBe('2');expect(w.get('.creator-panel h2').text()).toBe('Beta');expect(w.get('#creator-tab-overview').attributes('aria-selected')).toBe('true');
  });
  it('routes internal local-admission links through the dirty guard, but does not capture modifier/new-tab clicks',async()=>{
    const {w,router}=await setup();await w.get('.profile-form input').setValue('Draft');await w.get('#creator-tab-directories').trigger('click');await flushPromises();expect(router.currentRoute.value.query.manageTab).toBe('directories');const link=w.get('a[href="/creator-admission/local/1"]');
    await link.trigger('click',{ctrlKey:true});await flushPromises();expect(w.get('.leave-dialog').element.open).toBe(false);expect(router.currentRoute.value.path).toBe('/archive-catalog');
    await link.trigger('click');await flushPromises();await button(w,'取消跳转').trigger('click');await flushPromises();expect(router.currentRoute.value.path).toBe('/archive-catalog');expect(w.get('.creator-panel').exists()).toBe(true);
    await link.trigger('click');await flushPromises();await button(w,'放弃更改并继续').trigger('click');await flushPromises();expect(router.currentRoute.value.path).toBe('/creator-admission/local/1');expect(w.text()).toContain('Local admission destination');expect(api.saveManagedCreatorDirectories).not.toHaveBeenCalled();
  });
});
