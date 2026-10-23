import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AdmissionErrorNotice from '../components/AdmissionErrorNotice.vue';
import type { AdmissionBatch, AdmissionItem } from '../types/local-admission';
import { admissionErrorMessage, admissionExecutionSummary, admissionIssueKind, admissionItemError, admissionItemPhase, admissionQueueNotice } from './admission-execution-display';

const item = (overrides: Partial<AdmissionItem> = {}): AdmissionItem => ({
  key: 'album', sourceRelativePath: '合成图集', targetPath: 'R:/图库/合成图集', displayTitle: '合成图集', group: 'A',
  summary: { images: 1, videos: 0, other: 0, bytes: 1 }, candidates: [], conflicts: [], ads: [], state: 'not_started', ...overrides
});
const review = item({state:'files_verified',lastError:'Scoped media indexing did not complete',executionIssue:{kind:'review',code:'MEDIA_INDEX_INCOMPLETE',message:'图集索引未完成，请核对异常文件'}});

describe('local admission execution display', () => {
  it('translates historical indexing failures and keeps unknown errors out of visible English notices', () => {
    expect(admissionErrorMessage('Scoped media indexing did not complete: fixture.jpg')).toBe('图集索引未完成，请核对异常文件');
    expect(admissionErrorMessage('SQLITE_BUSY: database is locked')).toBe('入库未完成，请查看技术详情并核对原因');
    expect(admissionErrorMessage('EACCES: permission denied, open 图集甲/001.jpg')).toBe('入库未完成，请查看技术详情并核对原因');
    expect(admissionErrorMessage('EACCES: permission denied, open 图集甲/001.jpg', 'EACCES: permission denied, open 图集甲/001.jpg')).toBe('入库未完成，请查看技术详情并核对原因');
    expect(admissionErrorMessage('raw English', '磁盘读取失败，请核对权限')).toBe('磁盘读取失败，请核对权限');
    expect(admissionErrorMessage(null)).toBe('');
  });

  it('explains historical and structured unsupported media failures in Chinese', () => {
    const raw = 'No supported media found; nothing admitted';
    const message = '目录中未找到支持入库的图片或视频，请核对文件格式';
    expect(admissionErrorMessage(raw)).toBe(message);
    expect(admissionErrorMessage(null, raw)).toBe(message);
    expect(admissionErrorMessage(null, null, 'NO_SUPPORTED_MEDIA')).toBe(message);
    const unsupported = item({lastError:'Unsupported media in fixture',executionIssue:{kind:'review',code:'NO_SUPPORTED_MEDIA',message:'Unsupported media'}});
    expect(admissionItemError(unsupported)).toBe(message);
    expect(admissionErrorMessage(raw, '目录没有支持的媒体，请先核对内容', 'NO_SUPPORTED_MEDIA')).toBe('目录没有支持的媒体，请先核对内容');
    expect(admissionQueueNotice(false, [], [{state:'needs_review',error:raw} as AdmissionBatch])).toBe(`队列已暂停：${message}`);
  });

  it('shows the unsupported media code in Chinese while retaining the original technical evidence', () => {
    const raw = 'No supported media found; nothing admitted';
    const wrapper = mount(AdmissionErrorNotice, {props:{error:'Unsupported media in fixture',issue:{kind:'review',code:'NO_SUPPORTED_MEDIA',message:'Unsupported media',detail:raw}}});
    expect(wrapper.get('[data-test=admission-error-message]').text()).toBe('目录中未找到支持入库的图片或视频，请核对文件格式');
    expect(wrapper.get('[data-test=admission-error-detail]').text()).toContain(raw);
    expect(wrapper.get('[data-test=admission-error-detail]').text()).toContain('NO_SUPPORTED_MEDIA');
    wrapper.unmount();
  });

  it('keeps an explicit system failure classified as system even with an indexing error', () => {
    const system = item({...review,executionIssue:{kind:'system',code:'EIO',message:'读取图集失败，请核对磁盘'}});
    expect(admissionIssueKind(system)).toBe('system');
    expect(admissionItemPhase(system)).toBe('异常暂停 · 文件已核验');
    expect(admissionItemPhase(review)).toBe('待审核');
    expect(admissionItemPhase(item({executionIssue:{kind:'dependency',code:'DEPENDENCY_NOT_READY',message:'目标图集待审核',blockedByItemKey:'album'}}))).toBe('等待依赖');
    expect(admissionItemPhase(item({state:'defer'}))).toBe('人工暂缓，等待区保留');
  });

  it('treats historical errors as an unknown system pause even when a review entry is available', () => {
    for (const lastError of ['Scoped media indexing did not complete', 'SQLITE_BUSY: database is locked']) {
      const historical = item({state:'files_verified',lastError,nextAction:'review_files'});
      expect(admissionIssueKind(historical)).toBe('system');
      expect(admissionQueueNotice(false,[historical,item()],[{state:'needs_review',error:lastError,items:[historical,item()]} as AdmissionBatch])).toContain('队列因异常暂停');
    }
    expect(admissionQueueNotice(false,[],[{state:'needs_review',error:'Scoped media indexing did not complete'} as AdmissionBatch])).toBe('队列已暂停：图集索引未完成，请核对异常文件');
  });

  it('uses authoritative separate totals and never treats deferred or dependency items as unstarted', () => {
    const totals = {total:7,selected:5,completed:2,skipped:1,deferred:1,review:1,dependency:1,unstarted:1};
    expect(admissionExecutionSummary(totals)).toBe('2 已完成 · 1 待审核 · 1 等待依赖 · 1 尚未执行 · 1 人工暂缓 · 1 跳过');
    expect(admissionExecutionSummary({...totals,unstarted:undefined}, [review,item({state:'defer'}),item({executionIssue:{kind:'dependency',code:'WAIT',message:'等待目标'}}),item()])).toContain('1 尚未执行');
    expect(admissionExecutionSummary({total:1,selected:0,completed:0,skipped:0,deferred:1}, [item()])).toContain('0 尚未执行');
  });

  it('explains continued work, retained review and dependency items, and system pauses separately', () => {
    const items = [review,item({executionIssue:{kind:'dependency',code:'WAIT',message:'等待目标'}})];
    expect(admissionQueueNotice(true,items,[])).toBe('异常项已保留，其余可执行图集继续处理');
    expect(admissionQueueNotice(false,items,[])).toBe('可执行项目已处理，剩余项目待审核或等待依赖');
    const system = item({lastError:'EIO',executionIssue:{kind:'system',code:'EIO',message:'磁盘读取失败'}});
    expect(admissionQueueNotice(false,[...items,system],[])).toBe('队列因异常暂停：磁盘读取失败');
    expect(admissionQueueNotice(true,[system],[])).toBe('服务端正在执行，异常结果仍保留，请等待最新进度');
    expect(admissionQueueNotice(true,[...items,system],[])).toBe('异常项已保留，其余可执行图集继续处理');
    expect(admissionQueueNotice(false,[],[{state:'interrupted'} as AdmissionBatch])).toContain('队列已暂停');
    expect(admissionQueueNotice(false,[],[{state:'needs_review',error:'EIO: fixture disk error',errorMessage:'磁盘读取失败'} as AdmissionBatch])).toBe('队列已暂停：磁盘读取失败');
    expect(admissionQueueNotice(false,items,[{state:'needs_review',error:'EIO: fixture disk error',errorMessage:'磁盘读取失败',totals:{review:1}} as AdmissionBatch])).toBe('队列已暂停：磁盘读取失败');
    expect(admissionQueueNotice(false,[...items,item()],[{state:'needs_review',error:'部分图集需要核对；其余独立图集已按原计划执行',totals:{unstarted:1}} as AdmissionBatch])).toBe('本计划仍有未执行项，请核对原因后继续');
    expect(admissionQueueNotice(false,[...items,item()],[{state:'needs_review',error:review.lastError,items:[review],totals:{unstarted:1}} as AdmissionBatch])).toBe('本计划仍有未执行项，请核对原因后继续');
  });
});
