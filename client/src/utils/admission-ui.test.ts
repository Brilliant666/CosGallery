import {describe,expect,it} from 'vitest';
import {mount} from '@vue/test-utils';
import AdmissionItemEditor from '../components/AdmissionItemEditor.vue';
import {admissionAction,admissionPayload,admissionScopeReviewReason,changedAdmissionAction,confirmAdmissionScope,isAdmissionSafeCandidate,normalizeAdmissionScopeAction,selectAdmissionAds} from './admission-ui';
import type {AdmissionItem} from '../types/local-admission';
const item:AdmissionItem={key:'a',sourceRelativePath:'a',targetPath:'gallery/a',displayTitle:'a',group:'A',state:'preview',summary:{images:1,videos:0,other:0,bytes:1},candidates:[],conflicts:[],ads:[{relativePath:'ad.txt',size:1}]};
describe('admission action provenance and safe candidates',()=>{
  it('recognizes only a server-marked exact historical system defer as scope review',()=>{
    const marked={...item,scopeReviewRequired:true as const};
    const old={key:item.key,action:'defer' as const,selectionOrigin:'manual' as const,reason:admissionScopeReviewReason,approvedAds:[],acceptSourceIds:[]};
    expect(normalizeAdmissionScopeAction(marked,old).selectionOrigin).toBe('scope-review');
    expect(normalizeAdmissionScopeAction(item,old).selectionOrigin).toBe('manual');
    for(const edit of [{reason:'用户决定暂缓'},{reason:undefined},{action:'skip' as const},{primary:true},{displayTitle:'手工标题'},{workId:9},{sameAsKey:'other'},{approvedAds:['ad.txt']},{acceptSourceIds:[9]},{scopeConfirmed:true}])
      expect(normalizeAdmissionScopeAction(marked,{...old,...edit}).selectionOrigin).toBe('manual');
    expect(normalizeAdmissionScopeAction(marked,admissionAction(marked,'defer',old)).selectionOrigin).toBe('manual');
  });
  it('confirms scope without confirming identities, retains cancellations, and strips all UI-only metadata',()=>{
    const marked={...item,scopeReviewRequired:true as const};
    const held={key:item.key,action:'defer' as const,selectionOrigin:'scope-review' as const,reason:admissionScopeReviewReason,cancelledAds:['ad.txt'],approvedAds:[],acceptSourceIds:[]};
    expect(changedAdmissionAction(marked,held).selectionOrigin).toBe('scope-review');
    const chosen=confirmAdmissionScope(marked,held);
    expect(chosen).toMatchObject({action:'new',selectionOrigin:'automatic',scopeConfirmed:true,approvedAds:[],cancelledAds:['ad.txt']});
    for(const group of ['B','C','D'] as const)expect(confirmAdmissionScope({...marked,group},held)).toMatchObject({action:'defer',selectionOrigin:'automatic',scopeConfirmed:true});
    const changed=changedAdmissionAction({...marked,summary:{...marked.summary,bytes:2}},chosen,marked.ads);
    expect(changed).toMatchObject({action:'new',scopeConfirmed:true,approvedAds:[],cancelledAds:['ad.txt']});
    const payload=admissionPayload([{item:marked,action:chosen}],true)[0]!;
    expect(payload).not.toHaveProperty('scopeConfirmed');expect(payload).not.toHaveProperty('selectionOrigin');expect(payload).not.toHaveProperty('cancelledAds');
    const manual={...held,selectionOrigin:'manual' as const};expect(confirmAdmissionScope(marked,manual)).toBe(manual);
  });
  it('makes explicit helper choices manual and removes UI provenance from execution actions',()=>{
    const action=admissionAction(item,'new');expect(action.selectionOrigin).toBe('manual');
    expect(admissionPayload([{item,action}],false)[0]).not.toHaveProperty('selectionOrigin');
    expect(admissionPayload([{item,action:{...action,cancelledAds:['ad.txt']}}],false)[0]).not.toHaveProperty('cancelledAds');
    expect(admissionPayload([{item,action:{...action,selectionOrigin:'automatic'}}],false)[0]).not.toHaveProperty('selectionOrigin');
  });
  it('requires every safety condition before considering an A item automatically selectable',()=>{
    expect(isAdmissionSafeCandidate(item)).toBe(true);
    for(const changed of [{group:'B' as const},{candidates:[{workId:1}]},{conflicts:['collision']},{structureWarnings:['nested']},{needsBoundaryReview:true},{reviewIssues:['title_similar']},{candidatesTruncated:true},{currentDisposition:{status:'unresolved' as const}}])expect(isAdmissionSafeCandidate({...item,...changed} as AdmissionItem)).toBe(false);
  });
  it('demotes only an automatic new choice when historical coverage is unresolved, retaining manual decisions',()=>{
    const unknown={...item,currentDisposition:{status:'unresolved' as const}};
    const automatic={...admissionAction(item,'new'),selectionOrigin:'automatic' as const,cancelledAds:['ad.txt']};
    expect(normalizeAdmissionScopeAction(unknown,automatic)).toMatchObject({action:'defer',selectionOrigin:'automatic',approvedAds:[],cancelledAds:['ad.txt']});
    const manual={...automatic,selectionOrigin:'manual' as const,displayTitle:'用户明确的整套标题'};expect(normalizeAdmissionScopeAction(unknown,manual)).toBe(manual);
    expect(confirmAdmissionScope({...unknown,scopeReviewRequired:true},{...automatic,action:'defer',selectionOrigin:'scope-review',reason:admissionScopeReviewReason})).toMatchObject({action:'defer'});
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
