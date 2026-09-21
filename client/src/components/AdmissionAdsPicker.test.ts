import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { describe,expect,it } from 'vitest';
import AdmissionAdsPicker from './AdmissionAdsPicker.vue';
import type { AdmissionEntry } from '../utils/admission-ui';
const entry=(key:string,action:'new'|'defer',approved:boolean):AdmissionEntry=>({item:{key,displayTitle:key,sourceRelativePath:key,targetPath:key,group:'A',state:'preview',summary:{images:1,videos:0,other:1,bytes:100},candidates:[],conflicts:[],ads:[{relativePath:'广告.txt',size:1}]},action:{key,action,approvedAds:approved?['广告.txt']:[],acceptSourceIds:[]}});
describe('grouped advertisement selection',()=>{
  it('represents partial selection and toggles exact selected-directory files without touching deferred items',async()=>{
    const entries=reactive([entry('a','new',true),entry('b','new',false),entry('c','defer',false)]);
    const wrapper=mount(AdmissionAdsPicker,{props:{entries,locked:false}}),check=wrapper.get('input');
    expect(check.element.indeterminate).toBe(true);
    await check.setValue(true);expect(entries.map(row=>row.action.approvedAds)).toEqual([['广告.txt'],['广告.txt'],[]]);
    expect(check.element.indeterminate).toBe(false);
    await check.setValue(false);expect(entries.every(row=>row.action.approvedAds?.length===0)).toBe(true);
    expect(entries[0]!.action.cancelledAds).toEqual(['广告.txt']);expect(wrapper.emitted('change')).toHaveLength(2);
    wrapper.unmount();
  });
  it('does not mutate a locked original receipt',async()=>{
    const entries=[entry('a','new',true)],wrapper=mount(AdmissionAdsPicker,{props:{entries,locked:true}});
    await wrapper.get('input').setValue(false);
    expect(entries[0]!.action.approvedAds).toEqual(['广告.txt']);expect(wrapper.emitted('change')).toBeUndefined();wrapper.unmount();
  });
});
