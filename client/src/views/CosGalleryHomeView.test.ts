import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CosGalleryHomeView from './CosGalleryHomeView.vue';
import { fetchCosGalleryCreators } from '../api/gallery';

vi.mock('../api/gallery', () => ({ fetchCosGalleryCreators: vi.fn() }));

describe('managed gallery classifications', () => {
  beforeEach(() => vi.mocked(fetchCosGalleryCreators).mockReset());
  it('distinguishes linked null, unlinked and inactive while keeping folder navigation', async () => {
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue({total:3,items:[
      {id:1,slug:'one',name:'Canonical A',contentRating:null,linkStatus:'linked',rosterStatus:'active',workCount:1},
      {id:2,slug:'two',name:'Folder B',contentRating:null,linkStatus:'unlinked',rosterStatus:'unlinked',workCount:2},
      {id:3,slug:'three',name:'Canonical C',contentRating:'R18',linkStatus:'linked',rosterStatus:'inactive',workCount:3}
    ]} as Awaited<ReturnType<typeof fetchCosGalleryCreators>>);
    const wrapper=mount(CosGalleryHomeView,{global:{stubs:{RouterLink:{props:['to'],template:'<a :data-target="to.params.slug"><slot /></a>'}}}});
    await flushPromises();
    const cards=wrapper.findAll('[data-target]');
    expect(cards[0].text()).toContain('待分类');
    expect(cards[0].text()).not.toContain('未关联');
    expect(cards[1].text()).toContain('未关联');
    expect(cards[2].text()).toContain('已停用');
    expect(cards[0].attributes('data-target')).toBe('one');
    expect(wrapper.text()).toContain('Canonical A');
    wrapper.unmount();
  });
  it('requests exact rating and lifecycle filters rather than inferring from names', async () => {
    vi.mocked(fetchCosGalleryCreators).mockResolvedValue({total:0,items:[]});
    const wrapper=mount(CosGalleryHomeView,{global:{stubs:{RouterLink:true}}});
    await flushPromises();
    expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(undefined,'');
    for(const [label,value] of [['R15','R15'],['R18','R18'],['待分类','unclassified'],['未关联','unlinked'],['已停用','inactive']]) {
      await wrapper.findAll('button').find(button=>button.text()===label)!.trigger('click');
      await flushPromises();
      expect(fetchCosGalleryCreators).toHaveBeenLastCalledWith(value,'');
    }
    wrapper.unmount();
  });
});
