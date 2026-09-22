import type { AdmissionAction, AdmissionActionKind, AdmissionItem } from '../types/local-admission';

export interface AdmissionEntry { item:AdmissionItem; action:AdmissionAction }
export const admissionGroups = {A:'无冲突的新作品',B:'已有作品候选，待本次确认',C:'同名 / 副本需确认',D:'冲突 / 需整理'};
export const admissionActionLabels = {new:'新独立作品',existing:'对应已有作品','same-as':'与本批目录同套',skip:'跳过',defer:'暂缓'};
export const isAdmissionSelected = (action:AdmissionAction) => ['new','existing','same-as'].includes(action.action);
export const isAdmissionSafeCandidate = (item:AdmissionItem) => item.group==='A'&&!item.candidates.length&&!item.conflicts.length&&!item.structureWarnings?.length&&!item.needsBoundaryReview;
export const mediaSize = (value:number) => value>=1024**3?`${(value/1024**3).toFixed(2)} GiB`:value>=1024**2?`${(value/1024**2).toFixed(2)} MiB`:`${value} B`;
export const admissionScopeReviewReason = '旧预览未记录父目录完整范围，请核对新发现目录是否属于本批作品';
/** Only the exact old system default can be upgraded; never reinterpret an edited choice. */
export function normalizeAdmissionScopeAction(item:AdmissionItem,action:AdmissionAction):AdmissionAction {
  if(item.scopeReviewRequired&&!action.scopeConfirmed&&action.action==='defer'&&action.reason===admissionScopeReviewReason
    &&action.workId===undefined&&action.sameAsKey===undefined&&!action.primary
    &&(action.displayTitle===undefined||action.displayTitle===item.displayTitle)
    &&!action.approvedAds?.length&&!action.acceptSourceIds?.length)
    return {...action,selectionOrigin:'scope-review'};
  return action;
}
export function confirmAdmissionScope(item:AdmissionItem,previous:AdmissionAction):AdmissionAction {
  if(previous.selectionOrigin!=='scope-review'||previous.action!=='defer')return previous;
  return {...admissionAction(item,isAdmissionSafeCandidate(item)?'new':'defer',previous),selectionOrigin:'automatic',scopeConfirmed:true,
    reason:isAdmissionSafeCandidate(item)?'用户确认本批目录范围，预选无冲突作品，待最终确认执行':'本批目录范围已确认，作品身份或目录边界仍需核对'};
}
function cancelledAdmissionAds(action:AdmissionAction,ads:AdmissionItem['ads']):string[]{
  return [...new Set([...(action.cancelledAds??[]),...(isAdmissionSelected(action)?ads.filter(ad=>!action.approvedAds?.includes(ad.relativePath)).map(ad=>ad.relativePath):[])])];
}
export function rememberAdmissionAdCancellations(item:AdmissionItem,action:AdmissionAction){
  action.cancelledAds=item.ads.filter(ad=>!action.approvedAds?.includes(ad.relativePath)).map(ad=>ad.relativePath);
}
export function admissionAction(item:AdmissionItem,kind:AdmissionActionKind,previous?:AdmissionAction):AdmissionAction {
  const cancelledAds=previous?cancelledAdmissionAds(previous,item.ads):[];
  return {key:item.key,action:kind,selectionOrigin:'manual',cancelledAds,...(previous?.scopeConfirmed?{scopeConfirmed:true}:{}),displayTitle:item.displayTitle,primary:false,acceptSourceIds:[],
    approvedAds:['new','existing','same-as'].includes(kind)?previous&&isAdmissionSelected(previous)?[...(previous.approvedAds??[])]:item.ads.map(ad=>ad.relativePath).filter(path=>!cancelledAds.includes(path)):[]};
}
/** Reconsider changed evidence without interpreting an old user choice as an automatic default. */
export function changedAdmissionAction(item:AdmissionItem,previous:AdmissionAction,previousAds:AdmissionItem['ads']=[]):AdmissionAction {
  previous=normalizeAdmissionScopeAction(item,previous);
  const cancelledAds=cancelledAdmissionAds(previous,previousAds).filter(path=>item.ads.some(ad=>ad.relativePath===path));
  if(previous.action==='defer'&&previous.selectionOrigin==='scope-review')return {...previous,key:item.key,cancelledAds,approvedAds:[],acceptSourceIds:[]};
  if(previous.action==='skip'||previous.action==='defer'&&previous.selectionOrigin!=='automatic')return {...previous,key:item.key,selectionOrigin:'manual',cancelledAds,approvedAds:[],acceptSourceIds:[]};
  if(previous.selectionOrigin==='automatic'&&['defer','new'].includes(previous.action)){
    const action={...admissionAction(item,isAdmissionSafeCandidate(item)?'new':'defer'),selectionOrigin:'automatic' as const,cancelledAds,...(previous.scopeConfirmed?{scopeConfirmed:true}:{})};
    action.approvedAds=action.approvedAds?.filter(path=>!cancelledAds.includes(path));
    return action;
  }
  return {...admissionAction(item,'defer'),cancelledAds,...(previous.scopeConfirmed?{scopeConfirmed:true}:{}),reason:'文件或身份依据有变化，或旧预览缺少比对依据，请重新核对后选择'};
}
export function validateAdmissionSelection(entries:AdmissionEntry[]):string {
  const primary=new Set<string>();
  for(const {item,action} of entries){
    if(action.action==='existing'&&!action.workId)return `请为“${item.displayTitle}”选择已有作品，或改为暂缓。`;
    const peer=action.action==='same-as'?entries.find(other=>other.item.key===action.sameAsKey):undefined;
    if(action.action==='same-as'&&(!peer||!['new','existing'].includes(peer.action.action)))return `请为“${item.displayTitle}”选择本博主批次内明确接纳的同套目录，或改为暂缓。`;
    if(action.primary&&isAdmissionSelected(action)){
      const root=peer?.action??action,key=root.action==='existing'?`work:${root.workId}`:root.key;
      if(primary.has(key))return '同一套作品只能明确选择一个主副本，请取消重复的主副本选择。';primary.add(key);
    }
  }
  return '';
}
export function admissionPayload(entries:AdmissionEntry[],accept:boolean):AdmissionAction[]{
  return entries.map(({action})=>{const {selectionOrigin:_origin,scopeConfirmed:_scopeConfirmed,cancelledAds:_cancelledAds,...payload}=action;return {...payload,approvedAds:isAdmissionSelected(action)?[...(action.approvedAds??[])]:[],acceptSourceIds:accept&&action.action==='existing'?[...(action.acceptSourceIds??[])]:[],reason:action.reason||`用户在网页确认页选择：${admissionActionLabels[action.action]}`};});
}
export function admissionAdSummary(entries:AdmissionEntry[]){
  const rows=new Map<string,{filename:string;type:string;directories:number;files:number;selected:number;automatic:boolean}>();
  for(const {item,action} of entries.filter(entry=>isAdmissionSelected(entry.action))){
    const approved=new Set(action.approvedAds??[]),names=new Set<string>();
    for(const ad of item.ads){const filename=ad.relativePath.split(/[\\/]/).at(-1)??ad.relativePath,row=rows.get(filename)??{filename,type:filename.split('.').at(-1)?.toUpperCase()??'附件',directories:0,files:0,selected:0,automatic:false};row.files++;if(!names.has(filename))row.directories++;row.selected+=Number(approved.has(ad.relativePath));row.automatic ||=ad.automatic===true;names.add(filename);rows.set(filename,row);}
  }
  return [...rows.values()].sort((a,b)=>a.filename.localeCompare(b.filename,'zh-CN'));
}
export function selectAdmissionAds(entries:AdmissionEntry[],selected:boolean,filename?:string){
  for(const {item,action} of entries.filter(entry=>isAdmissionSelected(entry.action))){const approved=new Set(action.approvedAds??[]);for(const ad of item.ads)if(!filename||(ad.relativePath.split(/[\\/]/).at(-1)??ad.relativePath)===filename){if(selected)approved.add(ad.relativePath);else approved.delete(ad.relativePath);}action.approvedAds=[...approved];rememberAdmissionAdCancellations(item,action);}
}
