import type { AdmissionAction, AdmissionItem, AdmissionWork } from '../types/local-admission';
import { admissionAction, changedAdmissionAction, isAdmissionSafeCandidate, normalizeAdmissionScopeAction } from './admission-ui';

const lastKey = 'cosgallery:admission:last-collection';
const draftKey = 'cosgallery:admission:tab-drafts';
export interface DraftEntry { batchId:string; creatorId:number; item:AdmissionItem; action:AdmissionAction; work?:AdmissionWork }
interface SavedEntry { batchId:string; creatorId:number; key:string; evidence:string; action:AdmissionAction; work?:AdmissionWork; sourceRelativePath?:string; ads?:AdmissionItem['ads'] }
// One tab's navigation/unsent choices only. Always fetch the authorized server
// collection first; this is never an execution receipt or an ownership proof.
const evidence = (item:AdmissionItem) => JSON.stringify([item.key,item.sourceRelativePath,item.targetPath,item.group,item.summary,item.candidates,item.conflicts,item.structureWarnings,item.needsBoundaryReview,item.ads,item.reviewFingerprint,item.displayTitle,
  // Keep old tab evidence identical when these new optional risk fields are absent/empty.
  ...(item.reviewIssues?.length||item.candidatesTruncated?[item.reviewIssues??[],!!item.candidatesTruncated]:[]),
  ...(item.peerCandidates?.length||item.peerCandidatesTruncated?[{peerCandidates:item.peerCandidates??[],peerCandidatesTruncated:!!item.peerCandidatesTruncated}]:[])]);
const savedEntry = ({batchId,creatorId,item,action,work}:DraftEntry):SavedEntry => ({batchId,creatorId,key:item.key,evidence:evidence(item),sourceRelativePath:item.sourceRelativePath,ads:item.ads,action,work});
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
    drafts.push({id,entries:entries.map(savedEntry)});
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
    return carrySavedChoices(saved.entries,entries,true);
  } catch { return []; }
}
/** Reconcile one loaded draft without depending on optional browser storage. */
export function carryRefreshedChoices(previous:DraftEntry[],next:DraftEntry[]):SavedEntry[]{
  return carrySavedChoices(previous.map(savedEntry),next,false);
}
function carrySavedChoices(saved:SavedEntry[],entries:DraftEntry[],validateStored:boolean):SavedEntry[]{
    const restored:SavedEntry[]=entries.flatMap(entry=>{
      const stored=saved.find(row=>row?.batchId===entry.batchId&&row.creatorId===entry.creatorId&&row.key===entry.item.key);
      const value=stored?.action?{...stored,action:normalizeAdmissionScopeAction(entry.item,stored.action)}:stored;
      if(!value||!value.action||value.action.key!==entry.item.key||!['new','existing','same-as','skip','defer'].includes(value.action.action))return [];
      if(value.evidence!==evidence(entry.item)){
        let previousEvidence:unknown;try{previousEvidence=JSON.parse(value.evidence);}catch{previousEvidence=undefined;}
        const sameSource=(value.sourceRelativePath??(Array.isArray(previousEvidence)?previousEvidence[1]:undefined))===entry.item.sourceRelativePath;
        const previousAds=value.ads??(Array.isArray(previousEvidence)?previousEvidence[9]:undefined);
        const action=sameSource?changedAdmissionAction(entry.item,value.action,Array.isArray(previousAds)?previousAds:[]):{...admissionAction(entry.item,'defer'),reason:'预览信息变化，请重新核对'};
        return [{batchId:entry.batchId,creatorId:entry.creatorId,key:entry.item.key,evidence:evidence(entry.item),action}];
      }
      if(validateStored){
        if(value.action.action==='existing'&&(!Number.isSafeInteger(value.action.workId)||value.work?.workId!==value.action.workId))return [];
        if(!Array.isArray(value.action.approvedAds)||!value.action.approvedAds.every((path:unknown)=>typeof path==='string'&&entry.item.ads.some(ad=>ad.relativePath===path)))return [];
        if(!Array.isArray(value.action.acceptSourceIds)||!value.action.acceptSourceIds.every((sourceId:unknown)=>Number.isSafeInteger(sourceId)&&value.work?.sources?.some((source:{sourceWorkId:number})=>source.sourceWorkId===sourceId)))return [];
      }
      if(value.action.action==='defer'&&value.action.selectionOrigin==='automatic'&&isAdmissionSafeCandidate(entry.item))return [{...value,action:changedAdmissionAction(entry.item,value.action)}];
      return [value as SavedEntry];
    });
    return restored.map(value=>{
      if(value.action.action!=='same-as')return value;
      const peer=restored.find(row=>row.batchId===value.batchId&&row.creatorId===value.creatorId&&row.key===value.action.sameAsKey);
      const oldPeer=saved.find(row=>row?.batchId===value.batchId&&row.creatorId===value.creatorId&&row.key===value.action.sameAsKey);
      if(peer&&['new','existing'].includes(peer.action.action)&&oldPeer?.evidence===peer.evidence)return value;
      const entry=entries.find(row=>row.batchId===value.batchId&&row.creatorId===value.creatorId&&row.item.key===value.key)!;
      return {...value,work:undefined,action:{...admissionAction(entry.item,'defer',value.action),reason:'同套目录的预览依据变化，请重新核对'}};
    });
}
