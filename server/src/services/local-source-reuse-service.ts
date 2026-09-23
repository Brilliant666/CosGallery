import type { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeWorkTitle } from '../utils/work-title.js';
import { isWorkTitleCandidate } from '../utils/work-title-candidate.js';
import { ArchiveLocalFulfillmentService, fulfillmentValidSql, localVersionSql } from './archive-local-fulfillment-service.js';

// Decision keys stay stable across suggestion-rule revisions.
const RULE='unique-work-title-v1';
const REVIEW_RULE='unique-work-title-v2-review-candidates';
type SourceInput={sourceOrder:string;label:string};
export type SourceReuseResult={sourceOrder:string;rawTitle:string;normalizedTitle:string;ruleVersion:string;
 status:'reuse'|'missing'|'review'|'existing';reason:string;workId?:number;localWorkId?:number;candidateWorkIds?:number[];satisfied:boolean};
type Local={id:number;work_id:number;absolute_path:string;post_id:number|null;is_active:number;identity_policy:string;
 provenance_json:string|null;folder_active:number;root_path:string;image_count:number;video_count:number};

/** Complete-set, read-only resolution, shared by preparation and import. Titles
 * produce rule decisions, never a claim of byte/content equality. */
export class LocalSourceReuseService {
 constructor(private readonly db:DatabaseSync){}
 evaluate(creatorId:number,postId:string,inputs:SourceInput[]):SourceReuseResult[]{
  const creator=this.db.prepare('SELECT canonical_name FROM archive_catalog_creators WHERE id=?').get(creatorId) as {canonical_name:string}|undefined;
  if(!creator)throw Error('Canonical creator not found');
  const names=[creator.canonical_name,...(this.db.prepare('SELECT alias FROM archive_catalog_creator_aliases WHERE creator_id=?').all(creatorId) as {alias:string}[]).map(x=>x.alias)];
  const normalized=inputs.map(i=>normalizeWorkTitle(i.label,names));
  const counts=new Map<string,number>();for(const n of normalized)counts.set(n,(counts.get(n)??0)+1);
  const works=this.db.prepare(`SELECT w.id,w.display_title,w.primary_local_work_id,
   EXISTS(SELECT 1 FROM archive_catalog_local_works l WHERE l.work_id=w.id) AS has_local
   FROM archive_catalog_works w WHERE w.creator_id=?`).all(creatorId) as {id:number;display_title:string;primary_local_work_id:number|null;has_local:number}[];
  const collection=this.db.prepare("SELECT id FROM archive_catalog_collections WHERE creator_id=? AND source='costuan' AND source_collection_id=?").get(creatorId,postId) as {id:number}|undefined;
  return inputs.map((i,index)=>{
   const base:SourceReuseResult={sourceOrder:i.sourceOrder,rawTitle:i.label,normalizedTitle:normalized[index],ruleVersion:REVIEW_RULE,status:'missing',satisfied:false,reason:'未发现可复用的同名本地作品'};
   const localCandidates=works.filter(w=>w.has_local && isWorkTitleCandidate(w.display_title,i.label,names));
   const existing=collection?this.db.prepare(`SELECT s.id,s.work_id,${fulfillmentValidSql('s')} AS satisfied FROM archive_catalog_source_works s WHERE collection_id=? AND source_work_id=?`).get(collection.id,i.sourceOrder) as {id:number;work_id:number;satisfied:number}|undefined:undefined;
   // Existing identity is never replaced by a name rule. A revoked rule is held,
   // not silently recreated, even after restart or a source refresh.
   if(existing){
    const boundLocal=this.db.prepare('SELECT id FROM archive_catalog_local_works WHERE work_id=?').get(existing.work_id);
    const explicit=this.db.prepare("SELECT id FROM archive_catalog_work_decisions WHERE source_work_id=? AND state='active' AND kind IN ('same_work','source_mapping','source_binding') ORDER BY id DESC LIMIT 1").get(existing.id) as {id:number}|undefined;
    if(!boundLocal && !explicit && localCandidates.some(w=>w.id!==existing.work_id))
     return {...base,status:'review',workId:existing.work_id,candidateWorkIds:localCandidates.map(w=>w.id),reason:'来源与本地候选已有不同Work ID；保留来源事实，待确认，不自动合并或重复获取'};
    const revoked=this.db.prepare("SELECT id FROM archive_catalog_work_decisions WHERE source_work_id=? AND kind='unique_name' AND state='revoked' ORDER BY id DESC LIMIT 1").get(existing.id) as {id:number}|undefined;
    const automatic=this.db.prepare("SELECT id,local_work_id FROM archive_catalog_work_decisions WHERE source_work_id=? AND kind='unique_name' AND state='active'").get(existing.id) as {id:number;local_work_id:number}|undefined;
    if(explicit && explicit.id>Math.max(revoked?.id??0,automatic?.id??0))return {...base,status:'existing',workId:existing.work_id,satisfied:!!existing.satisfied,reason:'复用后续人工确认的来源关系及版本决定'};
    if(automatic){
     const local=this.db.prepare('SELECT l.*,f.is_active AS folder_active,f.root_path FROM archive_catalog_local_works l JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id WHERE l.id=?').get(automatic.local_work_id) as Local|undefined;
     if(!local||!this.usable(local)||!existing.satisfied)return {...base,status:'review',workId:existing.work_id,reason:'已有名称关联的本地版本变化或接受失效，待复核'};
    }
    return {...base,status:revoked?'review':'existing',workId:existing.work_id,satisfied:!revoked&&!!existing.satisfied,reason:revoked?'名称关联已撤销，待人工纠正':automatic?'按唯一同名关联；本地已有，无需获取':'复用既有来源身份'};
   }
   const binding=collection?this.db.prepare(`SELECT b.work_id,d.state FROM archive_catalog_source_bindings b JOIN archive_catalog_work_decisions d ON d.id=b.decision_id WHERE b.collection_id=? AND b.source_work_id=?`).get(collection.id,i.sourceOrder) as {work_id:number;state:string}|undefined:undefined;
   if(binding?.state==='revoked')return {...base,status:'review',reason:'明确来源绑定已撤销，禁止自动重新关联'};
   const candidates=binding?works.filter(w=>w.id===binding.work_id):works.filter(w=>normalizeWorkTitle(w.display_title,names)===base.normalizedTitle);
   if(!binding && localCandidates.some(w=>!candidates.some(exact=>exact.id===w.id)))
    return {...base,status:'review',candidateWorkIds:localCandidates.map(w=>w.id),reason:'发现格式或前缀不同的本地作品候选；待确认，不代表缺失或内容相同'};
   if(!binding && (counts.get(base.normalizedTitle)!==1 || candidates.length>1))return {...base,status:'review',reason:'同名冲突，完整来源清单或Work集合不唯一，待确认'};
   if(!candidates.length){
    // Suggestions only: never strip meaningful punctuation/numbers for identity.
    const variant=works.some(w=>{
     const other=normalizeWorkTitle(w.display_title,names),title=base.normalizedTitle;
     if((other.match(/\d+/g)??[]).join()!==(title.match(/\d+/g)??[]).join())return false;
     return other.replace(/[\s\p{P}]/gu,'')===title.replace(/[\s\p{P}]/gu,'') ||
       (Math.min(other.length,title.length)>=4 && Math.min(other.length,title.length)/Math.max(other.length,title.length)>=0.7 && (other.includes(title)||title.includes(other)));
    });
    return variant?{...base,status:'review',reason:'标题可能是变体，非完全同名；仅作为候选，待确认'}:base;
   }
   const w=candidates[0];
   const locals=this.db.prepare(`SELECT l.*,f.is_active AS folder_active,f.root_path FROM archive_catalog_local_works l JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id WHERE l.work_id=?`).all(w.id) as Local[];
   if(!locals.length)return {...base,status:'review',workId:w.id,reason:'同名身份存在，但没有已索引本地副本，需确认复用范围'};
   const explicitBlock=this.db.prepare(`SELECT id FROM archive_catalog_work_decisions WHERE work_id=? AND (kind='different_work' AND state='active' OR kind IN ('same_work','unique_name') AND state='revoked') LIMIT 1`).get(w.id);
   if(!binding && (explicitBlock || locals.some(l=>l.identity_policy==='local_only')))return {...base,status:'review',workId:w.id,reason:'存在明确排除、禁止自动关联或撤销决定，名称规则不覆盖'};
   const local=locals.find(l=>l.id===w.primary_local_work_id) ?? (locals.length===1?locals[0]:undefined);
   if(!local)return {...base,status:'review',workId:w.id,reason:'同套多副本尚未明确主副本'};
   if(!this.usable(local))return {...base,status:'review',workId:w.id,localWorkId:local.id,reason:'本地副本离线、变化、未完成接纳或媒体索引，待核查而非已满足'};
   const policy=JSON.parse(local.provenance_json??'{}');
   if(policy.acceptExistingVersion!==true)return {...base,status:'review',workId:w.id,localWorkId:local.id,reason:'唯一同名候选，但尚未接受已有可用版本策略'};
   return {...base,status:'reuse',workId:w.id,localWorkId:local.id,satisfied:true,reason:binding?'按明确来源绑定复用本地已接受版本':'按唯一同名关联；本地已有，无需获取（非逐字节一致证明）'};
  });
 }

 private usable(l:Local):boolean{
  if(!l.is_active||!l.folder_active||!l.post_id||l.image_count+l.video_count===0)return false;
  if(this.db.prepare("SELECT 1 FROM archive_local_admission_items WHERE local_work_id=? AND state<>'completed'").get(l.id))return false;
  const post=this.db.prepare('SELECT source_path FROM posts WHERE id=? AND is_deleted=0 AND is_trashed=0').get(l.post_id) as {source_path:string}|undefined;
  if(!post||path.resolve(l.root_path,post.source_path)!==path.resolve(l.absolute_path))return false;
  const media=this.db.prepare('SELECT i.relative_path,i.file_size,i.mtime_ms FROM post_items p JOIN images i ON i.id=p.image_id WHERE p.post_id=? AND i.is_deleted=0 AND i.is_trashed=0').all(l.post_id) as {relative_path:string;file_size:number;mtime_ms:number}[];
  if(media.length!==l.image_count+l.video_count)return false;
  try{
   const dir=lstatSync(l.absolute_path);if(!dir.isDirectory()||dir.isSymbolicLink())return false;
   for(const m of media){const file=path.resolve(l.root_path,m.relative_path),relative=path.relative(l.absolute_path,file);if(relative.startsWith('..')||path.isAbsolute(relative))return false;const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size!==m.file_size||Math.abs(s.mtimeMs-m.mtime_ms)>1)return false;}
   return true;
  }catch{return false;}
 }

 /** Called only after SourceWork insertion in the same import transaction. */
 accept(sourceId:number,result:SourceReuseResult):void{
  if(result.status==='review'){
   this.db.prepare(`UPDATE archive_catalog_local_fulfillments SET state='stale' WHERE source_work_id=? AND state='active' AND decision_id IN
    (SELECT id FROM archive_catalog_work_decisions WHERE decision_key LIKE ? AND kind='accept_version')`).run(sourceId,`${RULE}:source:${sourceId}:accept:%`);
   return;
  }
  if(result.status!=='reuse'||!result.satisfied||!result.localWorkId||!result.workId)return;
  const key=`${RULE}:source:${sourceId}`;
  const evidence=JSON.stringify(result);
  this.db.prepare(`INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,source_work_id,reason,payload_json)
   VALUES (?,'unique_name',?,?,?,?,?) ON CONFLICT(decision_key) DO NOTHING`).run(key,result.workId,result.localWorkId,sourceId,result.reason,evidence);
  // An admission same_work decision already backs the actual local identity.
  const tasks=this.db.prepare('SELECT id,status FROM archive_catalog_download_tasks WHERE source_work_id=? ORDER BY id').all(sourceId) as {id:number;status:string}[];
  if(tasks.some(t=>['claimed','downloading'].includes(t.status)))return;
  const snapshot=this.db.prepare(`SELECT ${localVersionSql('l')} AS snapshot FROM archive_catalog_local_works l WHERE l.id=?`).get(result.localWorkId) as {snapshot:string};
  const fingerprint=createHash('sha256').update(snapshot.snapshot).digest('hex');
  new ArchiveLocalFulfillmentService(this.db).accept({decisionKey:`${key}:accept:${fingerprint}`,sourceWorkId:sourceId,localWorkId:result.localWorkId,taskIds:tasks.map(t=>t.id),reason:result.reason});
 }
}
