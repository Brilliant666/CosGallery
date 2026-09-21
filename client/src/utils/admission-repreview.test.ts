import {describe,it,expect} from 'vitest';
import {carryRepreviewChoices,type RepreviewEntry} from './admission-repreview';
const row=(key:string,fingerprint='one',batchId='old'):RepreviewEntry=>({batchId,creatorId:1,parent:'same',item:{key,sourceRelativePath:key.replace(/new-/g,''),displayTitle:key,targetPath:'/target',group:'A',state:'preview',summary:{images:1,videos:0,other:0,bytes:1},candidates:[],conflicts:[],ads:[],reviewFingerprint:fingerprint},action:{key,action:'defer',approvedAds:[],acceptSourceIds:[]}});
describe('new preview choices are evidence bound',()=>{
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
});
