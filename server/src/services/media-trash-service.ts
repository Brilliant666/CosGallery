import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { appConfig } from '../config/env.js';
import { databaseManager } from '../db/database.js';
import { safeJoin } from '../utils/path-utils.js';
import { maintenanceOperationLock } from './maintenance-operation-lock.js';
import { runWithAdmissionBarrier } from './local-admission-lock.js';
import {
  captureMediaAdjustment,
  recordMediaAdjustment,
} from './archive-local-fulfillment-service.js';

export class MediaTrashError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

export function assertLegacyPostRemovalAllowed(postId: number) {
  const db = databaseManager.connection;
  if (
    db
      .prepare('SELECT 1 FROM archive_catalog_local_works WHERE post_id=?')
      .get(postId) ||
    db.prepare('SELECT 1 FROM media_trash_entries WHERE post_id=?').get(postId)
  ) {
    throw new MediaTrashError(
      'WORK_REMOVAL_REQUIRED',
      '请在资源目录回收独立作品，或在单张详情回收当前媒体。',
    );
  }
}

export function assertLegacyPostRestoreAllowed(postId: number) {
  const db = databaseManager.connection;
  if (
    db
      .prepare(
        `SELECT 1 FROM archive_catalog_local_works local
      JOIN work_removals removal ON removal.work_id=local.work_id
      WHERE local.post_id=?`,
      )
      .get(postId) ||
    db
      .prepare(
        `SELECT 1 FROM posts post JOIN work_removal_paths removed_path ON removed_path.relative_path=post.source_path
      JOIN work_removals removal ON removal.work_id=removed_path.work_id WHERE post.id=?`,
      )
      .get(postId) ||
    db.prepare('SELECT 1 FROM media_trash_entries WHERE post_id=?').get(postId)
  ) {
    throw new MediaTrashError(
      'MANAGED_TRASH_RESTORE_REQUIRED',
      '请从对应的独立作品或单张媒体回收记录恢复，不能通过旧图集入口恢复。',
    );
  }
}
interface MediaRow {
  id: number;
  filename: string;
  relative_path: string;
  thumbnail_path: string;
  file_size: number;
  mtime_ms: number;
  media_type: string;
  is_deleted: number;
  is_trashed: number;
}
interface Entry {
  image_id: number;
  post_id: number;
  active: number;
  original_order_json: string;
  original_file_identity: string | null;
}
interface PostRow {
  id: number;
  folder_id: number;
  post_type: string;
  is_deleted: number;
  is_trashed: number;
}

/** Checks every component without following links inside a configured root. */
function checkedFile(
  root: string,
  relative: string,
): { filename: string; stat: fs.Stats } {
  const filename = safeJoin(root, relative);
  const parts = path
    .relative(path.resolve(root), filename)
    .split(path.sep)
    .filter(Boolean);
  if (!parts.length)
    throw new MediaTrashError(
      'MEDIA_PATH_CHANGED',
      '文件路径已变化，请核对后重试。',
    );
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink())
      throw new MediaTrashError(
        'MEDIA_PATH_CHANGED',
        '文件路径包含链接，不能恢复。',
      );
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile())
    throw new MediaTrashError('MEDIA_PATH_CHANGED', '原件不再是普通文件。');
  return { filename, stat };
}
// Our own quarantine and rollback rename can change ctime without changing the original.
const fileIdentity = (stat: fs.Stats) =>
  JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs]);

export class MediaTrashService {
  constructor(
    private readonly db: DatabaseSync = databaseManager.connection,
    private readonly galleryRoot = appConfig.galleryRoot,
    private readonly thumbnailRoot = appConfig.thumbnailsDir,
  ) {}

  private members(postId: number): number[] {
    return (
      this.db
        .prepare(
          'SELECT image_id FROM post_items WHERE post_id=? ORDER BY position',
        )
        .all(postId) as { image_id: number }[]
    ).map((row) => row.image_id);
  }

  private assertWorkAvailable(postId: number) {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM archive_catalog_local_works l JOIN work_removals r ON r.work_id=l.work_id WHERE l.post_id=?`,
        )
        .get(postId)
    ) {
      throw new MediaTrashError(
        'WORK_IN_TRASH',
        '所属作品已回收，请先从回收站恢复整个作品。',
      );
    }
  }

  private result(postId: number, mediaId: number) {
    const remainingMediaCount = this.members(postId).length;
    return {
      ok: true as const,
      postId,
      mediaId,
      remainingMediaCount,
      postTrashed: remainingMediaCount === 0,
    };
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private rebuild(post: PostRow, ids: number[], now: string) {
    this.db.prepare('DELETE FROM post_items WHERE post_id=?').run(post.id);
    const insert = this.db.prepare(
      'INSERT INTO post_items(post_id,image_id,position) VALUES(?,?,?)',
    );
    ids.forEach((id, index) => insert.run(post.id, id, index + 1));
    this.db
      .prepare(
        `UPDATE posts SET post_type=?,is_deleted=?,deleted_at=?,is_trashed=?,trashed_at=?,
      place_id=(SELECT place_id FROM images WHERE id=?),updated_at=? WHERE id=?`,
      )
      .run(
        ids.length > 1 ? 'carousel' : 'single',
        ids.length ? 0 : 1,
        ids.length ? null : now,
        ids.length ? 0 : 1,
        ids.length ? null : now,
        ids[0] ?? null,
        now,
        post.id,
      );
  }

  async trash(postId: number, mediaId: number, confirmLastMedia = false) {
    return maintenanceOperationLock.runExclusive(() =>
      runWithAdmissionBarrier(this.db, async () =>
        this.transaction(() => {
          this.assertWorkAvailable(postId);
          const entry = this.db
            .prepare('SELECT * FROM media_trash_entries WHERE image_id=?')
            .get(mediaId) as unknown as Entry | undefined;
          if (entry?.active && entry.post_id === postId)
            return this.result(postId, mediaId);
          const post = this.db
            .prepare('SELECT * FROM posts WHERE id=?')
            .get(postId) as unknown as PostRow | undefined;
          const image = this.db
            .prepare('SELECT * FROM images WHERE id=?')
            .get(mediaId) as unknown as MediaRow | undefined;
          const ids = this.members(postId);
          if (
            !post ||
            post.is_deleted ||
            post.is_trashed ||
            !image ||
            image.is_deleted ||
            image.is_trashed ||
            !ids.includes(mediaId)
          ) {
            throw new MediaTrashError(
              'MEDIA_NOT_IN_GALLERY',
              '当前媒体已不可用或不属于此图集，请刷新。',
              404,
            );
          }
          if (ids.length === 1 && !confirmLastMedia)
            throw new MediaTrashError(
              'LAST_MEDIA_CONFIRMATION_REQUIRED',
              '这是图集最后一个媒体，回收后图集将暂时不可浏览，请确认。',
            );
          let originalIdentity: string;
          try {
            const { stat } = checkedFile(this.galleryRoot, image.relative_path);
            if (
              stat.size !== image.file_size ||
              Math.round(stat.mtimeMs) !== Math.round(image.mtime_ms)
            )
              throw new Error('changed');
            originalIdentity = fileIdentity(stat);
          } catch {
            throw new MediaTrashError(
              'MEDIA_ORIGINAL_CHANGED',
              '原件缺失或已变化，请刷新核对后再移入回收站。',
            );
          }
          const adjustment = captureMediaAdjustment(this.db, postId);
          const existing = this.db
            .prepare(
              'SELECT original_order_json FROM media_trash_entries WHERE post_id=? AND active=1 ORDER BY trashed_at LIMIT 1',
            )
            .get(postId) as { original_order_json: string } | undefined;
          const original: number[] = existing
            ? JSON.parse(existing.original_order_json)
            : [...ids];
          for (const id of ids) if (!original.includes(id)) original.push(id);
          const index = ids.indexOf(mediaId);
          const now = new Date().toISOString();
          this.db
            .prepare(
              `INSERT INTO media_trash_entries(image_id,post_id,original_position,original_post_type,previous_image_id,next_image_id,original_order_json,original_file_identity,trashed_at,active,restored_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,NULL) ON CONFLICT(image_id) DO UPDATE SET post_id=excluded.post_id,
        original_position=excluded.original_position,original_post_type=excluded.original_post_type,
        previous_image_id=excluded.previous_image_id,next_image_id=excluded.next_image_id,original_order_json=excluded.original_order_json,
        original_file_identity=excluded.original_file_identity,
        trashed_at=excluded.trashed_at,active=1,restored_at=NULL`,
            )
            .run(
              mediaId,
              postId,
              original.indexOf(mediaId) + 1,
              post.post_type,
              ids[index - 1] ?? null,
              ids[index + 1] ?? null,
              JSON.stringify(original),
              originalIdentity,
              now,
            );
          this.db
            .prepare(
              'UPDATE images SET is_deleted=1,deleted_at=?,is_trashed=1,trashed_at=?,updated_at=? WHERE id=?',
            )
            .run(now, now, now, mediaId);
          this.db
            .prepare(
              "UPDATE folders SET avatar_image_id=NULL,avatar_source='auto',updated_at=? WHERE avatar_image_id=?",
            )
            .run(now, mediaId);
          this.rebuild(
            post,
            ids.filter((id) => id !== mediaId),
            now,
          );
          recordMediaAdjustment(this.db, adjustment, `media-trash:${mediaId}`);
          return this.result(postId, mediaId);
        }),
      ),
    );
  }

  async restore(postId: number, mediaId: number) {
    return maintenanceOperationLock.runExclusive(() =>
      runWithAdmissionBarrier(this.db, async () =>
        this.transaction(() => {
          this.assertWorkAvailable(postId);
          const entry = this.db
            .prepare(
              'SELECT * FROM media_trash_entries WHERE image_id=? AND post_id=?',
            )
            .get(mediaId, postId) as unknown as Entry | undefined;
          if (!entry)
            throw new MediaTrashError(
              'MEDIA_TRASH_NOT_FOUND',
              '没有找到该媒体的回收记录。',
              404,
            );
          if (!entry.active) {
            if (this.members(postId).includes(mediaId))
              return this.result(postId, mediaId);
            throw new MediaTrashError(
              'MEDIA_STATE_CHANGED',
              '媒体归属已变化，请重新核对。',
            );
          }
          const post = this.db
            .prepare('SELECT * FROM posts WHERE id=?')
            .get(postId) as unknown as PostRow | undefined;
          const image = this.db
            .prepare('SELECT * FROM images WHERE id=?')
            .get(mediaId) as unknown as MediaRow | undefined;
          if (!post || !image || !image.is_trashed)
            throw new MediaTrashError(
              'MEDIA_STATE_CHANGED',
              '媒体或图集状态已变化，不能使用旧回收记录。',
            );
          const members = this.members(postId);
          if (post.is_trashed && members.length)
            throw new MediaTrashError(
              'POST_IN_TRASH',
              '所属图集已整体回收，请先恢复图集。',
            );
          try {
            const { stat } = checkedFile(this.galleryRoot, image.relative_path);
            if (
              !entry.original_file_identity ||
              fileIdentity(stat) !== entry.original_file_identity
            )
              throw new Error('changed');
          } catch {
            throw new MediaTrashError(
              'MEDIA_ORIGINAL_CHANGED',
              '原件缺失、被替换或路径已变化，暂不能恢复；回收记录已保留。',
            );
          }
          const other = this.db
            .prepare('SELECT post_id FROM post_items WHERE image_id=?')
            .get(mediaId);
          if (other)
            throw new MediaTrashError(
              'MEDIA_STATE_CHANGED',
              '媒体已有其他归属，暂不能恢复。',
            );
          const adjustment = captureMediaAdjustment(this.db, postId);
          const original = JSON.parse(entry.original_order_json) as number[];
          const ids = [...members, mediaId];
          const rank = (id: number) => {
            const i = original.indexOf(id);
            return i < 0 ? original.length + members.indexOf(id) : i;
          };
          ids.sort((a, b) => rank(a) - rank(b));
          const now = new Date().toISOString();
          this.db
            .prepare(
              'UPDATE images SET is_deleted=0,deleted_at=NULL,is_trashed=0,trashed_at=NULL,updated_at=? WHERE id=?',
            )
            .run(now, mediaId);
          this.db
            .prepare(
              'UPDATE media_trash_entries SET active=0,restored_at=? WHERE image_id=?',
            )
            .run(now, mediaId);
          this.rebuild(post, ids, now);
          recordMediaAdjustment(
            this.db,
            adjustment,
            `media-restore:${mediaId}`,
          );
          return this.result(postId, mediaId);
        }),
      ),
    );
  }

  list() {
    const rows = this.db
      .prepare(
        `SELECT m.image_id AS mediaId,m.post_id AS postId,
      (SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=m.post_id LIMIT 1) AS creatorId,
      COALESCE((SELECT w.display_title FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=m.post_id LIMIT 1),p.caption,p.source_path) AS postTitle,
      i.filename,i.media_type AS mediaType,m.trashed_at AS trashedAt FROM media_trash_entries m
      JOIN images i ON i.id=m.image_id JOIN posts p ON p.id=m.post_id WHERE m.active=1
      AND NOT EXISTS(SELECT 1 FROM archive_catalog_local_works l JOIN work_removals r ON r.work_id=l.work_id WHERE l.post_id=m.post_id)
      ORDER BY m.trashed_at DESC,m.image_id DESC`,
      )
      .all();
    return {
      items: rows.map((row) => ({
        ...row,
        thumbnailUrl: `/api/trash/media/${row.mediaId}/thumbnail`,
      })),
      total: rows.length,
    };
  }

  thumbnail(mediaId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT i.thumbnail_path FROM media_trash_entries m JOIN images i ON i.id=m.image_id
      WHERE m.image_id=? AND m.active=1 AND NOT EXISTS(SELECT 1 FROM archive_catalog_local_works l JOIN work_removals r ON r.work_id=l.work_id WHERE l.post_id=m.post_id)`,
      )
      .get(mediaId) as { thumbnail_path: string } | undefined;
    if (!row) return null;
    try {
      return checkedFile(this.thumbnailRoot, row.thumbnail_path).filename;
    } catch {
      return null;
    }
  }
}
