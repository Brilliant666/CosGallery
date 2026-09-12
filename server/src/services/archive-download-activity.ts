import type { DatabaseSync } from 'node:sqlite';

export const DOWNLOAD_STAGED_AT_PREFIX = 'archive.download-task.staged-at.';

/** Preserve actual staging evidence before later states overwrite task timestamps. */
export function preserveDownloadStagedAt(database: DatabaseSync, scope: {
  taskId?: number;
  provider?: string;
  creatorIds?: number[] | null;
}): void {
  const conditions = ["tasks.status='staged'", 'julianday(tasks.updated_at) IS NOT NULL'];
  const values: Array<string | number> = [DOWNLOAD_STAGED_AT_PREFIX];
  if (scope.taskId !== undefined) { conditions.push('tasks.id=?'); values.push(scope.taskId); }
  if (scope.provider !== undefined) { conditions.push('tasks.provider=?'); values.push(scope.provider); }
  if (scope.creatorIds !== undefined && scope.creatorIds !== null) {
    if (!scope.creatorIds.length) return;
    conditions.push(`tasks.source_work_id IN (SELECT source.id FROM archive_catalog_source_works source
      JOIN archive_catalog_works work ON work.id=source.work_id
      WHERE work.creator_id IN (${scope.creatorIds.map(() => '?').join(',')}))`);
    values.push(...scope.creatorIds);
  }
  database.prepare(`INSERT INTO app_settings(key,value)
    SELECT ?||tasks.id,tasks.updated_at FROM archive_catalog_download_tasks tasks
    WHERE ${conditions.join(' AND ')} ON CONFLICT(key) DO NOTHING`).run(...values);
}

/** Only a real transition into staged records a new event; repeated receipts do not. */
export function recordDownloadStagedAt(database: DatabaseSync, taskId: number, timestamp: string): void {
  database.prepare(`INSERT INTO app_settings(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(`${DOWNLOAD_STAGED_AT_PREFIX}${taskId}`, timestamp);
}
