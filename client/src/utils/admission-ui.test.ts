import {describe,expect,it} from 'vitest';
import {mount} from '@vue/test-utils';
import AdmissionItemEditor from '../components/AdmissionItemEditor.vue';
import {admissionAction,admissionPayload,isAdmissionSafeCandidate,selectAdmissionAds} from './admission-ui';
import type {AdmissionItem} from '../types/local-admission';
const item:AdmissionItem={key:'a',sourceRelativePath:'a',targetPath:'gallery/a',displayTitle:'a',group:'A',state:'preview',summary:{images:1,videos:0,other:0,bytes:1},candidates:[],conflicts:[],ads:[{relativePath:'ad.txt',size:1}]};
describe('admission action provenance and safe candidates',()=>{
  it('makes explicit helper choices manual and removes UI provenance from execution actions',()=>{
    const action=admissionAction(item,'new');expect(action.selectionOrigin).toBe('manual');
    expect(admissionPayload([{item,action}],false)[0]).not.toHaveProperty('selectionOrigin');
    expect(admissionPayload([{item,action:{...action,cancelledAds:['ad.txt']}}],false)[0]).not.toHaveProperty('cancelledAds');
    expect(admissionPayload([{item,action:{...action,selectionOrigin:'automatic'}}],false)[0]).not.toHaveProperty('selectionOrigin');
  });
  it('requires every safety condition before considering an A item automatically selectable',()=>{
    expect(isAdmissionSafeCandidate(item)).toBe(true);
    for(const changed of [{group:'B' as const},{candidates:[{workId:1}]},{conflicts:['collision']},{structureWarnings:['nested']},{needsBoundaryReview:true}])expect(isAdmissionSafeCandidate({...item,...changed} as AdmissionItem)).toBe(false);
  });
  it('records a manually edited title without making an ad cancellation a manual selection',async()=>{
    const action={...admissionAction(item,'new'),selectionOrigin:'automatic' as const};
    const wrapper=mount(AdmissionItemEditor,{props:{item,creatorId:1,peers:[],locked:false,acceptExistingVersion:false,modelValue:action}});
    await wrapper.get('.item-ads input').setValue(false);
    expect(action.selectionOrigin).toBe('automatic');expect(action.approvedAds).toEqual([]);expect(action.cancelledAds).toEqual(['ad.txt']);
    await wrapper.get('input[maxlength="500"]').setValue('A reviewed title');
    expect(action.selectionOrigin).toBe('manual');expect(action.displayTitle).toBe('A reviewed title');expect(wrapper.emitted('change')).toBeTruthy();
    wrapper.unmount();
  });
  it('tracks bulk ad cancellations and explicitly re-approved advertisements',()=>{
    const action=admissionAction(item,'new');selectAdmissionAds([{item,action}],false);
    expect(action.cancelledAds).toEqual(['ad.txt']);
    const deferred=admissionAction(item,'defer',action),selected=admissionAction(item,'new',deferred);
    expect(selected.approvedAds).toEqual([]);
    selectAdmissionAds([{item,action:selected}],true);
    expect(selected.cancelledAds).toEqual([]);expect(selected.approvedAds).toEqual(['ad.txt']);
  });
});
