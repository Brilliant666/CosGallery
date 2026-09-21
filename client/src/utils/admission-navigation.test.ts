import {beforeEach,describe,expect,it} from 'vitest';
import {lastAdmissionCollection,rememberAdmissionCollection,restoreAdmissionDraft,saveAdmissionDraft,type DraftEntry} from './admission-navigation';
const row:DraftEntry={batchId:'b',creatorId:17,item:{key:'i',sourceRelativePath:'same',targetPath:'gallery/same',displayTitle:'same',group:'A',summary:{images:1,videos:0,other:0,bytes:10},candidates:[],conflicts:[],ads:[],state:'preview'},action:{key:'i',action:'skip',approvedAds:[],acceptSourceIds:[]}};
describe('tab-local admission navigation hints',()=>{
  beforeEach(()=>sessionStorage.clear());
  it('remembers only a collection id and clears it when deliberately starting a new scope',()=>{rememberAdmissionCollection('c');expect(lastAdmissionCollection()).toBe('c');rememberAdmissionCollection(null);expect(lastAdmissionCollection()).toBeNull();});
  it('restores manual skip only for the same collection, batch, creator, item and evidence',()=>{
    saveAdmissionDraft('c',[row]);expect(restoreAdmissionDraft('c',[row])[0]?.action).toEqual(row.action);
    expect(restoreAdmissionDraft('other',[row])).toEqual([]);expect(restoreAdmissionDraft('c',[{...row,creatorId:18}])).toEqual([]);
    expect(restoreAdmissionDraft('c',[{...row,item:{...row.item,summary:{...row.item.summary,bytes:20}}}])[0]?.action).toMatchObject({action:'defer',approvedAds:[],acceptSourceIds:[]});
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
