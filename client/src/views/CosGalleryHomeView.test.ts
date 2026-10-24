import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useCreatorReadingStore } from '../stores/creator-reading';
import CosGalleryHomeView from './CosGalleryHomeView.vue';
import { fetchCosGalleryCreators } from '../api/gallery';

vi.mock('../api/gallery', () => ({ fetchCosGalleryCreators: vi.fn() }));
const routerState = vi.hoisted(() => ({
  route: { name: 'library', query: {} as Record<string, string | string[]>, fullPath: '/library' },
  replace: vi.fn(),
  push: vi.fn()
}));
vi.mock('vue-router', async (importOriginal) => {
  const { reactive } = await import('vue');
  routerState.route = reactive(routerState.route);
  return { ...await importOriginal<typeof import('vue-router')>(), onBeforeRouteLeave: vi.fn(), onBeforeRouteUpdate: vi.fn(), useRoute: () => routerState.route, useRouter: () => ({ replace: routerState.replace, push: routerState.push }) };
});

type CreatorPage = Awaited<ReturnType<typeof fetchCosGalleryCreators>>;
function creatorPage(total: number, page: number): CreatorPage {
  return { total, page, limit: 60, hasMore: page * 60 < total,
    summary: { all: total, R15: 0, R18: total, unclassified: 0, unlinked: 0, inactive: 0 },
    items: total && page <= Math.ceil(total / 60) ? [{
      key: 'creator:1', identityType: 'creator', id: 1, slug: 'one', name: 'Last valid page creator',
      canonicalCreatorId: 1, canonicalName: 'Last valid page creator', contentRating: 'R18',
      linkStatus: 'linked', rosterStatus: 'active', workCount: 1, folderIds: [10], folderNames: ['one'], aliases: []
    }] : [] };
}

describe('managed gallery classifications', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchCosGalleryCreators).mockReset();
    routerState.replace.mockReset().mockImplementation(async location => {
      routerState.route.query = location.query;
      routerState.route.fullPath = '/library?' + new URLSearchParams(location.query).toString();
    });
    routerState.push.mockReset().mockImplementation(routerState.replace);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    routerState.route.query = {};
    routerState.route.fullPath = '/library';
  });
  it('retries the current library query and page, ignoring unsubmitted search text', async () => {
    routerState.route.query = { q: ['applied', 'ignored'], rating: 'R18', page: '2' };
    routerState.route.fullPath = '/library?q=applied&q=ignored&rating=R18&page=2';
    vi.mocked(fetchCosGalleryCreators).mockRejectedValueOnce(new Error('Offline'));
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } });
    await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('Offline');
    expect(wrapper.text()).not.toContain('没有符合当前条件');
    await wrapper.get('input[type=search]').setValue('not submitted');
    vi.mocked(fetchCosGalleryCreators).mockResolvedValueOnce(creatorPage(120, 2));
    await wrapper.get('[data-test=retry-creators]').trigger('click');
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('R18', 'applied', 2, 60, undefined, undefined);
    expect(routerState.replace).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test=retry-creators]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Last valid page creator');
    wrapper.unmount();
  });
  it('hides cards from a previous filter when the next filter request fails', async () => {
    vi.mocked(fetchCosGalleryCreators).mockResolvedValueOnce(creatorPage(1, 1)).mockRejectedValueOnce(new Error('New filter failed')).mockResolvedValueOnce(creatorPage(1, 1));
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } });
    await flushPromises();
    expect(wrapper.find('[aria-label="博主目录"]').exists()).toBe(true);
    routerState.route.query = { rating: 'R15' };
    routerState.route.fullPath = '/library?rating=R15';
    await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('New filter failed');
    expect(wrapper.find('[aria-label="博主目录"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('没有符合当前条件');
    await wrapper.get('[data-test=retry-creators]').trigger('click'); await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('R15', '', 1, 60, undefined, undefined);
    expect(wrapper.find('[aria-label="博主目录"]').exists()).toBe(true);
    wrapper.unmount();
  });
  it('distinguishes linked null, unlinked and inactive while keeping folder navigation', async () => {
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue({total:3,page:1,limit:50,hasMore:false,summary:{all:2,R15:0,R18:0,unclassified:1,unlinked:1,inactive:1},items:[
      {key:'creator:1',identityType:'creator',id:1,slug:'one',name:'Canonical A',canonicalCreatorId:1,canonicalName:'Canonical A',contentRating:null,linkStatus:'linked',rosterStatus:'active',workCount:1,folderIds:[10],folderNames:['one'],aliases:[]},
      {key:'folder:2',identityType:'folder',id:2,slug:'two',name:'Folder B',canonicalCreatorId:null,canonicalName:null,contentRating:null,linkStatus:'unlinked',rosterStatus:'unlinked',workCount:2,folderIds:[2],folderNames:['Folder B'],aliases:[]},
      {key:'creator:3',identityType:'creator',id:3,slug:'three',name:'Canonical C',canonicalCreatorId:3,canonicalName:'Canonical C',contentRating:'R18',linkStatus:'linked',rosterStatus:'inactive',workCount:3,folderIds:[30],folderNames:['three'],aliases:[]}
    ]} as Awaited<ReturnType<typeof fetchCosGalleryCreators>>);
    const wrapper=mount(CosGalleryHomeView,{global:{stubs:{RouterLink:{props:['to'],template:'<a :data-target="`${to.name}:${to.params.creatorId ?? to.params.slug}`"><slot /></a>'}}}});
    await flushPromises();
    const cards=wrapper.findAll('[data-target]');
    expect(cards[0].text()).toContain('待分类');
    expect(cards[0].text()).not.toContain('未关联');
    expect(cards[1].text()).toContain('未关联');
    expect(cards[2].text()).toContain('已停用');
    expect(cards[0].attributes('data-target')).toBe('canonical-creator:1');
    expect(cards[1].attributes('data-target')).toBe('folder:two');
    expect(wrapper.text()).toContain('Canonical A');
    wrapper.unmount();
  });
  it('reloads an active library after real invalidation without accepting an old response', async () => {
    type Payload = Awaited<ReturnType<typeof fetchCosGalleryCreators>>;
    const empty: Payload = {total:0,page:1,limit:50,hasMore:false,summary:{all:0,R15:0,R18:0,unclassified:0,unlinked:0,inactive:0},items:[]};
    let resolveOld!: (value: Payload) => void;
    vi.mocked(fetchCosGalleryCreators).mockImplementationOnce(() => new Promise(done => { resolveOld = done; })).mockResolvedValue(empty);
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    useCreatorReadingStore().invalidate();
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenCalledTimes(2);
    resolveOld({ ...empty, total: 99 });
    await flushPromises();
    expect(wrapper.text()).toContain('0 位博主');
    wrapper.unmount();
  });

  it('combines rating, preference and search and requests sixty without hidden daily lifecycle filters', async () => {
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue({total:0,page:1,limit:50,hasMore:false,summary:{all:0,R15:0,R18:0,unclassified:0,unlinked:0,inactive:0},items:[]});
    const wrapper=mount(CosGalleryHomeView,{global:{stubs:{RouterLink:true}}});
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(undefined,'',1,60,undefined,undefined);
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.get('[role="group"][aria-label="分级"]').findAll('button').map(item=>item.text())).toEqual(['全部','R15','R18']);
    expect(wrapper.get('[role="group"][aria-label="偏好"]').findAll('button').map(item=>item.text())).toEqual(['全部','喜欢','保留']);
    for(const value of ['R15','R18']) {
      await wrapper.get(`[aria-label="分级"] button[value="${value}"]`).trigger('click');
      await flushPromises();
      expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(value,'',1,60,undefined,undefined);
      expect(wrapper.get(`[aria-label="分级"] button[value="${value}"]`).attributes('aria-pressed')).toBe('true');
    }
    await wrapper.get('[aria-label="偏好"] button[value="liked"]').trigger('click');
    await wrapper.get('input[type="search"]').setValue('别名');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('R18','别名',1,60,'liked',undefined);
    expect(routerState.route.query).toEqual({ q: '别名', rating: 'R18', preference: 'liked' });
    expect(wrapper.get('[aria-label="偏好"] button[value="liked"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[aria-label="分级"]').text()).not.toContain('未关联');
    const requestCount=vi.mocked(fetchCosGalleryCreators).mock.calls.length,pushCount=routerState.push.mock.calls.length;
    await wrapper.get('[aria-label="偏好"] button[value="liked"]').trigger('click');await wrapper.get('[aria-label="分级"] button[value="R18"]').trigger('click');await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenCalledTimes(requestCount);expect(routerState.push).toHaveBeenCalledTimes(pushCount);
    await wrapper.get('[aria-label="偏好"] button[value="kept"]').trigger('click');await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('R18','别名',1,60,'kept',undefined);
    wrapper.unmount();
  });
  it('keeps old special URLs explicit and unchanged until the user exits the filter', async () => {
    routerState.route.query = { rating: 'inactive' };
    routerState.route.fullPath = '/library?rating=inactive';
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue({total:0,page:1,limit:60,hasMore:false,summary:{all:0,R15:0,R18:0,unclassified:0,unlinked:0,inactive:0},items:[]});
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('inactive', '', 1, 60, undefined, undefined);
    expect(wrapper.get('[role="status"]').text()).toContain('范围未改变');
    expect(wrapper.findAll('[aria-label="分级"] button[aria-pressed="true"]')).toHaveLength(0);
    await wrapper.get('[aria-label="分级"] button[value="all"]').trigger('click');
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(undefined, '', 1, 60, undefined, undefined);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it('replaces a legacy out-of-range page without flashing an empty result or dropping filters', async () => {
    routerState.route.query = { rating: 'R18', preference: 'kept', q: '别名', page: '2' };
    routerState.route.fullPath = '/library?rating=R18&preference=kept&q=别名&page=2';
    let resolveLast!: (value: CreatorPage) => void;
    vi.mocked(fetchCosGalleryCreators).mockResolvedValueOnce(creatorPage(54, 2))
      .mockImplementationOnce(() => new Promise(resolve => { resolveLast = resolve; }));
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(routerState.replace).toHaveBeenCalledExactlyOnceWith({ name: 'library', query: { rating: 'R18', preference: 'kept', q: '别名' } });
    expect(routerState.push).not.toHaveBeenCalled();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('R18', '别名', 1, 60, 'kept', undefined);
    expect(wrapper.text()).toContain('正在加载博主目录');
    expect(wrapper.text()).not.toContain('没有符合当前条件');
    resolveLast(creatorPage(54, 1));
    await flushPromises();
    expect(wrapper.text()).toContain('54 位博主');
    expect(wrapper.find('[aria-label="博主目录"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('没有符合当前条件');
    wrapper.unmount();
  });
  it.each([{ total: 123, expected: 3 }, { total: 0, expected: 1 }])('bounds a stale page for total $total to page $expected', async ({ total, expected }) => {
    routerState.route.query = { rating: 'R18', page: '9' };
    routerState.route.fullPath = '/library?rating=R18&page=9';
    vi.mocked(fetchCosGalleryCreators).mockImplementation(async (_rating, _query, requestedPage) => creatorPage(total, requestedPage!));
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(routerState.replace).toHaveBeenCalledTimes(1);
    expect(routerState.route.query).toEqual({ rating: 'R18', ...(expected > 1 ? { page: String(expected) } : {}) });
    expect(fetchCosGalleryCreators).toHaveBeenCalledTimes(2);
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('R18', '', expected, 60, undefined, undefined);
    expect(wrapper.text()).toContain(total ? '第 3 / 3 页' : '没有符合当前条件');
    wrapper.unmount();
  });
  it('rejects an invalid cached page and restores only the corrected page data', async () => {
    const reading = useCreatorReadingStore();
    routerState.route.query = { rating: 'R18', page: '2' };
    routerState.route.fullPath = '/library?rating=R18&page=2';
    reading.libraryPages['library:60:/library?rating=R18&page=2'] = { items: [], total: 54, scrollY: 900 };
    reading.libraryPages['library:60:/library?rating=R18'] = { items: creatorPage(54, 1).items, total: 54, scrollY: 1200 };
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(routerState.replace).toHaveBeenCalledTimes(1);
    expect(reading.libraryPages['library:60:/library?rating=R18&page=2']).toBeUndefined();
    expect(fetchCosGalleryCreators).not.toHaveBeenCalled();
    expect(wrapper.find('[aria-label="博主目录"]').exists()).toBe(true);
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0 });
    wrapper.unmount();
  });
  it('does not let a late out-of-range response replace a newer filter route', async () => {
    routerState.route.query = { rating: 'R18', page: '9' };
    routerState.route.fullPath = '/library?rating=R18&page=9';
    let resolveOld!: (value: CreatorPage) => void;
    vi.mocked(fetchCosGalleryCreators).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(creatorPage(61, 1));
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    routerState.route.query = { rating: 'R15' };
    routerState.route.fullPath = '/library?rating=R15';
    await flushPromises();
    resolveOld(creatorPage(54, 9));
    await flushPromises();
    expect(routerState.replace).not.toHaveBeenCalled();
    expect(routerState.route.query).toEqual({ rating: 'R15' });
    expect(wrapper.text()).toContain('61 位博主');
    wrapper.unmount();
  });
  it('restores return positions, but choosing all uses the cached data without its old scroll and repeated all is inert', async () => {
    const reading = useCreatorReadingStore();
    reading.libraryPages['library:60:/library?rating=R18'] = { items: [], total: 2, scrollY: 870 };
    reading.libraryPages['library:60:/library?'] = { items: [], total: 121, scrollY: 1300 };
    routerState.route.query = { rating: 'R18' };
    routerState.route.fullPath = '/library?rating=R18';
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 870 });
    await wrapper.get('[aria-label="分级"] button[value="all"]').trigger('click');
    await flushPromises();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0 });
    expect(wrapper.text()).toContain('第 1 / 3 页');
    const count = vi.mocked(window.scrollTo).mock.calls.length;
    await wrapper.get('[aria-label="分级"] button[value="all"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(window.scrollTo).mock.calls).toHaveLength(count);
    expect(fetchCosGalleryCreators).not.toHaveBeenCalled();
    // Browser history restores the exact old filter position, not another key.
    routerState.route.query = { rating: 'R18' };
    routerState.route.fullPath = '/library?rating=R18';
    await flushPromises();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 870 });
    wrapper.unmount();
  });
});
