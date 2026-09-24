import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useCreatorReadingStore } from '../stores/creator-reading';
import CosGalleryHomeView from './CosGalleryHomeView.vue';
import { fetchCosGalleryCreators } from '../api/gallery';

vi.mock('../api/gallery', () => ({ fetchCosGalleryCreators: vi.fn() }));
const routerState = vi.hoisted(() => ({
  route: { name: 'library', query: {} as Record<string, string>, fullPath: '/library' },
  replace: vi.fn(),
  push: vi.fn()
}));
vi.mock('vue-router', async (importOriginal) => {
  const { reactive } = await import('vue');
  routerState.route = reactive(routerState.route);
  return { ...await importOriginal<typeof import('vue-router')>(), onBeforeRouteLeave: vi.fn(), onBeforeRouteUpdate: vi.fn(), useRoute: () => routerState.route, useRouter: () => ({ replace: routerState.replace, push: routerState.push }) };
});

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
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(undefined,'',1,60,undefined);
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.get('[role="group"][aria-label="分级"]').findAll('button').map(item=>item.text())).toEqual(['全部','R15','R18']);
    expect(wrapper.get('[role="group"][aria-label="偏好"]').findAll('button').map(item=>item.text())).toEqual(['全部','喜欢','保留']);
    for(const value of ['R15','R18']) {
      await wrapper.get(`[aria-label="分级"] button[value="${value}"]`).trigger('click');
      await flushPromises();
      expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(value,'',1,60,undefined);
      expect(wrapper.get(`[aria-label="分级"] button[value="${value}"]`).attributes('aria-pressed')).toBe('true');
    }
    await wrapper.get('[aria-label="偏好"] button[value="liked"]').trigger('click');
    await wrapper.get('input[type="search"]').setValue('别名');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('R18','别名',1,60,'liked');
    expect(routerState.route.query).toEqual({ q: '别名', rating: 'R18', preference: 'liked' });
    expect(wrapper.get('[aria-label="偏好"] button[value="liked"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[aria-label="分级"]').text()).not.toContain('未关联');
    const requestCount=vi.mocked(fetchCosGalleryCreators).mock.calls.length,pushCount=routerState.push.mock.calls.length;
    await wrapper.get('[aria-label="偏好"] button[value="liked"]').trigger('click');await wrapper.get('[aria-label="分级"] button[value="R18"]').trigger('click');await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenCalledTimes(requestCount);expect(routerState.push).toHaveBeenCalledTimes(pushCount);
    await wrapper.get('[aria-label="偏好"] button[value="kept"]').trigger('click');await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('R18','别名',1,60,'kept');
    wrapper.unmount();
  });
  it('keeps old special URLs explicit and unchanged until the user exits the filter', async () => {
    routerState.route.query = { rating: 'inactive' };
    routerState.route.fullPath = '/library?rating=inactive';
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue({total:0,page:1,limit:60,hasMore:false,summary:{all:0,R15:0,R18:0,unclassified:0,unlinked:0,inactive:0},items:[]});
    const wrapper = mount(CosGalleryHomeView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith('inactive', '', 1, 60, undefined);
    expect(wrapper.get('[role="status"]').text()).toContain('范围未改变');
    expect(wrapper.findAll('[aria-label="分级"] button[aria-pressed="true"]')).toHaveLength(0);
    await wrapper.get('[aria-label="分级"] button[value="all"]').trigger('click');
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(undefined, '', 1, 60, undefined);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
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
