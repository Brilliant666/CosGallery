import type { DatabaseSync } from 'node:sqlite';

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
};

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

function mapTask(row: TaskRow): ArchiveMetadataTask {
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

  planLocalOnly(options: { source?: string; retryNotFound?: boolean } = {}): ArchiveMetadataPlanResult {
    const source = options.source ?? 'costuan';
    const candidates = this.database.prepare(
      `SELECT creators.id AS creator_id
       FROM archive_catalog_creators creators
       WHERE EXISTS (
         SELECT 1
         FROM archive_catalog_local_creator_folders local_folders
         JOIN archive_catalog_local_works local_works
           ON local_works.local_creator_folder_id = local_folders.id
         WHERE local_folders.creator_id = creators.id
           AND local_folders.is_active = 1
           AND local_works.is_active = 1
       )
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
    ).all(source) as Array<{ creator_id: number }>;
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
  } = {}): ArchiveMetadataTaskPayload {
    const source = options.source ?? 'costuan';
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
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
       LIMIT ?`
    ).all(...parameters, limit) as TaskRow[];
    const total = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM archive_catalog_metadata_tasks tasks
       WHERE ${where}`
    ).get(...parameters) as { count: number };
    return {
      summary: this.getSummary(source),
      items: items.map(mapTask),
      total: total.count
    };
  }

  claim(options: { workerId: string; source?: string; limit?: number }): ArchiveMetadataTask[] {
    const workerId = options.workerId.trim().slice(0, 120);
    if (!workerId) throw new Error('采集工作端标识不能为空。');
    const source = options.source ?? 'costuan';
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const timestamp = nowIso();
    const ids: number[] = [];

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database.prepare(
        `SELECT tasks.id, tasks.status, tasks.claimed_by
         FROM archive_catalog_metadata_tasks tasks
         JOIN archive_catalog_creators creators ON creators.id = tasks.creator_id
         WHERE tasks.source = ?
           AND (
             tasks.status IN ('pending', 'failed')
             OR (tasks.status = 'claimed' AND tasks.claimed_by = ?)
           )
         ORDER BY CASE creators.preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END,
                  tasks.id
         LIMIT ?`
      ).all(source, workerId, limit) as Array<{
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
  }): { task: ArchiveMetadataTask; importResult: CostuanCatalogImportResult } {
    const current = this.requireClaim(options.id, options.workerId);
    const importResult = new ArchiveCatalogService(this.database).importCostuanRecord(options.record, {
      sourcePath: `bridge:metadata-task:${current.id}`
    });
    if (importResult.matchedCreators !== 1 || importResult.unmatchedCreators.length > 0) {
      throw new Error(`Costuan 元数据无法唯一关联到“${current.creatorName}”。`);
    }
    const timestamp = nowIso();
    this.database.prepare(
      `UPDATE archive_catalog_metadata_tasks
       SET status = 'completed', completed_at = ?, claimed_by = NULL, claimed_at = NULL,
           last_error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(timestamp, timestamp, current.id);
    return { task: this.get(current.id)!, importResult };
  }

  report(options: {
    id: number;
    workerId: string;
    status: 'not_found' | 'failed' | 'pending';
    error?: string | null;
  }): ArchiveMetadataTask {
    const current = this.requireClaim(options.id, options.workerId);
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
    return row ? mapTask(row) : null;
  }

  private requireClaim(id: number, workerId: string): ArchiveMetadataTask {
    const current = this.get(id);
    if (!current) throw new Error('博主元数据采集任务不存在。');
    if (current.status !== 'claimed') throw new Error(`采集任务当前状态为 ${current.status}，不能提交结果。`);
    if (current.claimedBy !== workerId) throw new Error('采集任务已由其他工作端领取。');
    return current;
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
