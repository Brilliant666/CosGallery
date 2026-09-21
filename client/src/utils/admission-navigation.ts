import type { AdmissionAction, AdmissionItem, AdmissionWork } from '../types/local-admission';
import { admissionAction } from './admission-ui';

const lastKey = 'cosgallery:admission:last-collection';
const draftKey = 'cosgallery:admission:tab-drafts';
export interface DraftEntry { batchId:string; creatorId:number; item:AdmissionItem; action:AdmissionAction; work?:AdmissionWork }
interface SavedEntry { batchId:string; creatorId:number; key:string; evidence:string; action:AdmissionAction; work?:AdmissionWork }
// One tab's navigation/unsent choices only. Always fetch the authorized server
// collection first; this is never an execution receipt or an ownership proof.
const evidence = (item:AdmissionItem) => JSON.stringify([item.key,item.sourceRelativePath,item.targetPath,item.group,item.summary,item.candidates,item.conflicts,item.structureWarnings,item.needsBoundaryReview,item.ads]);
export function lastAdmissionCollection():string|null {
  try { const id=sessionStorage.getItem(lastKey);return id&&/^[\w-]{1,150}$/.test(id)?id:null; } catch { return null; }
}
export function rememberAdmissionCollection(id:string|null) {
  try { if(id)sessionStorage.setItem(lastKey,id);else sessionStorage.removeItem(lastKey); } catch { /* Navigation remains available through history. */ }
}
export function saveAdmissionDraft(id:string,entries:DraftEntry[]) {
  try {
    const saved=JSON.parse(sessionStorage.getItem(draftKey)||'[]');
    const drafts=Array.isArray(saved)?saved.filter(row=>row?.id!==id).slice(-9):[];
    drafts.push({id,entries:entries.map(({batchId,creatorId,item,action,work})=>({batchId,creatorId,key:item.key,evidence:evidence(item),action,work}))});
    sessionStorage.setItem(draftKey,JSON.stringify(drafts));
  }
  catch { /* Optional tab state; never replace durable original receipts. */ }
}
export function clearAdmissionDraft(id:string) {
  try { const drafts=JSON.parse(sessionStorage.getItem(draftKey)||'[]');if(Array.isArray(drafts))sessionStorage.setItem(draftKey,JSON.stringify(drafts.filter(row=>row?.id!==id))); } catch { /* Optional tab state. */ }
}
export function restoreAdmissionDraft(id:string,entries:DraftEntry[]):SavedEntry[] {
  try {
    const drafts=JSON.parse(sessionStorage.getItem(draftKey)||'[]');
    const saved=Array.isArray(drafts)?drafts.find(row=>row?.id===id):null;
    if(saved?.id!==id||!Array.isArray(saved.entries))return [];
    return entries.flatMap(entry=>{
      const value=saved.entries.find((row:SavedEntry)=>row?.batchId===entry.batchId&&row.creatorId===entry.creatorId&&row.key===entry.item.key);
      if(!value||!value.action||value.action.key!==entry.item.key||!['new','existing','same-as','skip','defer'].includes(value.action.action))return [];
      if(value.evidence!==evidence(entry.item))return [{batchId:entry.batchId,creatorId:entry.creatorId,key:entry.item.key,evidence:evidence(entry.item),action:{...admissionAction(entry.item,'defer'),reason:'预览信息变化，请重新核对'}}];
      if(value.action.action==='existing'&&(!Number.isSafeInteger(value.action.workId)||value.work?.workId!==value.action.workId))return [];
      if(!Array.isArray(value.action.approvedAds)||!value.action.approvedAds.every((path:unknown)=>typeof path==='string'&&entry.item.ads.some(ad=>ad.relativePath===path)))return [];
      if(!Array.isArray(value.action.acceptSourceIds)||!value.action.acceptSourceIds.every((sourceId:unknown)=>Number.isSafeInteger(sourceId)&&value.work?.sources?.some((source:{sourceWorkId:number})=>source.sourceWorkId===sourceId)))return [];
      return [value as SavedEntry];
    });
  } catch { return []; }
}
