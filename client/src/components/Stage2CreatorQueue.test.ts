import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Stage2CreatorQueue from './Stage2CreatorQueue.vue';
import { fetchDownloadCreators, fetchDownloadTaskPage } from '../api/creator-sync';
import type { DownloadCreatorPage, DownloadTaskPage } from '../api/creator-sync';
import type { ArchiveDownloadTask, ArchiveDownloadTaskSummary } from '../types/api';
vi.mock('../api/creator-sync', () => ({fetchDownloadCreators:vi.fn(),fetchDownloadTaskPage:vi.fn()}));
const summary: ArchiveDownloadTaskSummary={total:655,pending:0,claimed:0,staged:16,downloading:0,downloaded:0,ingested:639,failed:0,cancelled:0};
const row=(creatorId:number,total=150)=>({creatorId,creatorName:'同名博主',preference:'liked' as const,rating:'R15' as const,isActive:true,total,summary:{...summary,total,staged:0,ingested:total}});
const page=(items=[row(21),row(22)]):DownloadCreatorPage=>({items,total:21,taskTotal:655,page:1,limit:20,hasMore:true,readAt:'now',summary});
const task=(id:number,creatorId:number):ArchiveDownloadTask=>({id,creatorId,creatorName:'同名博主',title:`作品${id}`,status:'ingested',targetFilename:`${id}.7z`} as ArchiveDownloadTask);
const detail=(creatorId:number,p=1):DownloadTaskPage=>({items:[task(p,creatorId)],total:150,page:p,limit:50,hasMore:p<3,readAt:'now',summary:{...summary,total:150,ingested:150,staged:0}});
const start=async()=>{const w=mount(Stage2CreatorQueue);await w.vm.refresh();await flushPromises();return w;};
const clickLabel=async(w:ReturnType<typeof mount>,text:string)=>{await w.findAll('button').find(button=>button.text()===text)!.trigger('click');await flushPromises();};
describe('Stage 2 complete creator summaries and lazy detail pages',()=>{
  enableAutoUnmount(afterEach);
  beforeEach(()=>{vi.clearAllMocks();vi.mocked(fetchDownloadCreators).mockResolvedValue(page());vi.mocked(fetchDownloadTaskPage).mockImplementation(async options=>detail(options.creatorId,options.page));});
  it('separates historical staged state from accepted local coverage and review holds',async()=>{
    vi.mocked(fetchDownloadCreators).mockResolvedValue({...page(),items:[{...row(21),localSatisfied:1,acquisitionReviewRequired:1}]});
    vi.mocked(fetchDownloadTaskPage).mockResolvedValue({...detail(21),items:[{...task(1,21),status:'staged',acquisitionState:'local_satisfied',acquisitionExplanation:'本地已有资源满足，无需继续获取。'},{...task(2,21),status:'staged',acquisitionState:'review_required'}]});
    const w=await start();expect(w.get('[data-test=stage2-local-acceptance]').text()).toContain('本地已有资源满足 1 条 · 接受决定待复核 1 条');
    await w.get('[data-creator-id="21"] button').trigger('click');await flushPromises();
    const rows=w.findAll('[data-test=stage2-task]');expect(rows[0]!.text()).toContain('网盘已暂存，待本地确认');expect(rows[0]!.text()).toContain('无需继续获取');expect(rows[1]!.text()).toContain('未计为已满足');
  });
  it('shows complete summaries including creators beyond 100 tasks, with no eager details or local preview counts',async()=>{
    const w=await start();expect(w.findAll('article')).toHaveLength(2);expect(w.text()).toContain('完整汇总 150 条');expect(w.text()).toContain('655 条匹配任务');expect(w.text()).not.toContain('当前预览');
    expect(fetchDownloadTaskPage).not.toHaveBeenCalled();expect(w.findAll('[data-test=stage2-task]')).toHaveLength(0);
    vi.mocked(fetchDownloadCreators).mockResolvedValueOnce({...page([row(99,2)]),page:2,hasMore:false});
    await w.get('[data-test=stage2-creators-next]').trigger('click');await flushPromises();
    expect(fetchDownloadCreators).toHaveBeenLastCalledWith({enabled:'all',page:2,limit:20});expect(w.get('article').attributes('data-creator-id')).toBe('99');
  });
  it('uses creator identity, pages one creator lazily, preserves expansion and current detail page on refresh',async()=>{
    const w=await start();await w.get('[data-creator-id="22"] button').trigger('click');await flushPromises();
    expect(fetchDownloadTaskPage).toHaveBeenCalledWith({enabled:'all',creatorId:22,page:1,limit:50});expect(w.findAll('[data-test=stage2-task]')).toHaveLength(1);
    await clickLabel(w,'下一页明细');expect(fetchDownloadTaskPage).toHaveBeenLastCalledWith({enabled:'all',creatorId:22,page:2,limit:50});
    await w.vm.refresh();await flushPromises();expect(fetchDownloadTaskPage).toHaveBeenLastCalledWith({enabled:'all',creatorId:22,page:2,limit:50});expect(w.get('[data-creator-id="22"] button').attributes('aria-expanded')).toBe('true');expect(w.get('[data-creator-id="21"] button').attributes('aria-expanded')).toBe('false');
  });
  it('preserves last summary on errors, never reports zero for unavailable detail, and retries only reads',async()=>{
    const w=await start();vi.mocked(fetchDownloadTaskPage).mockRejectedValueOnce(new Error('明细网络失败'));
    await w.get('[data-creator-id="21"] button').trigger('click');await flushPromises();expect(w.get('[role=alert]').text()).toContain('明细网络失败');expect(w.text()).toContain('完整汇总 150 条');
    await clickLabel(w,'重试读取');expect(w.findAll('[data-test=stage2-task]')).toHaveLength(1);
    vi.mocked(fetchDownloadCreators).mockRejectedValueOnce(new Error('服务不可用'));await w.vm.refresh();expect(w.text()).toContain('保留上次读取结果');expect(w.text()).toContain('655 条匹配任务');
  });
  it('filters both summaries and details identically and ignores an old detail response after scope changes',async()=>{
    const w=await start();let resolve!:(result:DownloadTaskPage)=>void;vi.mocked(fetchDownloadTaskPage).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
    await w.get('[data-creator-id="21"] button').trigger('click');await flushPromises();
    await w.get('input').setValue('新版');await w.findAll('select')[0]!.setValue('failed');
    vi.mocked(fetchDownloadCreators).mockResolvedValueOnce(page([row(22,1)]));await w.get('form').trigger('submit');await flushPromises();
    resolve(detail(21));await flushPromises();expect(w.find('[data-creator-id="21"]').exists()).toBe(false);
    await w.get('[data-creator-id="22"] button').trigger('click');await flushPromises();expect(fetchDownloadTaskPage).toHaveBeenLastCalledWith({q:'新版',status:'failed',enabled:'all',creatorId:22,page:1,limit:50});expect(w.get('[data-test=stage2-task]').text()).toContain('作品1');
  });
  it('does not poll or treat an empty page as a global zero',async()=>{
    vi.useFakeTimers();const w=await start();const reads=vi.mocked(fetchDownloadCreators).mock.calls.length;await vi.advanceTimersByTimeAsync(60_000);expect(fetchDownloadCreators).toHaveBeenCalledTimes(reads);vi.useRealTimers();
    vi.mocked(fetchDownloadCreators).mockResolvedValueOnce(page([]));await w.vm.refresh();expect(w.text()).toContain('655 条匹配任务');expect(w.text()).not.toContain('没有匹配');
  });
});
