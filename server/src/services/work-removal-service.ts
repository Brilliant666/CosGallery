import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { appConfig } from '../config/env.js';
import { databaseManager } from '../db/database.js';
import { maintenanceOperationLock } from './maintenance-operation-lock.js';
import { runWithAdmissionBarrier } from './local-admission-lock.js';
import {
  permanentDeletionService,
  type PermanentDeletionService,
  type RemovalFileTarget,
} from './permanent-deletion-service.js';
import { ResourceCatalogService } from './resource-catalog-service.js';
import { storageService } from './storage-service.js';

export type WorkRemovalMode = 'trash' | 'permanent' | 'restore';
type Row = Record<string, any>;
type FileEntry = RemovalFileTarget & {
  size: number;
  identity: string;
  present: boolean;
};
type Snapshot = {
  work: Row;
  locals: Row[];
  posts: Row[];
  images: Row[];
  fulfillments: Row[];
  files: FileEntry[];
  mediaTrash: Row[];
  references: Row;
};
type Plan = {
  workId: number;
  mode: WorkRemovalMode;
  fingerprint: string;
  expiresAt: number;
  snapshot: Snapshot;
};
export class WorkRemovalError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new WorkRemovalError(409, 'WORK_REMOVAL_BLOCKED', message);
};
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (value: string) =>
  process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
const within = (root: string, target: string) => {
  const r = path.relative(root, target);
  return (
    r === '' ||
    (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r))
  );
};
const normalized = (value: string) => value.split(path.sep).join('/');

export class WorkRemovalService {
  constructor(
    private readonly database: () => DatabaseSync = () =>
      databaseManager.connection,
    private readonly files: PermanentDeletionService = permanentDeletionService,
  ) {}
  private locked<T>(action: () => Promise<T>): Promise<T> {
    return maintenanceOperationLock.runExclusive(() =>
      runWithAdmissionBarrier(this.database(), action),
    );
  }
  private checkOnline() {
    const state = storageService.getState();
    if (!state.libraryAvailable || state.usingInMemoryDatabase)
      throw new WorkRemovalError(
        503,
        'STORAGE_UNAVAILABLE',
        '图库或持久数据库当前不可用，无法修改作品。',
      );
  }
  listTrash() {
    const pending = this
      .rows(`SELECT o.operation_id,w.display_title title FROM removal_operations o JOIN archive_catalog_works w ON w.id=o.target_id
      WHERE o.kind='work' AND o.state IN ('committed','cleanup_pending','recovery_pending') ORDER BY o.created_at,o.operation_id`);
    return {
      pendingOperations: pending.map((row) => ({
        ...this.status(row.operation_id),
        title: row.title,
      })),
      items: this.database()
        .prepare(
          `SELECT w.id workId,w.display_title title,w.creator_id creatorId,r.created_at trashedAt,
      (SELECT COUNT(*) FROM archive_catalog_local_works l WHERE l.work_id=w.id) localCopyCount
      FROM work_removals r JOIN archive_catalog_works w ON w.id=r.work_id WHERE r.state='trashed' ORDER BY r.created_at DESC,w.id`,
        )
        .all(),
    };
  }
  private rows(sql: string, ...args: (string | number)[]): Row[] {
    return this.database()
      .prepare(sql)
      .all(...args) as Row[];
  }
  private references(workId: number, creatorId: number): Row {
    const locals = this.rows(
      'SELECT id,work_id,absolute_path FROM archive_catalog_local_works ORDER BY id',
    );
    const ownPaths = locals
      .filter((l) => l.work_id === workId)
      .map((l) => key(l.absolute_path));
    const ownedIds = `SELECT pi.image_id FROM post_items pi JOIN archive_catalog_local_works l ON l.post_id=pi.post_id WHERE l.work_id=?
      UNION SELECT m.image_id FROM media_trash_entries m JOIN archive_catalog_local_works l ON l.post_id=m.post_id WHERE l.work_id=?`;
    const pathImages: Row[] = [];
    for (const absolute of ownPaths) {
      const prefix =
        normalized(path.relative(appConfig.galleryRoot, absolute)) + '/';
      pathImages.push(
        ...this.rows(
          `SELECT id,relative_path FROM images WHERE substr(relative_path,1,?) ${process.platform === 'win32' ? 'COLLATE NOCASE' : ''}=? ORDER BY id`,
          prefix.length,
          prefix,
        ),
      );
    }
    return {
      sources: this.rows(
        'SELECT id,work_id,is_active FROM archive_catalog_source_works WHERE work_id=? ORDER BY id',
        workId,
      ),
      downloads: this.rows(
        'SELECT t.* FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id WHERE s.work_id=? ORDER BY t.id',
        workId,
      ),
      ingest: this.rows(
        'SELECT j.* FROM local_ingest_jobs j LEFT JOIN archive_catalog_source_works s ON s.id=j.source_work_id WHERE s.work_id=? OR j.creator_id=? ORDER BY j.id',
        workId,
        creatorId,
      ),
      admissions: this.rows(
        'SELECT * FROM archive_local_admission_items WHERE work_id=? ORDER BY plan_id,item_key',
        workId,
      ),
      locals: locals.filter((l) =>
        ownPaths.some(
          (p) =>
            within(p, key(l.absolute_path)) || within(key(l.absolute_path), p),
        ),
      ),
      postItems: this.rows(
        `SELECT * FROM post_items WHERE image_id IN (${ownedIds}) ORDER BY post_id,position`,
        workId,
        workId,
      ),
      derivativeRefs: this.rows(
        `WITH owned AS (SELECT thumbnail_path,preview_path FROM images WHERE id IN (${ownedIds}))
        SELECT id,thumbnail_path,preview_path FROM images WHERE thumbnail_path IN (SELECT thumbnail_path FROM owned) OR preview_path IN (SELECT preview_path FROM owned) ORDER BY id`,
        workId,
        workId,
      ),
      pathImages: pathImages.sort((a, b) => a.id - b.id),
    };
  }
  private async fileEntry(target: RemovalFileTarget): Promise<FileEntry> {
    const root =
      target.root === 'gallery'
        ? appConfig.galleryRoot
        : target.root === 'thumbnails'
          ? appConfig.thumbnailsDir
          : appConfig.previewsDir;
    const absolute = path.resolve(root, target.relativePath);
    if (
      !within(root, absolute) ||
      key(root) === key(absolute) ||
      path.isAbsolute(target.relativePath)
    )
      fail('文件路径超出允许的存储目录。');
    let cursor = path.resolve(root);
    for (const part of path.relative(root, absolute).split(path.sep)) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor, { bigint: true }).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return { ...target, size: 0, identity: '', present: false };
      if (stat.isSymbolicLink()) fail('删除路径包含符号链接，需先人工核对。');
      if (cursor === absolute) {
        if (!stat.isFile()) fail('文件清单包含非普通文件。');
        return {
          ...target,
          size: Number(stat.size),
          identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(':'),
          present: true,
        };
      }
      if (!stat.isDirectory()) fail('文件父路径不是目录。');
    }
    return fail('无法核对文件路径。');
  }
  private async collectDirectory(
    absolute: string,
  ): Promise<RemovalFileTarget[]> {
    const root = path.resolve(appConfig.galleryRoot);
    if (!within(root, absolute) || key(root) === key(absolute))
      fail('本地副本不在当前图库根目录内，不能自动删除。');
    const segments = path.relative(root, absolute).split(path.sep);
    if (segments.length < 2) fail('副本路径不能是图库根或博主目录。');
    let cursor = root;
    for (const part of segments) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return [];
      if (!stat.isDirectory() || stat.isSymbolicLink())
        fail('本地副本路径不是可核对的普通目录。');
    }
    const result: RemovalFileTarget[] = [];
    const walk = async (directory: string) => {
      const entries = (
        await fs.readdir(directory, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
          fail('图集中存在符号链接，永久删除已阻断。');
        if (entry.isDirectory()) await walk(candidate);
        else if (entry.isFile())
          result.push({
            root: 'gallery',
            relativePath: normalized(path.relative(root, candidate)),
          });
        else fail('图集中存在非普通文件，删除已阻断。');
        if (result.length > 100000) fail('单次文件数量超过安全上限。');
      }
    };
    await walk(absolute);
    return result;
  }
  private async inspect(workId: number, mode: WorkRemovalMode) {
    const db = this.database();
    const work = db
      .prepare('SELECT * FROM archive_catalog_works WHERE id=?')
      .get(workId) as Row | undefined;
    if (!work)
      throw new WorkRemovalError(404, 'WORK_NOT_FOUND', '作品不存在。');
    const removal = db
      .prepare('SELECT * FROM work_removals WHERE work_id=?')
      .get(workId) as Row | undefined;
    const blockers: string[] = [];
    if (
      this.rows(
        "SELECT operation_id FROM removal_operations WHERE kind='work' AND target_id=? AND state IN ('executing','committed','cleanup_pending','recovery_pending')",
        workId,
      ).length
    )
      blockers.push('作品存在尚未完成的文件清理或恢复操作，请先完成该操作。');
    if (mode === 'trash' && removal)
      blockers.push('作品已在回收站或已永久删除。');
    if (mode !== 'trash' && removal?.state !== 'trashed')
      blockers.push('只能从回收站恢复或永久删除作品。');
    if (
      this.rows(
        `SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id
      WHERE s.work_id=? AND t.status IN ('claimed','downloading','staged')`,
        workId,
      ).length
    )
      blockers.push('相关下载任务仍在执行。');
    if (
      this.rows(
        `SELECT j.id FROM local_ingest_jobs j LEFT JOIN archive_catalog_source_works s ON s.id=j.source_work_id
      WHERE (s.work_id=? OR (j.creator_id=? AND j.source_work_id IS NULL)) AND j.status IN ('running','reconciling','awaiting_review')`,
        workId,
        work.creator_id,
      ).length
    )
      blockers.push('相关入库任务或待处理恢复仍在执行。');
    if (
      this.rows(
        `SELECT i.item_key FROM archive_local_admission_items i WHERE i.work_id=? AND i.state NOT IN ('completed','indexed','failed')`,
        workId,
      ).length
    )
      blockers.push('作品仍关联尚未完成的入库计划。');
    const locals = this.rows(
      `SELECT l.*,f.root_path,f.creator_id owner_creator_id FROM archive_catalog_local_works l
      JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id WHERE l.work_id=? ORDER BY l.id`,
      workId,
    );
    const posts = this.rows(
      'SELECT p.* FROM posts p JOIN archive_catalog_local_works l ON l.post_id=p.id WHERE l.work_id=? ORDER BY p.id',
      workId,
    );
    const images = this.rows(
      `SELECT DISTINCT i.* FROM images i WHERE i.id IN (
      SELECT pi.image_id FROM post_items pi JOIN archive_catalog_local_works l ON l.post_id=pi.post_id WHERE l.work_id=?
      UNION SELECT m.image_id FROM media_trash_entries m JOIN archive_catalog_local_works l ON l.post_id=m.post_id WHERE l.work_id=?) ORDER BY i.id`,
      workId,
      workId,
    );
    const mediaTrash = this.rows(
      `SELECT m.* FROM media_trash_entries m JOIN archive_catalog_local_works l ON l.post_id=m.post_id WHERE l.work_id=? ORDER BY m.image_id`,
      workId,
    );
    const fulfillments = this.rows(
      'SELECT * FROM archive_catalog_local_fulfillments WHERE work_id=? ORDER BY id',
      workId,
    );
    const candidates: RemovalFileTarget[] = [];
    const copies: Row[] = [];
    const allLocalPaths = this.rows(
      'SELECT id,work_id,absolute_path FROM archive_catalog_local_works',
    );
    for (const local of locals) {
      try {
        if (local.owner_creator_id !== work.creator_id)
          fail('本地副本的博主归属存在冲突。');
        const absolute = path.resolve(local.absolute_path);
        if (key(local.root_path) !== key(appConfig.galleryRoot))
          fail('本地副本属于另一个图库根目录。');
        if (
          allLocalPaths.some(
            (other) =>
              other.id !== local.id &&
              (within(key(absolute), key(other.absolute_path)) ||
                within(key(other.absolute_path), key(absolute))),
          )
        )
          fail('副本目录与其他已登记副本重叠。');
        const post = posts.find((p) => p.id === local.post_id);
        if (
          local.post_id === null &&
          this.rows(
            'SELECT id FROM posts WHERE source_path=?',
            normalized(path.relative(appConfig.galleryRoot, absolute)),
          ).length
        )
          fail('旧展示记录尚未关联本地副本，请先修复身份关联后再移除。');
        if (
          post &&
          key(path.join(appConfig.galleryRoot, post.source_path)) !==
            key(absolute)
        )
          fail('展示记录与副本目录不一致。');
        const files = await this.collectDirectory(absolute);
        candidates.push(...files);
        copies.push({
          id: local.id,
          directoryName: local.folder_name,
          path: normalized(path.relative(appConfig.galleryRoot, absolute)),
          postId: local.post_id,
          imageCount: local.image_count,
          videoCount: local.video_count,
          fileCount: files.length,
          bytes: 0,
        });
      } catch (error) {
        blockers.push(`${local.folder_name}: ${(error as Error).message}`);
      }
    }
    const postIds = new Set(posts.map((p) => p.id));
    for (const image of images) {
      if (
        this.rows(
          'SELECT post_id FROM post_items WHERE image_id=?',
          image.id,
        ).some((r) => !postIds.has(r.post_id))
      )
        blockers.push(`媒体 ${image.filename} 仍被其他图集引用。`);
      if (
        !locals.some((l) =>
          within(
            key(l.absolute_path),
            key(path.join(appConfig.galleryRoot, image.relative_path)),
          ),
        )
      )
        blockers.push(`媒体 ${image.filename} 不属于确认的副本目录。`);
      for (const [root, relativePath] of [
        ['gallery', image.relative_path],
        ['thumbnails', image.thumbnail_path],
        ['previews', image.preview_path],
      ] as const) {
        if (relativePath) candidates.push({ root, relativePath });
      }
      for (const field of ['thumbnail_path', 'preview_path']) {
        if (
          image[field] &&
          this.rows(
            `SELECT id FROM images WHERE ${field}=? AND id<>?`,
            image[field],
            image.id,
          ).some((r) => !images.some((i) => i.id === r.id))
        )
          blockers.push(`媒体 ${image.filename} 的派生文件仍被其他媒体引用。`);
      }
    }
    const files: FileEntry[] = [];
    const unique = new Map(
      candidates.map((t) => [
        `${t.root}:${process.platform === 'win32' ? t.relativePath.toLowerCase() : t.relativePath}`,
        t,
      ]),
    );
    for (const candidate of [...unique.values()].sort((a, b) =>
      `${a.root}:${a.relativePath}`.localeCompare(
        `${b.root}:${b.relativePath}`,
      ),
    )) {
      try {
        files.push(await this.fileEntry(candidate));
      } catch (error) {
        blockers.push((error as Error).message);
      }
    }
    for (const copy of copies)
      copy.bytes = files
        .filter(
          (f) =>
            f.root === 'gallery' &&
            (f.relativePath === copy.path ||
              f.relativePath.startsWith(`${copy.path}/`)),
        )
        .reduce((n, f) => n + f.size, 0);
    if (mode === 'restore' && removal) {
      const original = JSON.parse(removal.snapshot_json) as Snapshot;
      for (const file of original.files.filter(
        (f) => f.root === 'gallery' && f.present,
      )) {
        const current = files.find(
          (f) => f.root === file.root && f.relativePath === file.relativePath,
        );
        if (!current || current.identity !== file.identity)
          blockers.push(`原文件缺失或已变化：${file.relativePath}`);
      }
    }
    const references = this.references(workId, work.creator_id);
    if (
      references.pathImages.some(
        (i: Row) => !images.some((owned) => owned.id === i.id),
      )
    )
      blockers.push('副本目录内存在未归属于该作品的媒体记录，需先核对归属。');
    const snapshot: Snapshot = {
      work,
      locals,
      posts,
      images,
      fulfillments,
      files,
      mediaTrash,
      references,
    };
    return {
      snapshot,
      blockers: [...new Set(blockers)],
      copies,
      fingerprint: hash({ snapshot, removal, mode, blockers }),
    };
  }
  async preview(
    workId: number,
    mode: WorkRemovalMode,
    revision?: string,
    revisionScope: 'all' | 'creator' = 'creator',
  ) {
    this.checkOnline();
    return this.locked(async () => {
      if (revision && mode === 'trash') {
        const creatorId = this.database()
          .prepare('SELECT creator_id FROM archive_catalog_works WHERE id=?')
          .get(workId)?.creator_id;
        if (typeof creatorId === 'number')
          new ResourceCatalogService().detail(
            creatorId,
            workId,
            revision,
            revisionScope,
          );
      }
      const inspected = await this.inspect(workId, mode);
      const previewToken = randomUUID();
      const now = new Date().toISOString();
      const plan: Plan = {
        workId,
        mode,
        fingerprint: inspected.fingerprint,
        expiresAt: Date.now() + 15 * 60 * 1000,
        snapshot: inspected.snapshot,
      };
      this.database()
        .prepare(
          `INSERT INTO removal_operations(operation_id,kind,target_id,mode,state,payload_json,created_at,updated_at) VALUES(?,'work',?,?,'previewed',?,?,?)`,
        )
        .run(previewToken, workId, mode, JSON.stringify(plan), now, now);
      return {
        previewToken,
        mode,
        work: {
          id: workId,
          title: inspected.snapshot.work.display_title,
          creatorId: inspected.snapshot.work.creator_id,
        },
        localCopies: inspected.copies,
        fileCount: inspected.snapshot.files.filter(
          (f) => f.root === 'gallery' && f.present,
        ).length,
        totalBytes: inspected.snapshot.files
          .filter((f) => f.root === 'gallery')
          .reduce((n, f) => n + f.size, 0),
        relatedSources: inspected.snapshot.references.sources.length,
        relatedTasks: {
          downloads: inspected.snapshot.references.downloads.map((r: Row) => ({
            id: r.id,
            status: r.status,
          })),
          admissions: inspected.snapshot.references.admissions.map(
            (r: Row) => ({
              planId: r.plan_id,
              itemKey: r.item_key,
              state: r.state,
            }),
          ),
        },
        blockers: inspected.blockers,
        canExecute: inspected.blockers.length === 0,
      };
    });
  }
  status(operationId: string) {
    const row = this.database()
      .prepare(
        "SELECT * FROM removal_operations WHERE operation_id=? AND kind='work'",
      )
      .get(operationId) as Row | undefined;
    if (!row)
      throw new WorkRemovalError(404, 'REMOVAL_NOT_FOUND', '操作不存在。');
    return {
      operationId,
      workId: row.target_id,
      mode: row.mode,
      state: row.state,
      filesRemoved: row.mode === 'permanent' && row.state === 'completed',
      cleanupPending: ['committed', 'cleanup_pending'].includes(row.state),
      recoveryPending: row.state === 'recovery_pending',
      message: row.error ?? null,
    };
  }
  async retry(operationId: string) {
    this.checkOnline();
    return this.locked(async () => {
      const operation = this.status(operationId);
      if (
        !['committed', 'cleanup_pending', 'recovery_pending'].includes(
          operation.state,
        )
      )
        fail('此操作没有待重试的清理或恢复。');
      try {
        await this.files.recoverPendingDeletionsWhileLocked(operationId);
      } catch (error) {
        this.database()
          .prepare(
            'UPDATE removal_operations SET error=?,updated_at=? WHERE operation_id=?',
          )
          .run(String(error), new Date().toISOString(), operationId);
      }
      return this.status(operationId);
    });
  }
  async execute(workId: number, previewToken: string) {
    this.checkOnline();
    return this.locked(async () => {
      const db = this.database();
      const row = db
        .prepare(
          "SELECT * FROM removal_operations WHERE operation_id=? AND target_id=? AND kind='work'",
        )
        .get(previewToken, workId) as Row | undefined;
      if (!row) fail('确认计划不存在。');
      if (['completed', 'committed', 'cleanup_pending'].includes(row!.state))
        return this.status(previewToken);
      if (row!.state !== 'previewed') fail('计划状态不允许重放，请重新预览。');
      const plan = JSON.parse(row!.payload_json) as Plan;
      if (plan.expiresAt < Date.now()) fail('确认已过期，请重新预览。');
      const current = await this.inspect(workId, plan.mode);
      if (current.blockers.length) fail(current.blockers.join('；'));
      if (current.fingerprint !== plan.fingerprint)
        fail('作品、文件或引用已变化，请重新预览。');
      const commit = () => this.commit(plan, previewToken);
      if (plan.mode === 'permanent') {
        db.prepare(
          "UPDATE removal_operations SET state='executing',updated_at=? WHERE operation_id=?",
        ).run(new Date().toISOString(), previewToken);
        try {
          await this.files.executeFileRemovalWhileLocked({
            operationId: previewToken,
            targetId: workId,
            targets: plan.snapshot.files,
            commit,
            validateQuarantined: async () => {
              for (const local of plan.snapshot.locals)
                if (
                  (
                    await this.collectDirectory(
                      path.resolve(local.absolute_path),
                    )
                  ).length
                )
                  fail('隔离期间图集出现新文件，已停止删除并恢复原文件。');
            },
          });
        } catch (error) {
          const journalExists = await fs
            .stat(
              path.join(
                appConfig.galleryRoot,
                '.foldergram-delete-quarantine',
                'journals',
                `${previewToken}.json`,
              ),
            )
            .then(
              () => true,
              () => false,
            );
          db.prepare(
            "UPDATE removal_operations SET state=?,error=?,updated_at=? WHERE operation_id=? AND state='executing'",
          ).run(
            journalExists ? 'recovery_pending' : 'failed',
            String(error),
            new Date().toISOString(),
            previewToken,
          );
          throw error;
        }
      } else commit();
      return this.status(previewToken);
    });
  }
  private commit(plan: Plan, operationId: string) {
    const db = this.database();
    const now = new Date().toISOString();
    const s = plan.snapshot;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Metadata writers may run while filesystem operations await I/O. Compare
      // the exact owned rows again inside the same write transaction.
      const currentWork = db
        .prepare('SELECT * FROM archive_catalog_works WHERE id=?')
        .get(plan.workId);
      const currentLocals = this.rows(
        `SELECT l.*,f.root_path,f.creator_id owner_creator_id FROM archive_catalog_local_works l JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id WHERE l.work_id=? ORDER BY l.id`,
        plan.workId,
      );
      const currentPosts = this.rows(
        'SELECT p.* FROM posts p JOIN archive_catalog_local_works l ON l.post_id=p.id WHERE l.work_id=? ORDER BY p.id',
        plan.workId,
      );
      const currentImages = this.rows(
        `SELECT DISTINCT i.* FROM images i WHERE i.id IN (
        SELECT pi.image_id FROM post_items pi JOIN archive_catalog_local_works l ON l.post_id=pi.post_id WHERE l.work_id=?
        UNION SELECT m.image_id FROM media_trash_entries m JOIN archive_catalog_local_works l ON l.post_id=m.post_id WHERE l.work_id=?) ORDER BY i.id`,
        plan.workId,
        plan.workId,
      );
      if (
        hash([
          currentWork,
          currentLocals,
          currentPosts,
          currentImages,
          this.rows(
            'SELECT * FROM archive_catalog_local_fulfillments WHERE work_id=? ORDER BY id',
            plan.workId,
          ),
        ]) !== hash([s.work, s.locals, s.posts, s.images, s.fulfillments])
      )
        fail('文件处置期间作品或引用发生变化，已阻止提交。');
      if (
        hash(this.references(plan.workId, s.work.creator_id)) !==
        hash(s.references)
      )
        fail('文件处置期间共享引用或任务发生变化，已阻止提交。');
      if (plan.mode === 'trash') {
        db.prepare(
          'INSERT INTO work_removals(work_id,state,operation_id,snapshot_json,created_at) VALUES(?,?,?,?,?)',
        ).run(plan.workId, 'trashed', operationId, JSON.stringify(s), now);
        for (const local of s.locals) {
          db.prepare(
            'INSERT INTO work_removal_paths(work_id,local_work_id,absolute_path,relative_path) VALUES(?,?,?,?)',
          ).run(
            plan.workId,
            local.id,
            local.absolute_path,
            normalized(
              path.relative(appConfig.galleryRoot, local.absolute_path),
            ),
          );
          db.prepare(
            'UPDATE archive_catalog_local_works SET is_active=0 WHERE id=?',
          ).run(local.id);
        }
        for (const post of s.posts)
          db.prepare(
            'UPDATE posts SET is_trashed=1,trashed_at=?,updated_at=? WHERE id=?',
          ).run(now, now, post.id);
        for (const image of s.images)
          db.prepare(
            'UPDATE images SET is_trashed=1,trashed_at=?,updated_at=? WHERE id=?',
          ).run(now, now, image.id);
        db.prepare(
          "UPDATE archive_catalog_local_fulfillments SET state='stale',revoked_reason='work_removed',revoked_at=? WHERE work_id=? AND state='active'",
        ).run(now, plan.workId);
      } else if (plan.mode === 'restore') {
        const removal = db
          .prepare('SELECT snapshot_json FROM work_removals WHERE work_id=?')
          .get(plan.workId)!;
        const old = JSON.parse(String(removal.snapshot_json)) as Snapshot;
        db.prepare('DELETE FROM work_removal_paths WHERE work_id=?').run(
          plan.workId,
        );
        db.prepare('DELETE FROM work_removals WHERE work_id=?').run(
          plan.workId,
        );
        for (const local of old.locals)
          db.prepare(
            'UPDATE archive_catalog_local_works SET is_active=? WHERE id=?',
          ).run(local.is_active, local.id);
        for (const post of old.posts)
          db.prepare(
            'UPDATE posts SET is_deleted=?,deleted_at=?,is_trashed=?,trashed_at=?,updated_at=? WHERE id=?',
          ).run(
            post.is_deleted,
            post.deleted_at,
            post.is_trashed,
            post.trashed_at,
            now,
            post.id,
          );
        for (const image of old.images)
          db.prepare(
            'UPDATE images SET is_deleted=?,deleted_at=?,is_trashed=?,trashed_at=?,updated_at=? WHERE id=?',
          ).run(
            image.is_deleted,
            image.deleted_at,
            image.is_trashed,
            image.trashed_at,
            now,
            image.id,
          );
        for (const f of old.fulfillments)
          if (f.state === 'active')
            db.prepare(
              "UPDATE archive_catalog_local_fulfillments SET state='active',revoked_at=?,revoked_reason=? WHERE id=? AND state='stale' AND revoked_reason='work_removed'",
            ).run(f.revoked_at, f.revoked_reason, f.id);
      } else {
        for (const local of s.locals)
          db.prepare(
            'UPDATE archive_catalog_local_works SET post_id=NULL,is_active=0 WHERE id=?',
          ).run(local.id);
        for (const image of s.images) {
          db.prepare(
            "UPDATE folders SET avatar_image_id=NULL,avatar_source='auto',updated_at=? WHERE avatar_image_id=?",
          ).run(now, image.id);
          db.prepare('DELETE FROM media_trash_entries WHERE image_id=?').run(
            image.id,
          );
        }
        for (const post of s.posts) {
          db.prepare('DELETE FROM likes WHERE post_id=?').run(post.id);
          db.prepare('DELETE FROM collection_items WHERE post_id=?').run(
            post.id,
          );
          db.prepare('DELETE FROM post_items WHERE post_id=?').run(post.id);
          db.prepare('DELETE FROM posts WHERE id=?').run(post.id);
        }
        for (const image of s.images)
          db.prepare('DELETE FROM images WHERE id=?').run(image.id);
        db.prepare(
          "UPDATE work_removals SET state='deleted',operation_id=? WHERE work_id=?",
        ).run(operationId, plan.workId);
      }
      db.prepare(
        'INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,reason,payload_json) VALUES(?,?,?,?,?)',
      ).run(
        operationId,
        `work_${plan.mode}`,
        plan.workId,
        'User confirmed whole Work removal operation',
        JSON.stringify({
          operationId,
          mode: plan.mode,
          localWorkIds: s.locals.map((l) => l.id),
        }),
      );
      db.prepare(
        'UPDATE removal_operations SET state=?,updated_at=? WHERE operation_id=?',
      ).run(
        plan.mode === 'permanent' ? 'committed' : 'completed',
        now,
        operationId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
