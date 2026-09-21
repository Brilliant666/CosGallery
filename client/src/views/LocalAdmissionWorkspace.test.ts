import { enableAutoUnmount,flushPromises,mount } from '@vue/test-utils';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createMemoryHistory,createRouter } from 'vue-router';
import LocalAdmissionWorkspace from './LocalAdmissionWorkspace.vue';
import * as api from '../api/local-admission';
import { RequestError } from '../api/http';
import type { AdmissionBatch,AdmissionCollection,AdmissionItem,AdmissionWorkspace } from '../types/local-admission';
vi.mock('../api/local-admission');
vi.mock('../api/source-evidence',()=>({fetchSourceEvidence:vi.fn()}));
const workspace:AdmissionWorkspace={waitingRoot:'R:/待入库',galleryRoot:'R:/图库',archiveInboxRoot:'R:/压缩包',items:[
  {name:'甲别名',selectable:true,matches:[{creatorId:17,creatorName:'博主甲',matchedName:'甲别名',matchKind:'alias'}]},
  {name:'博主乙',selectable:true,matches:[{creatorId:88,creatorName:'博主乙',matchedName:'博主乙',matchKind:'canonical'}]},
  {name:'未明确身份',selectable:true,matches:[]}
]};
const batch=(id='a',creatorId=17):AdmissionBatch&{parent:string}=>({id,planId:id,collectionId:'collection-one',creatorId,creatorName:creatorId===17?'博主甲':'博主乙',parent:creatorId===17?'甲别名':'博主乙',inputRoot:'R:/待入库',state:'draft',createdAt:'2026-09-21T01:00:00Z',updatedAt:'2026-09-21T01:00:00Z',totals:{total:2,selected:0,completed:0,skipped:0,deferred:2}});
const collection=(state:AdmissionCollection['state']='draft'):AdmissionCollection=>({id:'collection-one',state,createdAt:'2026-09-21T01:00:00Z',updatedAt:'2026-09-21T01:00:00Z',error:null,totals:{creators:2,total:4,selected:0,completed:0,skipped:0,deferred:4,failedCreators:0},batches:[batch(),batch('b',88)]});
const item=(key:string,group:AdmissionItem['group']='A'):AdmissionItem=>({key,displayTitle:key,sourceRelativePath:key,targetPath:`R:/图库/${key}`,group,state:'planned',summary:{images:2,videos:0,other:1,bytes:3000},candidates:[],conflicts:[],ads:[{relativePath:'附件/推广.txt',size:20},{relativePath:'492.jpg',size:20,automatic:true}]});
const button=(wrapper:ReturnType<typeof mount>,text:string)=>wrapper.findAll('button').find(button=>button.text()===text)!;
async function render(query=''){const router=createRouter({history:createMemoryHistory(),routes:[{path:'/local-admission',name:'local-admission-workspace',component:LocalAdmissionWorkspace},{path:'/archive-catalog',component:{template:'<p>账本</p>'}},{path:'/library/:creatorId/works/:postId',name:'canonical-work-gallery',component:{template:'<p>图集</p>'}},{path:'/local-review',name:'local-review',component:{template:'<p>审核</p>'}}]});await router.push(`/local-admission${query}`);const wrapper=mount(LocalAdmissionWorkspace,{global:{plugins:[router]}});await flushPromises();return {wrapper,router};}
describe('independent multi-creator admission workspace',()=>{
  enableAutoUnmount(afterEach);
  beforeEach(()=>{vi.resetAllMocks();vi.useRealTimers();localStorage.clear();sessionStorage.clear();vi.mocked(api.fetchAdmissionWorkspace).mockResolvedValue(workspace);vi.mocked(api.fetchAdmissionCollections).mockResolvedValue({items:[],page:1,pageSize:20,total:0});vi.mocked(api.fetchAdmissionDirectories).mockImplementation(async(creatorId,parent)=>({creator:{id:creatorId,name:creatorId===17?'博主甲':'博主乙'},root:'R:/待入库',parent:parent??null,items:[{name:'第一套',selectable:true,matchedCreatorIds:[],matchesSelectedCreator:false},{name:'第二套',selectable:true,matchedCreatorIds:[],matchesSelectedCreator:false}]}));vi.mocked(api.previewAdmissionCollection).mockResolvedValue(collection());vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(collection());vi.mocked(api.fetchAdmissionItems).mockImplementation(async(id)=>({items:id==='a'?[item('a-first'),item('a-candidate','B')]:[item('b-first'),{...item('b-complex','D'),structureWarnings:['多个含媒体子目录'],needsBoundaryReview:true}],total:2,page:1,pageSize:100}));vi.mocked(api.executeAdmissionCollection).mockResolvedValue(collection('queued'));vi.mocked(api.resumeAdmissionCollection).mockResolvedValue(collection('running'));vi.mocked(api.searchAdmissionCreators).mockResolvedValue({items:[{id:92,name:'博主丙',aliases:['未明确身份']}],page:1,pageSize:20,total:1});});
  afterEach(()=>vi.useRealTimers());
  it('returns to scope editing with original selections and only includes explicitly selected new directories',async()=>{
    vi.mocked(api.fetchAdmissionCollectionScope).mockResolvedValue({scopes:[{creatorId:17,parent:'甲别名',directories:['第一套'],acceptExistingVersion:true}]});
    const {wrapper}=await render('?collection=collection-one');
    await wrapper.get('[data-test=collection-edit-scope]').trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('调整本批导入范围');
    const directories=wrapper.findAll('[data-folder="甲别名"] .directory-grid input');
    expect(directories.map(input=>(input.element as HTMLInputElement).checked)).toEqual([true,false]);
    expect(api.previewAdmissionCollection).not.toHaveBeenCalled();
    await directories[1].setValue(true);
    vi.mocked(api.repreviewAdmissionCollection).mockResolvedValue({...collection(),id:'replacement'});
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),id:'replacement'});
    await wrapper.get('[data-test=collection-preview]').trigger('click');await flushPromises();
    expect(api.repreviewAdmissionCollection).toHaveBeenCalledWith('collection-one',[{creatorId:17,parent:'甲别名',directories:['第一套','第二套'],acceptExistingVersion:true}]);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.previewAdmissionCollection).not.toHaveBeenCalled();
  });
  it('lets users deselect a renamed/missing directory instead of silently dropping or selecting replacements',async()=>{
    vi.mocked(api.fetchAdmissionCollectionScope).mockResolvedValue({scopes:[{creatorId:17,parent:'甲别名',directories:['原目录'],acceptExistingVersion:true}]});
    const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=collection-edit-scope]').trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('原目录已不存在');expect(wrapper.get('[data-test=collection-preview]').attributes('disabled')).toBeDefined();
    const directories=wrapper.findAll('[data-folder="甲别名"] .directory-grid input');
    expect(directories.map(input=>(input.element as HTMLInputElement).checked)).toEqual([false,false,true]);
    expect(directories[2].attributes('disabled')).toBeUndefined();await directories[2].setValue(false);await directories[0].setValue(true);
    expect(wrapper.get('[data-test=collection-preview]').attributes('disabled')).toBeUndefined();
    await button(wrapper,'取消调整，返回核对').trigger('click');expect(wrapper.text()).toContain('核对作品身份与文件范围');expect(api.repreviewAdmissionCollection).not.toHaveBeenCalled();
  });
  it('rechecks files into a new draft, retaining unchanged choices and deferring changed evidence until explicit selection',async()=>{
    let fresh=false;
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id,batches:[{...batch(fresh?'a2':'a'),totals:{total:2,selected:0,completed:0,skipped:0,deferred:2}}]}));
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async()=>({items:['one','two'].map(name=>({...item(fresh?`new-${name}`:name),sourceRelativePath:name,reviewFingerprint:fresh&&name==='two'?'changed':'same'})),total:2,page:1,pageSize:100}));
    vi.mocked(api.repreviewAdmissionCollection).mockImplementation(async()=>{fresh=true;return {...collection(),id:'fresh'};});
    const {wrapper,router}=await render('?collection=collection-one');await wrapper.get('[data-test=admission-item-one] select').setValue('skip');
    await wrapper.get('[data-test=collection-repreview]').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query.collection).toBe('fresh');expect(api.repreviewAdmissionCollection).toHaveBeenCalledWith('collection-one');
    expect(wrapper.get('[data-test=admission-item-new-one] select').element.value).toBe('skip');
    expect(wrapper.get('[data-test=admission-item-new-two] select').element.value).toBe('defer');
    await button(wrapper,'补选可直接入库的作品').trigger('click');expect(wrapper.get('[data-test=admission-item-new-two] select').element.value).toBe('new');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('keeps the original draft and choices when a concurrent confirmation rejects repreview',async()=>{
    vi.mocked(api.repreviewAdmissionCollection).mockRejectedValue(new RequestError('原批已确认',409));
    const {wrapper,router}=await render('?collection=collection-one');await wrapper.get('[data-test=admission-item-a-first] select').setValue('skip');
    await wrapper.get('[data-test=collection-repreview]').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query.collection).toBe('collection-one');expect(wrapper.text()).toContain('原批已确认');expect(wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('skip');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('preselects safe items once, preserves manual defer on refresh/return, and only reselects on explicit request',async()=>{
    const {wrapper}=await render('?collection=collection-one');
    expect(wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('new');
    expect(wrapper.get('[data-test=admission-item-a-candidate] select').element.value).toBe('defer');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
    await wrapper.get('[data-test=admission-item-a-first] select').setValue('defer');
    await button(wrapper,'读取已保存状态').trigger('click');await flushPromises();
    expect(wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('defer');
    expect(api.previewAdmissionCollection).not.toHaveBeenCalled();
    wrapper.unmount();const returned=await render();
    expect(returned.router.currentRoute.value.query.collection).toBe('collection-one');
    expect(returned.wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('defer');
    await button(returned.wrapper,'补选可直接入库的作品').trigger('click');
    expect(returned.wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('new');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('returns from an album to the same result via the bare workspace entry without replaying',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(collection('completed'));
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item('done'),postId:123,state:'completed'}],total:1,page:1,pageSize:100});
    const {wrapper,router}=await render('?collection=collection-one');
    await wrapper.findAll('a').find(link=>link.text()==='查看图集')!.trigger('click');await flushPromises();
    expect(router.currentRoute.value.name).toBe('canonical-work-gallery');wrapper.unmount();
    const returned=await render();expect(returned.router.currentRoute.value.query.collection).toBe('collection-one');
    expect(returned.wrapper.text()).toContain('本批处理完成');expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
    const reads=vi.mocked(api.fetchAdmissionWorkspace).mock.calls.length;
    await button(returned.wrapper,'新建批次').trigger('click');await flushPromises();
    expect(api.fetchAdmissionWorkspace).toHaveBeenCalledTimes(reads+1);
    expect(returned.router.currentRoute.value.query.collection).toBeUndefined();expect(returned.wrapper.text()).toContain('选择这次要收录的范围');
    returned.wrapper.unmount();const fresh=await render();expect(fresh.router.currentRoute.value.query.collection).toBeUndefined();
  });
  it('discards an unavailable remembered batch without falling back to cached results or looping',async()=>{
    sessionStorage.setItem('cosgallery:admission:last-collection','missing');
    vi.mocked(api.fetchAdmissionCollection).mockRejectedValue(new RequestError('批次不存在',404));
    const {wrapper}=await render();expect(wrapper.text()).toContain('批次不存在');expect(wrapper.text()).toContain('选择这次要收录的范围');
    expect(api.fetchAdmissionCollection).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem('cosgallery:admission:last-collection')).toBeNull();
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('preserves manual choices across two drafts and leaving during a refresh',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id}));
    const {wrapper,router}=await render('?collection=first');
    await wrapper.get('[data-test=admission-item-a-first] select').setValue('skip');
    await router.push('/local-admission?collection=second');await flushPromises();
    await router.push('/local-admission?collection=first');await flushPromises();
    expect(wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('skip');
    await wrapper.get('[data-test=admission-item-a-first] select').setValue('defer');
    let release!:(value:Awaited<ReturnType<typeof api.fetchAdmissionItems>>)=>void;
    vi.mocked(api.fetchAdmissionItems).mockReturnValueOnce(new Promise(done=>release=done));
    await button(wrapper,'读取已保存状态').trigger('click');await flushPromises();wrapper.unmount();
    const returned=await render('?collection=first');expect(returned.wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('defer');
    release({items:[item('late')],total:1,page:1,pageSize:100});await flushPromises();
    expect(returned.wrapper.find('[data-test=admission-item-late]').exists()).toBe(false);
  });
  it('shows the actual pending Work id rather than an older cached draft Work on retry',async()=>{
    const work={workId:91,title:'旧展示作品',catalogNo:1,images:2,videos:0,thumbnailUrl:null,primaryLocalWorkId:19,localState:'available',originalDirectories:['原目录'],sources:[]};
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item('a-first','B'),candidates:[work]}],total:1,page:1,pageSize:100});
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),batches:[batch()]});
    const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=admission-item-a-first] select').setValue('existing');await button(wrapper,'候选：旧展示作品 · 2 图 / 0 视频').trigger('click');wrapper.unmount();
    const original={requestKey:'old-receipt',confirmed:true,batches:[{batchId:'a',acceptExistingVersion:false,actions:[{key:'a-first',action:'existing',workId:92,approvedAds:[],acceptSourceIds:[]}]}]};
    localStorage.setItem('cosgallery:admission:collection:collection-one',JSON.stringify(original));
    const returned=await render('?collection=collection-one');expect(returned.wrapper.text()).toContain('对应作品 #92');expect(returned.wrapper.text()).not.toContain('对应：旧展示作品');
    await returned.wrapper.get('[data-test=collection-confirm]').trigger('click');expect(returned.wrapper.get('[role=dialog]').text()).toContain('作品 #92');expect(returned.wrapper.get('[role=dialog]').text()).not.toContain('旧展示作品');
    await returned.wrapper.get('[role=dialog] input').setValue(true);await returned.wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();expect(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1]).toEqual(original);
  });
  it('also saves edits made while refresh status is in flight before loading the item pages',async()=>{
    const {wrapper}=await render('?collection=collection-one');
    let status!:(value:AdmissionCollection)=>void,items!:(value:Awaited<ReturnType<typeof api.fetchAdmissionItems>>)=>void;
    vi.mocked(api.fetchAdmissionCollection).mockReturnValueOnce(new Promise(done=>status=done));
    vi.mocked(api.fetchAdmissionItems).mockReturnValueOnce(new Promise(done=>items=done));
    await button(wrapper,'读取已保存状态').trigger('click');
    await wrapper.get('[data-test=admission-item-a-first] select').setValue('defer');
    status(collection());await flushPromises();wrapper.unmount();
    const returned=await render('?collection=collection-one');expect(returned.wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('defer');
    items({items:[],total:0,page:1,pageSize:100});await flushPromises();
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('does not default-select suspicious A metadata or overwrite original pending actions',async()=>{
    const records=[{...item('boundary'),needsBoundaryReview:true},{...item('conflict'),conflicts:['目标存在']},{...item('suggested'),suggestedAction:{key:'suggested',action:'defer' as const,approvedAds:[],acceptSourceIds:[]}},item('safe')];
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),batches:[batch()]});vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:records,total:4,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one');
    expect(['boundary','conflict','suggested','safe'].map(key=>wrapper.get(`[data-test=admission-item-${key}] select`).element.value)).toEqual(['defer','defer','defer','new']);
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  });
  it('fills only undecided safe A items without overwriting manual identities, skips, titles, primary choices or ads',async()=>{
    const work={workId:91,title:'已选作品',catalogNo:1,images:2,videos:0,thumbnailUrl:null,primaryLocalWorkId:19,localState:'available',originalDirectories:['原目录'],sources:[]};
    const records=[{...item('existing'),candidates:[work]},item('skip'),{...item('edited'),suggestedAction:{key:'edited',action:'new' as const,displayTitle:'上次名称',primary:true,approvedAds:['492.jpg']}},item('copy'),item('undecided'),item('candidate','B'),item('complex','D')];
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),batches:[batch()]});vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:records,total:records.length,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=admission-item-existing] select').setValue('existing');await button(wrapper,'候选：已选作品 · 2 图 / 0 视频').trigger('click');await wrapper.get('[data-test=admission-item-skip] select').setValue('skip');
    const edited=wrapper.get('[data-test=admission-item-edited]');await edited.get('input:not([type=checkbox])').setValue('用户修改的标题');await edited.get('.item-ads input[value="492.jpg"]').setValue(false);await edited.get('.item-ads input[value="附件/推广.txt"]').setValue(true);
    await wrapper.get('[data-test=admission-item-copy] select').setValue('same-as');await wrapper.get('[data-test=admission-item-copy]').findAll('select')[1]!.setValue('edited');
    await wrapper.get('[data-test=collection-select-safe]').trigger('click');await wrapper.get('[data-test=collection-select-safe]').trigger('click');
    expect(wrapper.get('[data-test=admission-item-candidate] select').element.value).toBe('defer');expect(wrapper.get('[data-test=admission-item-complex] select').element.value).toBe('defer');
    await wrapper.get('[data-test=collection-confirm]').trigger('click');for(const input of wrapper.get('[role=dialog]').findAll('input'))await input.setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    const actions=vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1].batches[0]!.actions;
    expect(actions[0]).toMatchObject({action:'existing',workId:91});expect(actions[1]).toMatchObject({action:'skip',approvedAds:[]});expect(actions[2]).toMatchObject({action:'new',displayTitle:'用户修改的标题',primary:true,approvedAds:['附件/推广.txt']});expect(actions[3]).toMatchObject({action:'same-as',sameAsKey:'edited'});expect(actions[4]).toMatchObject({action:'new'});expect(actions.slice(5).map(action=>action.action)).toEqual(['defer','defer']);
  });
  it('releases a conclusively rejected oversized collection payload instead of locking it as an uncertain receipt',async()=>{
    vi.mocked(api.executeAdmissionCollection).mockRejectedValueOnce(new RequestError('Request failed with status 413',413));
    const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=collection-select-safe]').trigger('click');await wrapper.get('[data-test=ads-clear-all]').trigger('click');await wrapper.get('[data-test=collection-confirm]').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('本批确认内容超过上限，请分小批');expect(wrapper.text()).not.toContain('执行回执尚未确认');expect(localStorage.getItem('cosgallery:admission:collection:collection-one')).toBeNull();expect(wrapper.get('[data-test=collection-select-safe]').attributes('disabled')).toBeUndefined();expect(api.executeAdmissionCollection).toHaveBeenCalledTimes(1);
  });
  it('previews two creator scopes once without individual execute calls or automatically creating identities',async()=>{
    const {wrapper}=await render();expect(wrapper.get('[data-folder="未明确身份"] input[type=checkbox]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-folder="甲别名"] input[type=checkbox]').setValue(true);await wrapper.get('[data-folder="博主乙"] input[type=checkbox]').setValue(true);await flushPromises();
    expect(wrapper.get('[data-test=collection-preview]').attributes('disabled')).toBeUndefined();expect(wrapper.find('.stage-actions input[type=checkbox]').exists()).toBe(false);await wrapper.get('[data-test=collection-preview]').trigger('click');await flushPromises();
    expect(api.previewAdmissionCollection).toHaveBeenCalledExactlyOnceWith([{creatorId:17,parent:'甲别名',directories:['第一套','第二套'],acceptExistingVersion:true},{creatorId:88,parent:'博主乙',directories:['第一套','第二套'],acceptExistingVersion:true}]);expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmission).not.toHaveBeenCalled();expect(wrapper.text()).toContain('预览草稿 · 未执行');
  });
  it('confirms all creators centrally, leaves candidates and complex boundaries deferred, and asks separately for ads',async()=>{
    const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=collection-select-safe]').trigger('click');
    expect(wrapper.find('[data-test=admission-accept-version]').exists()).toBe(false);expect(wrapper.text()).toContain('已入库的同一作品不重复获取');
    expect(wrapper.get('[data-test=admission-item-a-first] select').element.value).toBe('new');expect(wrapper.get('[data-test=admission-item-a-candidate] select').element.value).toBe('defer');
    await wrapper.get('[data-ad-filename="推广.txt"]').findAll('button')[0]!.trigger('click');await wrapper.get('[data-test=collection-confirm]').trigger('click');
    const dialog=wrapper.get('[role=dialog]');expect(dialog.text()).toContain('博主甲');expect(dialog.text()).toContain('博主乙');expect(dialog.text()).toContain('b-complex');await dialog.findAll('input')[0]!.setValue(true);expect(dialog.get('[data-test=collection-execute]').attributes('disabled')).toBeDefined();await dialog.findAll('input')[1]!.setValue(true);await dialog.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    expect(api.executeAdmissionCollection).toHaveBeenCalledTimes(1);const input=vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1];expect(input.batches.map(batch=>batch.batchId)).toEqual(['a','b']);expect(input.batches.map(batch=>batch.actions.map(action=>action.action))).toEqual([['new','defer'],['new','defer']]);expect(input.batches.every(batch=>batch.adsConfirmed===true)).toBe(true);expect(input.batches[1]!.actions[0]!.approvedAds).toEqual(['492.jpg','附件/推广.txt']);expect(api.executeAdmission).not.toHaveBeenCalled();
    expect(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1].batches.every(batch=>batch.acceptExistingVersion===true)).toBe(true);
  });
  it('limits same-work choices to the active creator and displays boundary notes instead of silently splitting',async()=>{
    const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=collection-select-safe]').trigger('click');await wrapper.get('[data-test=admission-item-a-candidate] select').setValue('same-as');
    const peerSelect=wrapper.get('[data-test=admission-item-a-candidate]').findAll('select')[1]!;expect(peerSelect.text()).toContain('a-first');expect(peerSelect.text()).not.toContain('b-first');await wrapper.findAll('[role=tab]')[1]!.trigger('click');expect(wrapper.text()).toContain('目录边界提示');expect(wrapper.text()).toContain('多个含媒体子目录');expect(wrapper.get('[data-test=admission-item-b-complex] select').element.value).toBe('defer');expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('keeps cross-page advertisement choices scoped to all selected creators, preserving skipped and deferred files',async()=>{
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async(id)=>({items:id==='a'?Array.from({length:21},(_,index)=>item(`a-${index}`)):[item('b-first'),item('b-skip')],total:id==='a'?21:2,page:1,pageSize:100}));
    const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=collection-select-safe]').trigger('click');await wrapper.findAll('[role=tab]')[1]!.trigger('click');await wrapper.get('[data-test=admission-item-b-skip] select').setValue('skip');await wrapper.get('[data-ad-filename="推广.txt"]').findAll('button')[0]!.trigger('click');
    expect(wrapper.get('[data-ad-filename="推广.txt"]').text()).toContain('22 个接纳目录 / 22 个文件 · 已选 22');await wrapper.findAll('[role=tab]')[0]!.trigger('click');expect(wrapper.findAll('.item-card')).toHaveLength(20);await button(wrapper,'下一页目录').trigger('click');expect(wrapper.get('[data-test=admission-item-a-20] .item-ads').findAll('input').map(input=>(input.element as HTMLInputElement).checked)).toEqual([true,true]);
  });
  it('restores the exact whole-collection receipt after lost response and a fresh page without replaying child batches',async()=>{
    vi.mocked(api.executeAdmissionCollection).mockRejectedValueOnce(new Error('receipt lost'));const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=collection-select-safe]').trigger('click');await wrapper.get('[data-test=ads-clear-all]').trigger('click');await wrapper.get('[data-test=collection-confirm]').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    const original=JSON.parse(JSON.stringify(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1]));wrapper.unmount();const returned=await render('?collection=collection-one');expect(returned.wrapper.text()).toContain('回执尚未确认');expect(returned.wrapper.get('[data-test=collection-select-safe]').attributes('disabled')).toBeDefined();await returned.wrapper.get('[data-test=collection-confirm]').trigger('click');await returned.wrapper.get('[role=dialog] input').setValue(true);await returned.wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();expect(vi.mocked(api.executeAdmissionCollection).mock.calls[1]![1]).toEqual(original);expect(api.executeAdmission).not.toHaveBeenCalled();
  });
  it('polls only lightweight collection state, stops after completion, and never automatically resumes',async()=>{
    vi.useFakeTimers();vi.mocked(api.fetchAdmissionCollection).mockResolvedValueOnce(collection('running')).mockResolvedValue(collection('completed'));const {wrapper}=await render('?collection=collection-one');await vi.advanceTimersByTimeAsync(2500);await flushPromises();expect(wrapper.text()).toContain('本批处理完成');const calls=vi.mocked(api.fetchAdmissionCollection).mock.calls.length;await vi.advanceTimersByTimeAsync(15000);expect(api.fetchAdmissionCollection).toHaveBeenCalledTimes(calls);expect(api.executeAdmission).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('retries mixed historical creator policies unchanged, then uses the default only for a new confirmation',async()=>{
    const original={requestKey:'mixed-original',confirmed:true,batches:[{batchId:'a',acceptExistingVersion:false,actions:[{key:'a-first',action:'new',approvedAds:[]},{key:'a-candidate',action:'defer'}]},{batchId:'b',acceptExistingVersion:true,actions:[{key:'b-first',action:'new',approvedAds:[]},{key:'b-complex',action:'defer'}]}]};
    localStorage.setItem('cosgallery:admission:collection:collection-one',JSON.stringify(original));
    const {wrapper,router}=await render('?collection=collection-one');expect(wrapper.text()).toContain('本次重试保留原请求的策略和选择');expect(wrapper.find('[data-test=admission-accept-version]').exists()).toBe(false);
    await wrapper.get('[data-test=collection-confirm]').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    expect(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1]).toEqual(original);
    await router.push('/local-admission?collection=new-draft');await flushPromises();
    await wrapper.get('[data-test=collection-select-safe]').trigger('click');await wrapper.get('[data-test=ads-clear-all]').trigger('click');await wrapper.get('[data-test=collection-confirm]').trigger('click');expect(wrapper.get('[role=dialog]').text()).toContain('已入库的同一作品不重复获取');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    expect(vi.mocked(api.executeAdmissionCollection).mock.calls[1]![1].batches.every(entry=>entry.acceptExistingVersion)).toBe(true);
  });
  it('requires explicit canonical selection when the waiting-directory name is unresolved',async()=>{
    const {wrapper}=await render();const folder=wrapper.get('[data-folder="未明确身份"]');await folder.get('input[aria-label="搜索规范博主"]').setValue('未明确');await folder.get('form').trigger('submit');await flushPromises();await folder.get('.creator-picker .choices button').trigger('click');expect(folder.text()).toContain('博主丙');await folder.get('input[type=checkbox]').setValue(true);await flushPromises();expect(api.fetchAdmissionDirectories).toHaveBeenLastCalledWith(92,'未明确身份');expect(api.previewAdmissionCollection).not.toHaveBeenCalled();
  });
  it('explains changed unstarted files versus moved checkpoints without replaying or modifying the confirmed plan',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection('partial'),error:'源文件已变化'});const {wrapper}=await render('?collection=collection-one');
    expect(wrapper.text()).toContain('尚未移动但源文件已变化的目录');expect(wrapper.text()).toContain('新建批次');expect(wrapper.text()).toContain('不能修改或重放原确认计划');expect(wrapper.text()).toContain('已经移动的项目按原检查点处理');
    expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();expect(api.previewAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('does not silently omit a checked creator after every work directory is deselected',async()=>{
    const {wrapper}=await render();await wrapper.get('[data-folder="甲别名"] input[type=checkbox]').setValue(true);await wrapper.get('[data-folder="博主乙"] input[type=checkbox]').setValue(true);await flushPromises();
    const folder=wrapper.get('[data-folder="博主乙"]');await folder.findAll('input[type=checkbox]')[1]!.setValue(false);
    expect(wrapper.text()).toContain('“博主乙”没有选择作品目录');expect(wrapper.get('[data-test=collection-preview]').attributes('disabled')).toBeDefined();expect(api.previewAdmissionCollection).not.toHaveBeenCalled();
  });
});
