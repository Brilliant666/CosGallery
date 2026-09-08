import type { DatabaseSync } from 'node:sqlite';

import { databaseManager } from '../db/database.js';
import type { ArchiveDownloadTask, ArchiveDownloadTaskStatus, ArchiveDownloadTaskSummary } from './archive-download-task-service.js';
import type { ArchiveMetadataTaskStatus, ArchiveSourceState } from './archive-metadata-task-service.js';
import { normalizeCreatorIdentity } from '../utils/creator-identity.js';

export type CreatorSyncFilters = {
  q?: string;
  preference?: 'all' | 'liked' | 'kept' | 'unset';
  rating?: 'all' | 'R15' | 'R18' | 'unclassified';
  enabled?: 'all' | 'enabled' | 'disabled';
  local?: 'all' | 'present' | 'absent';
  source?: 'all' | 'present' | 'absent';
};
export type CreatorSyncPageOptions = CreatorSyncFilters & { page?: number; limit?: number };
export type CreatorSyncDownloadOptions = CreatorSyncPageOptions & { status?: ArchiveDownloadTaskStatus };
export type CreatorSyncPage<T> = { items: T[]; total: number; page: number; limit: number; hasMore: boolean; readAt: string };
export type CreatorSyncMetadataTask = {
  id: number;
  status: ArchiveMetadataTaskStatus;
  attemptCount: number;
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  updatedAt: string;
};
export type CreatorSyncRosterItem = {
  creatorId: number;
  creatorName: string;
  aliases: string[];
  preference: 'liked' | 'kept' | null;
  rating: 'R15' | 'R18' | null;
  isActive: boolean;
  localWorks: number;
  matchedLocalWorks: number;
  unresolvedLocalWorks: number;
  sourceWorks: number;
  sourceCollections: number;
  missingWorks: number;
  latestSourceAt: string | null;
  sourceState: ArchiveSourceState;
  metadataTask: CreatorSyncMetadataTask | null;
};
export type CreatorSyncDownloadCreator = Pick<CreatorSyncRosterItem, 'creatorId' | 'creatorName' | 'preference' | 'rating' | 'isActive'> & {
  total: number;
  summary: ArchiveDownloadTaskSummary;
};
export type CreatorSyncStats = {
  readAt: string;
  creators: { total: number; enabled: number; disabled: number; withLocal: number; withSource: number };
  works: { source: number; local: number; matchedLocal: number; unresolvedLocal: number; missing: number };
  execution: {
    metadata: Record<ArchiveMetadataTaskStatus, number> & { total: number };
    download: ArchiveDownloadTaskSummary;
    ingest: Record<string, number> & { total: number };
  };
  /** Unlinked directories have no canonical creator; this separate count is intentionally outside creator filters. */
  unlinkedLocalFolders: { total: number; localWorks: number; scope: 'all-unlinked' };
};

const DOWNLOAD_STATUSES: ArchiveDownloadTaskStatus[] = ['pending', 'claimed', 'staged', 'downloading', 'downloaded', 'ingested', 'failed', 'cancelled'];
const METADATA_STATUSES: ArchiveMetadataTaskStatus[] = ['pending', 'claimed', 'completed', 'not_found', 'failed', 'cancelled'];
const INGEST_STATUSES = ['queued', 'running', 'awaiting_review', 'reconciling', 'ingested', 'failed'];

// A small fixed set of aggregate queries, never one query per roster item. Local
// means known active ledger rows, not a claim that the disk was checked now.
// Source coverage comes from actual active Costuan collections/source works, not
// metadata task presence. Distinct work identity (not title/number) defines gaps.
const COHORT_CTES = `
  local_rows AS MATERIALIZED (
    SELECT local.id, local.work_id, local.match_status, folders.creator_id,linked_work.creator_id AS linked_creator_id
    FROM archive_catalog_local_works local
    JOIN archive_catalog_local_creator_folders folders ON folders.id=local.local_creator_folder_id
    LEFT JOIN archive_catalog_works linked_work ON linked_work.id=local.work_id
    WHERE local.is_active=1 AND folders.is_active=1 AND folders.creator_id IS NOT NULL
  ),
  local_counts AS (
    SELECT creator_id, COUNT(*) AS local_works,
      SUM(CASE WHEN match_status='matched' AND linked_creator_id=creator_id THEN 1 ELSE 0 END) AS matched_local_works
    FROM local_rows GROUP BY creator_id
  ),
  source_rows AS MATERIALIZED (
    SELECT source.id, source.work_id, work.creator_id, source.collection_id, collections.observed_at
    FROM archive_catalog_source_works source
    JOIN archive_catalog_works work ON work.id=source.work_id
    JOIN archive_catalog_collections collections ON collections.id=source.collection_id AND collections.creator_id=work.creator_id
    WHERE source.source='costuan' AND collections.source='costuan' AND source.is_active=1 AND collections.is_active=1
  ),
  source_counts AS (
    SELECT creator_id, COUNT(*) AS source_works, COUNT(DISTINCT collection_id) AS source_collections,
      MAX(observed_at) AS latest_source_at,
      COUNT(DISTINCT CASE WHEN NOT EXISTS (SELECT 1 FROM local_rows local
        WHERE local.creator_id=source_rows.creator_id AND local.work_id=source_rows.work_id AND local.match_status='matched')
        THEN work_id END) AS missing_works
    FROM source_rows GROUP BY creator_id
  ),
  delivery_counts AS (
    SELECT collections.creator_id, COUNT(*) AS usable,
      MAX(CASE WHEN json_valid(deliveries.metadata_json) THEN
        CASE WHEN json_extract(deliveries.metadata_json,'$.verification.checkedAt') IS NOT NULL
          AND json_extract(deliveries.metadata_json,'$.verification.method') IN ('saved','reused')
          AND LENGTH(COALESCE(json_extract(deliveries.metadata_json,'$.verification.sourceDirectory'),''))>0 THEN 1 ELSE 0 END
        ELSE 0 END) AS verified
    FROM archive_catalog_collections collections
    JOIN archive_catalog_deliveries deliveries ON deliveries.collection_id=collections.id
    WHERE collections.id IN (SELECT collection_id FROM source_rows) AND deliveries.provider='baidu'
      AND deliveries.status IN ('saved','already-saved')
      AND TRIM(COALESCE(deliveries.source_folder_name,''))<>'' AND TRIM(COALESCE(deliveries.destination_path,''))<>''
    GROUP BY collections.creator_id
  ),
  aliases AS (
    SELECT creator_id, json_group_array(alias) AS aliases_json
    FROM (SELECT DISTINCT creator_id, alias FROM archive_catalog_creator_aliases ORDER BY creator_id,alias)
    GROUP BY creator_id
  ),
  roster AS (
    SELECT creators.id AS creator_id, creators.canonical_name AS creator_name, creators.normalized_name,
      creators.preference, creators.effective_rating AS rating, creators.is_active,
      COALESCE(aliases.aliases_json,'[]') AS aliases_json,
      COALESCE(local_counts.local_works,0) AS local_works,
      COALESCE(local_counts.matched_local_works,0) AS matched_local_works,
      COALESCE(source_counts.source_works,0) AS source_works,
      COALESCE(source_counts.source_collections,0) AS source_collections,
      COALESCE(source_counts.missing_works,0) AS missing_works, source_counts.latest_source_at,
      COALESCE(delivery_counts.usable,0) AS usable_delivery, COALESCE(delivery_counts.verified,0) AS verified_delivery,
      tasks.id AS metadata_task_id, tasks.status AS metadata_status, tasks.attempt_count AS metadata_attempt_count,
      tasks.claimed_by AS metadata_claimed_by, tasks.claimed_at AS metadata_claimed_at,
      tasks.completed_at AS metadata_completed_at, tasks.last_error AS metadata_last_error, tasks.updated_at AS metadata_updated_at
    FROM archive_catalog_creators creators
    LEFT JOIN local_counts ON local_counts.creator_id=creators.id
    LEFT JOIN source_counts ON source_counts.creator_id=creators.id
    LEFT JOIN delivery_counts ON delivery_counts.creator_id=creators.id
    LEFT JOIN aliases ON aliases.creator_id=creators.id
    LEFT JOIN archive_catalog_metadata_tasks tasks ON tasks.creator_id=creators.id AND tasks.source='costuan'
  )`;

type RosterRow = {
  creator_id: number; creator_name: string; preference: 'liked' | 'kept' | null; rating: 'R15' | 'R18' | null;
  is_active: number; aliases_json: string; local_works: number; matched_local_works: number;
  source_works: number; source_collections: number; missing_works: number; latest_source_at: string | null;
  usable_delivery: number; verified_delivery: number; metadata_task_id: number | null;
  metadata_status: ArchiveMetadataTaskStatus | null; metadata_attempt_count: number | null;
  metadata_claimed_by: string | null; metadata_claimed_at: string | null; metadata_completed_at: string | null;
  metadata_last_error: string | null; metadata_updated_at: string | null;
};

function pageOptions(options: CreatorSyncPageOptions): { page: number; limit: number } {
  const page = options.page ?? 1, limit = options.limit ?? 50;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('分页参数无效，page 必须为正整数，limit 必须为 1～100。');
  }
  if (!Number.isSafeInteger((page - 1) * limit)) throw new Error('分页范围过大。');
  return { page, limit };
}

function whereFilters(options: CreatorSyncFilters): { sql: string; values: Array<string | number> } {
  const clauses: string[] = [], values: Array<string | number> = [];
  const enums = { preference: ['all', 'liked', 'kept', 'unset'], rating: ['all', 'R15', 'R18', 'unclassified'],
    enabled: ['all', 'enabled', 'disabled'], local: ['all', 'present', 'absent'], source: ['all', 'present', 'absent'] };
  for (const [key, allowed] of Object.entries(enums)) {
    const value = options[key as keyof typeof enums];
    if (value !== undefined && !allowed.includes(value)) throw new Error(`无效筛选条件 ${key}。`);
  }
  const enabled = options.enabled ?? 'enabled';
  if (enabled !== 'all') { clauses.push('is_active=?'); values.push(enabled === 'enabled' ? 1 : 0); }
  if (options.preference && options.preference !== 'all') {
    clauses.push(options.preference === 'unset' ? 'preference IS NULL' : 'preference=?');
    if (options.preference !== 'unset') values.push(options.preference);
  }
  if (options.rating && options.rating !== 'all') {
    clauses.push(options.rating === 'unclassified' ? 'rating IS NULL' : 'rating=?');
    if (options.rating !== 'unclassified') values.push(options.rating);
  }
  if (options.local && options.local !== 'all') clauses.push(`local_works ${options.local === 'present' ? '>' : '='} 0`);
  if (options.source && options.source !== 'all') clauses.push(`source_works ${options.source === 'present' ? '>' : '='} 0`);
  if (options.q !== undefined && (typeof options.q !== 'string' || options.q.length > 255)) throw new Error('搜索词无效。');
  if (options.q?.trim()) {
    const escaped = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
    const plain = escaped(options.q.normalize('NFKC').trim());
    const normalized = normalizeCreatorIdentity(options.q);
    clauses.push(`(creator_name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM archive_catalog_creator_aliases a
      WHERE a.creator_id=roster.creator_id AND a.alias LIKE ? ESCAPE '\\')${normalized ? ` OR normalized_name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM archive_catalog_creator_aliases a WHERE a.creator_id=roster.creator_id AND a.normalized_alias LIKE ? ESCAPE '\\')` : ''})`);
    values.push(plain, plain);
    if (normalized) values.push(escaped(normalized), escaped(normalized));
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function rosterItem(row: RosterRow): CreatorSyncRosterItem {
  return { creatorId: row.creator_id, creatorName: row.creator_name, aliases: JSON.parse(row.aliases_json) as string[],
    preference: row.preference, rating: row.rating, isActive: !!row.is_active,
    localWorks: row.local_works, matchedLocalWorks: row.matched_local_works, unresolvedLocalWorks: row.local_works - row.matched_local_works,
    sourceWorks: row.source_works, sourceCollections: row.source_collections, missingWorks: row.missing_works,
    latestSourceAt: row.latest_source_at,
    sourceState: { metadataAccepted: row.source_works > 0, deliveryReady: row.usable_delivery > 0,
      deliveryEvidence: row.verified_delivery ? 'verified' : row.usable_delivery ? 'historical' : 'missing',
      missing: !row.source_works ? ['尚无有效 Costuan 作品来源'] : row.usable_delivery ? [] : ['完整百度来源目录尚未转存或确认，缺少可用来源路径'] },
    metadataTask: row.metadata_task_id === null ? null : { id: row.metadata_task_id, status: row.metadata_status!,
      attemptCount: row.metadata_attempt_count!, claimedBy: row.metadata_claimed_by, claimedAt: row.metadata_claimed_at,
      completedAt: row.metadata_completed_at, lastError: row.metadata_last_error, updatedAt: row.metadata_updated_at! } };
}

function summary<T extends string>(statuses: readonly T[], rows: Array<{ status: string; count: number }>): Record<T, number> & { total: number } {
  const result = Object.fromEntries(statuses.map(status => [status, 0])) as Record<T, number> & { total: number };
  result.total = 0;
  for (const row of rows) {
    // Preserve future statuses as named counts rather than silently dropping jobs.
    (result as Record<string, number>)[row.status] = row.count;
    result.total += row.count;
  }
  return result;
}

/** Shared by authenticated admin and bridge routes. All methods are reads only. */
export class CreatorSyncQueryService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

  private read<T>(operation: () => T): T {
    this.database.exec('SAVEPOINT creator_sync_read');
    try { const result = operation(); this.database.exec('RELEASE creator_sync_read'); return result; }
    catch (error) { this.database.exec('ROLLBACK TO creator_sync_read; RELEASE creator_sync_read'); throw error; }
  }

  private cohort(options: CreatorSyncFilters) {
    const filters = whereFilters(options);
    return { sql: `WITH ${COHORT_CTES}, cohort AS (SELECT * FROM roster ${filters.sql})`, values: filters.values };
  }

  roster(options: CreatorSyncPageOptions = {}): CreatorSyncPage<CreatorSyncRosterItem> {
    const { page, limit } = pageOptions(options), cohort = this.cohort(options);
    return this.read(() => {
      const total = (this.database.prepare(`${cohort.sql} SELECT COUNT(*) AS count FROM cohort`).get(...cohort.values) as { count: number }).count;
      const rows = this.database.prepare(`${cohort.sql} SELECT * FROM cohort
        ORDER BY CASE preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END, creator_name COLLATE NOCASE,creator_id LIMIT ? OFFSET ?`)
        .all(...cohort.values, limit, (page - 1) * limit) as RosterRow[];
      return { items: rows.map(rosterItem), total, page, limit, hasMore: page * limit < total, readAt: new Date().toISOString() };
    });
  }

  stats(options: CreatorSyncFilters = {}): CreatorSyncStats {
    const cohort = this.cohort(options);
    return this.read(() => {
      const counts = this.database.prepare(`${cohort.sql} SELECT COUNT(*) AS total, COALESCE(SUM(is_active),0) AS enabled,
        COALESCE(SUM(CASE WHEN local_works>0 THEN 1 ELSE 0 END),0) AS withLocal,
        COALESCE(SUM(CASE WHEN source_works>0 THEN 1 ELSE 0 END),0) AS withSource,
        COALESCE(SUM(source_works),0) AS source,COALESCE(SUM(local_works),0) AS local,
        COALESCE(SUM(matched_local_works),0) AS matchedLocal,COALESCE(SUM(missing_works),0) AS missing FROM cohort`)
        .get(...cohort.values) as { total: number; enabled: number; withLocal: number; withSource: number; source: number; local: number; matchedLocal: number; missing: number };
      const metadata = this.database.prepare(`${cohort.sql} SELECT tasks.status,COUNT(*) AS count FROM archive_catalog_metadata_tasks tasks
        JOIN cohort ON cohort.creator_id=tasks.creator_id WHERE tasks.source='costuan' GROUP BY tasks.status`).all(...cohort.values) as Array<{ status: string; count: number }>;
      const download = this.database.prepare(`${cohort.sql} SELECT tasks.status,COUNT(*) AS count FROM archive_catalog_download_tasks tasks
        JOIN archive_catalog_source_works source ON source.id=tasks.source_work_id JOIN archive_catalog_works work ON work.id=source.work_id
        JOIN cohort ON cohort.creator_id=work.creator_id GROUP BY tasks.status`).all(...cohort.values) as Array<{ status: string; count: number }>;
      const ingest = this.database.prepare(`${cohort.sql} SELECT jobs.status,COUNT(*) AS count FROM local_ingest_jobs jobs
        JOIN cohort ON cohort.creator_id=jobs.creator_id GROUP BY jobs.status`).all(...cohort.values) as Array<{ status: string; count: number }>;
      const unlinked = this.database.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(local_works),0) AS localWorks FROM
        (SELECT folders.id,COUNT(local.id) AS local_works FROM archive_catalog_local_creator_folders folders
          LEFT JOIN archive_catalog_local_works local ON local.local_creator_folder_id=folders.id AND local.is_active=1
          WHERE folders.is_active=1 AND folders.creator_id IS NULL GROUP BY folders.id)`).get() as { total: number; localWorks: number };
      return { readAt: new Date().toISOString(), creators: { total: counts.total, enabled: counts.enabled,
        disabled: counts.total - counts.enabled, withLocal: counts.withLocal, withSource: counts.withSource },
        works: { source: counts.source, local: counts.local, matchedLocal: counts.matchedLocal,
          unresolvedLocal: counts.local - counts.matchedLocal, missing: counts.missing },
        execution: { metadata: summary(METADATA_STATUSES, metadata), download: summary(DOWNLOAD_STATUSES, download), ingest: summary(INGEST_STATUSES, ingest) },
        unlinkedLocalFolders: { ...unlinked, scope: 'all-unlinked' } };
    });
  }

  private taskScope(options: CreatorSyncDownloadOptions, creatorId?: number) {
    const cohort = this.cohort(options), conditions: string[] = [], values = [...cohort.values];
    if (options.status !== undefined) {
      if (!DOWNLOAD_STATUSES.includes(options.status)) throw new Error('暂存任务状态无效。');
      conditions.push('tasks.status=?'); values.push(options.status);
    }
    if (creatorId !== undefined) {
      if (!Number.isSafeInteger(creatorId) || creatorId <= 0) throw new Error('必须指定有效的规范 creatorId。');
      conditions.push('work.creator_id=?'); values.push(creatorId);
    }
    return { sql: `${cohort.sql}, task_scope AS (SELECT tasks.*,work.creator_id FROM archive_catalog_download_tasks tasks
      JOIN archive_catalog_source_works source ON source.id=tasks.source_work_id
      JOIN archive_catalog_works work ON work.id=source.work_id JOIN cohort ON cohort.creator_id=work.creator_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''})`, values };
  }

  downloadCreators(options: CreatorSyncDownloadOptions = {}): CreatorSyncPage<CreatorSyncDownloadCreator> & { summary: ArchiveDownloadTaskSummary; taskTotal: number } {
    const { page, limit } = pageOptions(options), scope = this.taskScope(options);
    return this.read(() => {
      const grouped = this.database.prepare(`${scope.sql} SELECT creator_id, status,COUNT(*) AS count FROM task_scope GROUP BY creator_id,status`)
        .all(...scope.values) as Array<{ creator_id: number; status: ArchiveDownloadTaskStatus; count: number }>;
      const byCreator = new Map<number, Array<{ status: string; count: number }>>();
      const totals = new Map<string, number>();
      for (const row of grouped) {
        const statuses = byCreator.get(row.creator_id) ?? []; statuses.push(row); byCreator.set(row.creator_id, statuses);
        totals.set(row.status, (totals.get(row.status) ?? 0) + row.count);
      }
      const completeSummary = summary(DOWNLOAD_STATUSES, [...totals].map(([status, count]) => ({ status, count })));
      const rows = this.database.prepare(`${scope.sql} SELECT creator_id,creator_name,preference,rating,is_active FROM cohort
        WHERE creator_id IN (SELECT creator_id FROM task_scope)
        ORDER BY CASE preference WHEN 'liked' THEN 0 WHEN 'kept' THEN 1 ELSE 2 END,creator_name COLLATE NOCASE,creator_id LIMIT ? OFFSET ?`)
        .all(...scope.values, limit, (page - 1) * limit) as Array<Pick<RosterRow, 'creator_id' | 'creator_name' | 'preference' | 'rating' | 'is_active'>>;
      const items = rows.map(row => {
        const counts = summary(DOWNLOAD_STATUSES, byCreator.get(row.creator_id)!);
        return { creatorId: row.creator_id, creatorName: row.creator_name, preference: row.preference, rating: row.rating,
          isActive: !!row.is_active, total: counts.total, summary: counts };
      });
      return { items, total: byCreator.size, page, limit, hasMore: page * limit < byCreator.size,
        readAt: new Date().toISOString(), summary: completeSummary, taskTotal: completeSummary.total };
    });
  }

  downloadTaskPage(options: CreatorSyncDownloadOptions & { creatorId: number }): CreatorSyncPage<ArchiveDownloadTask> & { summary: ArchiveDownloadTaskSummary } {
    if (!options || !Number.isSafeInteger(options.creatorId) || options.creatorId <= 0) throw new Error('任务明细必须指定有效的规范 creatorId。');
    const { page, limit } = pageOptions(options), scope = this.taskScope(options, options.creatorId);
    return this.read(() => {
      const creator = this.database.prepare('SELECT id FROM archive_catalog_creators WHERE id=?').get(options.creatorId);
      if (!creator) throw new Error('规范博主不存在，不能将查询失败显示为 0 条。');
      const counts = summary(DOWNLOAD_STATUSES, this.database.prepare(`${scope.sql} SELECT status,COUNT(*) AS count FROM task_scope GROUP BY status`)
        .all(...scope.values) as Array<{ status: string; count: number }>);
      const items = this.database.prepare(`${scope.sql}, deliveries_ranked AS (
        SELECT deliveries.*,ROW_NUMBER() OVER (PARTITION BY collection_id,provider ORDER BY transferred_at DESC,id DESC) AS ranking
        FROM archive_catalog_deliveries deliveries
        WHERE collection_id IN (SELECT source.collection_id FROM task_scope tasks JOIN archive_catalog_source_works source ON source.id=tasks.source_work_id)
      ) SELECT tasks.id,tasks.creator_id AS creatorId,creators.canonical_name AS creatorName,creators.preference,creators.effective_rating AS rating,
        source.work_id AS workId,source.id AS sourceWorkId,source.collection_id AS collectionId,source.source,
        collections.source_collection_id AS sourceCollectionId,source.source_order AS sourceOrder,source.source_order_label AS sourceOrderLabel,
        source.source_title AS title,tasks.provider,COALESCE(deliveries.source_folder_name,'') AS sourceFolderName,
        COALESCE(deliveries.destination_path,'') AS destinationPath,tasks.target_root AS targetRoot,
        tasks.target_relative_directory AS targetRelativeDirectory,tasks.target_filename AS targetFilename,tasks.status,
        tasks.claimed_by AS claimedBy,tasks.claimed_at AS claimedAt,tasks.started_at AS startedAt,tasks.completed_at AS completedAt,
        tasks.download_id AS downloadId,tasks.attempt_count AS attemptCount,tasks.last_error AS lastError,
        tasks.created_at AS createdAt,tasks.updated_at AS updatedAt
      FROM task_scope tasks JOIN archive_catalog_source_works source ON source.id=tasks.source_work_id
      JOIN archive_catalog_collections collections ON collections.id=source.collection_id
      JOIN archive_catalog_creators creators ON creators.id=tasks.creator_id
      LEFT JOIN deliveries_ranked deliveries ON deliveries.collection_id=source.collection_id AND deliveries.provider=tasks.provider AND deliveries.ranking=1
      ORDER BY CASE tasks.status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'claimed' THEN 2 WHEN 'staged' THEN 3
        WHEN 'downloading' THEN 4 WHEN 'downloaded' THEN 5 WHEN 'ingested' THEN 6 ELSE 7 END,source.source_order,tasks.id LIMIT ? OFFSET ?`)
        .all(...scope.values, limit, (page - 1) * limit) as ArchiveDownloadTask[];
      return { items, summary: counts, total: counts.total, page, limit, hasMore: page * limit < counts.total, readAt: new Date().toISOString() };
    });
  }
}
