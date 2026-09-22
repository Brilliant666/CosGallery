import {beforeEach,describe,expect,it,vi} from 'vitest';
import {carryRefreshedChoices,lastAdmissionCollection,rememberAdmissionCollection,restoreAdmissionDraft,saveAdmissionDraft,type DraftEntry} from './admission-navigation';
import {admissionScopeReviewReason,confirmAdmissionScope} from './admission-ui';
const row:DraftEntry={batchId:'b',creatorId:17,item:{key:'i',sourceRelativePath:'same',targetPath:'gallery/same',displayTitle:'same',group:'A',summary:{images:1,videos:0,other:0,bytes:10},candidates:[],conflicts:[],ads:[],state:'preview'},action:{key:'i',action:'skip',approvedAds:[],acceptSourceIds:[]}};
describe('tab-local admission navigation hints',()=>{
  beforeEach(()=>sessionStorage.clear());
  it('repairs the old tab default only after the server marks it and saves the explicit scope acknowledgement',()=>{
    const legacy={...row,action:{...row.action,action:'defer' as const,selectionOrigin:'manual' as const,reason:admissionScopeReviewReason}};
    const marked={...legacy,item:{...row.item,scopeReviewRequired:true as const}};
    saveAdmissionDraft('c',[legacy]);
    const waiting=restoreAdmissionDraft('c',[marked])[0]!.action;expect(waiting.selectionOrigin).toBe('scope-review');
    saveAdmissionDraft('c',[{...marked,action:waiting}]);expect(restoreAdmissionDraft('c',[marked])[0]?.action.action).toBe('defer');
    const confirmed=confirmAdmissionScope(marked.item,waiting);saveAdmissionDraft('c',[{...marked,action:confirmed}]);
    expect(restoreAdmissionDraft('c',[marked])[0]?.action).toMatchObject({action:'new',selectionOrigin:'automatic',scopeConfirmed:true});
    expect(carryRefreshedChoices([{...marked,action:confirmed}],[marked])[0]?.action.scopeConfirmed).toBe(true);
  });
  it('remembers only a collection id and clears it when deliberately starting a new scope',()=>{rememberAdmissionCollection('c');expect(lastAdmissionCollection()).toBe('c');rememberAdmissionCollection(null);expect(lastAdmissionCollection()).toBeNull();});
  it('retains manual skip across evidence changes only within the same source scope',()=>{
    saveAdmissionDraft('c',[row]);expect(restoreAdmissionDraft('c',[row])[0]?.action).toEqual(row.action);
    expect(restoreAdmissionDraft('other',[row])).toEqual([]);expect(restoreAdmissionDraft('c',[{...row,creatorId:18}])).toEqual([]);
    expect(restoreAdmissionDraft('c',[{...row,item:{...row.item,summary:{...row.item.summary,bytes:20}}}])[0]?.action).toMatchObject({action:'skip',selectionOrigin:'manual',approvedAds:[],acceptSourceIds:[]});
    expect(restoreAdmissionDraft('c',[{...row,item:{...row.item,sourceRelativePath:'different'}}])[0]?.action).toMatchObject({action:'defer',selectionOrigin:'manual'});
  });
  it('selects newly safe automatic defers while retaining manual and legacy defers',()=>{
    for(const selectionOrigin of ['automatic','manual',undefined] as const){
      saveAdmissionDraft('c',[{...row,item:{...row.item,group:'D',conflicts:['old conflict']},action:{...row.action,action:'defer',selectionOrigin}}]);
      expect(restoreAdmissionDraft('c',[row])[0]?.action.action).toBe(selectionOrigin==='automatic'?'new':'defer');
    }
  });
  it('preserves cancelled surviving ads for automatic new across refreshed evidence',()=>{
    const old={...row,item:{...row.item,ads:[{relativePath:'cancel.txt',size:1},{relativePath:'approved.txt',size:1}]},action:{...row.action,action:'new' as const,selectionOrigin:'automatic' as const,approvedAds:['approved.txt']}};
    saveAdmissionDraft('c',[old]);
    const fresh={...old,item:{...old.item,ads:[{relativePath:'cancel.txt',size:2},{relativePath:'approved.txt',size:2},{relativePath:'added.txt',size:1}]}};
    expect(restoreAdmissionDraft('c',[fresh])[0]?.action).toMatchObject({action:'new',selectionOrigin:'automatic',approvedAds:['approved.txt','added.txt']});
    const unsafe={...fresh,item:{...fresh.item,needsBoundaryReview:true}};
    const deferred=restoreAdmissionDraft('c',[unsafe])[0];
    expect(deferred?.action).toMatchObject({action:'defer',cancelledAds:['cancel.txt']});
    saveAdmissionDraft('c',[{...unsafe,action:deferred!.action}]);
    expect(restoreAdmissionDraft('c',[fresh])[0]?.action).toMatchObject({action:'new',approvedAds:['approved.txt','added.txt'],cancelledAds:['cancel.txt']});
  });
  it('defers changed existing mappings even if their stored origin is automatic',()=>{
    saveAdmissionDraft('c',[{...row,action:{...row.action,action:'existing',selectionOrigin:'automatic',workId:17}}]);
    expect(restoreAdmissionDraft('c',[{...row,item:{...row.item,reviewFingerprint:'changed'}}])[0]?.action).toMatchObject({action:'defer',selectionOrigin:'manual'});
  });
  it('defers a same-as choice when its peer evidence changed even if the peer remains safe automatic new',()=>{
    const root={...row,action:{...row.action,action:'new' as const,selectionOrigin:'automatic' as const}};
    const copy={...row,item:{...row.item,key:'copy',sourceRelativePath:'copy'},action:{...row.action,key:'copy',action:'same-as' as const,sameAsKey:'i'}};
    saveAdmissionDraft('c',[root,copy]);
    const restored=restoreAdmissionDraft('c',[{...root,item:{...root.item,reviewFingerprint:'changed'}},copy]);
    expect(restored.map(entry=>entry.action.action)).toEqual(['new','defer']);
    expect(restored[1]?.action.selectionOrigin).toBe('manual');
  });
  it('does not reuse an arbitrary work or advertisement from corrupted tab state',()=>{
    saveAdmissionDraft('c',[{...row,action:{...row.action,action:'existing',workId:100}}]);expect(restoreAdmissionDraft('c',[row])).toEqual([]);
    saveAdmissionDraft('c',[{...row,action:{...row.action,approvedAds:['not-in-manifest.txt']}}]);expect(restoreAdmissionDraft('c',[row])).toEqual([]);
    sessionStorage.setItem('cosgallery:admission:tab-drafts','invalid');expect(restoreAdmissionDraft('c',[row])).toEqual([]);
  });
  it('retains separate recent drafts with a bounded ten-collection capacity',()=>{
    saveAdmissionDraft('a',[row]);saveAdmissionDraft('b',[{...row,action:{...row.action,action:'defer'}}]);
    expect(restoreAdmissionDraft('a',[row])[0]?.action.action).toBe('skip');expect(restoreAdmissionDraft('b',[row])[0]?.action.action).toBe('defer');
    for(let i=0;i<10;i++)saveAdmissionDraft(`new-${i}`,[row]);
    expect(restoreAdmissionDraft('a',[row])).toEqual([]);expect(JSON.parse(sessionStorage.getItem('cosgallery:admission:tab-drafts')!)).toHaveLength(10);
  });
});
describe('in-memory saved-state refresh choices',()=>{
  it('retains identical legacy user choices without relying on working browser storage',()=>{
    const previous={...row,action:{...row.action,action:'new' as const,displayTitle:'Edited title'}};
    const storage=vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('Unavailable storage');});
    try{
      const result=carryRefreshedChoices([previous],[row]);
      expect(result[0]?.action).toEqual(previous.action);expect(result[0]?.action.selectionOrigin).toBeUndefined();
      expect(storage).not.toHaveBeenCalled();
    }finally{storage.mockRestore();}
  });
  it('compares effective ads even when the server fingerprint is unchanged',()=>{
    const previous={...row,item:{...row.item,reviewFingerprint:'saved-fingerprint',ads:[{relativePath:'cancel.txt',size:1}]},action:{...row.action,action:'new' as const,selectionOrigin:'automatic' as const,approvedAds:[]}};
    const fresh={...previous,item:{...previous.item,ads:[...previous.item.ads,{relativePath:'new.txt',size:1}]}};
    const before=JSON.stringify(previous);
    expect(carryRefreshedChoices([previous],[fresh])[0]?.action).toMatchObject({action:'new',approvedAds:['new.txt'],cancelledAds:['cancel.txt']});
    expect(JSON.stringify(previous)).toBe(before);
  });
  it('clears changed existing Work choices and invalidates dependent same-as choices',()=>{
    const work={workId:7,title:'Chosen Work',catalogNo:null,images:1,videos:0,thumbnailUrl:null,primaryLocalWorkId:null,localState:'available',originalDirectories:[],sources:[]};
    const previous={...row,work,action:{...row.action,action:'existing' as const,workId:7}};
    const peer={...row,item:{...row.item,key:'peer',sourceRelativePath:'peer'},action:{...row.action,key:'peer',action:'same-as' as const,sameAsKey:'i'}};
    const fresh={...previous,item:{...previous.item,candidates:[work]}};
    const result=carryRefreshedChoices([previous,peer],[fresh,peer]);
    expect(result.map(entry=>entry.action.action)).toEqual(['defer','defer']);
    expect(result.every(entry=>!entry.work&&entry.action.selectionOrigin==='manual')).toBe(true);
  });
  it('keeps changed manual skip/defer and does not carry choices across batch or creator scope',()=>{
    for(const action of ['skip','defer'] as const){
      const previous={...row,action:{...row.action,action}};
      expect(carryRefreshedChoices([previous],[{...row,item:{...row.item,conflicts:['changed']}}])[0]?.action.action).toBe(action);
      expect(carryRefreshedChoices([previous],[{...row,batchId:'other'},{...row,creatorId:18}])).toEqual([]);
    }
  });
});
