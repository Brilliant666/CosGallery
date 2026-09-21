import type { AdmissionAction, AdmissionActionKind, AdmissionItem } from '../types/local-admission';

export interface AdmissionEntry { item:AdmissionItem; action:AdmissionAction }
export const admissionGroups = {A:'无冲突的新作品',B:'已有作品候选，待本次确认',C:'同名 / 副本需确认',D:'冲突 / 需整理'};
export const admissionActionLabels = {new:'新独立作品',existing:'对应已有作品','same-as':'与本批目录同套',skip:'跳过',defer:'暂缓'};
export const isAdmissionSelected = (action:AdmissionAction) => ['new','existing','same-as'].includes(action.action);
export const mediaSize = (value:number) => value>=1024**3?`${(value/1024**3).toFixed(2)} GiB`:value>=1024**2?`${(value/1024**2).toFixed(2)} MiB`:`${value} B`;
export function admissionAction(item:AdmissionItem,kind:AdmissionActionKind,previous?:AdmissionAction):AdmissionAction {
  return {key:item.key,action:kind,displayTitle:item.displayTitle,primary:false,acceptSourceIds:[],
    approvedAds:['new','existing','same-as'].includes(kind)?previous&&isAdmissionSelected(previous)?[...(previous.approvedAds??[])]:item.ads.map(ad=>ad.relativePath):[]};
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
  return entries.map(({action})=>({...action,approvedAds:isAdmissionSelected(action)?[...(action.approvedAds??[])]:[],acceptSourceIds:accept&&action.action==='existing'?[...(action.acceptSourceIds??[])]:[],reason:action.reason||`用户在网页确认页选择：${admissionActionLabels[action.action]}`}));
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
  for(const {item,action} of entries.filter(entry=>isAdmissionSelected(entry.action))){const approved=new Set(action.approvedAds??[]);for(const ad of item.ads)if(!filename||(ad.relativePath.split(/[\\/]/).at(-1)??ad.relativePath)===filename){if(selected)approved.add(ad.relativePath);else approved.delete(ad.relativePath);}action.approvedAds=[...approved];}
}
