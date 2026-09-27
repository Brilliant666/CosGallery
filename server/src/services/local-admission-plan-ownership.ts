import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

type Scope = {planId:string;creatorId:number;inputRoot:string;items:ReadonlyArray<{key:string;sourceRelativePath:string;targetPath:string}>};
type Owner = {planId:string;itemKey:string;state:string;source:string;target:string};
const normalized=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const movedStates=['move_intent','files_verified','indexed'];

/** Execution ownership comes from checkpoints, never titles or inferred Work identity. */
function owners(db:DatabaseSync,scope:Scope):Owner[] {
  return db.prepare(`SELECT p.plan_id planId,a.item_key itemKey,a.state,
    json_extract(p.payload_json,'$.inputRoot') inputRoot,
    json_extract(item.value,'$.sourceRelativePath') relative,
    json_extract(item.value,'$.targetPath') target
    FROM archive_local_admission_plans p JOIN archive_local_admission_items a ON a.plan_id=p.plan_id
    JOIN json_each(p.payload_json,'$.items') item ON json_extract(item.value,'$.key')=a.item_key
    WHERE p.plan_id<>? AND json_extract(p.payload_json,'$.creatorId')=?
      AND a.state IN ('planned','move_intent','files_verified','indexed','completed')`).all(scope.planId,scope.creatorId)
    .map(row=>({planId:String(row.planId),itemKey:String(row.itemKey),state:String(row.state),
      source:normalized(path.join(String(row.inputRoot),String(row.relative))),target:normalized(String(row.target))}));
}
function overlaps(owner:Owner,scope:Scope,item:Scope['items'][number]) {
  return (owner.state!=='completed'&&owner.source===normalized(path.join(scope.inputRoot,item.sourceRelativePath)))||owner.target===normalized(item.targetPath);
}
export function planOwnershipError(planId:string,reason:string):Error {
  return new Error(`[ADMISSION_PLAN_CONFLICT:${planId}] ${reason} 请查看所属批次；不要移回文件或新建重复批次。`);
}
export function ownershipErrorPlan(message:string|null):string|null {
  return message?.match(/^\[ADMISSION_PLAN_CONFLICT:([a-zA-Z0-9_-]{1,100})\] /)?.[1]??null;
}
export function ownershipErrorText(message:string|null):string|null {
  return message?.replace(/^\[ADMISSION_PLAN_CONFLICT:[a-zA-Z0-9_-]{1,100}\] /,'')??null;
}

/** A changed, wholly unstarted scope may be re-previewed. A plan with moved files must be recovered first. */
export function assertNewAdmissionOwnership(db:DatabaseSync,scope:Scope) {
  const other=owners(db,scope),unfinished=new Set(other.filter(row=>movedStates.includes(row.state)).map(row=>row.planId));
  const conflict=other.find(row=>unfinished.has(row.planId)&&row.state!=='completed'&&scope.items.some(item=>overlaps(row,scope,item)));
  if(conflict)throw planOwnershipError(conflict.planId,'原批次已有移动中的目录且确认范围与本次重叠，须先处理原检查点。');
  const assertCase=foreignCaseCheckpointGuard(db,scope);
  for(const item of scope.items)assertCase(item);
}

/** Called before touching an item's source, target, attachments or registration. Existing plans stay immutable. */
export function admissionItemOwnershipGuard(db:DatabaseSync,scope:Scope) {
  // The durable admission lock is held by apply. Read other plans once, not once per directory.
  const other=owners(db,scope);
  return (item:Scope['items'][number])=>{
    const conflict=other.find(row=>row.state!=='planned'&&overlaps(row,scope,item));
    if(conflict)throw planOwnershipError(conflict.planId,'该目录已有其他批次的移动或完成记录，当前批次不能再次执行此目录。');
  };
}

/** Explain a known case-only parent collision; only its owning original plan may repair it. No adoption here. */
export function foreignCaseCheckpointGuard(db:DatabaseSync,scope:Scope) {
  if(process.platform!=='win32')return (_item:Scope['items'][number])=>{};
  const rows=db.prepare(`SELECT f.absolute_path,f.relative_path,a.plan_id
    FROM archive_catalog_local_creator_folders f
    JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id
    JOIN archive_local_admission_items a ON a.local_work_id=l.id
    WHERE f.creator_id=? AND f.is_active=1 AND f.gallery_folder_id IS NULL AND f.match_method='manual-admission'
      AND a.plan_id<>? AND a.state IN ('move_intent','files_verified','indexed')`).all(scope.creatorId,scope.planId);
  return (item:Scope['items'][number])=>{
    const parent=path.dirname(path.resolve(item.targetPath));
    const conflict=rows.find(row=>normalized(String(row.absolute_path))===normalized(parent)&&path.resolve(String(row.absolute_path))!==parent);
    if(conflict)throw planOwnershipError(String(conflict.plan_id),'同一博主目录仍有旧批次的大小写关联检查点，须先继续该原批次修正目录关联。');
  };
}
