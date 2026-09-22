import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type LaterCompletion = {status:'completed_later';batchId:string;collectionId:string|null;planId:string;itemKey:string;
  workId:number;localWorkId:number;postId:number|null;completedAt:string|null;completionTimeBasis:'batch_completed'|'unavailable';evidence:'exact_directory_scope'};
export type CurrentAdmissionDisposition=LaterCompletion|{status:'unresolved'};
type ScopeRow={batch_id:string;creator_id:number;input_root:string;created_at:string;item_key:string;relative:string;target:string;state:string|null};
const normalized=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
export const admissionItemIdentity=(batchId:string,itemKey:string)=>JSON.stringify([batchId,itemKey]);

/** A read-only projection of completed execution facts, never a rewrite of old plans.
 * Start with the requested batches, then the existing creator index. No media,
 * manifests, filesystem reads, or per-item queries participate in this lookup.
 * A newly created independent scope is not covered by an earlier completion.
 */
export function laterAdmissionCompletions(db:DatabaseSync,batchIds:string[]):Map<string,CurrentAdmissionDisposition> {
  const result=new Map<string,CurrentAdmissionDisposition>();if(!batchIds.length)return result;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_admission_web_batches'").get())return result;
  const scoped=db.prepare(`SELECT b.id batch_id,b.creator_id,b.input_root,b.created_at,x.item_key,
    json_extract(x.summary_json,'$.sourceRelativePath') relative,json_extract(x.summary_json,'$.targetPath') target,a.state
    FROM json_each(?) requested JOIN local_admission_web_batches b ON b.id=requested.value
    JOIN local_admission_web_items x ON x.batch_id=b.id
    LEFT JOIN archive_local_admission_items a ON a.plan_id=b.id AND a.item_key=x.item_key
    WHERE x.action<>'skip' AND (a.state IS NULL OR a.state='planned')`).all(JSON.stringify(batchIds)) as unknown as ScopeRow[];
  if(!scoped.length)return result;
  // JSON scope input keeps the number of SQL statements independent of item count.
  const candidates=db.prepare(`WITH scope AS (SELECT json_extract(value,'$.creator_id') creator_id,
      json_extract(value,'$.input_root') input_root,MIN(json_extract(value,'$.created_at')) created_at
      FROM json_each(?) GROUP BY creator_id,input_root)
    SELECT b.id batch_id,b.creator_id,b.input_root,b.created_at,
      x.item_key,json_extract(x.summary_json,'$.sourceRelativePath') relative,json_extract(x.summary_json,'$.targetPath') target,
      a.work_id,a.local_work_id,l.post_id,l.absolute_path,CASE WHEN b.state='completed' THEN b.updated_at END completed_at,c.collection_id
    FROM scope s CROSS JOIN local_admission_web_batches b INDEXED BY idx_admission_web_creator
    JOIN local_admission_web_items x ON x.batch_id=b.id
    JOIN archive_local_admission_items a ON a.plan_id=b.id AND a.item_key=x.item_key AND a.state='completed'
    JOIN archive_catalog_local_works l ON l.id=a.local_work_id AND l.work_id=a.work_id
    JOIN archive_catalog_works w ON w.id=a.work_id AND w.creator_id=b.creator_id
    LEFT JOIN local_admission_web_collection_batches c ON c.batch_id=b.id
    WHERE b.creator_id=s.creator_id AND b.created_at>s.created_at
      AND b.confirmed_json IS NOT NULL
      AND b.input_root=s.input_root COLLATE ${process.platform==='win32'?'NOCASE':'BINARY'}
    ORDER BY b.created_at,b.id,x.position`).all(JSON.stringify(scoped));
  const scopeKey=(creatorId:number,root:string,relative:string)=>JSON.stringify([creatorId,normalized(path.join(root,relative))]);
  const oldScopes=new Map<string,ScopeRow[]>();
  for(const row of scoped){const key=scopeKey(row.creator_id,row.input_root,row.relative);oldScopes.set(key,[...oldScopes.get(key)??[],row]);}
  const ambiguous=new Set<string>();
  const newestCompletedByRoot=new Map<string,string>();
  for(const row of candidates){const key=scopeKey(Number(row.creator_id),String(row.input_root),'.'),stamp=String(row.created_at);
    if(stamp>(newestCompletedByRoot.get(key)??''))newestCompletedByRoot.set(key,stamp);}
  for(const old of scoped)if(old.created_at<(newestCompletedByRoot.get(scopeKey(old.creator_id,old.input_root,'.'))??''))
    result.set(admissionItemIdentity(old.batch_id,old.item_key),{status:'unresolved'});
  for(const row of candidates){
    if(!row.target||!row.absolute_path||normalized(String(row.target))!==normalized(String(row.absolute_path)))continue;
    for(const old of oldScopes.get(scopeKey(Number(row.creator_id),String(row.input_root),String(row.relative)))??[]){
    if(old.batch_id===row.batch_id||old.created_at>=String(row.created_at)||!old.target||normalized(String(row.target))!==normalized(old.target))continue;
    const key=admissionItemIdentity(old.batch_id,old.item_key);if(ambiguous.has(key))continue;
    const value:LaterCompletion={status:'completed_later',batchId:String(row.batch_id),collectionId:row.collection_id==null?null:String(row.collection_id),
      planId:String(row.batch_id),itemKey:String(row.item_key),workId:Number(row.work_id),localWorkId:Number(row.local_work_id),
      postId:row.post_id==null?null:Number(row.post_id),completedAt:row.completed_at==null?null:String(row.completed_at),
      completionTimeBasis:row.completed_at==null?'unavailable':'batch_completed',evidence:'exact_directory_scope'};
    const previous=result.get(key);
    if(previous?.status==='completed_later'&&(previous.workId!==value.workId||previous.localWorkId!==value.localWorkId)){result.set(key,{status:'unresolved'});ambiguous.add(key);}
    else result.set(key,value);
    }
  }
  return result;
}

export function assertNoLaterAdmissionCompletion(db:DatabaseSync,batchId:string,itemKeys?:string[]) {
  const covered=laterAdmissionCompletions(db,[batchId]);
  if([...covered].some(([key,value])=>value.status==='completed_later'&&(!itemKeys||itemKeys.some(itemKey=>key===admissionItemIdentity(batchId,itemKey)))))
    throw new Error('历史项目已在后续批次完成；请查看后续结果，不得再次执行原项目。其余项目请单独核对原范围。');
}
