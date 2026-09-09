import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

import { databaseManager } from '../db/database.js';
import {
  ArchiveCatalogService,
  type CostuanCatalogImportResult
} from './archive-catalog-service.js';

export const ARCHIVE_METADATA_TASK_STATUSES = [
  'pending',
  'claimed',
  'completed',
  'not_found',
  'failed',
  'cancelled'
] as const;

export type ArchiveMetadataTaskStatus = typeof ARCHIVE_METADATA_TASK_STATUSES[number];

export type ArchiveMetadataTaskSummary = Record<ArchiveMetadataTaskStatus, number> & {
  total: number;
  actionable: number;
};

export type ArchiveMetadataTask = {
  id: number;
  creatorId: number;
  creatorName: string;
  canonicalCreatorId: number;
  aliases: string[];
  legacyIdentity?: { source: 'hentaiclub'; sourceCreatorId: string } | null;
  checkRoundId?: string | null;
  lastSuccessfulSource?: { postId:string; url:string|null; sourceFolderName:string|null; destinationPath:string|null; observedAt:string } | null;
  explicitSelection: boolean;
  sourceState: ArchiveSourceState;
  preference: 'liked' | 'kept' | null;
  rating: 'R15' | 'R18' | null;
  source: string;
  localWorks: number;
  status: ArchiveMetadataTaskStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArchiveMetadataTaskPayload = {
  summary: ArchiveMetadataTaskSummary;
  items: ArchiveMetadataTask[];
  total: number;
  page: number;
  limit: number;
};

export type ArchiveSourceState = {
  metadataAccepted: boolean;
  deliveryReady: boolean;
  deliveryEvidence: 'verified' | 'historical' | 'missing';
  missing: string[];
};

export class ArchiveMetadataTaskError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

type TaskContext = {
  explicitSelection?: boolean;
  checkRoundId?: string;
  requestId?: string;
  history?: Array<{attemptCount:number;checkRoundId?:string;status:ArchiveMetadataTaskStatus;completedAt:string|null;lastError:string|null;receipt?:TaskContext['receipt'];finalized?:TaskContext['finalized']}>;
  finalized?: {attemptCount:number;scopeKey:string;result:unknown};
  receipt?: { workerId: string; receiptId: string; checksum: string; importResult: CostuanCatalogImportResult };
};
const CONTEXT_PREFIX = 'archive.metadata-task.context.';
const REQUEST_PREFIX = 'archive.metadata-check.request.';
type CheckRequest = {creatorIds:number[];tasks:Array<{id:number;checkRoundId:string|null}>;createdAt:string};
export type MetadataFinalizeOptions = {creatorIds:number[];taskIds:number[];workerId:string;attempts?:Array<{taskId:number;expectedAttempt:number}>};
// Protect the existing asynchronous post-source handoff within this server
// process/connection. This is not a distributed or cross-process lease.
const finalizingTasks = new WeakMap<DatabaseSync, Set<number>>();

export function validateArchiveIds(ids: number[], label = 'creatorIds'): number[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ArchiveMetadataTaskError(`${label} 必须是 1～500 个有效正整数，不能扩大为空范围。`);
  }
  return [...new Set(ids)];
}

export type ArchiveMetadataPlanResult = {
  source: string;
  candidates: number;
  created: number;
  requeued: number;
  reconciled: number;
  summary: ArchiveMetadataTaskSummary;
};

type TaskRow = {
  id: number;
  creator_id: number;
  creator_name: string;
  preference: 'liked' | 'kept' | null;
  rating: 'R15' | 'R18' | null;
  source: string;
  local_works: number;
  status: ArchiveMetadataTaskStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function legacyRosterSeedKey(value: string): string {
  // Match CostuanArchiveManager's old normalizeCreatorName seed-ID encoding,
  // not canonical identity/name matching. Never normalize the returned seed ID.
  return value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    .replace(/[\s_.·・‧\-—–()（）\[\]【】]/g, '');
}

function mapTask(row: TaskRow): Omit<ArchiveMetadataTask, 'canonicalCreatorId' | 'aliases' | 'explicitSelection' | 'sourceState'> {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    preference: row.preference,
    rating: row.rating,
    source: row.source,
    localWorks: row.local_works,
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class ArchiveMetadataTaskService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

  private transaction<T>(action: () => T): T {
    this.database.exec('SAVEPOINT metadata_task');
    try { const result = action(); this.database.exec('RELEASE metadata_task'); return result; }
    catch (error) { this.database.exec('ROLLBACK TO metadata_task; RELEASE metadata_task'); throw error; }
  }

  private context(id: number): TaskContext {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(`${CONTEXT_PREFIX}${id}`) as {value:string}|undefined;
    return row ? JSON.parse(row.value) as TaskContext : {};
  }

  private saveContext(id: number, context: TaskContext): void {
    this.database.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`${CONTEXT_PREFIX}${id}`, JSON.stringify(context));
  }

  sourceState(creatorId: number): ArchiveSourceState {
    const rows = this.database.prepare(`SELECT deliveries.status, deliveries.source_folder_name, deliveries.destination_path,
        deliveries.metadata_json FROM archive_catalog_collections collections
      LEFT JOIN archive_catalog_deliveries deliveries ON deliveries.collection_id=collections.id AND deliveries.provider='baidu'
      WHERE collections.creator_id=? AND collections.source='costuan' AND collections.is_active=1
        AND EXISTS (SELECT 1 FROM archive_catalog_source_works sw WHERE sw.collection_id=collections.id AND sw.is_active=1)`)
      .all(creatorId) as Array<{status:string|null;source_folder_name:string|null;destination_path:string|null;metadata_json:string|null}>;
    const usable = rows.filter(row => ['saved','already-saved'].includes(row.status ?? '') && row.source_folder_name?.trim() && row.destination_path?.trim());
    const verified = usable.some(row => {
      try { const v = JSON.parse(row.metadata_json ?? '{}').verification; return !!v?.checkedAt && ['saved','reused'].includes(v.method) && !!v.sourceDirectory; }
      catch { return false; }
    });
    return { metadataAccepted: rows.length > 0, deliveryReady: usable.length > 0,
      deliveryEvidence: verified ? 'verified' : usable.length ? 'historical' : 'missing',
      missing: rows.length === 0 ? ['尚无有效 Costuan 作品来源'] : usable.length ? [] : ['完整百度来源目录尚未转存或确认，缺少可用来源路径'] };
  }

  private aliases(creatorId: number): string[] {
    return (this.database.prepare('SELECT DISTINCT alias FROM archive_catalog_creator_aliases WHERE creator_id=? ORDER BY alias')
      .all(creatorId) as Array<{alias:string}>).map(row => row.alias);
  }

  private legacyIdentityMap(): Map<number, string> {
    // Include inactive creators and creators without metadata tasks: a paged
    // task result cannot prove global ownership of the old roster record ID.
    const rows = this.database.prepare(`SELECT id, seed_source_creator_id AS sourceCreatorId
      FROM archive_catalog_creators WHERE seed_source='hentaiclub'`).all() as Array<{id:number;sourceCreatorId:string}>;
    const owners = new Map<string, number | null>();
    for (const row of rows) {
      const key = legacyRosterSeedKey(row.sourceCreatorId);
      if (key) owners.set(key, owners.has(key) ? null : row.id);
    }
    return new Map(rows.filter(row => owners.get(legacyRosterSeedKey(row.sourceCreatorId)) === row.id)
      .map(row => [row.id, row.sourceCreatorId]));
  }

  private lastSuccessfulSource(creatorId:number): ArchiveMetadataTask['lastSuccessfulSource'] {
    return this.database.prepare(`SELECT c.source_collection_id AS postId,c.source_url AS url,
      d.source_folder_name AS sourceFolderName,d.destination_path AS destinationPath,c.observed_at AS observedAt
      FROM archive_catalog_collections c LEFT JOIN archive_catalog_deliveries d ON d.id=(
        SELECT id FROM archive_catalog_deliveries WHERE collection_id=c.id AND provider='baidu'
          AND status IN ('saved','already-saved') ORDER BY last_seen_at DESC,id DESC LIMIT 1)
      WHERE c.creator_id=? AND c.source='costuan' AND c.is_active=1
        AND EXISTS(SELECT 1 FROM archive_catalog_source_works sw WHERE sw.collection_id=c.id AND sw.is_active=1)
      ORDER BY c.observed_at DESC,c.id DESC LIMIT 1`).get(creatorId) as NonNullable<ArchiveMetadataTask['lastSuccessfulSource']> | undefined ?? null;
  }

  private enrich(row: TaskRow, identities = this.legacyIdentityMap()): ArchiveMetadataTask {
    const seedId = identities.get(row.creator_id);
    const context = this.context(row.id);
    return {...mapTask(row),canonicalCreatorId:row.creator_id, aliases:this.aliases(row.creator_id),
      legacyIdentity:seedId === undefined ? null : {source:'hentaiclub',sourceCreatorId:seedId},
      checkRoundId:context.checkRoundId ?? null,lastSuccessfulSource:this.lastSuccessfulSource(row.creator_id),
      explicitSelection:!!context.explicitSelection,sourceState:this.sourceState(row.creator_id)};
  }

  candidates(options: { q?:string; page?:number; limit?:number; active?:'active'|'inactive'|'all'; hasSource?:'yes'|'no'|'all' } = {}) {
    const page = Math.max(1, options.page ?? 1), limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const clauses:string[] = [], params:Array<string|number> = [];
    if ((options.active ?? 'active') !== 'all') { clauses.push('creators.is_active=?'); params.push(options.active === 'inactive' ? 0 : 1); }
    if (options.q?.trim()) { clauses.push(`(creators.canonical_name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM archive_catalog_creator_aliases a WHERE a.creator_id=creators.id AND a.alias LIKE ? ESCAPE '\\'))`);
      const q = `%${options.q.trim().replace(/[\\%_]/g, '\\$&')}%`; params.push(q,q); }
    const source = options.hasSource ?? 'no';
    if (source !== 'all') clauses.push(`${source === 'no' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM archive_catalog_collections c JOIN archive_catalog_source_works s ON s.collection_id=c.id WHERE c.creator_id=creators.id AND c.source='costuan' AND c.is_active=1 AND s.is_active=1)`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (this.database.prepare(`SELECT COUNT(*) AS count FROM archive_catalog_creators creators ${where}`).get(...params) as {count:number}).count;
    const rows = this.database.prepare(`SELECT creators.id AS creatorId,creators.canonical_name AS creatorName,
      creators.preference,creators.effective_rating AS rating,creators.is_active AS isActive,
      (SELECT COUNT(*) FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works w ON w.local_creator_folder_id=f.id WHERE f.creator_id=creators.id AND f.is_active=1 AND w.is_active=1) AS localWorks
      FROM archive_catalog_creators creators ${where} ORDER BY CASE creators.preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END, creators.canonical_name COLLATE NOCASE,creators.id LIMIT ? OFFSET ?`)
      .all(...params,limit,(page-1)*limit) as Array<{creatorId:number;creatorName:string;preference:'liked'|'kept'|null;rating:'R15'|'R18'|null;isActive:number;localWorks:number}>;
    return {items:rows.map(row => ({...row,isActive:!!row.isActive,aliases:this.aliases(row.creatorId),sourceState:this.sourceState(row.creatorId),task:this.taskForCreator(row.creatorId)})),total,page,limit,pages:Math.ceil(total/limit)};
  }

  private taskForCreator(id: number): ArchiveMetadataTask | null {
    const row = this.database.prepare("SELECT id FROM archive_catalog_metadata_tasks WHERE creator_id=? AND source='costuan'").get(id) as {id:number}|undefined;
    return row ? this.get(row.id) : null;
  }

  planSelected(options: {creatorIds:number[];retry?:boolean;requestId?:string}) {
    const ids = validateArchiveIds(options.creatorIds);
    const requestId=options.requestId;
    if (requestId !== undefined && (typeof requestId!=='string' || !/^[A-Za-z0-9_-]{1,120}$/.test(requestId))) {
      throw new ArchiveMetadataTaskError('requestId 必须是 1～120 位有效请求标识；同一次提交重试必须复用。');
    }
    const creators = ids.map(id => this.database.prepare('SELECT id,canonical_name,is_active FROM archive_catalog_creators WHERE id=?').get(id) as {id:number;canonical_name:string;is_active:number}|undefined);
    if (creators.some(row => !row)) throw new ArchiveMetadataTaskError('选中范围包含不存在的规范博主。');
    return this.transaction(() => {
      const requestKey=requestId ? REQUEST_PREFIX+createHash('sha256').update(requestId).digest('hex') : null;
      const saved=requestKey ? this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(requestKey) as {value:string}|undefined : undefined;
      if (saved) {
        const request=JSON.parse(saved.value) as CheckRequest;
        if (JSON.stringify([...request.creatorIds].sort((a,b)=>a-b))!==JSON.stringify([...ids].sort((a,b)=>a-b))) {
          throw new ArchiveMetadataTaskError('requestId 已用于其他选择范围，不能扩大或更换博主。',409);
        }
        const tasks=request.tasks.map(item=>this.get(item.id));
        if (tasks.some((task,index)=>!task || (task.checkRoundId ?? null)!==request.tasks[index].checkRoundId)) {
          throw new ArchiveMetadataTaskError('该请求轮次已被之后的明确检查替代，不能领取新轮次。',409);
        }
        return {requestId,replayed:true,taskIds:tasks.filter(task=>task && ['pending','claimed'].includes(task.status)).map(task=>task!.id),
          items:creators.map(creator=>({creatorId:creator!.id,creatorName:creator!.canonical_name,result:'replayed' as const,
            task:tasks.find(task=>task?.creatorId===creator!.id) ?? null,sourceState:this.sourceState(creator!.id)}))};
      }
      const taskIds:number[] = [];
      const items = creators.map(creator => {
        const row = creator!;
        let task = this.taskForCreator(row.id);
        if (task && finalizingTasks.get(this.database)?.has(task.id)) {
          throw new ArchiveMetadataTaskError('该博主正在完成本轮差集对账，请等待收尾后再发起检查。',409);
        }
        let result:'created'|'reused'|'claimed'|'delivery_required'|'retry_required'|'inactive';
        const state = this.sourceState(row.id);
        if (!row.is_active) result='inactive';
        else if (task?.status === 'claimed') result='claimed';
        else if (task?.status === 'pending') result='reused';
        else if (task && !requestId && !options.retry) result=task.status === 'completed' ? 'delivery_required' : 'retry_required';
        else {
          if (task && !requestId) throw new ArchiveMetadataTaskError('新检查轮次需要 requestId；不能用无幂等标识的重试重新打开任务。');
          const timestamp=nowIso();
          if (!task) {
            this.database.prepare("INSERT INTO archive_catalog_metadata_tasks(creator_id,source,status,created_at,updated_at) VALUES (?,'costuan','pending',?,?)").run(row.id,timestamp,timestamp);
            result='created';
          } else {
            const context=this.context(task.id);
            const history=[...(context.history ?? []),{attemptCount:task.attemptCount,checkRoundId:context.checkRoundId,
              status:task.status,completedAt:task.completedAt,lastError:task.lastError,receipt:context.receipt,finalized:context.finalized}];
            this.saveContext(task.id,{...context,receipt:undefined,finalized:undefined,history,checkRoundId:randomUUID(),requestId});
            this.database.prepare("UPDATE archive_catalog_metadata_tasks SET status='pending',claimed_by=NULL,claimed_at=NULL,completed_at=NULL,last_error=NULL,updated_at=? WHERE id=?").run(timestamp,task.id);
            result='reused';
          }
          task=this.taskForCreator(row.id);
        }
        if (task && ['created','reused','claimed'].includes(result)) {
          const context=this.context(task.id);
          if (result !== 'claimed') this.saveContext(task.id,{...context,explicitSelection:true,
            ...(requestId && !context.checkRoundId ? {checkRoundId:randomUUID(),requestId} : {})});
          task=this.get(task.id); taskIds.push(task!.id);
        }
        return {creatorId:row.id,creatorName:row.canonical_name,result,task,sourceState:state};
      });
      if (requestKey) this.database.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)')
        .run(requestKey,JSON.stringify({creatorIds:ids,tasks:items.filter(item=>item.task && taskIds.includes(item.task.id))
          .map(item=>({id:item.task!.id,checkRoundId:item.task!.checkRoundId ?? null})),createdAt:nowIso()} satisfies CheckRequest));
      return {items,taskIds,requestId:requestId ?? null,replayed:false};
    });
  }

  planLocalOnly(options: { source?: string; retryNotFound?: boolean } = {}): ArchiveMetadataPlanResult {
    const source = options.source ?? 'costuan';
    const candidates = this.database.prepare(
      `SELECT creators.id AS creator_id
       FROM archive_catalog_creators creators
       WHERE creators.is_active = 1 AND EXISTS (
         SELECT 1
         FROM archive_catalog_local_creator_folders local_folders
         JOIN archive_catalog_local_works local_works
           ON local_works.local_creator_folder_id = local_folders.id
         WHERE local_folders.creator_id = creators.id
           AND local_folders.is_active = 1
           AND local_works.is_active = 1
       )
       AND NOT EXISTS (SELECT 1 FROM archive_catalog_metadata_tasks explicit_task JOIN app_settings context
         ON context.key='${CONTEXT_PREFIX}'||explicit_task.id
         WHERE explicit_task.creator_id=creators.id AND explicit_task.source=? AND json_extract(context.value,'$.explicitSelection')=1)
       AND NOT EXISTS (
         SELECT 1
         FROM archive_catalog_source_works source_works
         JOIN archive_catalog_works works ON works.id = source_works.work_id
         JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
         WHERE works.creator_id = creators.id
           AND source_works.source = ?
           AND source_works.is_active = 1
           AND collections.is_active = 1
       )
       ORDER BY CASE creators.preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END,
                creators.canonical_name COLLATE NOCASE`
    ).all(source,source) as Array<{ creator_id: number }>;
    const timestamp = nowIso();
    const insert = this.database.prepare(
      `INSERT INTO archive_catalog_metadata_tasks (
         creator_id, source, status, created_at, updated_at
       ) VALUES (?, ?, 'pending', ?, ?)
       ON CONFLICT(creator_id, source) DO NOTHING`
    );
    const requeueStatuses = options.retryNotFound
      ? ['failed', 'cancelled', 'not_found']
      : ['failed', 'cancelled'];
    const requeue = this.database.prepare(
      `UPDATE archive_catalog_metadata_tasks
       SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
           completed_at = NULL, last_error = NULL, updated_at = ?
       WHERE creator_id = ? AND source = ?
         AND status IN (${requeueStatuses.map(() => '?').join(', ')})`
    );
    let created = 0;
    let requeued = 0;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const candidate of candidates) {
        const inserted = insert.run(candidate.creator_id, source, timestamp, timestamp);
        if (Number(inserted.changes ?? 0) > 0) {
          created += 1;
          continue;
        }
        const updated = requeue.run(timestamp, candidate.creator_id, source, ...requeueStatuses);
        requeued += Number(updated.changes ?? 0);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    const reconciledResult = this.database.prepare(
      `UPDATE archive_catalog_metadata_tasks
       SET status = 'completed', claimed_by = NULL, claimed_at = NULL,
           completed_at = COALESCE(completed_at, ?), last_error = NULL, updated_at = ?
       WHERE source = ?
         AND status <> 'completed'
         AND NOT EXISTS (SELECT 1 FROM app_settings context WHERE context.key='${CONTEXT_PREFIX}'||archive_catalog_metadata_tasks.id AND json_extract(context.value,'$.explicitSelection')=1)
         AND EXISTS (SELECT 1 FROM archive_catalog_creators active_creator WHERE active_creator.id=archive_catalog_metadata_tasks.creator_id AND active_creator.is_active=1)
         AND EXISTS (
           SELECT 1
           FROM archive_catalog_source_works source_works
           JOIN archive_catalog_works works ON works.id = source_works.work_id
           JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
           WHERE works.creator_id = archive_catalog_metadata_tasks.creator_id
             AND source_works.source = archive_catalog_metadata_tasks.source
             AND source_works.is_active = 1
             AND collections.is_active = 1
         )`
    ).run(timestamp, timestamp, source);

    return {
      source,
      candidates: candidates.length,
      created,
      requeued,
      reconciled: Number(reconciledResult.changes ?? 0),
      summary: this.getSummary(source)
    };
  }

  list(options: {
    source?: string;
    status?: ArchiveMetadataTaskStatus;
    limit?: number;
    page?: number;
  } = {}): ArchiveMetadataTaskPayload {
    const source = options.source ?? 'costuan';
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const page = Math.max(1, options.page ?? 1);
    const clauses = ['tasks.source = ?'];
    const parameters: Array<string | number> = [source];
    if (options.status) {
      clauses.push('tasks.status = ?');
      parameters.push(options.status);
    }
    const where = clauses.join(' AND ');
    const items = this.database.prepare(
      `${this.taskSelectSql()}
       WHERE ${where}
       ORDER BY
         CASE tasks.status
           WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'claimed' THEN 2
           WHEN 'not_found' THEN 3 WHEN 'completed' THEN 4 ELSE 5
         END,
         CASE creators.preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END,
         local_works DESC, creators.canonical_name COLLATE NOCASE
       LIMIT ? OFFSET ?`
    ).all(...parameters, limit, (page-1)*limit) as TaskRow[];
    const total = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM archive_catalog_metadata_tasks tasks
       WHERE ${where}`
    ).get(...parameters) as { count: number };
    const identities = this.legacyIdentityMap();
    return {
      summary: this.getSummary(source),
      items: items.map(row => this.enrich(row, identities)),
      total: total.count, page, limit
    };
  }

  claim(options: { workerId: string; source?: string; limit?: number; taskIds?: number[];rounds?:Array<{taskId:number;checkRoundId:string}> }): ArchiveMetadataTask[] {
    const workerId = options.workerId.trim().slice(0, 120);
    if (!workerId) throw new Error('采集工作端标识不能为空。');
    const source = options.source ?? 'costuan';
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const timestamp = nowIso();
    const ids: number[] = [];
    const scope = options.taskIds === undefined ? null : validateArchiveIds(options.taskIds, 'taskIds');
    const rounds=options.rounds ?? [];
    if (!Array.isArray(rounds) || rounds.some(round=>!round || !Number.isSafeInteger(round.taskId) || round.taskId<=0 || typeof round.checkRoundId!=='string' || !round.checkRoundId)
      || new Set(rounds.map(round=>round.taskId)).size!==rounds.length || rounds.some(round=>!scope?.includes(round.taskId))) {
      throw new ArchiveMetadataTaskError('rounds 必须精确标识所选任务，不能重复、为空或扩大范围。');
    }
    if (scope) {
      for (const id of scope) {
        const task=this.get(id);
        if (!task) throw new ArchiveMetadataTaskError('领取范围包含不存在的元数据任务。');
        const round=rounds.find(item=>item.taskId===id);
        if ((task.checkRoundId && round?.checkRoundId!==task.checkRoundId) || (!task.checkRoundId && round)) {
          throw new ArchiveMetadataTaskError('来源检查轮次已变化或未提供 checkRoundId，请重新读取本次范围。',409);
        }
        this.requireActive(task.creatorId);
      }
    }
    const scopeSql = scope ? `AND tasks.id IN (${scope.map(()=>'?').join(',')})`
      : `AND NOT EXISTS (SELECT 1 FROM app_settings context WHERE context.key='${CONTEXT_PREFIX}'||tasks.id AND json_extract(context.value,'$.explicitSelection')=1)`;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database.prepare(
        `SELECT tasks.id, tasks.status, tasks.claimed_by
         FROM archive_catalog_metadata_tasks tasks
         JOIN archive_catalog_creators creators ON creators.id = tasks.creator_id
         WHERE tasks.source = ?
           AND creators.is_active=1
           ${scopeSql}
           AND (
             tasks.status IN (${scope ? "'pending'" : "'pending', 'failed'"})
             OR (tasks.status = 'claimed' AND tasks.claimed_by = ?)
           )
         ORDER BY CASE creators.preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END,
                  tasks.id
         LIMIT ?`
      ).all(source, ...(scope ?? []), workerId, limit) as Array<{
        id: number;
        status: ArchiveMetadataTaskStatus;
        claimed_by: string | null;
      }>;
      const update = this.database.prepare(
        `UPDATE archive_catalog_metadata_tasks
         SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?,
             attempt_count = attempt_count + 1, last_error = NULL
         WHERE id = ? AND status IN ('pending', 'failed')`
      );
      for (const row of rows) {
        if (row.status === 'claimed' && row.claimed_by === workerId) {
          ids.push(row.id);
          continue;
        }
        const result = update.run(workerId, timestamp, timestamp, row.id);
        if (Number(result.changes ?? 0) > 0) ids.push(row.id);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return ids.map((id) => this.get(id)).filter((task): task is ArchiveMetadataTask => task !== null);
  }

  complete(options: {
    id: number;
    workerId: string;
    record: unknown;
    canonicalCreatorId?: number;
    receiptId?: string;
    expectedAttempt?: number;
  }): { task: ArchiveMetadataTask; importResult: CostuanCatalogImportResult } {
    return this.transaction(() => {
      const snapshot=this.get(options.id);
      if (!snapshot) throw new ArchiveMetadataTaskError('博主元数据采集任务不存在。');
      const context=this.context(options.id);
      this.requireAttempt(snapshot, options.expectedAttempt);
      const checksum=createHash('sha256').update(JSON.stringify({canonicalCreatorId:options.canonicalCreatorId ?? snapshot.creatorId,record:options.record})).digest('hex');
      if (context.explicitSelection && (options.canonicalCreatorId !== snapshot.creatorId || !options.receiptId?.trim())) {
        throw new ArchiveMetadataTaskError('显式来源任务必须携带正确 canonicalCreatorId 和 receiptId。');
      }
      if (snapshot.status === 'completed' && context.receipt) {
        const receipt=context.receipt;
        if (receipt.workerId===options.workerId && receipt.receiptId===(options.receiptId ?? 'legacy') && receipt.checksum===checksum) {
          return {task:snapshot,importResult:receipt.importResult};
        }
        throw new ArchiveMetadataTaskError('已完成任务结果与回放凭据不一致，不能覆盖。',409);
      }
      if ((context.receipt && context.receipt.receiptId === options.receiptId)
        || context.history?.some(attempt=>attempt.receipt?.receiptId===options.receiptId)) throw new ArchiveMetadataTaskError('旧尝试的回传已经结束，不能用于新领取。',409);
      const current=this.requireClaim(options.id,options.workerId,options.expectedAttempt);
      if (options.canonicalCreatorId !== undefined && options.canonicalCreatorId !== current.creatorId) throw new ArchiveMetadataTaskError('规范博主身份与任务不一致。');
      const importResult=new ArchiveCatalogService(this.database).importCostuanRecord(options.record,{
        sourcePath:`bridge:metadata-task:${current.id}`,expectedCreatorId:current.creatorId,completeCheckRoundId:context.checkRoundId
      });
      if (importResult.matchedCreators!==1 || importResult.unmatchedCreators.length || importResult.importedWorks===0) throw new ArchiveMetadataTaskError('来源必须包含有效作品，并唯一关联到本任务博主。');
      const timestamp=nowIso();
      this.database.prepare(`UPDATE archive_catalog_metadata_tasks SET status='completed',completed_at=?,claimed_by=NULL,claimed_at=NULL,last_error=NULL,updated_at=? WHERE id=?`)
        .run(timestamp,timestamp,current.id);
      this.saveContext(current.id,{...context,receipt:{workerId:options.workerId,receiptId:options.receiptId ?? 'legacy',checksum,importResult}});
      return {task:this.get(current.id)!,importResult};
    });
  }

  validateSource(options: {id:number;workerId:string;canonicalCreatorId:number;postId:string;title:string;expectedAttempt?:number}) {
    const task=this.requireClaim(options.id,options.workerId,options.expectedAttempt);
    if (task.creatorId!==options.canonicalCreatorId) throw new ArchiveMetadataTaskError('规范博主身份与任务不一致。');
    new ArchiveCatalogService(this.database).validateCostuanIdentity(task.creatorId,options.postId,options.title);
    return task;
  }

  validateDirectory(options:{id:number;workerId:string;expectedAttempt?:number;canonicalCreatorId:number;record:unknown}) {
    const task=this.requireClaim(options.id,options.workerId,options.expectedAttempt);
    if (task.creatorId!==options.canonicalCreatorId) throw new ArchiveMetadataTaskError('规范博主身份与任务不一致。');
    if (!task.checkRoundId) throw new ArchiveMetadataTaskError('该任务没有本轮检查身份，请从规范博主选择器发起新的明确检查。',409);
    const {requiredFilenames,sourceFilenames,supplementalContents}=new ArchiveCatalogService(this.database).validateCompleteCostuanDirectory(options.record,task.creatorId);
    return {task,requiredFilenames,sourceFilenames,supplementalContents};
  }

  async finalizeSelected<T>(options:MetadataFinalizeOptions, action:(creatorIds:number[])=>Promise<T>):Promise<T> {
    const creatorIds=this.validateFinalize(options);
    const taskIds=[...new Set(options.taskIds)].sort((a,b)=>a-b);
    const scopeKey=createHash('sha256').update(JSON.stringify({creatorIds:[...creatorIds].sort((a,b)=>a-b),
      tasks:taskIds.map(id=>({id,attempt:this.get(id)!.attemptCount})),workerId:options.workerId})).digest('hex');
    const contexts=taskIds.map(id=>this.context(id));
    if (contexts.every(context=>context.finalized?.scopeKey===scopeKey)) {
      return structuredClone(contexts[0].finalized!.result) as T;
    }
    if (contexts.some(context=>context.finalized)) throw new ArchiveMetadataTaskError('本轮已有部分任务按其他范围收尾，请复用原收尾范围，不重复对账。',409);
    const locks=finalizingTasks.get(this.database) ?? new Set<number>();
    if (taskIds.some(id=>locks.has(id))) throw new ArchiveMetadataTaskError('本轮来源对账正在执行，不能重复提交。',409);
    finalizingTasks.set(this.database,locks);
    taskIds.forEach(id=>locks.add(id));
    try {
      const result=await action(creatorIds);
      // Guard again before recording completion. A different DB connection is
      // outside the in-process lock, so a changed attempt must never be accepted.
      this.validateFinalize(options);
      this.transaction(()=>taskIds.forEach(id=>{
        const task=this.get(id)!;
        this.saveContext(id,{...this.context(id),finalized:{attemptCount:task.attemptCount,scopeKey,result}});
      }));
      return result;
    } finally {
      taskIds.forEach(id=>locks.delete(id));
      if (!locks.size) finalizingTasks.delete(this.database);
    }
  }

  validateFinalize(options: MetadataFinalizeOptions): number[] {
    const ids=validateArchiveIds(options.creatorIds), tasks=validateArchiveIds(options.taskIds,'taskIds');
    const attempts=options.attempts ?? [];
    if (!Array.isArray(attempts) || attempts.some(item=>!item || !tasks.includes(item.taskId) || !Number.isSafeInteger(item.expectedAttempt) || item.expectedAttempt<=0)
      || new Set(attempts.map(item=>item.taskId)).size!==attempts.length) throw new ArchiveMetadataTaskError('收尾 attempts 必须属于明确任务范围且不能重复。');
    const actual=new Set<number>();
    for (const id of tasks) {
      const task=this.get(id), context=this.context(id);
      if (!task || task.status!=='completed' || context.receipt?.workerId!==options.workerId) throw new ArchiveMetadataTaskError('仅可收尾本工作端已确认回传的任务。',409);
      const attempt=attempts.find(item=>item.taskId===id);
      if ((task.checkRoundId && !attempt) || (attempt && attempt.expectedAttempt!==task.attemptCount)) {
        throw new ArchiveMetadataTaskError('收尾尝试已变化，旧轮次不能收尾当前检查。',409);
      }
      this.requireActive(task.creatorId); actual.add(task.creatorId);
    }
    if (actual.size!==ids.length || ids.some(id=>!actual.has(id))) throw new ArchiveMetadataTaskError('收尾 creatorIds 与 taskIds 必须严格一致，不能扩大范围。');
    return ids;
  }

  report(options: {
    id: number;
    workerId: string;
    status: 'not_found' | 'failed' | 'pending';
    error?: string | null;
    expectedAttempt?: number;
  }): ArchiveMetadataTask {
    const current = this.requireClaim(options.id, options.workerId, options.expectedAttempt);
    const timestamp = nowIso();
    const completedAt = options.status === 'not_found' ? timestamp : null;
    this.database.prepare(
      `UPDATE archive_catalog_metadata_tasks
       SET status = ?, claimed_by = NULL, claimed_at = NULL, completed_at = ?,
           last_error = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      options.status,
      completedAt,
      options.error?.trim().slice(0, 1000) || null,
      timestamp,
      current.id
    );
    return this.get(current.id)!;
  }

  get(id: number): ArchiveMetadataTask | null {
    const row = this.database.prepare(
      `${this.taskSelectSql()} WHERE tasks.id = ?`
    ).get(id) as TaskRow | undefined;
    return row ? this.enrich(row) : null;
  }

  private requireClaim(id: number, workerId: string, expectedAttempt?:number): ArchiveMetadataTask {
    const current = this.get(id);
    if (!current) throw new Error('博主元数据采集任务不存在。');
    this.requireActive(current.creatorId);
    this.requireAttempt(current,expectedAttempt);
    if (current.status !== 'claimed') throw new Error(`采集任务当前状态为 ${current.status}，不能提交结果。`);
    if (current.claimedBy !== workerId) throw new Error('采集任务已由其他工作端领取。');
    return current;
  }

  private requireAttempt(task:ArchiveMetadataTask, expectedAttempt?:number):void {
    if ((task.explicitSelection || expectedAttempt !== undefined) &&
      (!Number.isSafeInteger(expectedAttempt) || expectedAttempt !== task.attemptCount)) {
      throw new ArchiveMetadataTaskError('采集尝试已变化，旧执行结果不能覆盖当前任务。',409);
    }
  }

  private requireActive(id:number): void {
    const row=this.database.prepare('SELECT is_active FROM archive_catalog_creators WHERE id=?').get(id) as {is_active:number}|undefined;
    if (!row?.is_active) throw new ArchiveMetadataTaskError('规范博主已停用，停止处理。',409);
  }

  private getSummary(source: string): ArchiveMetadataTaskSummary {
    const summary = Object.fromEntries(
      ARCHIVE_METADATA_TASK_STATUSES.map((status) => [status, 0])
    ) as ArchiveMetadataTaskSummary;
    summary.total = 0;
    summary.actionable = 0;
    const rows = this.database.prepare(
      `SELECT status, COUNT(*) AS count
       FROM archive_catalog_metadata_tasks
       WHERE source = ?
       GROUP BY status`
    ).all(source) as Array<{ status: ArchiveMetadataTaskStatus; count: number }>;
    for (const row of rows) {
      summary[row.status] = row.count;
      summary.total += row.count;
    }
    summary.actionable = summary.pending + summary.failed;
    return summary;
  }

  private taskSelectSql(): string {
    return `SELECT tasks.id,
                   creators.id AS creator_id,
                   creators.canonical_name AS creator_name,
                   creators.preference,
                   creators.effective_rating AS rating,
                   tasks.source,
                   (
                     SELECT COUNT(*)
                     FROM archive_catalog_local_creator_folders local_folders
                     JOIN archive_catalog_local_works local_works
                       ON local_works.local_creator_folder_id = local_folders.id
                     WHERE local_folders.creator_id = creators.id
                       AND local_folders.is_active = 1
                       AND local_works.is_active = 1
                   ) AS local_works,
                   tasks.status,
                   tasks.claimed_by,
                   tasks.claimed_at,
                   tasks.completed_at,
                   tasks.attempt_count,
                   tasks.last_error,
                   tasks.created_at,
                   tasks.updated_at
            FROM archive_catalog_metadata_tasks tasks
            JOIN archive_catalog_creators creators ON creators.id = tasks.creator_id`;
  }
}
