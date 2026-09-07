import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FirstCollectionSelector from './FirstCollectionSelector.vue';
import { fetchFirstCollectionCandidates, planFirstCollection } from '../api/first-collection';
import type { FirstCollectionCandidate, FirstCollectionResult } from '../api/first-collection';
import type { ArchiveMetadataTask } from '../types/api';

vi.mock('../api/first-collection', async importOriginal => ({ ...await importOriginal<typeof import('../api/first-collection')>(), fetchFirstCollectionCandidates: vi.fn(), planFirstCollection: vi.fn() }));
const candidate = (id: number, active = true): FirstCollectionCandidate => ({ creatorId:id, creatorName:'同名博主', aliases:['旧名称'], preference:'liked', rating:'R18', isActive:active, localWorks:0, sourceState:{ metadataAccepted:false, deliveryReady:false, deliveryEvidence:'missing', missing:[] }, task:null });
const task = (id: number, creatorId: number, status: ArchiveMetadataTask['status'] = 'pending'): ArchiveMetadataTask => ({ id, creatorId, creatorName:'同名博主', preference:'liked', rating:'R18', source:'costuan',localWorks:0,status,claimedBy:status==='claimed'?'worker-a':null,claimedAt:null,completedAt:null,attemptCount:0,lastError:null,createdAt:'now',updatedAt:'now' });
const button = (w: ReturnType<typeof mount>, label: string) => w.findAll('button').find(item => item.text() === label)!;
const open = async () => { const w=mount(FirstCollectionSelector); await w.get('[data-test=open-first-collection]').trigger('click'); await flushPromises(); return w; };

describe('explicit first collection selector', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal=function(){ this.open=true; };
    HTMLDialogElement.prototype.close=function(){ this.open=false; this.dispatchEvent(new Event('close')); };
    vi.mocked(fetchFirstCollectionCandidates).mockImplementation(async options => ({ items:[candidate(options.page),candidate(99,false)], total:52,page:options.page,limit:50,pages:2 }));
    vi.mocked(planFirstCollection).mockImplementation(async ids => ({ items:ids.map(id=>({ creatorId:id,creatorName:'同名博主',result:'created',task:task(id+100,id) })), taskIds:ids.map(id=>id+100) }));
  });
  it('loads only a page, defaults to active missing sources and cancellation writes nothing', async () => {
    const w=await open();
    expect(fetchFirstCollectionCandidates).toHaveBeenCalledWith({ q:'',page:1,limit:50,active:'active',hasSource:'no' });
    expect(w.get('[data-test=submit-first-collection]').attributes('disabled')).toBeDefined();
    expect(w.findAll('tbody tr')).toHaveLength(2);
    await w.get('input[type=checkbox]').setValue(true);
    await button(w,'取消').trigger('click');
    expect(planFirstCollection).not.toHaveBeenCalled();
    await w.get('[data-test=open-first-collection]').trigger('click');await flushPromises();
    expect(w.get('[data-test=selected-count]').text()).toBe('已选 0 位');
  });
  it('keeps explicitly selected IDs across pages, distinguishes same names and never selects the filtered roster', async () => {
    const w=await open(); await w.get('input[type=checkbox]').setValue(true);
    await button(w,'下一页').trigger('click'); await flushPromises();
    await w.get('input[type=checkbox]').setValue(true);
    expect(w.get('[data-test=selected-count]').text()).toBe('已选 2 位');
    await w.get('[data-test=submit-first-collection]').trigger('click'); await flushPromises();
    expect(planFirstCollection).toHaveBeenCalledWith([1,2],false);
    const scope=JSON.parse((w.get('[data-test=stage1-handoff]').element as HTMLTextAreaElement).value);
    expect(scope).toEqual({ version:1,type:'costuan-stage1-scope',taskIds:[101,102],creatorIds:[1,2],names:['同名博主','同名博主'] });
    expect(w.emitted('planned')).toEqual([[[1,2]]]);
  });
  it('disabled candidates and an empty set cannot be submitted, query failure never broadens scope', async () => {
    const w=await open();
    expect(w.findAll('input[type=checkbox]')[1]!.attributes('disabled')).toBeDefined();
    await w.get('[data-test=submit-first-collection]').trigger('click');
    expect(planFirstCollection).not.toHaveBeenCalled();
    vi.mocked(fetchFirstCollectionCandidates).mockRejectedValueOnce(new Error('网络不可用'));
    await w.get('form').trigger('submit'); await flushPromises();
    expect(w.get('[role=alert]').text()).toBe('网络不可用');
    expect(planFirstCollection).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent submits and blocks cancellation during an in-flight write', async () => {
    const w=await open();await w.get('input[type=checkbox]').setValue(true);
    let resolve!:(result:FirstCollectionResult)=>void;
    vi.mocked(planFirstCollection).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
    await w.get('[data-test=submit-first-collection]').trigger('click');
    await w.get('[data-test=submit-first-collection]').trigger('click');
    expect(planFirstCollection).toHaveBeenCalledTimes(1);
    const cancel=new Event('cancel',{cancelable:true});w.get('dialog').element.dispatchEvent(cancel);expect(cancel.defaultPrevented).toBe(true);
    resolve({items:[{ creatorId:1,creatorName:'同名博主',result:'reused',task:task(101,1) }],taskIds:[101]});await flushPromises();
    expect(w.text()).toContain('复用已有待处理任务');
  });
  it('shows partial results and retries only explicit failure/delivery items, retaining prior handoff', async () => {
    const w=await open();await w.get('input[type=checkbox]').setValue(true);
    await button(w,'下一页').trigger('click');await flushPromises();await w.get('input[type=checkbox]').setValue(true);
    vi.mocked(planFirstCollection).mockResolvedValueOnce({ items:[
      {creatorId:1,creatorName:'一',result:'created',task:task(101,1)},
      {creatorId:2,creatorName:'二',result:'retry_required',task:task(102,2,'not_found')}
    ],taskIds:[101] });
    await w.get('[data-test=submit-first-collection]').trigger('click');await flushPromises();
    expect(w.text()).toContain('需要明确重试');
    expect(planFirstCollection).toHaveBeenCalledTimes(1);
    await w.get('[data-test=retry-first-collection]').trigger('click');await flushPromises();
    expect(planFirstCollection).toHaveBeenLastCalledWith([2],true);
    expect(JSON.parse((w.get('[data-test=stage1-handoff]').element as HTMLTextAreaElement).value).taskIds).toEqual([101,102]);
  });
  it('the creator detail entry reuses the exact same submit path and does not search or auto-run', async () => {
    const w=mount(FirstCollectionSelector,{props:{ creator:{ id:166,name:'lunana',isActive:true,localWorks:0,preference:'kept',rating:'R15' } }});
    await w.get('[data-test=open-first-collection]').trigger('click');await flushPromises();
    expect(fetchFirstCollectionCandidates).not.toHaveBeenCalled();expect(planFirstCollection).not.toHaveBeenCalled();
    expect(w.get('[data-test=selected-count]').text()).toBe('已选 1 位');
    vi.mocked(planFirstCollection).mockResolvedValueOnce({items:[{creatorId:166,creatorName:'lunana',result:'source_ready',task:task(99,166,'completed')}],taskIds:[]});
    await w.get('[data-test=submit-first-collection]').trigger('click');await flushPromises();
    expect(planFirstCollection).toHaveBeenCalledWith([166],false);
    expect(w.text()).toContain('查看 Stage 2');expect(w.find('[data-test=stage1-handoff]').exists()).toBe(false);
  });
  it('explains unavailable source delivery and claimed workers without presenting metadata as download success',async()=>{
    vi.mocked(fetchFirstCollectionCandidates).mockResolvedValueOnce({items:[{...candidate(1),sourceState:{metadataAccepted:true,deliveryReady:false,deliveryEvidence:'missing',missing:['完整来源目录缺失']},task:task(101,1,'claimed')}],total:1,page:1,limit:50,pages:1});
    const w=await open();expect(w.text()).toContain('元数据已接入，网盘来源待确认');expect(w.text()).toContain('完整来源目录缺失');expect(w.text()).toContain('worker-a');
    expect(w.text()).not.toContain('已入库');
  });
});
