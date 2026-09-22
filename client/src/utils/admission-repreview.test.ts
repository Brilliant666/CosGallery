import {describe,it,expect} from 'vitest';
import {carryRepreviewChoices,type RepreviewEntry} from './admission-repreview';
import {admissionScopeReviewReason,confirmAdmissionScope} from './admission-ui';
const row=(key:string,fingerprint='one',batchId='old'):RepreviewEntry=>({batchId,creatorId:1,parent:'same',item:{key,sourceRelativePath:key.replace(/new-/g,''),displayTitle:key,targetPath:'/target',group:'A',state:'preview',summary:{images:1,videos:0,other:0,bytes:1},candidates:[],conflicts:[],ads:[],reviewFingerprint:fingerprint},action:{key,action:'defer',approvedAds:[],acceptSourceIds:[]}});
describe('new preview choices are evidence bound',()=>{
  it('does not auto-confirm legacy scope during a fresh read and carries explicit acknowledgement across changed evidence',()=>{
    const old=row('a');old.item.scopeReviewRequired=true;old.action={...old.action,selectionOrigin:'manual',reason:admissionScopeReviewReason};
    const next=row('new-a','changed','fresh');
    const held=carryRepreviewChoices([old],[next])[0]!;
    expect(held.action).toMatchObject({action:'defer',selectionOrigin:'scope-review'});
    const acknowledged={...held,action:confirmAdmissionScope(held.item,held.action)};
    const later=row('new-a','changed-again','later');later.item.scopeReviewRequired=true;
    expect(carryRepreviewChoices([acknowledged],[later])[0]?.action).toMatchObject({action:'new',selectionOrigin:'automatic',scopeConfirmed:true});
  });
  it('retains a manual defer/skip, not key-bound auto defaults',()=>{
    const a=row('a'),b=row('b');b.action.action='skip';
    const result=carryRepreviewChoices([a,b],[row('new-a','one','new'),row('new-b','one','new')]);
    expect(result.map(x=>[x.key,x.action.action])).toEqual([['new-a','defer'],['new-b','skip']]);
  });
  it('defers changed or old unversioned evidence and never carries approval across creators/parents',()=>{
    const a=row('a');a.action.action='new';a.item.reviewFingerprint=undefined;
    const result=carryRepreviewChoices([a,row('b')],[row('new-a','one','new'),row('new-b','changed','new'),{...row('new-a'),creatorId:2},{...row('new-b'),parent:'other'}]);
    expect(result).toHaveLength(2);expect(result.every(x=>x.action.action==='defer'&&!x.action.approvedAds?.length)).toBe(true);
  });
  it('remaps same-work keys only if both endpoints keep their exact evidence',()=>{
    const a=row('a'),b=row('b');a.action.action='new';b.action={...b.action,action:'same-as',sameAsKey:'a',primary:true};
    const result=carryRepreviewChoices([a,b],[row('new-a','one','new'),row('new-b','one','new')]);
    expect(result[1].action).toMatchObject({key:'new-b',action:'same-as',sameAsKey:'new-a',primary:true});
    expect(carryRepreviewChoices([a,b],[row('new-b','one','new')])[0].action.action).toBe('defer');
  });
  it('does not carry an existing Work with mismatched presentation evidence',()=>{
    const a=row('a');a.action={...a.action,action:'existing',workId:7};
    expect(carryRepreviewChoices([a],[row('new-a','one','new')])[0].action.action).toBe('defer');
  });
  it('automatically selects newly safe system defers but preserves changed manual defer and skip choices',()=>{
    const previous=['automatic','manual',undefined].map((selectionOrigin,index)=>{const entry=row(String(index));entry.item.group='D';entry.action.selectionOrigin=selectionOrigin as 'automatic'|'manual'|undefined;return entry;});
    const skipped=row('skip');skipped.action.action='skip';previous.push(skipped);
    const result=carryRepreviewChoices(previous,previous.map(old=>row(`new-${old.item.key}`,'changed','new')));
    expect(result.map(entry=>entry.action.action)).toEqual(['new','defer','defer','skip']);
    expect(result[0].action.selectionOrigin).toBe('automatic');
  });
  it('keeps automatic new only for safe fresh evidence and retains surviving advertisement cancellations',()=>{
    const old=row('a');old.action={...old.action,action:'new',selectionOrigin:'automatic',approvedAds:['approved.txt']};old.item.ads=[{relativePath:'cancel.txt',size:1},{relativePath:'approved.txt',size:1}];
    const fresh=row('new-a','changed','new');fresh.item.ads=[{relativePath:'cancel.txt',size:2},{relativePath:'approved.txt',size:2},{relativePath:'added.txt',size:1}];
    expect(carryRepreviewChoices([old],[fresh])[0].action).toMatchObject({action:'new',selectionOrigin:'automatic',approvedAds:['approved.txt','added.txt']});
    fresh.item.needsBoundaryReview=true;
    const unsafe=carryRepreviewChoices([old],[fresh])[0];
    expect(unsafe.action).toMatchObject({action:'defer',approvedAds:[],cancelledAds:['cancel.txt']});
    const safeAgain={...fresh,item:{...fresh.item,needsBoundaryReview:false,reviewFingerprint:'safe-again'}};
    expect(carryRepreviewChoices([unsafe],[safeAgain])[0].action).toMatchObject({action:'new',approvedAds:['approved.txt','added.txt'],cancelledAds:['cancel.txt']});
  });
  it('does not turn changed manual new, existing or same-as mappings into new works',()=>{
    for(const kind of ['new','existing','same-as'] as const){
      const old=row('a');old.action={...old.action,action:kind,selectionOrigin:kind==='new'?'manual':'automatic',workId:7,sameAsKey:'peer'};
      expect(carryRepreviewChoices([old],[row('new-a','changed','new')])[0].action).toMatchObject({action:'defer',selectionOrigin:'manual',approvedAds:[]});
    }
  });
  it('retains unchanged exact manual selections, titles and cancelled ads',()=>{
    const old=row('a');old.item.ads=[{relativePath:'cancel.txt',size:1}];old.action={...old.action,action:'new',selectionOrigin:'manual',displayTitle:'My title',primary:true,approvedAds:[]};
    const fresh=row('new-a','one','new');fresh.item.ads=old.item.ads;
    expect(carryRepreviewChoices([old],[fresh])[0].action).toEqual({...old.action,key:'new-a'});
  });
});
