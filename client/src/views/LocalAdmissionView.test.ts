import { flushPromises, mount, enableAutoUnmount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import LocalAdmissionView from './LocalAdmissionView.vue';
import * as api from '../api/local-admission';
import { RequestError } from '../api/http';
import * as evidence from '../api/source-evidence';
import type { AdmissionBatch, AdmissionCurrentDisposition, AdmissionDirectories, AdmissionItem, AdmissionWork } from '../types/local-admission';
vi.mock('../api/local-admission');
vi.mock('../api/source-evidence',()=>({fetchSourceEvidence:vi.fn()}));
const dir=(parent:string|null=null):AdmissionDirectories=>({root:'R:/等待区',parent,creator:{id:17,name:'测试博主'},items:parent?[{name:'001 中文 & 空格',selectable:true,matchedCreatorIds:[],matchesSelectedCreator:false},{name:'002 第二套',selectable:true,matchedCreatorIds:[],matchesSelectedCreator:false},{name:'bad-link',selectable:false,reason:'目录链接不可用',matchedCreatorIds:[],matchesSelectedCreator:false}]:[{name:'别名目录',selectable:true,matchedCreatorIds:[17],matchesSelectedCreator:true}]});
const item=(key='first',group:AdmissionItem['group']='A'):AdmissionItem=>({key,sourceRelativePath:key==='first'?'001 中文 & 空格':key,targetPath:`R:/正式/测试博主/${key}`,displayTitle:key,group,summary:{images:12,videos:1,other:1,bytes:12345},candidates:[],conflicts:[],ads:[],state:'planned'});
const batch=(state:AdmissionBatch['state']='draft'):AdmissionBatch=>({id:'batch-synthetic',planId:state==='draft'?null:'original-plan',creatorId:17,creatorName:'测试博主',state,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',inputRoot:'R:/等待区/别名目录',totals:{total:3,selected:0,completed:0,skipped:0,deferred:3}});
const work:AdmissionWork={workId:91,title:'已有具体作品',catalogNo:23,images:24,videos:0,thumbnailUrl:null,primaryLocalWorkId:122,localState:'available',originalDirectories:['原始目录'],sources:[{sourceWorkId:71,title:'来源声明',sourceOrder:'030',mediaSummary:'23P',taskIds:[63]}]};
const completedLater:AdmissionCurrentDisposition={status:'completed_later',batchId:'later-batch',collectionId:null,planId:'later-batch',itemKey:'later-item',workId:201,localWorkId:301,postId:401,completedAt:null,completionTimeBasis:'unavailable',evidence:'exact_directory_scope'};
const button=(wrapper:Pick<ReturnType<typeof mount>,'findAll'>,text:string)=>wrapper.findAll('button').find(b=>b.text()===text)!;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
async function render(query=''){const router=createRouter({history:createMemoryHistory(),routes:[{path:'/library/:creatorId',name:'canonical-creator',component:{template:'<p>博主图库</p>'}},{path:'/local-admission/:creatorId',name:'local-admission',component:LocalAdmissionView},{path:'/local-admission',name:'local-admission-workspace',component:{template:'<p>全部博主入库</p>'}},{path:'/archive-catalog',component:{template:'<p>库</p>'}},{path:'/local-review',name:'local-review',component:{template:'<p>审核</p>'}},{path:'/library/:creatorId/works/:postId',name:'canonical-work-gallery',component:{template:'<p>图集</p>'}}]});await router.push(`/local-admission/17${query}`);const wrapper=mount({components:{RouterView},template:'<RouterView v-slot="{Component,route}"><KeepAlive><component :is="Component" :key="`${route.name}:${route.params.creatorId}`" /></KeepAlive></RouterView>'},{global:{plugins:[router]}});await flushPromises();return {wrapper,router};}
describe('web local admission without CLI or raw identity inputs',()=>{
  enableAutoUnmount(afterEach);
  beforeEach(()=>{vi.resetAllMocks();localStorage.clear();vi.useRealTimers();vi.mocked(api.fetchAdmissionSettings).mockResolvedValue({waitingRoot:'R:/等待区',galleryRoot:'R:/正式',archiveInboxRoot:'R:/压缩包'});vi.mocked(api.fetchAdmissionDirectories).mockImplementation(async(_id,parent)=>dir(parent??null));vi.mocked(api.fetchAdmissionBatches).mockResolvedValue({items:[],total:0,page:1,pageSize:20});vi.mocked(api.fetchAdmissionBatch).mockResolvedValue(batch());vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[item(),item('skip'),item('defer')],total:3,page:1,pageSize:100});vi.mocked(api.createAdmissionPreview).mockResolvedValue(batch());vi.mocked(api.executeAdmission).mockResolvedValue(batch('queued'));vi.mocked(api.fetchAdmissionWorks).mockResolvedValue({items:[work],total:1,page:1,pageSize:20});vi.mocked(evidence.fetchSourceEvidence).mockResolvedValue({items:[],total:0,page:1,limit:20});});
  afterEach(()=>{vi.useRealTimers();});
  it('keeps source and return context plus hash on saved-batch loading and removes the prior scope on explicit new selection',async()=>{
    const {wrapper,router}=await render('?batch=batch-synthetic&sourceEvidenceId=72&returnTo=%2Flibrary&session=old-session&planId=old-plan#review');
    expect(router.currentRoute.value.query).toEqual({batch:'batch-synthetic',sourceEvidenceId:'72',returnTo:'/library'});expect(router.currentRoute.value.hash).toBe('#review');
    await button(wrapper,'选择新一批目录').trigger('click');await flushPromises();
    expect(router.currentRoute.value.query).toEqual({sourceEvidenceId:'72',returnTo:'/library'});expect(router.currentRoute.value.hash).toBe('');
    expect(api.createAdmissionPreview).not.toHaveBeenCalled();expect(api.executeAdmission).not.toHaveBeenCalled();
  });
  it('carries supported query and hash from a single-creator batch link to its multi-creator collection',async()=>{
    vi.mocked(api.fetchAdmissionBatch).mockResolvedValue({...batch(),collectionId:'collection-parent'});
    const {router}=await render('?batch=batch-synthetic&sourceEvidenceId=72&returnTo=%2Flibrary&session=old-session#results');
    expect(router.currentRoute.value.name).toBe('local-admission-workspace');
    expect(router.currentRoute.value.query).toEqual({collection:'collection-parent',sourceEvidenceId:'72',returnTo:'/library'});expect(router.currentRoute.value.hash).toBe('#results');
  });
  it('does not bulk-select an unresolved historical A item while retaining its explicit manual choice',async()=>{
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item('unknown'),currentDisposition:{status:'unresolved'}},item('ordinary')],total:2,page:1,pageSize:100});
    const {wrapper}=await render('?batch=batch-synthetic');await button(wrapper,'选择无冲突的新作品').trigger('click');expect(wrapper.get('[data-test=admission-item-unknown] select').element.value).toBe('defer');expect(wrapper.get('[data-test=admission-item-ordinary] select').element.value).toBe('new');
    await wrapper.get('[data-test=admission-item-unknown] select').setValue('new');await wrapper.get('[data-test=admission-item-unknown] input[maxlength="500"]').setValue('用户确认保留整套');await button(wrapper,'选择无冲突的新作品').trigger('click');expect(wrapper.get('[data-test=admission-item-unknown] input[maxlength="500"]').element.value).toBe('用户确认保留整套');expect(api.executeAdmission).not.toHaveBeenCalled();
  });
  it('keeps original failure history but prevents completed-later items from resume or repreview',async()=>{
    vi.mocked(api.fetchAdmissionBatch).mockResolvedValue({...batch('needs_review'),error:'原锁错误',currentTotals:{completedLater:1,pending:1,unresolved:1}});
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item(),currentDisposition:completedLater,nextAction:'prepare_preview',lastError:'原文件阶段错误'},{...item('unknown','D'),currentDisposition:{status:'unresolved'},nextAction:'prepare_preview'}],total:2,page:1,pageSize:100});
    const {wrapper}=await render('?batch=batch-synthetic');expect(wrapper.get('[aria-label=批次状态]').text()).toContain('待审核');expect(wrapper.text()).toContain('原锁错误');expect(wrapper.text()).toContain('原文件阶段错误');expect(wrapper.text()).toContain('后续部分覆盖');
    expect(wrapper.get('[data-test=completed-later]').findAll('a').map(link=>link.attributes('href'))).toEqual(['/local-admission/17?batch=later-batch','/library/17/works/401']);expect(wrapper.text()).toContain('完成时间未单独记录');
    const rows=wrapper.findAll('[aria-label=执行结果] tbody tr');expect(rows[0]!.find('input').exists()).toBe(false);expect(rows[1]!.get('input').attributes('value')).toBe('unknown');expect(wrapper.findAll('button').some(button=>button.text()==='核对后继续原计划')).toBe(false);
    expect(api.resumeAdmission).not.toHaveBeenCalled();expect(api.repreviewAdmission).not.toHaveBeenCalled();
  });
  it('locks completed-later single-creator draft choices and excludes their previous ad selections',async()=>{
    vi.mocked(api.fetchAdmissionBatch).mockResolvedValue({...batch(),currentTotals:{completedLater:1,pending:0,unresolved:0}});
    const record={...item(),currentDisposition:completedLater,ads:[{relativePath:'广告.txt',size:8}],suggestedAction:{key:'first',action:'new' as const,approvedAds:['广告.txt']}};
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[record],total:1,page:1,pageSize:100});const {wrapper}=await render('?batch=batch-synthetic');
    expect(wrapper.text()).toContain('预览草稿 · 未执行');expect(wrapper.text()).toContain('0 接纳 · 0 跳过 · 0 暂缓');expect(wrapper.get('[data-test=admission-item-first]').find('fieldset').exists()).toBe(false);
    await button(wrapper,'选择无冲突的新作品').trigger('click');expect(wrapper.find('[data-ad-filename]').exists()).toBe(false);expect(button(wrapper,'查看入库确认').attributes('disabled')).toBeDefined();expect(api.executeAdmission).not.toHaveBeenCalled();expect(record.suggestedAction.approvedAds).toEqual(['广告.txt']);
  });
  it('bulk-selects only undecided A items and preserves manual choices and edited new-work fields',async()=>{
    const records=[{...item('existing'),candidates:[work]},item('skip'),{...item('edited'),ads:[{relativePath:'492.jpg',size:12,automatic:true},{relativePath:'指定广告.txt',size:8}],suggestedAction:{key:'edited',action:'new' as const,displayTitle:'上次名称',primary:true,approvedAds:['492.jpg']}},item('copy'),item('undecided'),item('candidate','B'),item('complex','D')];
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:records,total:records.length,page:1,pageSize:100});const {wrapper}=await render('?batch=batch-synthetic');
    await wrapper.get('[data-test=admission-item-existing] select').setValue('existing');await button(wrapper,`候选：${work.title} · 24 图 / 0 视频`).trigger('click');await wrapper.get('[data-test=admission-item-skip] select').setValue('skip');
    const edited=wrapper.get('[data-test=admission-item-edited]');await edited.get('input:not([type=checkbox])').setValue('用户修改的标题');await edited.get('.item-ads input[value="492.jpg"]').setValue(false);await edited.get('.item-ads input[value="指定广告.txt"]').setValue(true);
    await wrapper.get('[data-test=admission-item-copy] select').setValue('same-as');await wrapper.get('[data-test=admission-item-copy]').findAll('select')[1]!.setValue('edited');
    await button(wrapper,'选择无冲突的新作品').trigger('click');await button(wrapper,'选择无冲突的新作品').trigger('click');
    expect(wrapper.get('[data-test=admission-item-candidate] select').element.value).toBe('defer');expect(wrapper.get('[data-test=admission-item-complex] select').element.value).toBe('defer');
    await button(wrapper,'查看入库确认').trigger('click');for(const input of wrapper.get('[role=dialog]').findAll('input'))await input.setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');await flushPromises();
    const actions=vi.mocked(api.executeAdmission).mock.calls[0]![1].actions;expect(actions[0]).toMatchObject({action:'existing',workId:91});expect(actions[1]).toMatchObject({action:'skip',approvedAds:[]});expect(actions[2]).toMatchObject({action:'new',displayTitle:'用户修改的标题',primary:true,approvedAds:['指定广告.txt']});expect(actions[3]).toMatchObject({action:'same-as',sameAsKey:'edited'});expect(actions[4]).toMatchObject({action:'new'});expect(actions.slice(5).map(action=>action.action)).toEqual(['defer','defer']);
  });
  it('clears an oversized single-creator request after HTTP 413 so a smaller scope can be prepared',async()=>{
    vi.mocked(api.executeAdmission).mockRejectedValueOnce(new RequestError('body too large',413));const {wrapper}=await render('?batch=batch-synthetic');await wrapper.get('[data-test=admission-item-first] select').setValue('new');await button(wrapper,'查看入库确认').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');await flushPromises();expect(wrapper.text()).toContain('本批确认内容超过上限，请分小批');expect(wrapper.text()).not.toContain('上次执行回执尚未确认');expect(localStorage.getItem('cosgallery:admission:pending:batch-synthetic')).toBeNull();expect(wrapper.get('[data-test=admission-item-first] fieldset').attributes('disabled')).toBeUndefined();
  });
  it('redirects a collection child deep link to the central collection without allowing a separate execution',async()=>{
    vi.mocked(api.fetchAdmissionBatch).mockResolvedValue({...batch(),collectionId:'collection-one'});const {router}=await render('?batch=batch-synthetic');expect(router.currentRoute.value.name).toBe('local-admission-workspace');expect(router.currentRoute.value.query.collection).toBe('collection-one');expect(api.executeAdmission).not.toHaveBeenCalled();expect(api.fetchAdmissionItems).not.toHaveBeenCalled();
  });
  it('lists one level, uses directory choices and creates only a preview without a redundant preliminary checkbox',async()=>{const {wrapper}=await render();expect(api.fetchAdmissionDirectories).toHaveBeenCalledExactlyOnceWith(17,undefined);expect(api.createAdmissionPreview).not.toHaveBeenCalled();await wrapper.get('.directory-list button').trigger('click');await flushPromises();expect(api.fetchAdmissionDirectories).toHaveBeenLastCalledWith(17,'别名目录');await button(wrapper,'全选当前可接纳目录').trigger('click');expect(wrapper.text()).toContain('已选 2 / 3');expect(wrapper.get('[data-test=admission-preview]').attributes('disabled')).toBeUndefined();await wrapper.get('[data-test=admission-preview]').trigger('click');await flushPromises();expect(api.createAdmissionPreview).toHaveBeenCalledWith({creatorId:17,parent:'别名目录',directories:['001 中文 & 空格','002 第二套'],acceptExistingVersion:true});expect(api.executeAdmission).not.toHaveBeenCalled();expect(wrapper.text()).toContain('预览草稿 · 未执行');});
  it('keeps candidate relations unconfirmed, submits new/skip/defer and requires a distinct advertisement confirmation',async()=>{const first={...item(),ads:[{relativePath:'明确广告.txt',size:8}]};vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[first,item('skip'),item('defer')],total:3,page:1,pageSize:100});const {wrapper}=await render('?batch=batch-synthetic');expect(wrapper.get('[data-test=admission-item-first] select').element.value).toBe('defer');await wrapper.get('[data-test=admission-item-first] select').setValue('new');await wrapper.get('[data-test=admission-item-skip] select').setValue('skip');await wrapper.get('[data-test=admission-item-first] .item-ads input').setValue(true);await button(wrapper,'查看入库确认').trigger('click');const dialog=wrapper.get('[role=dialog]');await dialog.findAll('input')[0]!.setValue(true);expect(dialog.get('[data-test=admission-execute]').attributes('disabled')).toBeDefined();await dialog.findAll('input')[1]!.setValue(true);await dialog.get('[data-test=admission-execute]').trigger('click');await flushPromises();expect(api.executeAdmission).toHaveBeenCalledTimes(1);const payload=vi.mocked(api.executeAdmission).mock.calls[0]![1];expect(payload.confirmed).toBe(true);expect(payload.adsConfirmed).toBe(true);expect(payload.actions.map(action=>action.action)).toEqual(['new','skip','defer']);expect(payload.actions[0]?.approvedAds).toEqual(['明确广告.txt']);expect(payload.actions[1]?.approvedAds).toEqual([]);expect(payload.actions[0]?.reason).toContain('网页确认页');expect(payload.actions[0]?.reason).not.toContain('逐字节');});
  it('selects an existing work by name and accepts only explicitly selected mapped sources',async()=>{const {wrapper}=await render('?batch=batch-synthetic');await wrapper.get('[data-test=admission-item-first] select').setValue('existing');await button(wrapper,'查找已有作品').trigger('click');await flushPromises();await wrapper.get('.work-option').trigger('click');expect(wrapper.find('[data-test=admission-accept-version]').exists()).toBe(false);await wrapper.get('[data-test=admission-item-first]').findAll('label.check').find(label=>label.text().includes('来源声明'))!.get('input').setValue(true);await button(wrapper,'查看入库确认').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');await flushPromises();const payload=vi.mocked(api.executeAdmission).mock.calls[0]![1];expect(payload.actions[0]).toMatchObject({action:'existing',workId:91,primary:false,acceptSourceIds:[71]});expect(payload.acceptExistingVersion).toBe(true);expect(wrapper.find('input[type=number]').exists()).toBe(false);});
  it('defaults a new confirmation to future reuse without automatically selecting any existing source',async()=>{
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item(),candidates:[work]}],total:1,page:1,pageSize:100});
    const {wrapper}=await render('?batch=batch-synthetic');await wrapper.get('[data-test=admission-item-first] select').setValue('existing');await button(wrapper,`候选：${work.title} · 24 图 / 0 视频`).trigger('click');
    expect(wrapper.find('[data-test=admission-accept-version]').exists()).toBe(false);
    const source=wrapper.get('[data-test=admission-item-first]').findAll('label.check').find(label=>label.text().includes('来源声明'))!;expect((source.get('input').element as HTMLInputElement).checked).toBe(false);
    await button(wrapper,'查看入库确认').trigger('click');expect(wrapper.get('[role=dialog]').text()).toContain('已入库的同一作品不重复获取');expect(wrapper.get('[role=dialog]').text()).toContain('不代表文件完整');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');await flushPromises();
    const input=vi.mocked(api.executeAdmission).mock.calls[0]![1];expect(input.acceptExistingVersion).toBe(true);expect(input.actions[0]).toMatchObject({action:'existing',workId:91,acceptSourceIds:[]});
  });
  it('preserves an uncertain submitted payload across a new page and retries exactly the same request',async()=>{vi.mocked(api.executeAdmission).mockRejectedValueOnce(new Error('response lost'));const {wrapper}=await render('?batch=batch-synthetic');await wrapper.get('[data-test=admission-item-first] select').setValue('new');await button(wrapper,'查看入库确认').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');await flushPromises();const original=JSON.parse(JSON.stringify(vi.mocked(api.executeAdmission).mock.calls[0]![1]));expect(wrapper.text()).toContain('回执尚未确认');wrapper.unmount();const returned=await render('?batch=batch-synthetic');await button(returned.wrapper,'查看并重试原提交').trigger('click');await returned.wrapper.get('[role=dialog] input').setValue(true);await returned.wrapper.get('[data-test=admission-execute]').trigger('click');await flushPromises();expect(vi.mocked(api.executeAdmission).mock.calls[1]![1]).toEqual(original);expect(localStorage.getItem('cosgallery:admission:pending:batch-synthetic')).toBeNull();});
  it('does not send two execution requests when the user double clicks while the receipt is pending',async()=>{const receipt=deferred<AdmissionBatch>();vi.mocked(api.executeAdmission).mockReturnValue(receipt.promise);const {wrapper}=await render('?batch=batch-synthetic');await wrapper.get('[data-test=admission-item-first] select').setValue('new');await button(wrapper,'查看入库确认').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');await wrapper.get('[data-test=admission-execute]').trigger('click');expect(api.executeAdmission).toHaveBeenCalledTimes(1);receipt.resolve(batch('queued'));await flushPromises();});
  it('restores an active server batch, stops polling on completion, and never starts a historical batch on page load',async()=>{vi.useFakeTimers();vi.mocked(api.fetchAdmissionBatch).mockResolvedValueOnce(batch('running')).mockResolvedValue(batch('completed'));const {wrapper}=await render('?batch=batch-synthetic');expect(api.executeAdmission).not.toHaveBeenCalled();expect(api.resumeAdmission).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(2500);await flushPromises();expect(wrapper.text()).toContain('已完成');const calls=vi.mocked(api.fetchAdmissionBatch).mock.calls.length;await vi.advanceTimersByTimeAsync(15000);expect(api.fetchAdmissionBatch).toHaveBeenCalledTimes(calls);});
  it('leaving the page stops active status requests',async()=>{vi.useFakeTimers();vi.mocked(api.fetchAdmissionBatch).mockResolvedValue(batch('running'));const {wrapper}=await render('?batch=batch-synthetic');wrapper.unmount();await vi.advanceTimersByTimeAsync(15000);expect(api.fetchAdmissionBatch).toHaveBeenCalledTimes(1);});
  it('can continue local-first selection if optional source evidence is unavailable',async()=>{vi.mocked(evidence.fetchSourceEvidence).mockRejectedValue(new Error('temporary failure'));const {wrapper}=await render();expect(wrapper.text()).toContain('可先本地接纳');expect(wrapper.text()).toContain('别名目录');expect(api.createAdmissionPreview).not.toHaveBeenCalled();});
  it('uses a new resume request only after a previous resume was acknowledged and failed again',async()=>{
    vi.mocked(api.fetchAdmissionBatch).mockResolvedValue(batch('needs_review'));
    vi.mocked(api.resumeAdmission).mockResolvedValue(batch('needs_review'));
    const {wrapper}=await render('?batch=batch-synthetic');
    await button(wrapper,'核对后继续原计划').trigger('click');await button(wrapper,'确认继续本批').trigger('click');await flushPromises();
    const first=vi.mocked(api.resumeAdmission).mock.calls[0]![1].requestKey;
    await button(wrapper,'核对后继续原计划').trigger('click');await button(wrapper,'确认继续本批').trigger('click');await flushPromises();
    expect(vi.mocked(api.resumeAdmission).mock.calls[1]![1].requestKey).not.toBe(first);
  });
  it('reuses the exact resume request after an uncertain response and a new browser view',async()=>{
    vi.mocked(api.fetchAdmissionBatch).mockResolvedValue(batch('needs_review'));
    vi.mocked(api.resumeAdmission).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(batch('running'));
    const {wrapper}=await render('?batch=batch-synthetic');await button(wrapper,'核对后继续原计划').trigger('click');await button(wrapper,'确认继续本批').trigger('click');await flushPromises();
    const first=vi.mocked(api.resumeAdmission).mock.calls[0]![1];wrapper.unmount();
    const returned=await render('?batch=batch-synthetic');await button(returned.wrapper,'核对后继续原计划').trigger('click');await button(returned.wrapper,'确认继续本批').trigger('click');await flushPromises();
    expect(vi.mocked(api.resumeAdmission).mock.calls[1]![1]).toEqual(first);
  });
  it('does not allow a late execution receipt to change the newly selected creator page',async()=>{
    const receipt=deferred<AdmissionBatch>();vi.mocked(api.executeAdmission).mockReturnValue(receipt.promise);
    const {wrapper,router}=await render('?batch=batch-synthetic');await wrapper.get('[data-test=admission-item-first] select').setValue('new');await button(wrapper,'查看入库确认').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');
    vi.mocked(api.fetchAdmissionDirectories).mockResolvedValue({...dir(),creator:{id:88,name:'另一个博主'}});
    await router.push('/local-admission/88');await flushPromises();receipt.resolve(batch('queued'));await flushPromises();
    expect(wrapper.text()).toContain('另一个博主 · 本地导入');expect(wrapper.find('[aria-label="批次状态"]').exists()).toBe(false);expect(router.currentRoute.value.params.creatorId).toBe('88');
  });
  it('clears the previous creator directory selection immediately, before the next creator read returns',async()=>{
    const {wrapper,router}=await render();await wrapper.get('.directory-list button').trigger('click');await flushPromises();await button(wrapper,'全选当前可接纳目录').trigger('click');
    const next=deferred<AdmissionDirectories>();vi.mocked(api.fetchAdmissionDirectories).mockReturnValue(next.promise);
    await router.push('/local-admission/88');await flushPromises();
    expect(wrapper.text()).not.toContain('001 中文 & 空格');expect(wrapper.find('[data-test=admission-preview]').exists()).toBe(false);expect(wrapper.text()).toContain('正在读取');
    next.resolve({...dir(),creator:{id:88,name:'另一个博主'}});await flushPromises();expect(wrapper.text()).toContain('另一个博主');expect(api.createAdmissionPreview).not.toHaveBeenCalled();
  });
  it('restores only server-validated unchanged selections in a new unconfirmed preview',async()=>{
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[
      {...item(),suggestedAction:{key:'first',action:'new',displayTitle:'原确认名称',approvedAds:[]}},
      {...item('copy'),suggestedAction:{key:'copy',action:'same-as',sameAsKey:'first',primary:true}},
      {...item('existing','B'),candidates:[work],suggestedAction:{key:'existing',action:'existing',workId:91,acceptSourceIds:[71]}},
      item('changed')
    ],total:4,page:1,pageSize:100});
    const {wrapper}=await render('?batch=batch-synthetic');
    expect(wrapper.text()).toContain('已保留未变化项目的上次选择，仍需本次确认');
    expect(wrapper.get('[data-test=admission-item-first] select').element.value).toBe('new');
    expect(wrapper.get('[data-test=admission-item-copy] select').element.value).toBe('same-as');
    expect(wrapper.get('[data-test=admission-item-existing]').text()).toContain('对应：已有具体作品');
    expect(wrapper.get('[data-test=admission-item-changed] select').element.value).toBe('defer');
    expect(api.executeAdmission).not.toHaveBeenCalled();expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  });
  it('selects same-name advertisements across directory pages and filters without touching skipped or deferred items',async()=>{
    const records=Array.from({length:23},(_,index)=>({...item(`set-${index}`),ads:[{relativePath:'附件/指定广告.txt',size:8},{relativePath:'链接.url',size:9}]}));
    vi.mocked(api.fetchAdmissionItems).mockImplementation(async(_id,page=1)=>({items:records.slice((page-1)*20,page*20),total:23,page,pageSize:20}));
    const {wrapper}=await render('?batch=batch-synthetic');
    expect(api.fetchAdmissionItems).toHaveBeenCalledTimes(2);
    await button(wrapper,'选择无冲突的新作品').trigger('click');
    await wrapper.get('[data-test=admission-item-set-0] select').setValue('skip');
    await wrapper.get('[data-test=admission-item-set-1] select').setValue('defer');
    const group=wrapper.findAll('label').find(label=>label.text().startsWith('分组'))!.get('select');
    await group.setValue('D');
    expect(wrapper.find('.item-card').exists()).toBe(false);
    const row=wrapper.get('[data-ad-filename="指定广告.txt"]');
    expect(row.text()).toContain('21 个接纳目录 / 21 个文件 · 已选 21');
    expect(wrapper.get('[data-ad-filename="链接.url"]').text()).toContain('已选 21');
    await wrapper.get('[data-test=ads-clear-all]').trigger('click');
    expect(row.text()).toContain('已选 0');
    await row.get('input[type=checkbox]').setValue(true);
    expect(row.text()).toContain('已选 21');
    expect(wrapper.get('[data-ad-filename="链接.url"]').text()).toContain('已选 0');
    await group.setValue('all');await button(wrapper,'下一页目录').trigger('click');
    expect(wrapper.get('[data-test=admission-item-set-22] details input').element).toMatchObject({checked:true});
    await button(wrapper,'查看入库确认').trigger('click');
    const dialog=wrapper.get('[role=dialog]');await dialog.findAll('input')[0]!.setValue(true);await dialog.findAll('input')[1]!.setValue(true);
    await dialog.get('[data-test=admission-execute]').trigger('click');await flushPromises();
    const actions=vi.mocked(api.executeAdmission).mock.calls[0]![1].actions;
    expect(actions[0]).toMatchObject({action:'skip',approvedAds:[]});expect(actions[1]).toMatchObject({action:'defer',approvedAds:[]});
    expect(actions.slice(2).every(action=>JSON.stringify(action.approvedAds)===JSON.stringify(['附件/指定广告.txt']))).toBe(true);
  });
  it('selects and clears concrete candidate paths without changing identity, primary, source or version selections',async()=>{
    const records=[{...item(),candidates:[work],ads:[{relativePath:'广告.txt',size:8},{relativePath:'内层/广告.txt',size:9}]},{...item('copy'),ads:[{relativePath:'链接.url',size:8}]},item('defer')];
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:records,total:3,page:1,pageSize:100});
    const {wrapper}=await render('?batch=batch-synthetic');
    await wrapper.get('[data-test=admission-item-first] select').setValue('existing');
    await button(wrapper,`候选：${work.title} · 24 图 / 0 视频`).trigger('click');
    await wrapper.get('[data-test=admission-item-first] input[type=checkbox]').setValue(true);
    expect(wrapper.find('[data-test=admission-accept-version]').exists()).toBe(false);
    await wrapper.get('[data-test=admission-item-first]').findAll('label.check').find(label=>label.text().includes('来源声明'))!.get('input').setValue(true);
    await wrapper.get('[data-test=admission-item-copy] select').setValue('same-as');
    await wrapper.get('[data-test=admission-item-copy]').findAll('select')[1]!.setValue('first');
    await wrapper.get('[data-test=admission-item-copy] input:not([type=checkbox])').setValue('用户确认同套');
    await wrapper.get('[data-test=ads-select-all]').trigger('click');
    expect(wrapper.get('[data-ad-filename="广告.txt"]').text()).toContain('1 个接纳目录 / 2 个文件 · 已选 2');
    await wrapper.get('[data-ad-filename="广告.txt"] input[type=checkbox]').setValue(false);
    expect(wrapper.get('[data-ad-filename="广告.txt"]').text()).toContain('已选 0');
    expect(wrapper.get('[data-ad-filename="链接.url"]').text()).toContain('已选 1');
    await wrapper.get('[data-test=ads-select-all]').trigger('click');
    await wrapper.get('[data-test=ads-clear-all]').trigger('click');
    expect(wrapper.text()).toContain('已勾选 0 个具体文件');
    await button(wrapper,'查看入库确认').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');await flushPromises();
    const payload=vi.mocked(api.executeAdmission).mock.calls[0]![1];
    expect(payload.actions[0]).toMatchObject({action:'existing',workId:91,primary:true,acceptSourceIds:[71],approvedAds:[]});
    expect(payload.actions[1]).toMatchObject({action:'same-as',sameAsKey:'first',reason:'用户确认同套',approvedAds:[]});
    expect(payload.actions[2]).toMatchObject({action:'defer',approvedAds:[]});expect(payload.acceptExistingVersion).toBe(true);expect(payload.adsConfirmed).toBeUndefined();
  });
  it('preselects all listed advertisement candidates on new admission choices and retains cancellations and old choices',async()=>{
    const ads=[{relativePath:'广告.txt',size:8},{relativePath:'492.jpg',size:12,automatic:true},{relativePath:'内层/009-01.jpg',size:13,automatic:true},{relativePath:'内层/链接.url',size:9}];
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item(),ads,candidates:[work]}, {...item('old'),ads,suggestedAction:{key:'old',action:'new',approvedAds:[]}}],total:2,page:1,pageSize:100});
    const {wrapper}=await render('?batch=batch-synthetic');
    expect(wrapper.get('[data-test=admission-item-old] details').findAll('input').every(input=>!(input.element as HTMLInputElement).checked)).toBe(true);
    await wrapper.get('[data-test=admission-item-first] select').setValue('new');
    let checks=wrapper.get('[data-test=admission-item-first] .item-ads').findAll('input');
    expect(checks.map(input=>(input.element as HTMLInputElement).checked)).toEqual([true,true,true,true]);
    await checks[0]!.setValue(false);
    await checks[1]!.setValue(false);
    await wrapper.get('[data-test=admission-item-first] select').setValue('existing');
    await button(wrapper,`候选：${work.title} · 24 图 / 0 视频`).trigger('click');
    checks=wrapper.get('[data-test=admission-item-first] .item-ads').findAll('input');
    expect(checks.map(input=>(input.element as HTMLInputElement).checked)).toEqual([false,false,true,true]);
    await button(wrapper,'查看入库确认').trigger('click');const dialog=wrapper.get('[role=dialog]');
    expect(dialog.text()).toContain('广告送入Windows回收站：内层/009-01.jpg');expect(dialog.text()).toContain('广告送入Windows回收站：内层/链接.url');expect(dialog.text()).not.toContain('广告送入Windows回收站：492.jpg');expect(dialog.text()).not.toContain('广告送入Windows回收站：广告.txt');
    await dialog.findAll('input')[0]!.setValue(true);expect(dialog.get('[data-test=admission-execute]').attributes('disabled')).toBeDefined();
    await dialog.findAll('input')[1]!.setValue(true);await dialog.get('[data-test=admission-execute]').trigger('click');await flushPromises();
    const payload=vi.mocked(api.executeAdmission).mock.calls[0]![1];expect(payload.actions[0]?.approvedAds).toEqual(['内层/009-01.jpg','内层/链接.url']);expect(payload.actions[1]?.approvedAds).toEqual([]);
  });
  it('locks bulk advertisements while the original execution receipt is unresolved and does not add new defaults',async()=>{
    const original={requestKey:'unchanged-request',confirmed:true as const,acceptExistingVersion:false,actions:[{key:'first',action:'new' as const,approvedAds:[]}]};
    localStorage.setItem('cosgallery:admission:pending:batch-synthetic',JSON.stringify(original));
    vi.mocked(api.fetchAdmissionItems).mockResolvedValue({items:[{...item(),ads:[{relativePath:'492.jpg',size:8,automatic:true},{relativePath:'广告.txt',size:9},{relativePath:'链接.url',size:10}]}],total:1,page:1,pageSize:100});
    const {wrapper}=await render('?batch=batch-synthetic');
    expect(wrapper.get('[aria-label="本批附件集中选择"] fieldset').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-test=ads-select-all]').trigger('click');
    expect(wrapper.text()).toContain('已勾选 0 个具体文件');expect(localStorage.getItem('cosgallery:admission:pending:batch-synthetic')).toBe(JSON.stringify(original));
    await button(wrapper,'查看并重试原提交').trigger('click');await wrapper.get('[role=dialog] input').setValue(true);await wrapper.get('[data-test=admission-execute]').trigger('click');await flushPromises();
    expect(vi.mocked(api.executeAdmission).mock.calls[0]![1]).toEqual(original);
  });
  it('waits for the complete saved item list before enabling admission or batch advertisement choices',async()=>{
    const delayed=deferred<Awaited<ReturnType<typeof api.fetchAdmissionItems>>>();
    vi.mocked(api.fetchAdmissionItems).mockReturnValue(delayed.promise);
    const {wrapper}=await render('?batch=batch-synthetic');
    expect(wrapper.text()).toContain('正在读取预览摘要');
    expect(button(wrapper,'选择无冲突的新作品').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[aria-label="本批附件集中选择"]').exists()).toBe(false);
    expect(wrapper.find('[data-test=ads-select-all]').exists()).toBe(false);expect(api.executeAdmission).not.toHaveBeenCalled();
    delayed.resolve({items:[{...item(),ads:[{relativePath:'广告.txt',size:8}]}],total:1,page:1,pageSize:100});await flushPromises();
    expect(wrapper.find('[aria-label="本批附件集中选择"]').exists()).toBe(false);
    await button(wrapper,'选择无冲突的新作品').trigger('click');
    expect(wrapper.get('[aria-label="本批附件集中选择"] fieldset').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-ad-filename="广告.txt"]').text()).toContain('已选 1');
  });

  it('does not present directory or history read failures as empty data',async()=>{
    vi.mocked(api.fetchAdmissionBatches).mockRejectedValueOnce(new Error('历史读取失败'));
    vi.mocked(api.fetchAdmissionDirectories).mockRejectedValueOnce(new Error('目录不可读'));
    const {wrapper}=await render();
    expect(wrapper.text()).toContain('历史读取失败');expect(wrapper.text()).not.toContain('还没有导入批次');
    expect(wrapper.text()).toContain('目录不可读');expect(wrapper.text()).not.toContain('当前层级没有目录');
    expect(wrapper.find('[data-test=admission-preview]').exists()).toBe(false);expect(api.createAdmissionPreview).not.toHaveBeenCalled();
  });
  it('keeps the exact confirmation behind explicit choices and displays its disabled reason',async()=>{
    const {wrapper}=await render('?batch=batch-synthetic');
    await wrapper.get('[data-test=admission-item-first] select').setValue('new');
    await button(wrapper,'查看入库确认').trigger('click');
    const dialog=wrapper.get('[role=dialog]');
    expect(dialog.text()).toContain('请核对并确认目录范围及作品选择');
    expect(dialog.get('[data-test=admission-execute]').text()).toBe('确认入库 1 个目录');
    expect(dialog.get('[data-test=admission-execute]').attributes('disabled')).toBeDefined();
    expect(api.executeAdmission).not.toHaveBeenCalled();
    await button(wrapper,'返回修改').trigger('click');
    expect(wrapper.get('[data-test=admission-item-first] select').element.value).toBe('new');
  });
});
