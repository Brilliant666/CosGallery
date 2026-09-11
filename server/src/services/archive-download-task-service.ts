import { DatabaseSync } from 'node:sqlite';

import { databaseManager } from '../db/database.js';
import {directShareMetadata,currentBaiduDeliverySql} from './archive-baidu-delivery.js';

export type ArchiveDownloadTaskStatus =
  | 'pending'
  | 'claimed'
  | 'staged'
  | 'downloading'
  | 'downloaded'
  | 'ingested'
  | 'failed'
  | 'cancelled';

export type ArchiveDownloadTask = {
  id: number;
  creatorId: number;
  creatorName: string;
  preference: 'liked' | 'kept' | null;
  rating: 'R15' | 'R18' | null;
  workId: number;
  sourceWorkId: number;
  collectionId: number;
  source: string;
  sourceCollectionId: string;
  sourceOrder: number;
  sourceOrderLabel: string | null;
  title: string;
  provider: string;
  sourceFolderName: string;
  destinationPath: string;
  sourceMode?: 'owned-folder' | 'direct-share';
  sourceShareUrl?: string | null;
  targetRoot: string;
  targetRelativeDirectory: string;
  targetFilename: string;
  status: ArchiveDownloadTaskStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  downloadId: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArchiveDownloadTaskSummary = Record<ArchiveDownloadTaskStatus, number> & {
  total: number;
};

export type ArchiveDownloadTaskPayload = {
  summary: ArchiveDownloadTaskSummary;
  items: ArchiveDownloadTask[];
  total: number;
};

export type ArchiveDownloadPlanResult = {
  created: number;
  existing: number;
  removedOutOfScope: number;
  reconciledLocal: number;
  skippedWithoutOrder: number;
  skippedWithoutDelivery: number;
  targetRoot: string;
};

const TASK_STATUSES: ArchiveDownloadTaskStatus[] = [
  'pending',
  'claimed',
  'staged',
  'downloading',
  'downloaded',
  'ingested',
  'failed',
  'cancelled'
];

const ALLOWED_TRANSITIONS: Record<ArchiveDownloadTaskStatus, Set<ArchiveDownloadTaskStatus>> = {
  pending: new Set(['claimed', 'cancelled']),
  claimed: new Set(['pending', 'staged', 'downloading', 'downloaded', 'failed', 'cancelled']),
  staged: new Set(['pending', 'downloaded', 'ingested', 'failed', 'cancelled']),
  downloading: new Set(['downloaded', 'failed', 'cancelled']),
  downloaded: new Set(['ingested', 'failed']),
  ingested: new Set(),
  failed: new Set(['pending', 'claimed', 'cancelled']),
  cancelled: new Set(['pending'])
};

type TaskRow = {
  id: number;
  creator_id: number;
  creator_name: string;
  preference: 'liked' | 'kept' | null;
  rating: 'R15' | 'R18' | null;
  work_id: number;
  source_work_id: number;
  collection_id: number;
  source: string;
  source_collection_id: string;
  source_order: number;
  source_order_label: string | null;
  source_title: string;
  provider: string;
  source_folder_name: string;
  destination_path: string;
  delivery_metadata: string|null;
  target_root: string;
  target_relative_directory: string;
  target_filename: string;
  status: ArchiveDownloadTaskStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  download_id: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type PlanCandidateRow = {
  source_work_id: number;
  source_order: number | null;
  creator_name: string;
  delivery_id: number | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeArchiveInboxRoot(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/u, '');
  if (!normalized) throw new Error('待入库根目录不能为空。');
  if (normalized.length > 500) throw new Error('待入库根目录过长。');
  return normalized;
}

export function sanitizeArchiveDirectoryName(value: string): string {
  const sanitized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .trim();
  return sanitized || '未命名博主';
}

function buildTargetFilename(sourceOrder: number): string {
  return `${String(sourceOrder).padStart(3, '0')}.7z`;
}

function mapTask(row: TaskRow): ArchiveDownloadTask {
  const direct=directShareMetadata(row.delivery_metadata);
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    preference: row.preference,
    rating: row.rating,
    workId: row.work_id,
    sourceWorkId: row.source_work_id,
    collectionId: row.collection_id,
    source: row.source,
    sourceCollectionId: row.source_collection_id,
    sourceOrder: row.source_order,
    sourceOrderLabel: row.source_order_label,
    title: row.source_title,
    provider: row.provider,
    sourceFolderName: row.source_folder_name,
    destinationPath: row.destination_path,
    sourceMode:direct?'direct-share':'owned-folder',
    sourceShareUrl:direct?.shareUrl??null,
    targetRoot: row.target_root,
    targetRelativeDirectory: row.target_relative_directory,
    targetFilename: row.target_filename,
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    downloadId: row.download_id,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class ArchiveDownloadTaskService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

  getLatestTargetRoot(): string | null {
    const row = this.database.prepare(
      `SELECT target_root
       FROM archive_catalog_download_tasks
       WHERE TRIM(target_root) <> ''
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    ).get() as { target_root: string } | undefined;
    return row?.target_root ?? null;
  }

  planMissing(options: { targetRoot: string; creatorIds?: number[]; provider?: string }): ArchiveDownloadPlanResult {
    const targetRoot = normalizeArchiveInboxRoot(options.targetRoot);
    const provider = options.provider ?? 'baidu';
    const hasExplicitCreatorScope = Object.prototype.hasOwnProperty.call(options, 'creatorIds');
    const creatorIds = hasExplicitCreatorScope
      ? [...new Set(options.creatorIds ?? [])]
      : null;
    if (creatorIds !== null) {
      if (creatorIds.length === 0) {
        throw new Error('博主定向缺失任务规划不允许空 creatorIds。');
      }
      if (creatorIds.some((creatorId) => !Number.isSafeInteger(creatorId) || creatorId <= 0)) {
        throw new Error('博主定向缺失任务规划收到无效 creatorId。');
      }
      const placeholders = creatorIds.map(() => '?').join(', ');
      const rows = this.database.prepare(
        `SELECT id FROM archive_catalog_creators WHERE id IN (${placeholders})`
      ).all(...creatorIds) as Array<{ id: number }>;
      if (rows.length !== creatorIds.length) {
        throw new Error('博主定向缺失任务规划包含不存在的 creatorId。');
      }
    }
    const creatorParameters = creatorIds ?? [];
    const creatorFilter = creatorIds !== null
      ? `AND works.creator_id IN (${creatorIds.map(() => '?').join(', ')})`
      : '';
    let created = 0;
    let existing = 0;
    let reconciledLocal = 0;
    let removedOutOfScope = 0;
    let skippedWithoutOrder = 0;
    let skippedWithoutDelivery = 0;
    const timestamp = nowIso();

    this.database.exec('BEGIN IMMEDIATE');
    try {
      reconciledLocal = this.reconcileAlreadyLocalTasks(provider, creatorIds, timestamp);
      removedOutOfScope = this.removeOutOfScopeTasks(provider, creatorIds);
      const candidates = this.database.prepare(
        `SELECT source_works.id AS source_work_id,
                source_works.source_order,
                creators.canonical_name AS creator_name,
                deliveries.id AS delivery_id
         FROM archive_catalog_source_works source_works
         JOIN archive_catalog_works works ON works.id = source_works.work_id
         JOIN archive_catalog_creators creators ON creators.id = works.creator_id
         JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
         LEFT JOIN archive_catalog_deliveries deliveries
           ON deliveries.id = (
             SELECT candidate.id
             FROM archive_catalog_deliveries candidate
             WHERE candidate.collection_id = collections.id
               AND candidate.provider = ?
               AND ${currentBaiduDeliverySql('candidate',"printf('%03d.7z',source_works.source_order)")}
             ORDER BY candidate.last_seen_at DESC, candidate.id DESC
             LIMIT 1
           )
         WHERE source_works.source = 'costuan'
           AND creators.is_active = 1
           AND source_works.is_active = 1
           AND collections.is_active = 1
           AND NOT EXISTS (
             SELECT 1
             FROM archive_catalog_local_works local_works
             JOIN archive_catalog_local_creator_folders local_folders
               ON local_folders.id = local_works.local_creator_folder_id
             WHERE local_works.work_id = works.id
               AND local_works.is_active = 1
               AND local_folders.is_active = 1
           )
           ${creatorFilter}
         ORDER BY creators.id, source_works.source_order, source_works.id`
      ).all(provider, ...creatorParameters) as PlanCandidateRow[];
      const insert = this.database.prepare(
        `INSERT INTO archive_catalog_download_tasks (
           source_work_id, provider, target_root, target_relative_directory,
           target_filename, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(source_work_id, provider) DO NOTHING`
      );
      for (const candidate of candidates) {
        if (candidate.source_order === null) {
          skippedWithoutOrder += 1;
          continue;
        }
        if (candidate.delivery_id === null) {
          skippedWithoutDelivery += 1;
          continue;
        }
        const result = insert.run(
          candidate.source_work_id,
          provider,
          targetRoot,
          sanitizeArchiveDirectoryName(candidate.creator_name),
          buildTargetFilename(candidate.source_order),
          timestamp,
          timestamp
        );
        if (Number(result.changes ?? 0) > 0) created += 1;
        else existing += 1;
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return {
      created,
      existing,
      removedOutOfScope,
      reconciledLocal,
      skippedWithoutOrder,
      skippedWithoutDelivery,
      targetRoot
    };
  }

  private reconcileAlreadyLocalTasks(
    provider: string,
    creatorIds: number[] | null = null,
    timestamp = nowIso()
  ): number {
    const creatorFilter = creatorIds === null
      ? ''
      : `AND works.creator_id IN (${creatorIds.map(() => '?').join(', ')})`;
    const result = this.database.prepare(
      `UPDATE archive_catalog_download_tasks
       SET status = 'ingested', completed_at = COALESCE(completed_at, ?), updated_at = ?,
           claimed_by = NULL, claimed_at = NULL, last_error = NULL
       WHERE provider = ?
         AND status IN ('pending', 'claimed', 'failed', 'staged', 'downloaded')
         AND source_work_id IN (
           SELECT source_works.id
            FROM archive_catalog_source_works source_works
            JOIN archive_catalog_works works ON works.id = source_works.work_id
            JOIN archive_catalog_local_works local_works ON local_works.work_id = source_works.work_id
            JOIN archive_catalog_local_creator_folders local_folders
              ON local_folders.id = local_works.local_creator_folder_id
            WHERE local_works.is_active = 1
              AND EXISTS (SELECT 1 FROM archive_catalog_creators active_creator WHERE active_creator.id=works.creator_id AND active_creator.is_active=1)
              AND local_folders.is_active = 1
              ${creatorFilter}
          )`
    ).run(timestamp, timestamp, provider, ...(creatorIds ?? []));
    return Number(result.changes ?? 0);
  }

  private removeOutOfScopeTasks(provider: string, creatorIds: number[] | null = null): number {
    const creatorFilter = creatorIds === null
      ? ''
      : `AND source_work_id IN (
           SELECT scoped_source_works.id
           FROM archive_catalog_source_works scoped_source_works
           JOIN archive_catalog_works scoped_works ON scoped_works.id = scoped_source_works.work_id
           WHERE scoped_works.creator_id IN (${creatorIds.map(() => '?').join(', ')})
         )`;
    const result = this.database.prepare(
      `DELETE FROM archive_catalog_download_tasks
       WHERE provider = ?
          AND status IN ('pending', 'failed', 'cancelled')
          AND EXISTS (SELECT 1 FROM archive_catalog_source_works active_source
            JOIN archive_catalog_works active_work ON active_work.id=active_source.work_id
            JOIN archive_catalog_creators active_creator ON active_creator.id=active_work.creator_id
            WHERE active_source.id=archive_catalog_download_tasks.source_work_id AND active_creator.is_active=1)
          ${creatorFilter}
          AND NOT EXISTS (
           SELECT 1
           FROM archive_catalog_source_works source_works
           JOIN archive_catalog_collections collections
             ON collections.id = source_works.collection_id
           WHERE source_works.id = archive_catalog_download_tasks.source_work_id
             AND source_works.is_active = 1
             AND collections.is_active = 1
             AND EXISTS (
               SELECT 1
               FROM archive_catalog_deliveries deliveries
               WHERE deliveries.collection_id = collections.id
                 AND deliveries.provider = archive_catalog_download_tasks.provider
                 AND ${currentBaiduDeliverySql('deliveries')}
             )
         )`
    ).run(provider, ...(creatorIds ?? []));
    return Number(result.changes ?? 0);
  }

  list(options: { status?: ArchiveDownloadTaskStatus; creatorId?: number; limit?: number } = {}): ArchiveDownloadTaskPayload {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.status) {
      clauses.push('tasks.status = ?');
      parameters.push(options.status);
    }
    if (options.creatorId) {
      clauses.push('works.creator_id = ?');
      parameters.push(options.creatorId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const items = this.database.prepare(
      `${this.taskSelectSql()}
       ${where}
       ORDER BY
         CASE tasks.status
           WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'claimed' THEN 2
           WHEN 'staged' THEN 3 WHEN 'downloading' THEN 4 WHEN 'downloaded' THEN 5
           WHEN 'ingested' THEN 6 ELSE 7
         END,
         CASE creators.preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END,
         creators.id,
         source_works.source_order,
         tasks.id
       LIMIT ?`
    ).all(...parameters, limit) as TaskRow[];
    const totalRow = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM archive_catalog_download_tasks tasks
       JOIN archive_catalog_source_works source_works ON source_works.id = tasks.source_work_id
       JOIN archive_catalog_works works ON works.id = source_works.work_id
       ${where}`
    ).get(...parameters) as { count: number };

    return {
      summary: this.getSummary(),
      items: items.map(mapTask),
      total: totalRow.count
    };
  }

  claim(options: { workerId: string; limit?: number; seedTaskId?: number }): ArchiveDownloadTask[] {
    const workerId = options.workerId.trim().slice(0, 120);
    if (!workerId) throw new Error('下载工作端标识不能为空。');
    const limit = Math.min(500, Math.max(1, options.limit ?? 1));
    const timestamp = nowIso();
    const ids: number[] = [];

    if (options.seedTaskId !== undefined) {
      if (!Number.isSafeInteger(options.seedTaskId) || options.seedTaskId <= 0) throw new Error('指定暂存任务 ID 无效，不能扩大领取范围。');
      const target = this.database.prepare(`SELECT works.creator_id, tasks.provider,
          creators.is_active AS creator_active, source_works.is_active AS source_active, collections.is_active AS collection_active,
          EXISTS (SELECT 1 FROM archive_catalog_deliveries deliveries WHERE deliveries.collection_id=collections.id
            AND deliveries.provider=tasks.provider AND ${currentBaiduDeliverySql('deliveries','tasks.target_filename')}) AS delivery_ready
        FROM archive_catalog_download_tasks tasks
        JOIN archive_catalog_source_works source_works ON source_works.id=tasks.source_work_id
        JOIN archive_catalog_works works ON works.id=source_works.work_id
        JOIN archive_catalog_creators creators ON creators.id=works.creator_id
        JOIN archive_catalog_collections collections ON collections.id=source_works.collection_id
        WHERE tasks.id=?`).get(options.seedTaskId) as {creator_id:number;provider:string;creator_active:number;source_active:number;collection_active:number;delivery_ready:number}|undefined;
      if (!target) throw new Error('指定暂存任务不存在。');
      if (!target.creator_active || !target.source_active || !target.collection_active || !target.delivery_ready) {
        throw new Error('指定暂存任务的博主已停用或来源目录不可用，请先核验 Stage 1。');
      }
      this.reconcileAlreadyLocalTasks(target.provider,[target.creator_id]);
    } else {
      this.reconcileAlreadyLocalTasks('baidu');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const seed = options.seedTaskId
        ? this.database.prepare(
          `SELECT tasks.id, works.creator_id, source_works.collection_id, tasks.provider,
                  tasks.status, tasks.claimed_by
           FROM archive_catalog_download_tasks tasks
           JOIN archive_catalog_source_works source_works ON source_works.id = tasks.source_work_id
           JOIN archive_catalog_works works ON works.id = source_works.work_id
           WHERE tasks.id = ?`
        ).get(options.seedTaskId) as {
          id: number;
          creator_id: number;
          collection_id: number;
          provider: string;
          status: ArchiveDownloadTaskStatus;
          claimed_by: string | null;
        } | undefined
        : this.database.prepare(
          `SELECT tasks.id, works.creator_id, source_works.collection_id, tasks.provider,
                  tasks.status, tasks.claimed_by
           FROM archive_catalog_download_tasks tasks
           JOIN archive_catalog_source_works source_works ON source_works.id = tasks.source_work_id
           JOIN archive_catalog_works works ON works.id = source_works.work_id
           JOIN archive_catalog_creators creators ON creators.id = works.creator_id
           WHERE tasks.status IN ('pending', 'failed')
             AND creators.is_active=1 AND source_works.is_active=1
             AND EXISTS (SELECT 1 FROM archive_catalog_collections c JOIN archive_catalog_deliveries d ON d.collection_id=c.id
               WHERE c.id=source_works.collection_id AND c.is_active=1 AND d.provider=tasks.provider
               AND ${currentBaiduDeliverySql('d','tasks.target_filename')})
           ORDER BY CASE creators.preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END,
                    creators.id, source_works.source_order, tasks.id
           LIMIT 1`
        ).get() as {
          id: number;
          creator_id: number;
          collection_id: number;
          provider: string;
          status: ArchiveDownloadTaskStatus;
          claimed_by: string | null;
        } | undefined;

      if (!seed) {
        this.database.exec('COMMIT');
        return [];
      }
      if (!['pending', 'failed', 'claimed'].includes(seed.status)) {
        throw new Error(`下载任务 ${seed.id} 当前状态为 ${seed.status}，不能组成博主批次。`);
      }
      if (seed.status === 'claimed' && seed.claimed_by && seed.claimed_by !== workerId) {
        throw new Error('下载任务已由其他工作端领取。');
      }

      const rows = this.database.prepare(
        `SELECT tasks.id, tasks.status, tasks.claimed_by
         FROM archive_catalog_download_tasks tasks
         JOIN archive_catalog_source_works source_works ON source_works.id = tasks.source_work_id
         JOIN archive_catalog_works works ON works.id = source_works.work_id
         WHERE works.creator_id = ?
           AND source_works.collection_id = ?
           AND tasks.provider = ?
           AND source_works.is_active=1
           AND EXISTS (SELECT 1 FROM archive_catalog_collections c JOIN archive_catalog_deliveries d ON d.collection_id=c.id
             WHERE c.id=source_works.collection_id AND c.is_active=1 AND d.provider=tasks.provider
             AND ${currentBaiduDeliverySql('d','tasks.target_filename')})
           AND (
             tasks.status IN ('pending', 'failed')
             OR (tasks.status = 'claimed' AND tasks.claimed_by = ?)
           )
         ORDER BY source_works.source_order, tasks.id
         LIMIT ?`
      ).all(seed.creator_id, seed.collection_id, seed.provider, workerId, limit) as Array<{
        id: number;
        status: ArchiveDownloadTaskStatus;
        claimed_by: string | null;
      }>;
      const update = this.database.prepare(
        `UPDATE archive_catalog_download_tasks
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

    return ids.map((id) => this.get(id)).filter((task): task is ArchiveDownloadTask => task !== null);
  }

  update(id: number, patch: {
    status: ArchiveDownloadTaskStatus;
    downloadId?: string | null;
    error?: string | null;
    workerId?: string;
  }): ArchiveDownloadTask | null {
    const current = this.get(id);
    if (!current) return null;
    if (patch.status !== current.status && !ALLOWED_TRANSITIONS[current.status].has(patch.status)) {
      throw new Error(`下载任务不能从 ${current.status} 变更为 ${patch.status}。`);
    }
    if (current.claimedBy && patch.workerId && current.claimedBy !== patch.workerId) {
      throw new Error('下载任务已由其他工作端领取。');
    }
    const timestamp = nowIso();
    const startedAt = patch.status === 'downloading' && !current.startedAt ? timestamp : current.startedAt;
    const completedAt = ['downloaded', 'ingested'].includes(patch.status) ? timestamp : null;
    this.database.prepare(
      `UPDATE archive_catalog_download_tasks
       SET status = ?, download_id = COALESCE(?, download_id), last_error = ?,
           started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      patch.status,
      patch.downloadId ?? null,
      patch.error?.trim().slice(0, 1000) || null,
      startedAt,
      completedAt,
      timestamp,
      id
    );
    return this.get(id);
  }

  get(id: number): ArchiveDownloadTask | null {
    const row = this.database.prepare(
      `${this.taskSelectSql()} WHERE tasks.id = ?`
    ).get(id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  private getSummary(): ArchiveDownloadTaskSummary {
    const summary = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as ArchiveDownloadTaskSummary;
    summary.total = 0;
    const rows = this.database.prepare(
      `SELECT status, COUNT(*) AS count
       FROM archive_catalog_download_tasks
       GROUP BY status`
    ).all() as Array<{ status: ArchiveDownloadTaskStatus; count: number }>;
    for (const row of rows) {
      summary[row.status] = row.count;
      summary.total += row.count;
    }
    return summary;
  }

  private taskSelectSql(): string {
    return `SELECT tasks.id,
                   creators.id AS creator_id,
                   creators.canonical_name AS creator_name,
                   creators.preference,
                   creators.effective_rating AS rating,
                   works.id AS work_id,
                   source_works.id AS source_work_id,
                   collections.id AS collection_id,
                   source_works.source,
                   collections.source_collection_id,
                   source_works.source_order,
                   source_works.source_order_label,
                   source_works.source_title,
                   tasks.provider,
                   COALESCE(deliveries.source_folder_name, '') AS source_folder_name,
                   COALESCE(deliveries.destination_path, '') AS destination_path,
                   deliveries.metadata_json AS delivery_metadata,
                   tasks.target_root,
                   tasks.target_relative_directory,
                   tasks.target_filename,
                   tasks.status,
                   tasks.claimed_by,
                   tasks.claimed_at,
                   tasks.started_at,
                   tasks.completed_at,
                   tasks.download_id,
                   tasks.attempt_count,
                   tasks.last_error,
                   tasks.created_at,
                   tasks.updated_at
            FROM archive_catalog_download_tasks tasks
            JOIN archive_catalog_source_works source_works ON source_works.id = tasks.source_work_id
            JOIN archive_catalog_works works ON works.id = source_works.work_id
            JOIN archive_catalog_creators creators ON creators.id = works.creator_id
            JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
            LEFT JOIN archive_catalog_deliveries deliveries
              ON deliveries.id = (
                SELECT candidate.id
                FROM archive_catalog_deliveries candidate
                WHERE candidate.collection_id = collections.id
                  AND candidate.provider = tasks.provider
                ORDER BY candidate.last_seen_at DESC, candidate.id DESC
                LIMIT 1
              )`;
  }
}
