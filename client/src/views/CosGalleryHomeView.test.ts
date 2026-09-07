import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CosGalleryHomeView from './CosGalleryHomeView.vue';
import { fetchCosGalleryCreators } from '../api/gallery';

vi.mock('../api/gallery', () => ({ fetchCosGalleryCreators: vi.fn() }));
const routerState = vi.hoisted(() => ({
  route: { query: {} as Record<string, string>, fullPath: '/library' },
  replace: vi.fn()
}));
vi.mock('vue-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-router')>(),
  useRoute: () => routerState.route,
  useRouter: () => ({ replace: routerState.replace })
}));

describe('managed gallery classifications', () => {
  beforeEach(() => {
    vi.mocked(fetchCosGalleryCreators).mockReset();
    routerState.replace.mockReset();
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
  it('requests exact rating and lifecycle filters rather than inferring from names', async () => {
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue({total:0,page:1,limit:50,hasMore:false,summary:{all:0,R15:0,R18:0,unclassified:0,unlinked:0,inactive:0},items:[]});
    const wrapper=mount(CosGalleryHomeView,{global:{stubs:{RouterLink:true}}});
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(undefined,'',1,50);
    for(const [label,value] of [['R15','R15'],['R18','R18'],['待分类','unclassified'],['未关联','unlinked'],['已停用','inactive']]) {
      await wrapper.findAll('button').find(button=>button.text()===label)!.trigger('click');
      await flushPromises();
      expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(value,'',1,50);
    }
    wrapper.unmount();
  });
});
