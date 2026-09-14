import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SourceReuseReview from './SourceReuseReview.vue';
import { fetchSourceReuse } from '../api/source-reuse';
vi.mock('../api/source-reuse', () => ({ fetchSourceReuse: vi.fn() }));
describe('SourceReuseReview', () => {
  beforeEach(() => vi.clearAllMocks());
  it('reads only when expanded, explains reuse and review, and paginates', async () => {
    vi.mocked(fetchSourceReuse).mockResolvedValue({ items: [
      { creatorId: 1, creatorName: '样本', collectionId: 1, sourceOrder: '001', rawTitle: '女巫', normalizedTitle: '女巫', status: 'reuse', reason: '唯一候选', satisfied: true, ruleVersion: '1' },
      { creatorId: 1, creatorName: '样本', collectionId: 1, sourceOrder: '002', rawTitle: '少女', normalizedTitle: '少女', status: 'review', reason: '多个候选', satisfied: false, ruleVersion: '1' }
    ], total: 101, page: 1, limit: 20, hasMore: true });
    const wrapper = mount(SourceReuseReview);
    expect(fetchSourceReuse).not.toHaveBeenCalled();
    wrapper.get('details').element.open = true;
    await wrapper.get('details').trigger('toggle'); await flushPromises();
    expect(fetchSourceReuse).toHaveBeenCalledWith(1);
    expect(wrapper.text()).toContain('本地已有无需获取');
    expect(wrapper.text()).toContain('待确认原因：多个候选');
    expect(wrapper.text()).toContain('共 101 条');
    await wrapper.findAll('button').at(-1)!.trigger('click'); await flushPromises();
    expect(fetchSourceReuse).toHaveBeenLastCalledWith(2);
  });
  it('reports read errors without an execution action', async () => {
    vi.mocked(fetchSourceReuse).mockRejectedValue(new Error('offline'));
    const wrapper = mount(SourceReuseReview);
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('未执行任何关联操作');
    expect(wrapper.findAll('button')).toHaveLength(1);
  });
});
