import type { DraftEntry } from './admission-navigation';
import { admissionAction } from './admission-ui';

export interface RepreviewEntry extends DraftEntry { parent:string }

/** Unsent review choices only. A new preview never reuses an execution receipt. */
export function carryRepreviewChoices(previous:RepreviewEntry[],next:RepreviewEntry[]):Array<RepreviewEntry&{key:string}> {
  const matching=new Map<RepreviewEntry,RepreviewEntry>();
  for(const entry of next){
    const old=previous.find(row=>row.creatorId===entry.creatorId&&row.parent===entry.parent&&row.item.sourceRelativePath===entry.item.sourceRelativePath);
    if(old)matching.set(entry,old);
  }
  const valid=(entry:RepreviewEntry,seen=new Set<string>()):boolean=>{
    const old=matching.get(entry);
    if(!old||!old.item.reviewFingerprint||old.item.reviewFingerprint!==entry.item.reviewFingerprint)return false;
    if(old.action.action==='existing'&&old.work?.workId!==old.action.workId)return false;
    if(old.action.action==='same-as'){
      const key=`${old.batchId}:${old.item.key}`;if(seen.has(key))return false;seen.add(key);
      const peer=next.find(row=>row.batchId===entry.batchId&&matching.get(row)?.item.key===old.action.sameAsKey);
      if(!peer||!['new','existing'].includes(matching.get(peer)!.action.action)||!valid(peer,seen))return false;
    }
    return true;
  };
  return [...matching].map(([entry,old])=>{
    if(!valid(entry))return {...entry,key:entry.item.key,work:undefined,action:{...admissionAction(entry.item,'defer'),approvedAds:[],reason:'文件或身份依据有变化，或旧预览缺少比对依据，请重新核对后选择'}};
    const action={...old.action,key:entry.item.key,approvedAds:[...(old.action.approvedAds??[])],acceptSourceIds:[...(old.action.acceptSourceIds??[])]};
    if(action.action==='same-as')action.sameAsKey=next.find(row=>row.batchId===entry.batchId&&matching.get(row)?.item.key===old.action.sameAsKey)!.item.key;
    return {...entry,key:entry.item.key,action,work:old.work};
  });
}
