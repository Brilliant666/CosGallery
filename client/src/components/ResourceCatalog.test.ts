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
  items: [{ ...row }],
  page: 1,
  pageSize: 50,
  total: 101
});
const detail: api.ResourceDetail = {
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
  w.findAll('button').find((b) => b.text() === text)!;
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
    vi.mocked(api.exportResourceCatalog).mockResolvedValue('全部101行');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
  });
  afterEach(() => vi.useRealTimers());
  it('does not load any works before creator selection; resolves names/aliases explicitly', async () => {
    const w = mount(ResourceCatalog, { props: { creatorId: null } });
    await flushPromises();
    expect(api.fetchResourceCatalog).not.toHaveBeenCalled();
    expect(api.findResourceCreators).not.toHaveBeenCalled();
    await w.get('.creator-search input').setValue('别名');
    await w.get('.creator-search').trigger('submit');
    await flushPromises();
    expect(api.findResourceCreators).toHaveBeenCalledWith('别名');
    await button(w, '#2 别名对应博主').trigger('click');
    expect(w.emitted('select')).toEqual([[2]]);
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
    expect(api.fetchResourceDetail).toHaveBeenCalledWith(1, 22, 'r1');
    expect(w.text()).toContain('原目录 NO.003');
    expect(w.text()).toContain('保留原件不包含');
    expect(w.find('a[href="/library/1/works/33"]').exists()).toBe(true);
    await button(w, '收起').trigger('click');
    await button(w, '展开详情').trigger('click');
    await flushPromises();
    expect(api.fetchResourceDetail).toHaveBeenCalledTimes(1);
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
      { q: '中', localState: 'all', source: 'all' },
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
    expect(api.fetchResourceDetail).toHaveBeenCalledWith(1, 22, 'r1');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(row.text);
  });
});
