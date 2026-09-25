import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResourceCatalog from './ResourceCatalog.vue';
import * as api from '../api/resource-catalog';
import { RequestError } from '../api/http';
import { useCreatorReadingStore } from '../stores/creator-reading';
vi.mock('../api/resource-catalog', () => ({
  fetchResourceCatalog: vi.fn(),
  findResourceCreators: vi.fn(),
  fetchResourceDetail: vi.fn(),
  exportResourceCatalog: vi.fn()
}));
const row: api.ResourceRow = {
  creatorId: 1,
  creatorName: '博主1',
  workId: 22,
  no: 'NO.051',
  title: '同名作品',
  sortTimestamp: 1700000000000,
  primaryPostId: 33,
  primaryLocalWorkId: 44,
  imageCount: 31,
  videoCount: 0,
  mediaBytes: 1048576,
  originalDirectory: '原目录 NO.003',
  localState: 'indexed',
  reason: null,
  statisticsBasis: 'indexed',
  copyCount: 2,
  sources: [],
  text: '博主 NO.051 同名作品 [31P-1MiB]'
};
const page = (id = 1): api.ResourcePage => ({
  readModel: { status: 'ready', complete: true, pendingCreators: 0, failedCreators: 0, initializedCreators: 1, totalCreators: 1, updatedAt: '2026-09-19' },
  creator: { id, canonicalName: `博主${id}` },
  revision: `r${id}`,
  generatedAt: '2026-09-19',
  sortOrder: 'newest',
  summary: {
    totalWorks: 101,
    numberedWorks: 100,
    unarrangedWorks: 1,
    multipleCopyWorks: 1,
    unavailableWorks: 1,
    sourceOnlyWorks: 5,
    legacyPosts: 1,
    excludedDeletedWorks: 1
  },
  legacyGaps: [{ postId: 90, title: '历史图集', reason: '缺少可靠作品关系' }],
  items: [{ ...row, creatorId: id, creatorName: `博主${id}` }],
  page: 1,
  pageSize: 50,
  total: 101
});
const detail: api.ResourceDetail = {
  readModel: page().readModel,
  revision: 'r1',
  item: row,
  copies: [
    {
      localWorkId: 44,
      postId: 33,
      directoryName: row.originalDirectory!,
      primary: true,
      indexedAvailable: true,
      imageCount: 31,
      videoCount: 0,
      mediaBytes: 1048576,
      otherFileCount: 2,
      retainedOriginalCount: 1
    }
  ],
  notes: ['保留原件不包含在媒体容量内']
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const button = (w: ReturnType<typeof mount>, text: string) =>
  text === '展开详情' || text === '收起'
    ? w.get('.catalog-row')
    : w.findAll('button').find((b) => b.text() === text)!;
describe('resource catalog', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.fetchResourceCatalog).mockResolvedValue(page());
    vi.mocked(api.fetchResourceDetail).mockResolvedValue(detail);
    vi.mocked(api.findResourceCreators).mockResolvedValue({
      items: [
        {
          id: 2,
          canonicalName: '别名对应博主',
          preference: 'kept',
          enabled: true
        }
      ],
      total: 1
    });
    vi.mocked(api.exportResourceCatalog).mockResolvedValue({ text: '全部101行', metadata: null });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
  });
  afterEach(() => vi.useRealTimers());
  it('defaults to global data and uses a lightweight explicit name/alias picker', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: null } });
    await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenCalledWith(null, expect.any(Object), 1, undefined);
    expect(api.exportResourceCatalog).not.toHaveBeenCalled();
    expect(w.find('table').exists()).toBe(true);
    expect(w.find('.filters').exists()).toBe(true);
    expect(w.get('[data-test="view-all"]').attributes('disabled')).toBeDefined();
    expect(w.find('#resource-creator-picker').exists()).toBe(false);
    expect(api.fetchResourceDetail).not.toHaveBeenCalled();
    expect(api.findResourceCreators).not.toHaveBeenCalled();
    await w.get('.creator-search input').setValue('别名');
    await w.get('.creator-search').trigger('submit');
    await flushPromises();
    expect(api.findResourceCreators).toHaveBeenCalledWith('别名');
    expect(w.text()).not.toContain('查找博主');
    expect(w.get('.choices').text()).not.toContain('#2');
    await button(w, '别名对应博主').trigger('click');
    expect(w.emitted('select')).toEqual([[2]]);
    expect(w.find('.choices').exists()).toBe(false);
    expect((w.get('.creator-search input').element as HTMLInputElement).value).toBe('');
  });
  it('clearing selection isolates late global results and performs no new global read', async () => {
    const slow = deferred<api.ResourcePage>();
    vi.mocked(api.fetchResourceCatalog).mockReturnValueOnce(slow.promise);
    const w = mount(ResourceCatalog, { props: { creatorId: null, globalScope: true } });
    await w.setProps({ creatorId: 2, globalScope: false });
    await flushPromises();
    slow.resolve({ ...page(), creator: null });
    await flushPromises();
    expect(w.get('[data-test="view-all"]').attributes('aria-pressed')).toBe('false');
    expect(w.get('.current-creator').text()).toContain('当前博主');
    await w.get('[data-test="view-all"]').trigger('click');
    expect(w.emitted('all')).toEqual([[]]);
    await w.setProps({ creatorId: null });
    await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(2);
    expect(w.find('table').exists()).toBe(false);
    expect(w.text()).toContain('全部博主');
  });
  it('keeps secondary controls collapsed without hiding read-model failures', async () => {
    const p = page();
    p.readModel.status = 'failed';
    vi.mocked(api.fetchResourceCatalog).mockResolvedValue(p);
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    expect(w.get('.filters').isVisible()).toBe(true);
    expect(w.get('#resource-export').isVisible()).toBe(false);
    expect(w.text()).toContain('目录更新失败');
    expect(button(w, '导出 CSV').attributes('disabled')).toBeDefined();
  });
  it('keeps full-catalog NO across filters and pagination and requests details only on demand', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    expect(w.text()).toContain('NO.051');
    expect(api.fetchResourceDetail).not.toHaveBeenCalled();
    await button(w, '下一页').trigger('click');
    await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenLastCalledWith(
      1,
      expect.any(Object),
      2,
      'r1'
    );
    await button(w, '展开详情').trigger('click');
    await flushPromises();
    expect(api.fetchResourceDetail).toHaveBeenCalledWith(1, 22, 'r1', undefined);
    expect(w.text()).toContain('原目录 NO.003');
    expect(w.text()).toContain('保留原件不包含');
    expect(w.find('a[href="/library/1/works/33"]').exists()).toBe(true);
    await button(w, '收起').trigger('click');
    await button(w, '展开详情').trigger('click');
    await flushPromises();
    expect(api.fetchResourceDetail).toHaveBeenCalledTimes(1);
  });
  it('labels only estimated rows and loads source-order evidence inside details on demand', async () => {
    const estimate: api.ResourceSortEstimate = {
      method: 'source-order-interpolation', sourceOrder: 51,
      originalTimestamp: 1200000000000,
      lower: { workId: 20, sourceOrder: 50, timestamp: 1690000000000 },
      upper: { workId: 25, sourceOrder: 53, timestamp: 1720000000000 }
    };
    const estimated = { ...row, sortEstimate: estimate };
    const p = page();
    p.items = [estimated, { ...row, workId: 23 }];
    vi.mocked(api.fetchResourceCatalog).mockResolvedValue(p);
    vi.mocked(api.fetchResourceDetail).mockResolvedValue({ ...detail, item: estimated });
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    expect(w.findAll('[data-test="sort-estimate"]')).toHaveLength(1);
    expect(w.find('[data-test="sort-estimate-basis"]').exists()).toBe(false);
    expect(api.fetchResourceDetail).not.toHaveBeenCalled();
    await button(w, '展开详情').trigger('click');
    await flushPromises();
    const basis = w.get('[data-test="sort-estimate-basis"]');
    expect(basis.text()).toContain('来源 NO.51');
    expect(basis.text()).toContain('前参照 Work #20（来源 NO.50');
    expect(basis.text()).toContain('后参照 Work #25（来源 NO.53');
    for (const timestamp of [row.sortTimestamp!, estimate.originalTimestamp, estimate.lower.timestamp, estimate.upper.timestamp]) {
      expect(basis.text()).toContain(new Date(timestamp).toLocaleString());
    }
    expect(basis.text()).toContain('不是已证实的发布日期或拍摄时间');
    expect(basis.text()).toContain('不随浏览重新插值');
    await button(w, '收起').trigger('click');
    expect(w.find('[data-test="sort-estimate-basis"]').exists()).toBe(false);
    expect(w.findAll('[data-test="sort-estimate"]')).toHaveLength(1);
  });
  it('does not describe an ordinary or legacy confirmed time as an estimate', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    await button(w, '展开详情').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="sort-estimate"]').exists()).toBe(false);
    expect(w.find('[data-test="sort-estimate-basis"]').exists()).toBe(false);
  });
  it('ignores late creator/detail failures after switching creator', async () => {
    const slow = deferred<api.ResourcePage>();
    vi.mocked(api.fetchResourceCatalog).mockReturnValueOnce(slow.promise);
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    vi.mocked(api.fetchResourceCatalog).mockResolvedValueOnce(page(2));
    await w.setProps({ creatorId: 2 });
    await flushPromises();
    slow.resolve(page(1));
    await flushPromises();
    expect(w.text()).toContain('博主2');
    expect(w.text()).not.toContain('博主1');
    const d = deferred<api.ResourceDetail>();
    vi.mocked(api.fetchResourceDetail).mockReturnValueOnce(d.promise);
    await button(w, '展开详情').trigger('click');
    await w.setProps({ creatorId: 3 });
    await flushPromises();
    d.reject(new Error('old failure'));
    await flushPromises();
    expect(w.text()).not.toContain('old failure');
  });
  it('keeps old snapshot and disables pagination/export on 409 until explicit refresh', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    vi.mocked(api.fetchResourceCatalog).mockRejectedValueOnce(
      new RequestError('changed', 409)
    );
    await button(w, '下一页').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('请刷新');
    expect(w.text()).toContain('NO.051');
    expect(button(w, '导出 CSV').attributes('disabled')).toBeDefined();
    await button(w, '刷新目录').trigger('click');
    await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenLastCalledWith(
      1,
      expect.any(Object),
      1,
      undefined
    );
    expect(button(w, '导出 CSV').attributes('disabled')).toBeUndefined();
  });
  it('update signal only marks stale, without requesting or renumbering the page', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    useCreatorReadingStore().invalidate();
    await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(1);
    expect(w.text()).toContain('作品数据已更新');
    expect(w.text()).toContain('NO.051');
  });
  it('debounces search and waits for Chinese composition', async () => {
    vi.useFakeTimers();
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    const input = w.get('.filters input');
    await input.trigger('compositionstart');
    await input.setValue('中');
    await vi.advanceTimersByTimeAsync(400);
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(1);
    await input.trigger('compositionend');
    await vi.advanceTimersByTimeAsync(251);
    await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenLastCalledWith(
      1,
      { q: '中', localState: 'all', source: 'all', order: 'oldest' },
      1,
      'r1'
    );
  });
  it('exports full or filtered scope through server, never only the displayed page', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    await button(w, '复制目录').trigger('click');
    await flushPromises();
    expect(api.exportResourceCatalog).toHaveBeenLastCalledWith(
      1,
      expect.any(Object),
      'r1',
      'all',
      'txt'
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('全部101行');
    await w.get('[data-test="export-scope"]').setValue('filtered');
    await button(w, '复制目录').trigger('click');
    await flushPromises();
    expect(api.exportResourceCatalog).toHaveBeenLastCalledWith(
      1,
      expect.any(Object),
      'r1',
      'filtered',
      'txt'
    );
    vi.mocked(api.exportResourceCatalog).mockRejectedValueOnce(
      new RequestError('changed', 409)
    );
    await button(w, '复制目录').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('编排已变化');
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
  });
  it('validates revision when copying a single item and labels unknown statistics honestly', async () => {
    const p = page();
    p.items[0] = {
      ...row,
      imageCount: null,
      videoCount: null,
      mediaBytes: null,
      no: null,
      localState: 'unarranged'
    };
    vi.mocked(api.fetchResourceCatalog).mockResolvedValue(p);
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    expect(w.text()).toContain('容量未知');
    await button(w, '复制单条').trigger('click');
    await flushPromises();
    expect(api.fetchResourceDetail).toHaveBeenCalledWith(1, 22, 'r1', undefined);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(row.text);
  });
  it('ignores blank and composing Enter, searches only on committed Enter without changing scope', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    const input = w.get('.creator-search input');
    await input.setValue('   ');
    await input.trigger('keydown', { key: 'Enter' });
    await w.get('.creator-search').trigger('submit');
    expect(api.findResourceCreators).not.toHaveBeenCalled();
    await input.setValue('神');
    await input.trigger('compositionstart');
    await input.trigger('keydown', { key: 'Enter', isComposing: true });
    await w.get('.creator-search').trigger('submit');
    expect(api.findResourceCreators).not.toHaveBeenCalled();
    await input.trigger('compositionend');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.findResourceCreators).toHaveBeenCalledExactlyOnceWith('神');
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(1);
    expect(w.emitted('select')).toBeUndefined();
    expect(w.emitted('all')).toBeUndefined();
  });
  it('dismisses with Escape or outside pointer/focus, and never reopens merely on focus', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 }, attachTo: document.body });
    await flushPromises();
    const input = w.get('.creator-search input');
    await input.setValue('神');
    for (const cancel of ['escape', 'pointer', 'focus']) {
      await input.trigger('keydown', { key: 'Enter' });
      await flushPromises();
      expect(w.find('.choices').exists()).toBe(true);
      if (cancel === 'escape') {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        input.element.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      else if (cancel === 'pointer') document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      else await w.get('.filters input').trigger('focusin');
      await flushPromises();
      expect(w.find('.choices').exists()).toBe(false);
      expect((input.element as HTMLInputElement).value).toBe('神');
      await input.trigger('focus');
      expect(w.find('.choices').exists()).toBe(false);
    }
    expect(api.findResourceCreators).toHaveBeenCalledTimes(3);
    expect(w.emitted('select')).toBeUndefined();
    expect(w.emitted('all')).toBeUndefined();
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(1);
  });
  it.each(['edit', 'escape', 'outside', 'all', 'scope', 'unmount'])('ignores a late search after %s', async (action) => {
    const pending = deferred<Awaited<ReturnType<typeof api.findResourceCreators>>>();
    vi.mocked(api.findResourceCreators).mockReturnValueOnce(pending.promise);
    const w = mount(ResourceCatalog, { props: { creatorId: 1 }, attachTo: document.body });
    await flushPromises();
    const input = w.get('.creator-search input');
    await input.setValue('神');
    await w.get('.creator-search').trigger('submit');
    expect(w.text()).toContain('正在查找博主');
    if (action === 'edit') await input.setValue('');
    if (action === 'escape') await input.trigger('keydown', { key: 'Escape' });
    if (action === 'outside') document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    if (action === 'all') await w.get('[data-test="view-all"]').trigger('click');
    if (action === 'scope') await w.setProps({ creatorId: 2 });
    if (action === 'unmount') w.unmount();
    pending.resolve({ items: [{ id: 2, canonicalName: '迟到的博主', enabled: true, preference: null }], total: 1 });
    await flushPromises();
    expect(w.find('.choices').exists()).toBe(false);
    if (action !== 'unmount') expect(w.text()).not.toContain('正在查找博主');
    if (action === 'edit') expect(w.emitted('all')).toBeUndefined();
  });
  it('reports empty/error searches locally and shows IDs only for ambiguous names', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    const input = w.get('.creator-search input');
    await input.setValue('神');
    vi.mocked(api.findResourceCreators).mockResolvedValueOnce({ items: [], total: 0 });
    await input.trigger('keydown', { key: 'Enter' }); await flushPromises();
    expect(w.text()).toContain('没有符合名称或别名的博主');
    vi.mocked(api.findResourceCreators).mockRejectedValueOnce(new Error('搜索暂时失败'));
    await input.trigger('keydown', { key: 'Enter' }); await flushPromises();
    expect(w.get('.creator-picker [role="status"]').text()).toBe('搜索暂时失败');
    expect(w.find('[role="alert"]').exists()).toBe(false);
    const items = [2, 3].map(id => ({ id, canonicalName: '同名博主', enabled: true, preference: null }));
    vi.mocked(api.findResourceCreators).mockResolvedValueOnce({ items, total: 3 });
    await input.trigger('keydown', { key: 'Enter' }); await flushPromises();
    expect(w.get('.choices').text()).toContain('身份 #2');
    expect(w.get('.choices').text()).toContain('身份 #3');
    expect(w.text()).toContain('共 3 位，请缩小搜索范围');
    await w.get('.choices button').trigger('click');
    expect(w.emitted('select')).toEqual([[2]]);
    expect(w.find('.choices').exists()).toBe(false);
    expect(w.text()).not.toContain('请缩小搜索范围');
  });
  it('global rows keep their own creator links and global revision on detail reads', async () => {
    const p = page(2);
    p.creator = null;
    vi.mocked(api.fetchResourceCatalog).mockResolvedValue(p);
    const w = mount(ResourceCatalog, { props: { creatorId: null, globalScope: true } });
    await flushPromises();
    expect(w.text()).toContain('全部博主');
    expect(w.find('a[href="/library/2/works/33"]').exists()).toBe(true);
    expect(api.fetchResourceDetail).not.toHaveBeenCalled();
    await button(w, '展开详情').trigger('click');
    await flushPromises();
    expect(api.fetchResourceDetail).toHaveBeenCalledWith(2, 22, 'r2', 'all');
    expect(w.get('[data-test="view-all"]').attributes('aria-pressed')).toBe('true');
    expect(w.get('[data-test="view-all"]').attributes('disabled')).toBeDefined();
  });
  it('discloses incomplete initialization, blocks export, and polls a new revision without overlapping requests', async () => {
    vi.useFakeTimers();
    const p = page();
    p.readModel = { ...p.readModel, status: 'uninitialized', complete: false, pendingCreators: 2, initializedCreators: 0, totalCreators: 2 };
    vi.mocked(api.fetchResourceCatalog).mockResolvedValueOnce(p);
    const w = mount(ResourceCatalog, { props: { creatorId: null, globalScope: true } });
    await flushPromises();
    expect(w.text()).toContain('当前目录尚不完整');
    expect(button(w, '导出 TXT').attributes('disabled')).toBeDefined();
    const pending = deferred<api.ResourcePage>();
    vi.mocked(api.fetchResourceCatalog).mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.fetchResourceCatalog).toHaveBeenLastCalledWith(null, expect.any(Object), 1, undefined);
    await vi.advanceTimersByTimeAsync(9000);
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(2);
    pending.resolve(page());
    await flushPromises();
    expect(button(w, '导出 TXT').attributes('disabled')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(2);
  });
  it('cancels pending polling when the workspace is unmounted', async () => {
    vi.useFakeTimers();
    const p = page();
    p.readModel.status = 'failed';
    vi.mocked(api.fetchResourceCatalog).mockResolvedValue(p);
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    expect(w.text()).toContain('目录更新失败');
    w.unmount();
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(1);
  });
  it('polls the same page without resetting expanded detail, then marks a new version for explicit refresh', async () => {
    vi.useFakeTimers();
    const p = page();
    p.page = 2;
    p.readModel.status = 'updating';
    vi.mocked(api.fetchResourceCatalog).mockImplementation(async () => structuredClone(p));
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    await button(w, '展开详情').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenLastCalledWith(1, expect.any(Object), 2, undefined);
    expect(button(w, '收起').exists()).toBe(true);
    expect(api.fetchResourceDetail).toHaveBeenCalledTimes(1);
    const changed = page();
    changed.revision = 'r-new';
    changed.items[0]!.no = 'NO.099';
    vi.mocked(api.fetchResourceCatalog).mockResolvedValue(changed);
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(w.text()).toContain('NO.051');
    expect(w.text()).not.toContain('NO.099');
    expect(w.text()).toContain('目录版本已变化');
    expect(button(w, '导出 TXT').attributes('disabled')).toBeDefined();
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.fetchResourceCatalog).toHaveBeenCalledTimes(3);
    await button(w, '刷新目录').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('NO.099');
  });
  it('downloads CSV and its received metadata together with a matching revision filename', async () => {
    const metadata = { revision: 'r1', creatorId: 1, rowCount: 101 };
    vi.mocked(api.exportResourceCatalog).mockResolvedValue({ text: 'csv', metadata });
    const create = vi.fn().mockReturnValue('blob:test');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { names.push(this.download); });
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } });
    await flushPromises();
    await button(w, '导出 CSV').trigger('click');
    await flushPromises();
    expect(names).toEqual(['CosGallery-1-r1.csv', 'CosGallery-1-r1.metadata.json']);
    expect(create).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });
  it('keeps scope counts while applying visible exception/source/search filters and preserves zero selected states', async () => {
    const p = page(); p.summary.unlinkedWorks = 70; p.total = 12;
    vi.mocked(api.fetchResourceCatalog).mockResolvedValue(p);
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } }); await flushPromises();
    expect(w.get('.scope-count').text()).toBe('完整目录 101 套');
    expect(w.get('.filtered-count').text()).toBe('当前筛选 12 套');
    expect(w.find('.filters input[type="checkbox"]').exists()).toBe(false);
    expect(w.find('.status-tags button').exists()).toBe(false);
    await w.get('[data-test="local-state"]').setValue('exception'); await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenLastCalledWith(1, expect.objectContaining({ localState: 'exception', source: 'all' }), 1, 'r1');
    await w.get('[data-test="source-filter"]').setValue('unlinked'); await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenLastCalledWith(1, expect.objectContaining({ localState: 'exception', source: 'unlinked' }), 1, 'r1');
    const zero = page(); zero.summary.unavailableWorks = 0; zero.total = 0; zero.items = [];
    vi.mocked(api.fetchResourceCatalog).mockResolvedValueOnce(zero);
    expect(w.get('[data-test="combined-filters"]').text()).toBe('同时满足：只看异常 · 未关联来源');
    await w.get('[data-test="local-state"]').setValue('unavailable'); await flushPromises();
    expect((w.get('[data-test="local-state"]').element as HTMLSelectElement).value).toBe('unavailable');
    expect(w.get('.status-tags').text()).toContain('主副本不可用 0');
    expect(w.text()).toContain('当前筛选没有作品');
    await button(w, '清除筛选').trigger('click'); await flushPromises();
    expect(api.fetchResourceCatalog).toHaveBeenLastCalledWith(1, expect.objectContaining({ localState: 'all', source: 'all', q: '' }), 1, 'r1');
  });
  it('supports keyboard details and keeps row actions and selected text from expanding', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } }); await flushPromises();
    const rowElement = w.get('.catalog-row');
    expect(rowElement.attributes('aria-expanded')).toBe('false');
    expect(rowElement.get('.detail-indicator').text()).toBe('›');
    w.get('.row-actions a').element.addEventListener('click', event => event.preventDefault());
    await w.get('.row-actions a').trigger('click');
    await button(w, '复制单条').trigger('click'); await flushPromises();
    expect(rowElement.attributes('aria-expanded')).toBe('false');
    expect(api.fetchResourceDetail).toHaveBeenCalledTimes(1);
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'selected title' } as Selection);
    await rowElement.trigger('click'); expect(rowElement.attributes('aria-expanded')).toBe('false');
    selection.mockRestore();
    await rowElement.trigger('keydown', { key: 'Enter' }); await flushPromises();
    expect(rowElement.attributes('aria-expanded')).toBe('true');
    expect(rowElement.get('.detail-indicator').text()).toBe('⌄');
    expect(w.get(`#${rowElement.attributes('aria-controls')}`).exists()).toBe(true);
    expect(api.fetchResourceDetail).toHaveBeenCalledTimes(2);
    await rowElement.trigger('keydown', { key: ' ' });
    expect(rowElement.attributes('aria-expanded')).toBe('false');
    expect(w.get('.catalog-row').text()).not.toContain('0V');
  });
  it('invalid explicit scope never reads all and a late export cannot download into a new page', async () => {
    const invalid = mount(ResourceCatalog, { props: { creatorId: null, globalScope: false, scopeError: '无效博主链接' } });
    await flushPromises(); expect(api.fetchResourceCatalog).not.toHaveBeenCalled();
    expect(invalid.get('[role="alert"]').text()).toBe('无效博主链接'); invalid.unmount();
    const pending = deferred<{ text: string; metadata: Record<string, unknown> | null }>();
    vi.mocked(api.exportResourceCatalog).mockReturnValueOnce(pending.promise);
    const w = mount(ResourceCatalog, { props: { creatorId: 1 } }); await flushPromises();
    await button(w, '复制目录').trigger('click');
    await button(w, '下一页').trigger('click'); await flushPromises();
    pending.resolve({ text: 'late export', metadata: null }); await flushPromises();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(w.text()).not.toContain('已复制');
  });
});
