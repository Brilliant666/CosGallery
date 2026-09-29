import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { RequestInputError } from '../utils/request-input-error.js';

export const workRemovedSql = (workIdSql: string) =>
  `EXISTS (SELECT 1 FROM work_removals removal WHERE removal.work_id=${workIdSql})`;

export function assertWorkNotRemoved(
  db: DatabaseSync,
  workId: number | null | undefined,
): void {
  if (
    workId != null &&
    db.prepare('SELECT 1 FROM work_removals WHERE work_id=?').get(workId)
  ) {
    throw new RequestInputError(
      '该独立作品已移入回收站或永久删除，请先在回收站处理；旧计划不能重新创建作品。',
    );
  }
}

const canonical = (value: string) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
};

export function isRemovedPath(db: DatabaseSync, absolutePath: string): boolean {
  const candidate = canonical(absolutePath);
  return db
    .prepare(
      `SELECT p.absolute_path FROM work_removal_paths p
    JOIN work_removals r ON r.work_id=p.work_id`,
    )
    .all()
    .some((row) => {
      const removed = canonical(String(row.absolute_path));
      const relative = path.relative(removed, candidate);
      return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== '..' &&
          !path.isAbsolute(relative))
      );
    });
}

export function assertPathNotRemoved(
  db: DatabaseSync,
  absolutePath: string | null | undefined,
): void {
  if (absolutePath && isRemovedPath(db, absolutePath)) {
    throw new RequestInputError(
      '目标目录属于已移除的独立作品，旧计划不能重新入库；请先在回收站处理。',
    );
  }
}

export function assertSourceWorkNotRemoved(
  db: DatabaseSync,
  sourceId: number | null | undefined,
): void {
  if (sourceId == null) return;
  const source = db
    .prepare('SELECT work_id FROM archive_catalog_source_works WHERE id=?')
    .get(sourceId);
  if (source) assertWorkNotRemoved(db, Number(source.work_id));
}
