import { mount } from '@vue/test-utils';
import { describe, it, expect } from 'vitest';
import CreatorSourceStatus from './CreatorSourceStatus.vue';
import type { CreatorSyncRow } from '../api/creator-sync';

const row = (status?: string, source = false) => ({
  sourceWorks: source ? 13 : 0, missingWorks: 0, latestSourceAt: '2026-09-08T01:18:21.983Z',
  sourceState: { metadataAccepted: source, deliveryReady: source, deliveryEvidence: 'verified', missing: [] },
  metadataTask: status ? { id: 32, status, updatedAt: '2026-09-08T01:18:21.983Z', lastError: '原始原因', claimedBy: null } : null,
}) as CreatorSyncRow;
describe('creator source evidence presentation', () => {
  it('shows pending supplemental contents separately even when the numbered check completed', () => {
    const item = { ...row('completed', true), pendingSupplementalTitles: ['微博图'] };
    const view = mount(CreatorSourceStatus, { props: { item } });
    expect(view.text()).toContain('微博图：附加内容待人工处理，不参与自动下载/入库');
    expect(view.text()).toContain('编号作品网盘来源已核验');
    expect(view.text()).toContain('来源 13 套 · 已知缺失 0 套');
  });
  it('distinguishes unchecked from a completed search with no match and hides misleading zero counts', () => {
    const unchecked = mount(CreatorSourceStatus, { props: { item: row() } });
    expect(unchecked.text()).toContain('尚未检查来源');
    expect(unchecked.text()).not.toContain('0 套');
    expect(unchecked.find('details').exists()).toBe(false);
    const missing = mount(CreatorSourceStatus, { props: { item: row('not_found') } });
    expect(missing.text()).toContain('上次检查未找到合集');
    expect(missing.text()).not.toContain('0 套');
    expect(missing.get('details').attributes('open')).toBeUndefined();
    expect(missing.get('details').text()).toContain('任务 #32');
    expect(missing.get('details').text()).toContain('原始原因');
    expect(missing.text()).not.toContain('2026-09-08T');
  });
  it.each(['failed', 'not_found', 'pending', 'claimed', 'cancelled'])('preserves successful evidence despite latest %s attempt', status => {
    const w = mount(CreatorSourceStatus, { props: { item: row(status, true) } });
    expect(w.get('strong').text()).toBe('已有有效来源');
    expect(w.text()).toContain('来源 13 套 · 已知缺失 0 套');
    expect(w.text()).toContain('最近检查');
  });
  it.each([['failed', '来源检查失败'], ['pending', '来源待检查'], ['claimed', '来源检查已领取'], ['cancelled', '来源检查已取消']])('does not call %s uncollected', (status, label) => {
    expect(mount(CreatorSourceStatus, { props: { item: row(status) } }).get('strong').text()).toBe(label);
  });
});
