import { enableAutoUnmount,flushPromises,mount } from '@vue/test-utils';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import LocalAdmissionWorkspace from './LocalAdmissionWorkspace.vue';
import * as api from '../api/local-admission';
import { RequestError } from '../api/http';
import { saveAdmissionDraft } from '../utils/admission-navigation';
import { admissionScopeReviewReason } from '../utils/admission-ui';
import type { AdmissionBatch,AdmissionCollection,AdmissionCurrentDisposition,AdmissionItem,AdmissionWorkspace } from '../types/local-admission';
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
const completedLater:AdmissionCurrentDisposition={status:'completed_later',batchId:'later-batch',collectionId:'later-collection',planId:'later-batch',itemKey:'later-item',workId:201,localWorkId:301,postId:401,completedAt:'2026-09-22T08:35:00Z',completionTimeBasis:'batch_completed',evidence:'exact_directory_scope'};
const button=(wrapper:ReturnType<typeof mount>,text:string)=>wrapper.findAll('button').find(button=>button.text()===text)!;
async function render(query='',showAll=true){const router=createRouter({history:createMemoryHistory(),routes:[{path:'/library/:creatorId',name:'canonical-creator',component:{template:'<p>博主图库</p>'}},{path:'/local-admission',name:'local-admission-workspace',component:LocalAdmissionWorkspace},{path:'/archive-catalog',component:{template:'<p>账本</p>'}},{path:'/library/:creatorId/works/:postId',name:'canonical-work-gallery',component:{template:'<p>图集</p>'}},{path:'/local-review',name:'local-review',component:{template:'<p>审核</p>'}}]});await router.push(`/local-admission${query}`);const wrapper=mount(LocalAdmissionWorkspace,{global:{plugins:[router]}});await flushPromises();if(showAll)await showAllReview(wrapper);return {wrapper,router};}
async function closeReviewDialog(wrapper:ReturnType<typeof mount>){const dialog=wrapper.find('[data-test=admission-history-dialog], [data-test=review-ads-dialog], [data-test=review-help-dialog], [data-test=collection-details-dialog]');if(dialog.exists())await dialog.get('.heading button').trigger('click');}
async function showAllReview(wrapper:ReturnType<typeof mount>){if(wrapper.find('[data-test=review-status-all]').exists()){await wrapper.get('[data-test=review-status-all]').trigger('click');await wrapper.get('[data-test=review-creator]').setValue('a');}}
async function editItem(wrapper:ReturnType<typeof mount>,key:string){const selector=`[data-test="admission-item-${key}"]`;if(wrapper.find(selector).exists())return wrapper.get(selector);await closeReviewDialog(wrapper);if(!wrapper.find(selector).exists()){await wrapper.get('[data-test=review-status-all]').trigger('click');await wrapper.get('[data-test=review-creator]').setValue('all');}if(!wrapper.find(selector).exists())await wrapper.get('input[aria-label="搜索本批作品或博主"]').setValue(key);return wrapper.get(selector);}
async function savedStateButton(wrapper:ReturnType<typeof mount>){await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-details-open]').trigger('click');return button(wrapper,'读取已保存状态');}
async function openAds(wrapper:ReturnType<typeof mount>){await closeReviewDialog(wrapper);await wrapper.get('[data-test=review-ads-open]').trigger('click');return wrapper.get('[data-test=review-ads-dialog]');}
async function renderKept(query=''){
  const router=createRouter({history:createMemoryHistory(),routes:[
    {path:'/creator-admission/local',name:'local-admission-workspace',component:LocalAdmissionWorkspace},
    {path:'/creator-admission/costuan',name:'costuan-admission',component:{template:'<p>Costuan当前模块</p>'}},
    {path:'/archive-catalog',component:{template:'<p>账本</p>'}}
  ]});
  await router.push(`/creator-admission/local${query}`);
  const wrapper=mount({components:{RouterView},template:'<RouterView v-slot="{Component,route}"><KeepAlive><component :is="Component" :key="route.name" /></KeepAlive></RouterView>'},{global:{plugins:[router]}});
  await flushPromises();return {wrapper,router};
}
describe('independent multi-creator admission workspace',()=>{
  enableAutoUnmount(afterEach);
  beforeEach(()=>{vi.resetAllMocks();vi.useRealTimers();localStorage.clear();sessionStorage.clear();vi.mocked(api.fetchAdmissionWorkspace).mockResolvedValue(workspace);vi.mocked(api.fetchAdmissionCollections).mockResolvedValue({items:[],page:1,pageSize:20,total:0});vi.mocked(api.fetchAdmissionDirectories).mockImplementation(async(creatorId,parent)=>({creator:{id:creatorId,name:creatorId===17?'博主甲':'博主乙'},root:'R:/待入库',parent:parent??null,items:[{name:'第一套',selectable:true,matchedCreatorIds:[],matchesSelectedCreator:false},{name:'第二套',selectable:true,matchedCreatorIds:[],matchesSelectedCreator:false}]}));vi.mocked(api.previewAdmissionCollection).mockResolvedValue(collection());vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(collection());vi.mocked(api.fetchAdmissionItems).mockImplementation(async(id)=>({items:id==='a'?[item('a-first'),item('a-candidate','B')]:[item('b-first'),{...item('b-complex','D'),structureWarnings:['多个含媒体子目录'],needsBoundaryReview:true}],total:2,page:1,pageSize:100}));vi.mocked(api.executeAdmissionCollection).mockResolvedValue(collection('queued'));vi.mocked(api.resumeAdmissionCollection).mockResolvedValue(collection('running'));vi.mocked(api.searchAdmissionCreators).mockResolvedValue({items:[{id:92,name:'博主丙',aliases:['未明确身份']}],page:1,pageSize:20,total:1});});
  afterEach(()=>vi.useRealTimers());
  it('keeps unsubmitted creator and directory choices when changing admission modules without rereading or creating a draft',async()=>{
    const {wrapper,router}=await renderKept();
    const first=wrapper.findAll('.folder')[0]!;
    await first.get('.check input').setValue(true);await flushPromises();
    await first.findAll('.directory-grid input')[0]!.setValue(false);
    const reads=vi.mocked(api.fetchAdmissionDirectories).mock.calls.length;
    await router.push('/creator-admission/costuan?workspace=source&collection=unrelated');await flushPromises();
    expect(wrapper.text()).toBe('Costuan当前模块');
    await router.push('/creator-admission/local');await flushPromises();
    expect(wrapper.findAll('.folder')[0]!.get('.check input').element.checked).toBe(true);
    expect(wrapper.findAll('.folder')[0]!.findAll('.directory-grid input').map(input=>input.element.checked)).toEqual([false,true]);
    expect(api.fetchAdmissionDirectories).toHaveBeenCalledTimes(reads);expect(api.fetchAdmissionWorkspace).toHaveBeenCalledTimes(1);
    expect(api.previewAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('preserves entry query and hash when loading a saved collection, but drops stale record identity on a different collection',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id,nextCollectionIds:id==='collection-one'?['collection-next']:[]}));
    const {wrapper,router}=await renderKept('?collection=collection-one&sourceEvidenceId=72&returnTo=%2Flibrary&session=old-session&jobId=99#review');
    expect(router.currentRoute.value.query).toEqual({collection:'collection-one',sourceEvidenceId:'72',returnTo:'/library'});
    expect(router.currentRoute.value.hash).toBe('#review');
    await button(wrapper,'查看后续预览 · collecti').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query).toEqual({collection:'collection-next',sourceEvidenceId:'72',returnTo:'/library'});
    expect(router.currentRoute.value.hash).toBe('');expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('keeps manual deferral and draft filters across Costuan and ignores its unrelated batch query',async()=>{
    const {wrapper,router}=await renderKept('?collection=collection-one');await showAllReview(wrapper);
    await (await editItem(wrapper,'a-first')).get('select').setValue('defer');
    await wrapper.get('input[aria-label="搜索本批作品或博主"]').setValue('a-first');
    const reads=vi.mocked(api.fetchAdmissionCollection).mock.calls.length;
    await router.push('/creator-admission/costuan?workspace=ingest&collection=unrelated');await flushPromises();
    expect(api.fetchAdmissionCollection).toHaveBeenCalledTimes(reads);
    await router.push('/creator-admission/local?collection=collection-one');await flushPromises();
    expect((await editItem(wrapper,'a-first')).get('select').element.value).toBe('defer');
    expect(wrapper.get('input[aria-label="搜索本批作品或博主"]').element.value).toBe('a-first');
    expect(api.fetchAdmissionCollection).toHaveBeenCalledTimes(reads);expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('stops hidden result polling and reads current progress on activation without resuming execution',async()=>{
    vi.useFakeTimers();vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(collection('running'));
    const {wrapper,router}=await renderKept('?collection=collection-one');
    await router.push('/creator-admission/costuan?workspace=staging');await flushPromises();
    const reads=vi.mocked(api.fetchAdmissionCollection).mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);expect(api.fetchAdmissionCollection).toHaveBeenCalledTimes(reads);
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(collection('completed'));
    await router.push('/creator-admission/local?collection=collection-one');await flushPromises();
    expect(api.fetchAdmissionCollection).toHaveBeenCalledTimes(reads+1);expect(wrapper.text()).toContain('本批执行已结束');
    expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('does not let a late local collection response redirect the visible Costuan module',async()=>{
    let finish!:(value:AdmissionCollection)=>void;
    vi.mocked(api.fetchAdmissionCollection).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
    const {wrapper,router}=await renderKept('?collection=collection-one');
    await router.push('/creator-admission/costuan?workspace=source');await flushPromises();
    finish(collection('running'));await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/creator-admission/costuan?workspace=source');
    expect(wrapper.text()).toBe('Costuan当前模块');expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('publishes a late preview receipt into its local tab URL only on return, without creating it again',async()=>{
    let finish!:(value:AdmissionCollection)=>void;
    vi.mocked(api.previewAdmissionCollection).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
    const entry='/creator-admission/local?sourceEvidenceId=72&returnTo=%2Flibrary#scope';
    const {wrapper,router}=await renderKept('?sourceEvidenceId=72&returnTo=%2Flibrary#scope');
    await wrapper.findAll('.folder')[0]!.get('.check input').setValue(true);await flushPromises();
    await wrapper.get('[data-test=collection-preview]').trigger('click');
    await router.push('/creator-admission/costuan?workspace=source');await flushPromises();
    finish(collection());await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/creator-admission/costuan?workspace=source');
    await router.push(entry);await flushPromises();
    expect(router.currentRoute.value.query.collection).toBe('collection-one');
    expect(router.currentRoute.value.query.sourceEvidenceId).toBe('72');expect(router.currentRoute.value.query.returnTo).toBe('/library');expect(router.currentRoute.value.hash).toBe('#scope');
    expect(wrapper.text()).toContain('预览草稿');expect(api.previewAdmissionCollection).toHaveBeenCalledTimes(1);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it.each(['fresh','previous automatic'] as const)('keeps an unresolved old A directory pending (%s), then preserves an explicit user choice',async mode=>{
    const record={...item('unknown-old'),currentDisposition:{status:'unresolved' as const},reviewFingerprint:'same'};
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),currentTotals:{completedLater:0,pending:1,unresolved:1},batches:[batch()]});vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[record],total:1,page:1,pageSize:100});
    if(mode==='previous automatic')saveAdmissionDraft('collection-one',[{batchId:'a',creatorId:17,item:record,action:{key:record.key,action:'new',selectionOrigin:'automatic',approvedAds:[],acceptSourceIds:[]}}]);
    const {wrapper}=await render('?collection=collection-one',false);expect((await editItem(wrapper,'unknown-old')).get('select').element.value).toBe('defer');expect(wrapper.get('[data-test=review-creator]').text()).toContain('1 待处理');expect(wrapper.get('.stage-actions strong').text()).toContain('0 接纳');
    await (await editItem(wrapper,'unknown-old')).get('select').setValue('new');await showAllReview(wrapper);expect((await editItem(wrapper,'unknown-old')).get('select').element.value).toBe('new');
    await (await savedStateButton(wrapper)).trigger('click');await flushPromises();expect((await editItem(wrapper,'unknown-old')).get('select').element.value).toBe('new');wrapper.unmount();
    const reopened=await render('?collection=collection-one');expect((await editItem(reopened.wrapper,'unknown-old')).get('select').element.value).toBe('new');expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('shows all 77 later-completed draft scopes without counting or editing them or replaying the old plan',async()=>{
    const records=Array.from({length:77},(_,index):AdmissionItem=>({...item(`old-${index}`),currentDisposition:completedLater,suggestedAction:{key:`old-${index}`,action:'new',approvedAds:['492.jpg']}}));
    const currentTotals={completedLater:77,pending:0,unresolved:0};
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),currentTotals,batches:[{...batch(),currentTotals}]});vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:records,total:77,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one',false);
    expect(wrapper.get('.overview').text()).toContain('预览草稿 · 未执行');expect(wrapper.get('.overview').text()).toContain('后续已完成 77 项 · 当前仍需核对 0 项');expect(wrapper.get('[data-test=review-creator]').text()).toContain('0 待处理');
    expect(wrapper.text()).toContain('0 接纳 · 0 跳过 · 0 暂缓');expect(wrapper.get('[data-test=collection-confirm]').attributes('disabled')).toBeDefined();expect(wrapper.find('[data-ad-filename]').exists()).toBe(false);
    await wrapper.get('[data-test=view-later-completed]').trigger('click');expect(wrapper.findAll('.review-row')).toHaveLength(20);await editItem(wrapper,'old-0');expect(wrapper.find('.item-card fieldset').exists()).toBe(false);
    const evidence=wrapper.get('[data-test=completed-later]');expect(evidence.text()).toContain('Work #201 · LocalWork #301');expect(evidence.text()).toContain('后续批次完成时间');expect(evidence.findAll('a').map(link=>link.attributes('href'))).toEqual(['/local-admission?collection=later-collection','/library/17/works/401']);
    await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-confirm]').trigger('click');expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();expect(api.refreshAdmissionCollectionDirectories).not.toHaveBeenCalled();
  });
  it('separates partial later coverage from unresolved historical containers and keeps the failure history',async()=>{
    const currentTotals={completedLater:1,pending:1,unresolved:1};
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection('partial'),currentTotals,remainingCount:1,error:'历史锁错误',batches:[{...batch(),state:'needs_review',currentTotals,error:'历史锁错误'}]});
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item('old-completed'),currentDisposition:completedLater,nextAction:'resume_plan',lastError:'旧项失败'},{...item('old-container','D'),currentDisposition:{status:'unresolved'},nextAction:'prepare_preview'}],total:2,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one');expect(wrapper.text()).toContain('后续部分覆盖');expect(wrapper.text()).toContain('历史锁错误');expect(wrapper.text()).toContain('旧项失败');expect(wrapper.get('[data-test=completion-unresolved]').text()).toContain('不按历史容器条数推算剩余作品');expect(wrapper.find('[data-test=completed-later]').exists()).toBe(true);
    expect(wrapper.findAll('button').some(button=>button.text()==='核对后继续本批'||button.text()==='核对后继续原批次')).toBe(false);expect(wrapper.get('[data-test=collection-remaining]').text()).toContain('剩余 1 项');expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('does not claim unknown container coverage is complete or invent a completion timestamp',async()=>{
    const currentTotals={completedLater:1,pending:3,unresolved:3};
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection('partial'),currentTotals,batches:[{...batch(),state:'needs_review',currentTotals}]});
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item('known'),currentDisposition:{...completedLater,status:'completed_later',completedAt:null,completionTimeBasis:'unavailable'}},...['container-1','container-2','container-3'].map(key=>({...item(key,'D'),currentDisposition:{status:'unresolved' as const}}))],total:4,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one');expect(wrapper.get('[data-test=completed-later]').text()).toContain('完成时间未单独记录');expect(wrapper.findAll('[data-test=completion-unresolved]')).toHaveLength(3);expect(wrapper.text()).not.toContain('后续批次完成时间');expect(wrapper.text()).toContain('不代表这些历史目录各自仍是一套待入库作品');
  });
  it('lets an already deferred scope item explicitly stay manual-deferred before the bulk scope confirmation',async()=>{
    const rows=['one','two'].map(key=>({...item(key),scopeReviewRequired:true as const,suggestedAction:{key,action:'defer' as const,reason:admissionScopeReviewReason}}));
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),batches:[batch()]});
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:rows,total:2,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one',false);
    expect((await editItem(wrapper,'one')).get('select').element.value).toBe('defer');
    await (await editItem(wrapper,'one')).get('[data-test=scope-review-keep-deferred]').trigger('click');
    expect(wrapper.get('[data-test=scope-review]').text()).toContain('有 1 个目录需要确认属于本批');
    await wrapper.get('[data-test=scope-review-confirm]').trigger('click');await showAllReview(wrapper);
    expect((await editItem(wrapper,'one')).get('select').element.value).toBe('defer');
    expect((await editItem(wrapper,'two')).get('select').element.value).toBe('new');
    await (await savedStateButton(wrapper)).trigger('click');await flushPromises();
    expect((await editItem(wrapper,'one')).get('select').element.value).toBe('defer');expect(wrapper.find('[data-test=scope-review]').exists()).toBe(false);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('separately confirms 77 legacy safe scopes without overwriting manual choices or executing, and retains the result after refresh and reread',async()=>{
    let fresh=false;
    const records=Array.from({length:80},(_,index):AdmissionItem=>({...item(`scope-${index}`,index===77?'D':'A'),sourceRelativePath:`目录-${index}`,reviewFingerprint:'same',scopeReviewRequired:true,suggestedAction:{key:`scope-${index}`,action:'defer',reason:admissionScopeReviewReason},...(index===77?{needsBoundaryReview:true,structureWarnings:['作品边界仍待核对']}:{})}));
    const saved=records.filter((_,index)=>index!==77).map(record=>{const index=Number(record.key.slice(6));return {batchId:index<40?'a':'b',creatorId:index<40?17:88,item:{...record,scopeReviewRequired:undefined},action:{key:record.key,action:index===79?'skip' as const:'defer' as const,selectionOrigin:'manual' as const,approvedAds:[],acceptSourceIds:[],...(index===0?{cancelledAds:record.ads.map(ad=>ad.relativePath)}:{}),reason:index===78?'用户明确暂缓':index===79?'用户明确跳过':admissionScopeReviewReason}};});
    saveAdmissionDraft('collection-one',saved);
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id,batches:[batch(fresh?'new-a':'a'),batch(fresh?'new-b':'b',88)]}));
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async id=>{const rows=records.slice(id.endsWith('a')?0:40,id.endsWith('a')?40:80).map(record=>({...record,key:fresh?`fresh-${record.key}`:record.key,reviewFingerprint:fresh?'changed':'same',suggestedAction:{...record.suggestedAction!,key:fresh?`fresh-${record.key}`:record.key}}));return {items:rows,total:rows.length,page:1,pageSize:100};});
    vi.mocked(api.refreshAdmissionCollectionDirectories).mockImplementation(async()=>{fresh=true;return {...collection(),id:'reread'};});
    const {wrapper}=await render('?collection=collection-one',false);
    const scope=wrapper.get('[data-test=scope-review]');expect(scope.element.tagName).toBe('SECTION');
    expect(scope.text()).toContain('范围待确认，不代表文件冲突');expect(scope.text()).toContain('77 个无冲突候选可预选 · 1 个仍需判断');
    expect(scope.findAll('section')).toHaveLength(2);expect(scope.text()).toContain('甲别名 / 目录-0');
    expect(wrapper.text()).toContain('0 接纳 · 1 跳过 · 79 暂缓');
    expect(api.refreshAdmissionCollectionDirectories).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
    await wrapper.get('[data-test=scope-review-confirm]').trigger('click');await flushPromises();
    expect(wrapper.find('[data-test=scope-review]').exists()).toBe(false);expect(wrapper.text()).toContain('77 接纳 · 1 跳过 · 2 暂缓');
    const current=JSON.parse(sessionStorage.getItem('cosgallery:admission:tab-drafts')!).find((draft:{id:string})=>draft.id==='collection-one');
    expect(current.entries.find((entry:{key:string})=>entry.key==='scope-0').action).toMatchObject({scopeConfirmed:true,selectionOrigin:'automatic',approvedAds:[]});
    expect(current.entries.find((entry:{key:string})=>entry.key==='scope-77').action).toMatchObject({action:'defer',scopeConfirmed:true});
    expect(current.entries.find((entry:{key:string})=>entry.key==='scope-78').action).toMatchObject({action:'defer',selectionOrigin:'manual',reason:'用户明确暂缓'});
    await (await savedStateButton(wrapper)).trigger('click');await flushPromises();expect(wrapper.find('[data-test=scope-review]').exists()).toBe(false);
    wrapper.unmount();const returned=await render('?collection=collection-one',false);
    expect(returned.wrapper.find('[data-test=scope-review]').exists()).toBe(false);expect(returned.wrapper.text()).toContain('77 接纳 · 1 跳过 · 2 暂缓');
    await returned.wrapper.get('[data-test=collection-repreview]').trigger('click');await flushPromises();
    expect(returned.router.currentRoute.value.query.collection).toBe('reread');expect(returned.wrapper.find('[data-test=scope-review]').exists()).toBe(false);
    expect(returned.wrapper.text()).toContain('77 接纳 · 1 跳过 · 2 暂缓');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('opens remaining deferred work directly as a linked draft, keeping boundary review and manual deferral',async()=>{
    const done={...collection('completed'),remainingCount:1,totals:{...collection().totals,completed:3,deferred:1}};
    const next={...collection(),id:'remaining-draft',remainingCount:0,previousCollectionId:done.id,batches:[batch('remaining')]};
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>id===done.id?done:next);
    vi.mocked(api.previewRemainingAdmissionCollection).mockResolvedValue(next);
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async id=>({items:id==='remaining'?[{...item('complex','D'),needsBoundaryReview:true,structureWarnings:['两个含媒体分支'],suggestedAction:{key:'complex',action:'defer',reason:'用户暂缓'}}]:[{...item('done'),state:'completed'}],total:1,page:1,pageSize:100}));
    const {wrapper,router}=await render('?collection=collection-one',false);
    expect(wrapper.text()).toContain('3 已完成');expect(wrapper.text()).toContain('尚未执行的暂缓目录 1 项');
    expect(wrapper.text()).not.toContain('本批处理完成');
    await wrapper.get('[data-test=collection-remaining]').trigger('click');await flushPromises();
    expect(api.previewRemainingAdmissionCollection).toHaveBeenCalledExactlyOnceWith(done.id);
    expect(router.currentRoute.value.query.collection).toBe(next.id);
    expect(wrapper.text()).toContain('核对本批图集');expect(wrapper.text()).toContain('两个含媒体分支');
    expect(wrapper.get('.review-row').element.tagName).toBe('ARTICLE');
    expect((await editItem(wrapper,'complex')).get('select').element.value).toBe('defer');
    expect(button(wrapper,'查看上次预览')).toBeTruthy();
    expect(api.fetchAdmissionWorkspace).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('retains original results on a rejected continuation and never falls back to replay',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection('partial'),remainingCount:1});
    vi.mocked(api.previewRemainingAdmissionCollection).mockRejectedValue(new RequestError('仍有活动任务，请稍后再核对',409));
    const {wrapper,router}=await render('?collection=collection-one',false);
    await wrapper.get('[data-test=collection-remaining]').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query.collection).toBe('collection-one');expect(wrapper.text()).toContain('仍有活动任务');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('cleans only after an explicit result action and renders returned parent outcomes',async()=>{
    const result={...collection('completed'),remainingCount:0,batches:[{...batch(),parentCleanup:{status:'not_empty' as const,message:'非空父目录保持'}},{...batch('b',88),parentCleanup:{status:'recycled' as const,message:'空父目录已送入Windows回收站'}}]};
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(result);vi.mocked(api.cleanupAdmissionCollectionParents).mockResolvedValue(result);
    const {wrapper}=await render('?collection=collection-one',false);
    expect(wrapper.find('[data-test=collection-remaining]').exists()).toBe(false);
    await button(wrapper,'更新进度').trigger('click');await flushPromises();expect(api.cleanupAdmissionCollectionParents).not.toHaveBeenCalled();
    await wrapper.get('[data-test=collection-cleanup-parents]').trigger('click');await flushPromises();
    expect(api.cleanupAdmissionCollectionParents).toHaveBeenCalledExactlyOnceWith('collection-one');
    expect(wrapper.text()).toContain('博主甲：非空父目录保持');expect(wrapper.text()).toContain('博主乙：空父目录已送入Windows回收站');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it.each(['draft','queued','running'] as const)('does not offer remaining or cleanup writes for %s collections',async state=>{
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(state),remainingCount:2});
    const {wrapper}=await render('?collection=collection-one',false);
    expect(wrapper.find('[data-test=collection-remaining]').exists()).toBe(false);expect(wrapper.find('[data-test=collection-cleanup-parents]').exists()).toBe(false);
    expect(api.previewRemainingAdmissionCollection).not.toHaveBeenCalled();expect(api.cleanupAdmissionCollectionParents).not.toHaveBeenCalled();
  });
  it('reconciles changed saved ad evidence on status refresh while keeping cancellation and request authority',async()=>{
    const original={...item('a-first'),reviewFingerprint:'same-manifest'};
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),batches:[batch()]});
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[original],total:1,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one');await (await openAds(wrapper)).get('[data-test=ads-clear-all]').trigger('click');
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...original,ads:[...original.ads,{relativePath:'新增广告.url',size:20}]}],total:1,page:1,pageSize:100});
    await (await savedStateButton(wrapper)).trigger('click');await flushPromises();
    await openAds(wrapper);expect(wrapper.get('[data-ad-filename="492.jpg"] input').element.checked).toBe(false);
    expect(wrapper.get('[data-ad-filename="新增广告.url"] input').element.checked).toBe(true);
    expect(api.repreviewAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('starts with pending items across creators and shows their boundary and action controls inline',async()=>{
    const {wrapper}=await render('?collection=collection-one',false);
    expect(wrapper.findAll('.review-row').map(card=>card.attributes('data-item-key'))).toEqual(['a-candidate','b-complex']);
    expect(wrapper.find('[data-test=collection-select-safe]').exists()).toBe(false);
    expect(wrapper.get('[data-test=collection-repreview]').text()).toBe('重新读取并核对');
    expect(wrapper.get('[data-item-key="b-complex"]').text()).toContain('目录边界提示');
    expect(wrapper.get('[data-item-key="b-complex"]').text()).toContain('多个含媒体子目录');
    expect(wrapper.findAll('.review-row .item-card select')).toHaveLength(2);
    expect(wrapper.find('[data-test=review-item-open]').exists()).toBe(false);
    expect(wrapper.find('[data-test=review-item-dialog]').exists()).toBe(false);
    await wrapper.get('input[aria-label="搜索本批作品或博主"]').setValue('博主乙');
    expect(wrapper.findAll('.review-row')).toHaveLength(1);
    await wrapper.get('input[aria-label="搜索本批作品或博主"]').setValue('');
    await wrapper.get('[data-test=review-status-selected]').trigger('click');
    expect(wrapper.findAll('.review-row')).toHaveLength(2);
    expect(wrapper.findAll('.review-row').every(row=>!row.element.hasAttribute('open'))).toBe(true);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('immediately moves an admitted row out of pending and keeps it editable under selected',async()=>{
    const {wrapper,router}=await render('?collection=collection-one',false);
    await wrapper.get('[data-test=admission-item-a-candidate] select').setValue('new');
    expect(wrapper.find('[data-item-key="a-candidate"]').exists()).toBe(false);
    expect(wrapper.findAll('.review-row')).toHaveLength(1);
    expect(wrapper.get('[data-test=review-status-pending]').text()).toContain('1');
    await wrapper.get('[data-test=review-status-selected]').trigger('click');
    expect(wrapper.find('[data-item-key="a-candidate"]').exists()).toBe(true);
    await wrapper.get('[data-test=admission-item-a-candidate] input[maxlength="500"]').setValue('本次确认名称');
    expect(wrapper.get('[data-test=admission-item-a-candidate] input[maxlength="500"]').element.value).toBe('本次确认名称');
    await wrapper.get('[data-test=review-status-pending]').trigger('click');
    expect(wrapper.find('[data-item-key="a-candidate"]').exists()).toBe(false);
    await router.push('/local-admission?collection=another');await flushPromises();
    expect(wrapper.find('[data-test=review-item-dialog]').exists()).toBe(false);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('keeps an incomplete existing-work choice pending until its target is explicitly selected',async()=>{
    const work={workId:91,title:'已有关联作品',catalogNo:1,images:2,videos:0,thumbnailUrl:null,primaryLocalWorkId:19,localState:'available',originalDirectories:['原目录'],sources:[]};
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async id=>({items:id==='a'?[item('a-first'),{...item('a-candidate','B'),candidates:[work]}]:[item('b-complex','D')],total:id==='a'?2:1,page:1,pageSize:100}));
    const {wrapper}=await render('?collection=collection-one',false);
    await wrapper.get('[data-test=admission-item-a-candidate] select').setValue('existing');
    expect(wrapper.find('[data-item-key="a-candidate"]').exists()).toBe(true);
    const editor=wrapper.get('[data-test=admission-item-a-candidate]');
    await editor.findAll('button').find(entry=>entry.text().startsWith('候选：'))!.trigger('click');
    expect(wrapper.find('[data-item-key="a-candidate"]').exists()).toBe(false);
    expect(wrapper.get('[data-test=review-status-pending]').text()).toContain('1');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('keeps a same-work choice pending until its peer is selected, without admitting on a step switch',async()=>{
    const {wrapper}=await render('?collection=collection-one',false);
    await wrapper.get('[data-test=admission-item-a-candidate] select').setValue('same-as');
    expect(wrapper.find('[data-item-key="a-candidate"]').exists()).toBe(true);
    await wrapper.get('[data-test=admission-item-a-candidate]').findAll('select')[1]!.setValue('a-first');
    expect(wrapper.find('[data-item-key="a-candidate"]').exists()).toBe(false);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it.each(['queued','running','completed'] as const)('does not reopen the committed scope from the %s result step',async state=>{
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(collection(state));
    const {wrapper}=await render('?collection=collection-one',false);
    expect(wrapper.get('[data-test=admission-step-select]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test=admission-step-review]').attributes('disabled')).toBeDefined();
    expect(api.fetchAdmissionCollectionScope).not.toHaveBeenCalled();
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('opens accessible help, ads and batch details without a write and restores focus on Escape',async()=>{
    const {wrapper}=await render('?collection=collection-one',false),host=wrapper.element;document.body.appendChild(host);
    expect(wrapper.get('.step-tools').findAll('button').map(entry=>entry.text())).toEqual(['入库记录','批次详情','核对说明']);
    for(const [open,dialog] of [['admission-history-open','admission-history-dialog'],['review-help-open','review-help-dialog'],['review-ads-open','review-ads-dialog'],['collection-details-open','collection-details-dialog']]){
      const trigger=wrapper.get(`[data-test=${open}]`);(trigger.element as HTMLElement).focus();await trigger.trigger('click');await flushPromises();
      expect(wrapper.get(`[data-test=${dialog}]`).attributes('aria-modal')).toBe('true');
      expect(wrapper.get(`[data-test=${dialog}]`).find('details').exists()).toBe(false);
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await flushPromises();
      expect(wrapper.find(`[data-test=${dialog}]`).exists()).toBe(false);expect(document.activeElement).toBe(trigger.element);
    }
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.refreshAdmissionCollectionDirectories).not.toHaveBeenCalled();
    wrapper.unmount();host.remove();
  });
  it('replaces the inline editors when a reread publishes a new draft without carrying old component identity',async()=>{
    const next={...collection(),id:'fresh-draft',batches:[batch('fresh')]};
    vi.mocked(api.refreshAdmissionCollectionDirectories).mockResolvedValue(next);
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>id==='fresh-draft'?next:collection());
    const {wrapper,router}=await render('?collection=collection-one',false);
    await editItem(wrapper,'a-candidate');
    await wrapper.get('[data-test=collection-repreview]').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query.collection).toBe('fresh-draft');
    expect(wrapper.find('[data-test=review-item-dialog]').exists()).toBe(false);
    expect(wrapper.find('[data-item-key="a-candidate"]').exists()).toBe(false);
    expect(api.refreshAdmissionCollectionDirectories).toHaveBeenCalledExactlyOnceWith('collection-one');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('bulk-selects filtered known identities without replacing manual directory choices or unknown identities',async()=>{
    const {wrapper}=await render();
    await wrapper.get('[data-folder="甲别名"] input[type=checkbox]').setValue(true);await flushPromises();
    await wrapper.get('[data-folder="甲别名"] .directory-grid input').setValue(false);
    await wrapper.get('input[aria-label="筛选等待区博主"]').setValue('博主乙');
    await wrapper.get('[data-test=select-matched-creators]').trigger('click');await flushPromises();
    await wrapper.get('input[aria-label="筛选等待区博主"]').setValue('');
    expect(wrapper.get('[data-folder="未明确身份"] input[type=checkbox]').element.checked).toBe(false);
    expect(wrapper.get('[data-folder="甲别名"] .directory-grid input').element.checked).toBe(false);
    expect(wrapper.get('[data-folder="博主乙"] input[type=checkbox]').element.checked).toBe(true);
    expect(api.fetchAdmissionDirectories).toHaveBeenCalledTimes(2);
    expect(api.previewAdmissionCollection).not.toHaveBeenCalled();
  });
  it('does not bulk-select two parent directories matching the same canonical creator',async()=>{
    vi.mocked(api.fetchAdmissionWorkspace).mockResolvedValue({...workspace,items:[...workspace.items,{...workspace.items[0]!,name:'另一个甲目录'}]});
    const {wrapper}=await render();await wrapper.get('[data-test=select-matched-creators]').trigger('click');await flushPromises();
    expect(api.fetchAdmissionDirectories).toHaveBeenCalledExactlyOnceWith(88,'博主乙');
    expect(wrapper.get('[data-folder="甲别名"] input[type=checkbox]').element.checked).toBe(false);
  });
  it('shows creator names and links between previews without automatically executing either version',async()=>{
    const current={...collection(),previousCollectionId:'previous',nextCollectionIds:['newer']};
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(current);
    vi.mocked(api.fetchAdmissionCollections).mockResolvedValue({items:[current],page:1,pageSize:20,total:1});
    const {wrapper,router}=await render('?collection=collection-one',false);
    const historyToggle=wrapper.get('[data-test=admission-history-open]');
    expect(historyToggle.attributes('aria-haspopup')).toBe('dialog');
    expect(wrapper.find('.history').exists()).toBe(false);
    await historyToggle.trigger('click');
    expect(wrapper.get('.history').attributes('role')).toBe('dialog');
    expect(wrapper.get('.history').text()).toContain('博主甲、博主乙');
    expect(wrapper.get('.history').text()).toContain('已有 1 份后续预览');
    await closeReviewDialog(wrapper);
    expect(wrapper.find('.history').exists()).toBe(false);
    await button(wrapper,'查看后续预览 · newer').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query.collection).toBe('newer');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('closes history when opening a saved batch or leaving the module without executing a task',async()=>{
    vi.mocked(api.fetchAdmissionCollections).mockResolvedValue({items:[{...collection(),id:'history-batch'}],page:1,pageSize:20,total:1});
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id}));
    const {wrapper,router}=await renderKept('?collection=collection-one');
    await wrapper.get('[data-test=admission-history-open]').trigger('click');
    await wrapper.get('[data-test=admission-history-dialog] li button').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query.collection).toBe('history-batch');
    expect(wrapper.find('[data-test=admission-history-dialog]').exists()).toBe(false);
    await wrapper.get('[data-test=admission-history-open]').trigger('click');
    await router.push('/creator-admission/costuan');await flushPromises();
    await router.push('/creator-admission/local?collection=history-batch');await flushPromises();
    expect(wrapper.find('[data-test=admission-history-dialog]').exists()).toBe(false);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('keeps exact confirmation scope collapsed under per-creator summaries and omits UI provenance from execution',async()=>{
    const {wrapper}=await render('?collection=collection-one',false);
    await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-confirm]').trigger('click');
    const dialog=wrapper.get('[role=dialog]');
    expect(dialog.findAll('.confirmation-list>details').every(row=>!row.element.hasAttribute('open'))).toBe(true);
    expect(dialog.text()).toContain('1 接纳 · 0 跳过 · 1 暂缓');
    expect(dialog.text()).toContain('R:/图库/a-first');expect(dialog.text()).toContain('附件/推广.txt');
    for(const check of dialog.findAll('input'))await check.setValue(true);
    await dialog.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    const payload=JSON.stringify(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1]);
    expect(payload).not.toContain('selectionOrigin');expect(payload).not.toContain('cancelledAds');
  });
  it('offers only checkpoint-supported recovery links even when every item contains an error',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection('partial'),batches:[{...batch(),state:'needs_review'}]});
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[
      {...item('unstarted'),state:'not_started',lastError:'failed',nextAction:'none',nextActionReason:'尚未建立执行记录'},
      {...item('moved'),state:'files_verified',lastError:'failed',nextAction:'review_files'},
      {...item('indexed'),state:'indexed',lastError:'failed',nextAction:'resume_plan'}
    ],total:3,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one',false);
    const links=wrapper.findAll('a').filter(link=>link.text()==='核对文件处置');
    expect(links).toHaveLength(1);expect(links[0]!.attributes('href')).toContain('itemKey=moved');
    expect(wrapper.text()).toContain('尚未开始');expect(wrapper.text()).toContain('尚未建立执行记录');
    expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
    await button(wrapper,'核对后继续本批').trigger('click');
    await button(wrapper,'确认继续原批次').trigger('click');await flushPromises();
    expect(api.resumeAdmissionCollection).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll('a').some(link=>link.text()==='核对文件处置')).toBe(false);
  });
  it('returns to scope editing with original selections and only includes explicitly selected new directories',async()=>{
    vi.mocked(api.fetchAdmissionCollectionScope).mockResolvedValue({scopes:[{creatorId:17,parent:'甲别名',directories:['第一套'],acceptExistingVersion:true}]});
    const {wrapper}=await render('?collection=collection-one');
    expect(wrapper.find('[data-test=collection-edit-scope]').exists()).toBe(false);
    await wrapper.get('[data-test=admission-step-select]').trigger('click');await flushPromises();
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
    const {wrapper}=await render('?collection=collection-one');await wrapper.get('[data-test=admission-step-select]').trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('原目录已不存在');expect(wrapper.get('[data-test=collection-preview]').attributes('disabled')).toBeDefined();
    const directories=wrapper.findAll('[data-folder="甲别名"] .directory-grid input');
    expect(directories.map(input=>(input.element as HTMLInputElement).checked)).toEqual([false,false,true]);
    expect(directories[2].attributes('disabled')).toBeUndefined();await directories[2].setValue(false);await directories[0].setValue(true);
    expect(wrapper.get('[data-test=collection-preview]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-test=admission-step-review]').trigger('click');expect(wrapper.text()).toContain('核对本批图集');expect(api.repreviewAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('rechecks and updates automatic safe choices while retaining an explicit skip',async()=>{
    let fresh=false;
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id,batches:[{...batch(fresh?'a2':'a'),totals:{total:2,selected:0,completed:0,skipped:0,deferred:2}}]}));
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async()=>({items:['one','two'].map(name=>({...item(fresh?`new-${name}`:name),sourceRelativePath:name,reviewFingerprint:fresh&&name==='two'?'changed':'same'})),total:2,page:1,pageSize:100}));
    vi.mocked(api.refreshAdmissionCollectionDirectories).mockImplementation(async()=>{fresh=true;return {...collection(),id:'fresh'};});
    const {wrapper,router}=await render('?collection=collection-one');await (await editItem(wrapper,'one')).get('select').setValue('skip');
    await wrapper.get('[data-test=collection-repreview]').trigger('click');await flushPromises();await showAllReview(wrapper);
    expect(router.currentRoute.value.query.collection).toBe('fresh');expect(api.refreshAdmissionCollectionDirectories).toHaveBeenCalledWith('collection-one');expect(api.repreviewAdmissionCollection).not.toHaveBeenCalled();
    expect((await editItem(wrapper,'new-one')).get('select').element.value).toBe('skip');
    expect((await editItem(wrapper,'new-two')).get('select').element.value).toBe('new');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('keeps the original draft and choices when a concurrent confirmation rejects repreview',async()=>{
    vi.mocked(api.refreshAdmissionCollectionDirectories).mockRejectedValue(new RequestError('原批已确认',409));
    const {wrapper,router}=await render('?collection=collection-one');await (await editItem(wrapper,'a-first')).get('select').setValue('skip');
    await wrapper.get('[data-test=collection-repreview]').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query.collection).toBe('collection-one');expect(wrapper.text()).toContain('原批已确认');expect((await editItem(wrapper,'a-first')).get('select').element.value).toBe('skip');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('discovers split directories in review, reports persistent scope changes, and does not inherit the old bundle identity',async()=>{
    let fresh=false;
    const changes={added:['拆分甲','拆分乙','历史范围待核对'].map(name=>({creatorId:17,parent:'甲别名',name})),removed:[{creatorId:17,parent:'甲别名',name:'原合集'}],warnings:['历史草稿没有记录完整范围，新发现目录请核对。']};
    const work={workId:91,title:'原合集对应作品',catalogNo:1,images:2,videos:0,thumbnailUrl:null,primaryLocalWorkId:19,localState:'available',originalDirectories:['原合集'],sources:[]};
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id,batches:[batch(fresh?'a2':'a')],...(fresh?{directoryRefresh:changes,previousCollectionId:'collection-one'}:{})}));
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async()=>({items:fresh?[
      {...item('stable-new'),sourceRelativePath:'保留人工判断',reviewFingerprint:'same'},
      {...item('child-a'),sourceRelativePath:'拆分甲'},
      {...item('child-b'),sourceRelativePath:'拆分乙'},
      {...item('legacy-new'),sourceRelativePath:'历史范围待核对',suggestedAction:{key:'legacy-new',action:'defer',reason:'历史范围待核对'}},
    ]:[{...item('stable'),sourceRelativePath:'保留人工判断',reviewFingerprint:'same'},{...item('bundle','D'),sourceRelativePath:'原合集',candidates:[work],suggestedAction:{key:'bundle',action:'existing',workId:91,approvedAds:['原合集广告.txt']}}],total:fresh?4:2,page:1,pageSize:100}));
    vi.mocked(api.refreshAdmissionCollectionDirectories).mockImplementation(async()=>{fresh=true;return {...collection(),id:'fresh',directoryRefresh:changes};});
    const {wrapper,router}=await render('?collection=collection-one');
    await (await editItem(wrapper,'stable')).get('select').setValue('defer');
    await wrapper.get('[data-test=collection-repreview]').trigger('click');await flushPromises();await showAllReview(wrapper);
    expect(api.refreshAdmissionCollectionDirectories).toHaveBeenCalledExactlyOnceWith('collection-one');
    expect(api.fetchAdmissionWorkspace).not.toHaveBeenCalled();expect(api.fetchAdmissionDirectories).not.toHaveBeenCalled();
    expect(router.currentRoute.value.query.collection).toBe('fresh');
    expect(wrapper.text()).toContain('新增目录 3 个、移出目录 1 个');
    expect(wrapper.get('[data-test=directory-refresh]').text()).toContain('移出：甲别名 / 原合集');
    expect(wrapper.get('[data-test=directory-refresh]').text()).toContain('新增：甲别名 / 拆分甲');
    expect(wrapper.get('[data-test=directory-refresh]').text()).toContain(changes.warnings[0]);
    expect((await editItem(wrapper,'stable-new')).get('select').element.value).toBe('defer');
    expect((await editItem(wrapper,'legacy-new')).get('select').element.value).toBe('defer');
    expect((await editItem(wrapper,'child-a')).get('select').element.value).toBe('new');
    expect((await editItem(wrapper,'child-a')).text()).not.toContain(work.title);
    expect((await editItem(wrapper,'child-a')).text()).not.toContain('原合集广告.txt');
    expect(wrapper.find('[data-test=admission-item-bundle]').exists()).toBe(false);
    wrapper.unmount();const returned=await render('?collection=fresh');
    expect(returned.wrapper.get('[data-test=directory-refresh]').text()).toContain('新增 3 个 · 移出 1 个');
    expect(api.refreshAdmissionCollectionDirectories).toHaveBeenCalledTimes(1);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('preselects safe items once, preserves manual defer on refresh/return, and only reselects on explicit request',async()=>{
    const {wrapper}=await render('?collection=collection-one');
    expect((await editItem(wrapper,'a-first')).get('select').element.value).toBe('new');
    expect((await editItem(wrapper,'a-candidate')).get('select').element.value).toBe('defer');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
    await (await editItem(wrapper,'a-first')).get('select').setValue('defer');
    await (await savedStateButton(wrapper)).trigger('click');await flushPromises();
    expect((await editItem(wrapper,'a-first')).get('select').element.value).toBe('defer');
    expect(api.previewAdmissionCollection).not.toHaveBeenCalled();
    wrapper.unmount();const returned=await render();
    expect(returned.router.currentRoute.value.query.collection).toBe('collection-one');
    expect((await editItem(returned.wrapper,'a-first')).get('select').element.value).toBe('defer');
    await (await editItem(returned.wrapper,'a-first')).get('select').setValue('new');
    expect((await editItem(returned.wrapper,'a-first')).get('select').element.value).toBe('new');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('returns from an album to the same result via the bare workspace entry without replaying',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue(collection('completed'));
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item('done'),postId:123,state:'completed'}],total:1,page:1,pageSize:100});
    const {wrapper,router}=await render('?collection=collection-one');
    await button(wrapper,'查看已完成与跳过项目').trigger('click');
    await wrapper.findAll('a').find(link=>link.text()==='查看图集')!.trigger('click');await flushPromises();
    expect(router.currentRoute.value.name).toBe('canonical-work-gallery');wrapper.unmount();
    const returned=await render();expect(returned.router.currentRoute.value.query.collection).toBe('collection-one');
    expect(returned.wrapper.text()).toContain('本批执行已结束');expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
    const reads=vi.mocked(api.fetchAdmissionWorkspace).mock.calls.length;
    await button(returned.wrapper,'新建批次').trigger('click');await flushPromises();
    expect(api.fetchAdmissionWorkspace).toHaveBeenCalledTimes(reads+1);
    expect(returned.router.currentRoute.value.query.collection).toBeUndefined();expect(returned.wrapper.text()).toContain('选择这次要入库的图集');
    returned.wrapper.unmount();const fresh=await render();expect(fresh.router.currentRoute.value.query.collection).toBeUndefined();
  });
  it('discards an unavailable remembered batch without falling back to cached results or looping',async()=>{
    sessionStorage.setItem('cosgallery:admission:last-collection','missing');
    vi.mocked(api.fetchAdmissionCollection).mockRejectedValue(new RequestError('批次不存在',404));
    const {wrapper}=await render();expect(wrapper.text()).toContain('批次不存在');expect(wrapper.text()).toContain('选择这次要入库的图集');
    expect(api.fetchAdmissionCollection).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem('cosgallery:admission:last-collection')).toBeNull();
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('preserves manual choices across two drafts and leaving during a refresh',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id}));
    const {wrapper,router}=await render('?collection=first');
    await (await editItem(wrapper,'a-first')).get('select').setValue('skip');
    await router.push('/local-admission?collection=second');await flushPromises();
    await router.push('/local-admission?collection=first');await flushPromises();await showAllReview(wrapper);
    expect((await editItem(wrapper,'a-first')).get('select').element.value).toBe('skip');
    await (await editItem(wrapper,'a-first')).get('select').setValue('defer');
    let release!:(value:Awaited<ReturnType<typeof api.fetchAdmissionItems>>)=>void;
    vi.mocked(api.fetchAdmissionItems).mockReturnValueOnce(new Promise(done=>release=done));
    await (await savedStateButton(wrapper)).trigger('click');await flushPromises();wrapper.unmount();
    const returned=await render('?collection=first');expect((await editItem(returned.wrapper,'a-first')).get('select').element.value).toBe('defer');
    release({items:[item('late')],total:1,page:1,pageSize:100});await flushPromises();
    expect(returned.wrapper.find('[data-test=admission-item-late]').exists()).toBe(false);
  });
  it('shows the actual pending Work id rather than an older cached draft Work on retry',async()=>{
    const work={workId:91,title:'旧展示作品',catalogNo:1,images:2,videos:0,thumbnailUrl:null,primaryLocalWorkId:19,localState:'available',originalDirectories:['原目录'],sources:[]};
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item('a-first','B'),candidates:[work]}],total:1,page:1,pageSize:100});
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),batches:[batch()]});
    const {wrapper}=await render('?collection=collection-one');await (await editItem(wrapper,'a-first')).get('select').setValue('existing');await button(wrapper,'候选：旧展示作品 · 2 图 / 0 视频').trigger('click');wrapper.unmount();
    const original={requestKey:'old-receipt',confirmed:true,batches:[{batchId:'a',acceptExistingVersion:false,actions:[{key:'a-first',action:'existing',workId:92,approvedAds:[],acceptSourceIds:[]}]}]};
    localStorage.setItem('cosgallery:admission:collection:collection-one',JSON.stringify(original));
    const returned=await render('?collection=collection-one');await editItem(returned.wrapper,'a-first');expect(returned.wrapper.text()).toContain('对应作品 #92');expect(returned.wrapper.text()).not.toContain('对应：旧展示作品');
    await closeReviewDialog(returned.wrapper);await returned.wrapper.get('[data-test=collection-confirm]').trigger('click');expect(returned.wrapper.get('[role=dialog]').text()).toContain('作品 #92');expect(returned.wrapper.get('[role=dialog]').text()).not.toContain('旧展示作品');
    await returned.wrapper.get('[role=dialog] input').setValue(true);await returned.wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();expect(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1]).toEqual(original);
  });
  it('also saves edits made while refresh status is in flight before loading the item pages',async()=>{
    const {wrapper}=await render('?collection=collection-one');
    let status!:(value:AdmissionCollection)=>void,items!:(value:Awaited<ReturnType<typeof api.fetchAdmissionItems>>)=>void;
    vi.mocked(api.fetchAdmissionCollection).mockReturnValueOnce(new Promise(done=>status=done));
    vi.mocked(api.fetchAdmissionItems).mockReturnValueOnce(new Promise(done=>items=done));
    await (await savedStateButton(wrapper)).trigger('click');
    await (await editItem(wrapper,'a-first')).get('select').setValue('defer');
    status(collection());await flushPromises();wrapper.unmount();
    const returned=await render('?collection=collection-one');expect((await editItem(returned.wrapper,'a-first')).get('select').element.value).toBe('defer');
    items({items:[],total:0,page:1,pageSize:100});await flushPromises();
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('does not default-select suspicious A metadata or overwrite original pending actions',async()=>{
    const records=[{...item('boundary'),needsBoundaryReview:true},{...item('conflict'),conflicts:['目标存在']},{...item('suggested'),suggestedAction:{key:'suggested',action:'defer' as const,approvedAds:[],acceptSourceIds:[]}},item('safe')];
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),batches:[batch()]});vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:records,total:4,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one');
    const kinds=[];for(const key of ['boundary','conflict','suggested','safe'])kinds.push((await editItem(wrapper,key)).get('select').element.value);expect(kinds).toEqual(['defer','defer','defer','new']);
    await closeReviewDialog(wrapper);expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  });
  it('fills only undecided safe A items without overwriting manual identities, skips, titles, primary choices or ads',async()=>{
    const work={workId:91,title:'已选作品',catalogNo:1,images:2,videos:0,thumbnailUrl:null,primaryLocalWorkId:19,localState:'available',originalDirectories:['原目录'],sources:[]};
    const records=[{...item('existing'),candidates:[work]},item('skip'),{...item('edited'),suggestedAction:{key:'edited',action:'new' as const,displayTitle:'上次名称',primary:true,approvedAds:['492.jpg']}},item('copy'),item('undecided'),item('candidate','B'),item('complex','D')];
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...collection(),batches:[batch()]});vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:records,total:records.length,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one');await (await editItem(wrapper,'existing')).get('select').setValue('existing');await button(wrapper,'候选：已选作品 · 2 图 / 0 视频').trigger('click');await (await editItem(wrapper,'skip')).get('select').setValue('skip');
    const edited=(await editItem(wrapper,'edited'));await edited.get('input:not([type=checkbox])').setValue('用户修改的标题');await edited.get('.item-ads input[value="492.jpg"]').setValue(false);await edited.get('.item-ads input[value="附件/推广.txt"]').setValue(true);
    await (await editItem(wrapper,'copy')).get('select').setValue('same-as');await (await editItem(wrapper,'copy')).findAll('select')[1]!.setValue('edited');

    expect((await editItem(wrapper,'candidate')).get('select').element.value).toBe('defer');expect((await editItem(wrapper,'complex')).get('select').element.value).toBe('defer');
    await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-confirm]').trigger('click');for(const input of wrapper.get('[role=dialog]').findAll('input'))await input.setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    const actions=vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1].batches[0]!.actions;
    expect(actions[0]).toMatchObject({action:'existing',workId:91});expect(actions[1]).toMatchObject({action:'skip',approvedAds:[]});expect(actions[2]).toMatchObject({action:'new',displayTitle:'用户修改的标题',primary:true,approvedAds:['附件/推广.txt']});expect(actions[3]).toMatchObject({action:'same-as',sameAsKey:'edited'});expect(actions[4]).toMatchObject({action:'new'});expect(actions.slice(5).map(action=>action.action)).toEqual(['defer','defer']);
  });
  it('releases a conclusively rejected oversized collection payload instead of locking it as an uncertain receipt',async()=>{
    vi.mocked(api.executeAdmissionCollection).mockRejectedValueOnce(new RequestError('Request failed with status 413',413));
    const {wrapper}=await render('?collection=collection-one');await (await openAds(wrapper)).get('[data-test=ads-clear-all]').trigger('click');await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-confirm]').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('本批确认内容超过上限，请分小批');expect(wrapper.text()).not.toContain('执行回执尚未确认');expect(localStorage.getItem('cosgallery:admission:collection:collection-one')).toBeNull();expect(wrapper.get('[data-test=collection-repreview]').attributes('disabled')).toBeUndefined();expect(api.executeAdmissionCollection).toHaveBeenCalledTimes(1);
  });
  it('previews two creator scopes once without individual execute calls or automatically creating identities',async()=>{
    const {wrapper}=await render();expect(wrapper.get('[data-folder="未明确身份"] input[type=checkbox]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-folder="甲别名"] input[type=checkbox]').setValue(true);await wrapper.get('[data-folder="博主乙"] input[type=checkbox]').setValue(true);await flushPromises();
    expect(wrapper.get('[data-test=collection-preview]').attributes('disabled')).toBeUndefined();expect(wrapper.find('.stage-actions input[type=checkbox]').exists()).toBe(false);await wrapper.get('[data-test=collection-preview]').trigger('click');await flushPromises();
    expect(api.previewAdmissionCollection).toHaveBeenCalledExactlyOnceWith([{creatorId:17,parent:'甲别名',directories:['第一套','第二套'],acceptExistingVersion:true},{creatorId:88,parent:'博主乙',directories:['第一套','第二套'],acceptExistingVersion:true}]);expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.executeAdmission).not.toHaveBeenCalled();expect(wrapper.text()).toContain('预览草稿 · 未执行');
  });
  it('confirms all creators centrally, leaves candidates and complex boundaries deferred, and asks separately for ads',async()=>{
    const {wrapper}=await render('?collection=collection-one');
    expect(wrapper.find('[data-test=admission-accept-version]').exists()).toBe(false);await wrapper.get('[data-test=review-help-open]').trigger('click');expect(wrapper.get('[data-test=review-help-dialog]').text()).toContain('已入库的同一作品不重复获取');await closeReviewDialog(wrapper);
    expect((await editItem(wrapper,'a-first')).get('select').element.value).toBe('new');expect((await editItem(wrapper,'a-candidate')).get('select').element.value).toBe('defer');
    await openAds(wrapper);expect(wrapper.get('[data-ad-filename="推广.txt"]').text()).toContain('2 个接纳目录 / 2 个文件 · 已选 2');await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-confirm]').trigger('click');
    const dialog=wrapper.get('[role=dialog]');expect(dialog.text()).toContain('博主甲');expect(dialog.text()).toContain('博主乙');expect(dialog.text()).toContain('b-complex');await dialog.findAll('input')[0]!.setValue(true);expect(dialog.get('[data-test=collection-execute]').attributes('disabled')).toBeDefined();await dialog.findAll('input')[1]!.setValue(true);await dialog.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    expect(api.executeAdmissionCollection).toHaveBeenCalledTimes(1);const input=vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1];expect(input.batches.map(batch=>batch.batchId)).toEqual(['a','b']);expect(input.batches.map(batch=>batch.actions.map(action=>action.action))).toEqual([['new','defer'],['new','defer']]);expect(input.batches.every(batch=>batch.adsConfirmed===true)).toBe(true);expect(input.batches[1]!.actions[0]!.approvedAds).toEqual(['附件/推广.txt','492.jpg']);expect(api.executeAdmission).not.toHaveBeenCalled();
    expect(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1].batches.every(batch=>batch.acceptExistingVersion===true)).toBe(true);
  });
  it('preserves cleared advertisement defaults across saved-status refresh, page return and unchanged repreview',async()=>{
    vi.mocked(api.fetchAdmissionCollection).mockImplementation(async id=>({...collection(),id,batches:[batch()]}));
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item('first'),reviewFingerprint:'same-files'}],total:1,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one');
    expect(wrapper.text()).toContain('广告附件 · 已选 2 项');
    await (await openAds(wrapper)).get('[data-test=ads-clear-all]').trigger('click');
    await (await savedStateButton(wrapper)).trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('广告附件 · 已选 0 项');
    wrapper.unmount();const returned=await render('?collection=collection-one');
    expect(returned.wrapper.text()).toContain('广告附件 · 已选 0 项');
    vi.mocked(api.refreshAdmissionCollectionDirectories).mockResolvedValue({...collection(),id:'fresh'});
    await returned.wrapper.get('[data-test=collection-repreview]').trigger('click');await flushPromises();
    expect(returned.router.currentRoute.value.query.collection).toBe('fresh');
    await showAllReview(returned.wrapper);expect((await editItem(returned.wrapper,'first')).get('select').element.value).toBe('new');
    expect(returned.wrapper.text()).toContain('广告附件 · 已选 0 项');
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('limits same-work choices to the active creator and displays boundary notes instead of silently splitting',async()=>{
    const {wrapper}=await render('?collection=collection-one');await (await editItem(wrapper,'a-candidate')).get('select').setValue('same-as');
    const peerSelect=(await editItem(wrapper,'a-candidate')).findAll('select')[1]!;expect(peerSelect.text()).toContain('a-first');expect(peerSelect.text()).not.toContain('b-first');await closeReviewDialog(wrapper);await wrapper.get('[data-test=review-creator]').setValue('b');await editItem(wrapper,'b-complex');expect(wrapper.text()).toContain('目录边界提示');expect(wrapper.text()).toContain('多个含媒体子目录');expect((await editItem(wrapper,'b-complex')).get('select').element.value).toBe('defer');expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('keeps cross-page advertisement choices scoped to all selected creators, preserving skipped and deferred files',async()=>{
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async(id)=>({items:id==='a'?Array.from({length:21},(_,index)=>item(`a-${index}`)):[item('b-first'),item('b-skip')],total:id==='a'?21:2,page:1,pageSize:100}));
    const {wrapper}=await render('?collection=collection-one');await closeReviewDialog(wrapper);await wrapper.get('[data-test=review-creator]').setValue('b');await (await editItem(wrapper,'b-skip')).get('select').setValue('skip');await openAds(wrapper);await wrapper.get('[data-ad-filename="推广.txt"] input').setValue(true);
    expect(wrapper.get('[data-ad-filename="推广.txt"]').text()).toContain('22 个接纳目录 / 22 个文件 · 已选 22');await closeReviewDialog(wrapper);await wrapper.get('[data-test=review-creator]').setValue('a');expect(wrapper.findAll('.review-row')).toHaveLength(20);await button(wrapper,'下一页目录').trigger('click');expect((await editItem(wrapper,'a-20')).get('.item-ads').findAll('input').map(input=>(input.element as HTMLInputElement).checked)).toEqual([true,true]);
  });
  it('restores the exact whole-collection receipt after lost response and a fresh page without replaying child batches',async()=>{
    vi.mocked(api.executeAdmissionCollection).mockRejectedValueOnce(new Error('receipt lost'));const {wrapper}=await render('?collection=collection-one');await (await openAds(wrapper)).get('[data-test=ads-clear-all]').trigger('click');await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-confirm]').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    const original=JSON.parse(JSON.stringify(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1]));wrapper.unmount();const returned=await render('?collection=collection-one');expect(returned.wrapper.text()).toContain('回执尚未确认');expect(returned.wrapper.get('[data-test=collection-repreview]').attributes('disabled')).toBeDefined();await closeReviewDialog(returned.wrapper);await returned.wrapper.get('[data-test=collection-confirm]').trigger('click');await returned.wrapper.get('[role=dialog] input').setValue(true);await returned.wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();expect(vi.mocked(api.executeAdmissionCollection).mock.calls[1]![1]).toEqual(original);expect(api.executeAdmission).not.toHaveBeenCalled();
  });
  it('polls only lightweight collection state, stops after completion, and never automatically resumes',async()=>{
    vi.useFakeTimers();vi.mocked(api.fetchAdmissionCollection).mockResolvedValueOnce(collection('running')).mockResolvedValue(collection('completed'));const {wrapper}=await render('?collection=collection-one');await vi.advanceTimersByTimeAsync(2500);await flushPromises();expect(wrapper.text()).toContain('本批执行已结束');const calls=vi.mocked(api.fetchAdmissionCollection).mock.calls.length;await vi.advanceTimersByTimeAsync(15000);expect(api.fetchAdmissionCollection).toHaveBeenCalledTimes(calls);expect(api.executeAdmission).not.toHaveBeenCalled();expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.resumeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('retries mixed historical creator policies unchanged, then uses the default only for a new confirmation',async()=>{
    const original={requestKey:'mixed-original',confirmed:true,batches:[{batchId:'a',acceptExistingVersion:false,actions:[{key:'a-first',action:'new',approvedAds:[]},{key:'a-candidate',action:'defer'}]},{batchId:'b',acceptExistingVersion:true,actions:[{key:'b-first',action:'new',approvedAds:[]},{key:'b-complex',action:'defer'}]}]};
    localStorage.setItem('cosgallery:admission:collection:collection-one',JSON.stringify(original));
    const {wrapper,router}=await render('?collection=collection-one');await wrapper.get('[data-test=review-help-open]').trigger('click');expect(wrapper.text()).toContain('本次重试保留原请求的策略和选择');expect(wrapper.find('[data-test=admission-accept-version]').exists()).toBe(false);
    await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-confirm]').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
    expect(vi.mocked(api.executeAdmissionCollection).mock.calls[0]![1]).toEqual(original);
    await router.push('/local-admission?collection=new-draft');await flushPromises();
    await (await openAds(wrapper)).get('[data-test=ads-clear-all]').trigger('click');await closeReviewDialog(wrapper);await wrapper.get('[data-test=collection-confirm]').trigger('click');expect(wrapper.get('[role=dialog]').text()).toContain('已入库的同一作品不重复获取');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=collection-execute]').trigger('click');await flushPromises();
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

  it('separates unread, failed and truly empty waiting/history state without showing empty action tools',async()=>{
    let finish!:(value:AdmissionWorkspace)=>void;
    vi.mocked(api.fetchAdmissionWorkspace).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    vi.mocked(api.fetchAdmissionCollections).mockRejectedValueOnce(new Error('记录暂不可读'));
    const {wrapper}=await render('',false);
    expect(wrapper.text()).toContain('读取等待区…');await wrapper.get('[data-test=admission-history-open]').trigger('click');expect(wrapper.text()).toContain('记录暂不可读');
    expect(wrapper.text()).not.toContain('尚无多博主批次');expect(wrapper.text()).not.toContain('等待区目前没有');
    await closeReviewDialog(wrapper);
    finish({...workspace,items:[]});await flushPromises();
    expect(wrapper.text()).toContain('等待区目前没有');expect(wrapper.find('[data-test=collection-preview]').exists()).toBe(false);
    expect(wrapper.find('[data-test=select-matched-creators]').exists()).toBe(false);
    vi.mocked(api.fetchAdmissionWorkspace).mockRejectedValueOnce(new Error('无法访问等待区'));
    await button(wrapper,'重新读取等待区').trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('读取失败');expect(wrapper.text()).not.toContain('等待区目前没有');
    expect((wrapper.get('.settings input').element as HTMLInputElement).value).toBe('R:/待入库');expect(api.previewAdmissionCollection).not.toHaveBeenCalled();
  });
  it('explains disabled selection inline and does not let an unselected unknown identity block a valid range',async()=>{
    const {wrapper}=await render('',false);
    expect(wrapper.get('#collection-preview-reason').text()).toContain('尚未选择');
    expect(wrapper.findAll('[aria-current=step]').map(step=>step.text())).toEqual(['1 选择图集']);
    await wrapper.get('[data-folder="甲别名"] input[type=checkbox]').setValue(true);await flushPromises();
    expect(wrapper.get('[data-test=collection-preview]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-folder="未明确身份"]').text()).toContain('选择博主后才能加入本批');
    expect(api.fetchAdmissionDirectories).toHaveBeenCalledTimes(1);
    await wrapper.get('[data-test=collection-preview]').trigger('click');await flushPromises();
    expect(api.previewAdmissionCollection).toHaveBeenCalledTimes(1);expect(api.executeAdmissionCollection).not.toHaveBeenCalled();
  });
  it('prioritizes incomplete results while retaining completed-item errors, later evidence and separate cleanup failure',async()=>{
    const original=collection('partial');
    vi.mocked(api.fetchAdmissionCollection).mockResolvedValue({...original,currentTotals:{pending:1,unresolved:1,completedLater:1},batches:[{...batch(),state:'needs_review',totals:{...batch().totals,completed:2},parentCleanup:{status:'failed',message:'父目录被占用'}}]});
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[
      {...item('ordinary-complete'),state:'completed',postId:101,nextAction:'none'},
      {...item('cleanup-error'),state:'completed',lastError:'广告回收失败',nextAction:'review_files'},
      {...item('later-complete'),currentDisposition:completedLater},
      {...item('unknown-container'),currentDisposition:{status:'unresolved'}}
    ],total:4,page:1,pageSize:100});
    const {wrapper}=await render('?collection=collection-one',false);
    expect(wrapper.findAll('.result li').map(row=>row.get('strong').text())).toEqual(['cleanup-error','later-complete','unknown-container']);
    expect(wrapper.text()).toContain('广告回收失败');expect(wrapper.text()).toContain('父目录被占用');expect(wrapper.text()).toContain('清理失败不表示已入库作品需要重跑');
    expect(wrapper.findAll('a').find(link=>link.text()==='查看本博主图库')!.attributes('href')).toBe('/library/17');
    await button(wrapper,'查看已完成与跳过项目').trigger('click');
    expect(wrapper.findAll('.result li')).toHaveLength(4);
    expect(api.executeAdmissionCollection).not.toHaveBeenCalled();expect(api.cleanupAdmissionCollectionParents).not.toHaveBeenCalled();
  });
});
