import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { databaseManager } from '../db/database.js';

// Observation timestamps deliberately do not version content. Changes to the
// actual source declaration require another explicit acceptance.
export const sourceVersionSql = (s: string) => `json_object('workId',${s}.work_id,'sourceId',${s}.source_work_id,'order',${s}.source_order,'title',${s}.source_title,'media',${s}.media_summary,'metadata',${s}.metadata_json)`;
export const localVersionSql = (l: string) => `json_object('workId',${l}.work_id,'path',${l}.absolute_path,'images',${l}.image_count,'videos',${l}.video_count,'bytes',${l}.total_bytes)`;
export const fulfillmentValidSql = (s: string) => `EXISTS (SELECT 1 FROM archive_catalog_local_fulfillments fulfilled
 JOIN archive_catalog_work_decisions accepted ON accepted.id=fulfilled.decision_id
 JOIN archive_catalog_local_works accepted_local ON accepted_local.id=fulfilled.local_work_id
 JOIN archive_catalog_local_creator_folders accepted_folder ON accepted_folder.id=accepted_local.local_creator_folder_id
 WHERE fulfilled.source_work_id=${s}.id AND fulfilled.work_id=${s}.work_id
 AND fulfilled.state='active' AND accepted.state='active' AND accepted.kind='accept_version'
 AND accepted_local.is_active=1 AND accepted_folder.is_active=1 AND accepted_local.work_id=${s}.work_id
 AND EXISTS (SELECT 1 FROM posts accepted_post JOIN post_items accepted_item ON accepted_item.post_id=accepted_post.id JOIN images accepted_image ON accepted_image.id=accepted_item.image_id WHERE accepted_post.id=accepted_local.post_id AND accepted_post.is_deleted=0 AND accepted_post.is_trashed=0 AND accepted_image.is_deleted=0 AND accepted_image.is_trashed=0)
 AND fulfilled.source_snapshot_json=${sourceVersionSql(s)} AND fulfilled.local_snapshot_json=${localVersionSql('accepted_local')})`;
/** A revoked/changed acceptance is a review hold, never an automatic re-download. */
export const acquisitionHeldSql = (s: string) => `EXISTS (SELECT 1 FROM archive_catalog_local_fulfillments held WHERE held.source_work_id=${s}.id)`;
export const legacyLocalCoverageSql = (s: string) => `EXISTS (SELECT 1 FROM archive_catalog_local_works legacy_local
 JOIN archive_catalog_local_creator_folders legacy_folder ON legacy_folder.id=legacy_local.local_creator_folder_id
 WHERE legacy_local.work_id=${s}.work_id AND legacy_local.is_active=1 AND legacy_folder.is_active=1
 AND legacy_local.match_status='matched' AND legacy_folder.creator_id=(SELECT creator_id FROM archive_catalog_works WHERE id=${s}.work_id)
 AND NOT EXISTS (SELECT 1 FROM archive_catalog_work_decisions manual_decision WHERE manual_decision.local_work_id=legacy_local.id))`;
// Missing coverage and permission to acquire are separate: stale/revoked
// acceptances remain uncovered, while their hold prevents silent re-download.
export const sourceNeedsAcquisitionSql = (s: string) => `(NOT ${fulfillmentValidSql(s)} AND NOT ${legacyLocalCoverageSql(s)})`;

export class ArchiveLocalFulfillmentService {
 constructor(private readonly database: DatabaseSync = databaseManager.connection) {}
 accept(options: { decisionKey: string; sourceWorkId: number; localWorkId: number; taskIds: number[]; reason: string }) {
  if (!options.decisionKey.trim() || !options.reason.trim() || !Array.isArray(options.taskIds)
   || options.taskIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('明确版本接受需要决定键、理由及精确任务集合。');
  this.database.exec('SAVEPOINT accept_local_version');
  try {
   const source=this.database.prepare(`SELECT *,${sourceVersionSql('s')} AS snapshot FROM archive_catalog_source_works s WHERE id=?`).get(options.sourceWorkId) as any;
   const local=this.database.prepare(`SELECT l.*,f.creator_id, f.is_active AS folder_active,${localVersionSql('l')} AS snapshot FROM archive_catalog_local_works l JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id WHERE l.id=?`).get(options.localWorkId) as any;
   if(!source || !local || !source.is_active || !local.is_active || !local.folder_active || local.work_id!==source.work_id) throw new Error('接受版本必须是同一 Work 的有效来源和本地副本。');
   if(!existsSync(local.absolute_path) || !statSync(local.absolute_path).isDirectory()) throw new Error('接受版本的本地目录不可用。');
   if(!local.post_id || !this.database.prepare('SELECT 1 FROM posts p JOIN post_items pi ON pi.post_id=p.id JOIN images i ON i.id=pi.image_id WHERE p.id=? AND p.is_deleted=0 AND p.is_trashed=0 AND i.is_deleted=0 AND i.is_trashed=0 LIMIT 1').get(local.post_id)) throw new Error('本地副本尚未完成真实媒体索引，不能接受为空作品。');
   const identity=this.database.prepare(`SELECT id FROM archive_catalog_work_decisions WHERE work_id=? AND local_work_id=? AND state='active' AND kind IN ('same_work','manual','local_only','source_mapping')`).get(local.work_id,local.id);
   if(!identity) throw new Error('需要未撤销的明确作品身份决定。');
   const payload=JSON.stringify({sourceWorkId:source.id,localWorkId:local.id,taskIds:[...new Set(options.taskIds)].sort((a,b)=>a-b),source:source.snapshot,local:local.snapshot});
   const prior=this.database.prepare('SELECT id,payload_json,state FROM archive_catalog_work_decisions WHERE decision_key=?').get(options.decisionKey) as any;
   if(prior) {
    if(prior.payload_json!==payload || prior.state!=='active') throw new Error('决定键已用于不同或撤销内容，请重新明确确认。');
    this.database.exec('RELEASE accept_local_version'); return {decisionId:prior.id,replayed:true};
   }
   const tasks=this.database.prepare('SELECT id,status,claimed_by FROM archive_catalog_download_tasks WHERE source_work_id=?').all(source.id) as any[];
   if(tasks.some(t=>['claimed','downloading'].includes(t.status))) throw new Error('来源存在实际活动领取/下载，不可抢占或核销。');
   if(options.taskIds.length!==tasks.length || tasks.some(t=>!options.taskIds.includes(t.id))) throw new Error('任务集合已变化；必须重新确认该来源的精确任务集合。');
   const running=this.database.prepare(`SELECT id FROM local_ingest_jobs WHERE archive_download_task_id IN (SELECT id FROM archive_catalog_download_tasks WHERE source_work_id=?) AND status IN ('running','reconciling') LIMIT 1`).get(source.id);
   if(running) throw new Error('对应本地入库任务正在执行，暂缓接受版本。');
   const result=this.database.prepare(`INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,source_work_id,reason,payload_json,state,created_at) VALUES (?,'accept_version',?,?,?,?,?,'active',?)`).run(options.decisionKey,source.work_id,local.id,source.id,options.reason,payload,new Date().toISOString());
   const decisionId=Number(result.lastInsertRowid);
   const insert=this.database.prepare(`INSERT INTO archive_catalog_local_fulfillments(decision_id,work_id,source_work_id,local_work_id,task_id,source_snapshot_json,local_snapshot_json,reason,state,created_at) VALUES (?,?,?,?,?,?,?,?,'active',?)`);
   for(const taskId of options.taskIds.length?options.taskIds:[null]) insert.run(decisionId,source.work_id,source.id,local.id,taskId,source.snapshot,local.snapshot,options.reason,new Date().toISOString());
   this.database.exec('RELEASE accept_local_version');return {decisionId,replayed:false};
  }catch(error){this.database.exec('ROLLBACK TO accept_local_version; RELEASE accept_local_version');throw error;}
 }
}
