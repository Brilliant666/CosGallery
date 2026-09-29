import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { appConfig } from '../config/env.js';
import { databaseManager } from '../db/database.js';
import { normalizeCreatorIdentity } from '../utils/creator-identity.js';
import { ArchiveCatalogQueryService } from './archive-catalog-query-service.js';
import { normalizedAbsoluteCreatorPath } from './local-creator-folder-bridge-service.js';
import { creatorDeletionRows, inspectCreatorDeletion } from './managed-creator-deletion.js';
import { LocalIngestDestinationService } from './local-ingest-destination-service.js';

const name = z.string().transform(value => value.normalize('NFKC').trim()).pipe(z.string().min(1).max(255))
  .refine(value => normalizeCreatorIdentity(value).length > 0, '名称必须包含有效字符');
const preference = z.enum(['liked', 'kept']).nullable();
const rating = z.enum(['R15', 'R18']).nullable();
export const createManagedCreatorSchema = z.object({
  name, preference: preference.default(null), rating: rating.default(null),
  aliases: z.array(name).max(100).default([]), confirmDistinct: z.boolean().default(false)
}).strict();
export const patchManagedCreatorSchema = z.object({
  name: name.optional(), preference: preference.optional(), rating: rating.optional(),
  confirmDistinct: z.boolean().default(false)
}).strict().refine(value => value.name !== undefined || value.preference !== undefined || value.rating !== undefined,
  '至少修改一个字段');
export const managedAliasSchema = z.object({ alias: name, confirmDistinct: z.boolean().default(false) }).strict();
export const managedConfirmationSchema = z.object({ confirm: z.literal(true) }).strict();
export const deleteManagedCreatorSchema = z.object({
  confirm: z.literal(true), confirmationToken: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export const managedFolderLinkSchema = z.object({ creatorId: z.number().int().positive() }).strict();
export const managedFolderRatingSchema = z.object({ contentRating: rating }).strict();
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
export const managedProfileSettingsSchema = z.object({
  name, preference, rating, manualAliases: z.array(name).max(100),
  confirmDistinct: z.boolean().default(false), expectedRevision: revision
}).strict();
export const managedDirectorySettingsSchema = z.object({
  linkedFolderIds: z.array(z.number().int().positive()).max(1000),
  preferredLocalCreatorFolderId: z.number().int().positive().nullable().optional(),
  preferredGalleryFolderId: z.number().int().positive().nullable().optional(),
  expectedRevision: revision
}).strict().refine(value => (value.preferredLocalCreatorFolderId !== undefined)
  !== (value.preferredGalleryFolderId !== undefined), '请选择一种首选目录身份');

export class ManagedCreatorError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly candidates: Array<{ id: number; name: string }> = []) { super(message); }
}

/** Canonical metadata mutations only. Never scans, plans tasks or touches the filesystem. */
export class ManagedCreatorService {
  private readonly query: ArchiveCatalogQueryService;
  constructor(private readonly database: DatabaseSync = databaseManager.connection,
    private readonly galleryRoot = appConfig.galleryRoot) {
    this.query = new ArchiveCatalogQueryService(database);
  }

  private transaction<T>(action: () => T, acquireWriter = false): T {
    // A top-level folder link must reserve its writer before reading ownership.
    // A SAVEPOINT starts deferred: an independent catalog publisher can otherwise
    // acquire the writer between our reads and UPDATE, making the upgrade fail
    // immediately despite busy_timeout. Never commit a caller-owned transaction.
    const ownWriteTransaction = acquireWriter && !this.database.isTransaction;
    this.database.exec(ownWriteTransaction ? 'BEGIN IMMEDIATE' : 'SAVEPOINT managed_creator_mutation');
    try {
      const result = action();
      this.database.exec(ownWriteTransaction ? 'COMMIT' : 'RELEASE managed_creator_mutation');
      return result;
    } catch (error) {
      this.database.exec(ownWriteTransaction ? 'ROLLBACK' : 'ROLLBACK TO managed_creator_mutation; RELEASE managed_creator_mutation');
      throw error;
    }
  }

  private requireCreator(id: number) {
    const creator = this.query.getCreatorDetail(id);
    if (!creator) throw new ManagedCreatorError(404, 'CREATOR_NOT_FOUND', '博主不存在');
    return creator;
  }

  private checkCandidates(names: string[], exceptId: number | null, confirmed: boolean) {
    const candidates = new Map<number, { id: number; name: string }>();
    for (const value of names) {
      const normalized = normalizeCreatorIdentity(value);
      const rows = this.database.prepare(`SELECT DISTINCT creators.id, creators.canonical_name AS name
        FROM archive_catalog_creators creators LEFT JOIN archive_catalog_creator_aliases aliases ON aliases.creator_id=creators.id
        WHERE (creators.normalized_name=? OR aliases.normalized_alias=?) AND (? IS NULL OR creators.id<>?)`)
        .all(normalized, normalized, exceptId, exceptId) as Array<{ id: number; name: string }>;
      for (const row of rows) candidates.set(row.id, row);
    }
    if (candidates.size && !confirmed) throw new ManagedCreatorError(409, 'CREATOR_IDENTITY_AMBIGUOUS',
      '名称或别名与现有博主重复，请核对候选；确认是不同的人后才能保存。', [...candidates.values()]);
  }

  private addAliasRow(id: number, alias: string, source = 'manual') {
    const timestamp = new Date().toISOString();
    this.database.prepare(`INSERT INTO archive_catalog_creator_aliases
      (creator_id,alias,normalized_alias,source,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(creator_id,source,normalized_alias) DO NOTHING`)
      .run(id, alias, normalizeCreatorIdentity(alias), source, timestamp, timestamp);
  }

  private editingFacts(id: number) {
    const creator = this.database.prepare(`SELECT id,canonical_name,preference,effective_rating,is_active,
      seed_source,seed_source_creator_id,preferred_local_creator_folder_id FROM archive_catalog_creators WHERE id=?`).get(id);
    if (!creator) throw new ManagedCreatorError(404, 'CREATOR_NOT_FOUND', '博主不存在');
    const aliases = this.database.prepare(`SELECT alias,normalized_alias,source FROM archive_catalog_creator_aliases
      WHERE creator_id=? ORDER BY source,normalized_alias`).all(id);
    const folders = this.database.prepare(`SELECT local.id,local.creator_id,local.root_path,local.relative_path,
      local.absolute_path,local.is_active,local.match_status,local.gallery_folder_id,folders.folder_path,folders.role
      FROM archive_catalog_local_creator_folders local LEFT JOIN folders ON folders.id=local.gallery_folder_id
      WHERE local.creator_id=? ORDER BY local.id`).all(id);
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const { preferred_local_creator_folder_id: preferred, ...profile } = creator;
    return {
      profileRevision: hash({ profile, aliases }),
      directoriesRevision: hash({ id, active: creator.is_active, preferred, folders }),
      preferredLocalCreatorFolderId: preferred as number | null,
      linkedFolderIds: [...new Set(folders.filter(folder => folder.is_active === 1 && folder.gallery_folder_id !== null)
        .map(folder => Number(folder.gallery_folder_id)))].sort((a, b) => a - b)
    };
  }

  private assertRevision(expected: string, actual: string) {
    if (expected !== actual) throw new ManagedCreatorError(409, 'CREATOR_EDIT_CONFLICT',
      '该保存范围已被其他操作修改。草稿未保存，请重新读取当前资料后核对。');
  }

  async editingState(id: number) {
    // File availability is advisory. No transaction is held across filesystem IO;
    // detect database changes before returning a revision paired with that detail.
    const before = this.editingFacts(id);
    const destination = await new LocalIngestDestinationService(this.database, this.galleryRoot).getPreference(id);
    return this.transaction(() => {
      const facts = this.editingFacts(id);
      this.assertRevision(before.profileRevision, facts.profileRevision);
      this.assertRevision(before.directoriesRevision, facts.directoriesRevision);
      return { creator: this.requireCreator(id), ...facts, destination };
    });
  }

  saveProfile(id: number, input: unknown) {
    const data = managedProfileSettingsSchema.parse(input);
    return this.transaction(() => {
      this.assertRevision(data.expectedRevision, this.editingFacts(id).profileRevision);
      const current = this.requireCreator(id);
      const wanted = new Map(data.manualAliases.map(alias => [normalizeCreatorIdentity(alias), alias]));
      const existing = this.database.prepare(`SELECT normalized_alias,alias FROM archive_catalog_creator_aliases
        WHERE creator_id=? AND source='manual'`).all(id) as Array<{ normalized_alias: string; alias: string }>;
      this.checkCandidates([
        ...(data.name !== current.name ? [data.name] : []),
        ...[...wanted].filter(([normalized]) => !existing.some(row => row.normalized_alias === normalized)).map(([, alias]) => alias)
      ], id, data.confirmDistinct);
      if (data.name !== current.name) this.addAliasRow(id, current.name, 'manual-history');
      for (const row of existing) if (!wanted.has(row.normalized_alias)) {
        this.database.prepare(`DELETE FROM archive_catalog_creator_aliases WHERE creator_id=? AND source='manual' AND normalized_alias=?`)
          .run(id, row.normalized_alias);
      }
      for (const [normalized, alias] of wanted) {
        const old = existing.find(row => row.normalized_alias === normalized);
        if (!old) this.addAliasRow(id, alias);
        else if (old.alias !== alias) this.database.prepare(`UPDATE archive_catalog_creator_aliases SET alias=?,updated_at=?
          WHERE creator_id=? AND source='manual' AND normalized_alias=?`).run(alias, new Date().toISOString(), id, normalized);
      }
      if (data.name !== current.name || data.preference !== current.preference || data.rating !== current.rating) {
        this.database.prepare(`UPDATE archive_catalog_creators SET canonical_name=?,normalized_name=?,preference=?,effective_rating=?,updated_at=? WHERE id=?`)
          .run(data.name, normalizeCreatorIdentity(data.name), data.preference, data.rating, new Date().toISOString(), id);
      }
      return { creator: this.requireCreator(id), ...this.editingFacts(id) };
    }, true);
  }

  async saveDirectories(id: number, input: unknown) {
    const data = managedDirectorySettingsSchema.parse(input);
    const initial = this.editingFacts(id);
    this.assertRevision(data.expectedRevision, initial.directoriesRevision);
    const desired = [...new Set(data.linkedFolderIds)].sort((a, b) => a - b);
    const wantedPreferredGallery = data.preferredGalleryFolderId;
    const preferredRow = data.preferredLocalCreatorFolderId == null ? null : this.database.prepare(
      'SELECT gallery_folder_id FROM archive_catalog_local_creator_folders WHERE id=?').get(data.preferredLocalCreatorFolderId);
    if (data.preferredLocalCreatorFolderId != null && (!preferredRow || preferredRow.gallery_folder_id === null)) {
      throw new ManagedCreatorError(409, 'INGEST_DESTINATION_NOT_OWNED', '所选首选目录不存在');
    }
    const preferredGallery = wantedPreferredGallery === undefined
      ? (preferredRow?.gallery_folder_id as number | null ?? null) : wantedPreferredGallery;
    if (preferredGallery !== null && !desired.includes(preferredGallery)) {
      throw new ManagedCreatorError(409, 'INGEST_DESTINATION_NOT_OWNED', '首选目录必须属于保存后的关联目录');
    }
    // Validate disk availability before reserving SQLite's writer. Inside the
    // transaction the exact folder facts are checked again, never reinterpreted.
    const destinationService = new LocalIngestDestinationService(this.database, this.galleryRoot);
    const checked = preferredGallery === null ? null : await destinationService.inspectGalleryFolder(preferredGallery);
    if (checked && !checked.valid) throw new ManagedCreatorError(409, 'INGEST_DESTINATION_UNAVAILABLE',
      `所选目录不可用：${checked.unavailableReason}`);
    return this.transaction(() => {
      this.assertRevision(data.expectedRevision, this.editingFacts(id).directoriesRevision);
      if (checked && !destinationService.matchesInspectedGalleryFolder(checked)) {
        throw new ManagedCreatorError(409, 'CREATOR_EDIT_CONFLICT', '首选目录关系已经变化，请重新读取后核对');
      }
      const changed = desired.length !== initial.linkedFolderIds.length
        || desired.some((folder, index) => folder !== initial.linkedFolderIds[index])
        || (preferredGallery !== null && preferredGallery !== this.database.prepare(
          'SELECT gallery_folder_id FROM archive_catalog_local_creator_folders WHERE id=?').get(initial.preferredLocalCreatorFolderId)?.gallery_folder_id)
        || (preferredGallery === null && initial.preferredLocalCreatorFolderId !== null);
      if (changed) this.assertNoActiveDirectoryWork(id);
      for (const folderId of desired) if (!initial.linkedFolderIds.includes(folderId)) this.linkFolderRow(folderId, id);
      // Resolve the bridge only after all proposed links have passed domain checks.
      const preferred = preferredGallery === null ? null : this.database.prepare(`SELECT id FROM archive_catalog_local_creator_folders
        WHERE creator_id=? AND gallery_folder_id=? AND is_active=1 AND match_status='matched'`).all(id, preferredGallery);
      if (preferred !== null && preferred.length !== 1) throw new ManagedCreatorError(409,
        'INGEST_DESTINATION_NOT_OWNED', '首选目录需要唯一、有效的博主关联');
      const preferredId = preferred === null ? null : Number(preferred[0]!.id);
      if (preferredId !== initial.preferredLocalCreatorFolderId) this.database.prepare(`UPDATE archive_catalog_creators
        SET preferred_local_creator_folder_id=?,updated_at=? WHERE id=?`).run(preferredId, new Date().toISOString(), id);
      for (const folderId of initial.linkedFolderIds) if (!desired.includes(folderId)) this.unlinkFolderRow(folderId);
      return { creator: this.requireCreator(id), ...this.editingFacts(id) };
    }, true);
  }

  private assertNoActiveDirectoryWork(id: number) {
    const active = this.database.prepare(`SELECT 1 FROM local_ingest_jobs WHERE creator_id=?
      AND status IN ('queued','running','reconciling') LIMIT 1`).get(id);
    const admission = this.database.prepare(`SELECT 1 FROM local_admission_web_batches WHERE creator_id=?
      AND state IN ('queued','running') LIMIT 1`).get(id);
    if (active || admission) throw new ManagedCreatorError(409, 'LOCAL_INGEST_OPERATION_ACTIVE',
      '该博主有活动入库任务，请等待任务结束再修改目录设置');
  }

  create(input: unknown) {
    const data = createManagedCreatorSchema.parse(input);
    return this.transaction(() => {
      this.checkCandidates([data.name, ...data.aliases], null, data.confirmDistinct);
      const timestamp = new Date().toISOString();
      const result = this.database.prepare(`INSERT INTO archive_catalog_creators
        (canonical_name,normalized_name,preference,effective_rating,seed_source,seed_source_creator_id,created_at,updated_at)
        VALUES (?,?,?,?,'manual',?,?,?)`).run(data.name, normalizeCreatorIdentity(data.name), data.preference,
        data.rating, `manual:${randomUUID()}`, timestamp, timestamp);
      const id = Number(result.lastInsertRowid);
      for (const alias of [data.name, ...data.aliases]) this.addAliasRow(id, alias);
      return this.requireCreator(id);
    });
  }

  update(id: number, input: unknown) {
    const data = patchManagedCreatorSchema.parse(input);
    return this.transaction(() => {
      const current = this.requireCreator(id);
      const newName = data.name ?? current.name;
      if (newName !== current.name) {
        this.checkCandidates([newName], id, data.confirmDistinct);
        this.addAliasRow(id, current.name, 'manual-history');
        this.database.prepare(`DELETE FROM archive_catalog_creator_aliases WHERE creator_id=? AND source='manual' AND normalized_alias=?`)
          .run(id, normalizeCreatorIdentity(current.name));
        this.addAliasRow(id, newName);
      }
      this.database.prepare(`UPDATE archive_catalog_creators SET canonical_name=?, normalized_name=?,
        preference=?, effective_rating=?, updated_at=? WHERE id=?`).run(newName, normalizeCreatorIdentity(newName),
        data.preference === undefined ? current.preference : data.preference,
        data.rating === undefined ? current.rating : data.rating, new Date().toISOString(), id);
      return this.requireCreator(id);
    });
  }

  addAlias(id: number, input: unknown) {
    const data = managedAliasSchema.parse(input);
    return this.transaction(() => {
      this.requireCreator(id);
      this.checkCandidates([data.alias], id, data.confirmDistinct);
      this.addAliasRow(id, data.alias);
      return this.requireCreator(id);
    });
  }

  deleteAlias(id: number, aliasId: string) {
    return this.transaction(() => {
      this.requireCreator(id);
      let identity: unknown;
      try { identity = JSON.parse(Buffer.from(aliasId, 'base64url').toString('utf8')); } catch { /* invalid ID below */ }
      const parsed = z.tuple([z.string(), z.string()]).safeParse(identity);
      if (!parsed.success) throw new ManagedCreatorError(404, 'ALIAS_NOT_FOUND', '别名不存在');
      const [source, normalized] = parsed.data;
      if (source !== 'manual') throw new ManagedCreatorError(409, 'SOURCE_ALIAS_READ_ONLY', '来源和历史别名只读');
      const result = this.database.prepare(`DELETE FROM archive_catalog_creator_aliases
        WHERE creator_id=? AND source='manual' AND normalized_alias=?`).run(id, normalized);
      if (!result.changes) throw new ManagedCreatorError(404, 'ALIAS_NOT_FOUND', '别名不存在');
      return this.requireCreator(id);
    });
  }

  setActive(id: number, active: boolean, input: unknown) {
    managedConfirmationSchema.parse(input);
    return this.transaction(() => {
      const current = this.requireCreator(id);
      if (current.isActive === active) throw new ManagedCreatorError(409, 'CREATOR_STATE_CONFLICT', '博主状态已经变更，请刷新');
      const timestamp = new Date().toISOString();
      this.database.prepare(`UPDATE archive_catalog_creators SET is_active=?, deactivated_at=?, updated_at=? WHERE id=?`)
        .run(active ? 1 : 0, active ? null : timestamp, timestamp, id);
      return this.requireCreator(id);
    });
  }

  deletionPreview(id: number) {
    return this.transaction(() => {
      const preview = inspectCreatorDeletion(this.database, id);
      if (!preview) throw new ManagedCreatorError(404, 'CREATOR_NOT_FOUND', '博主不存在');
      return preview;
    });
  }

  deleteUnusedManualCreator(id: number, input: unknown) {
    const data = deleteManagedCreatorSchema.parse(input);
    return this.transaction(() => {
      const preview = inspectCreatorDeletion(this.database, id);
      if (!preview) throw new ManagedCreatorError(404, 'CREATOR_NOT_FOUND', '博主不存在');
      if (!preview.eligible) throw new ManagedCreatorError(409, 'CREATOR_DELETE_BLOCKED',
        `不能删除：${preview.blockers.map(item => `${item.label}（${item.count}）`).join('；')}`);
      if (preview.confirmationToken !== data.confirmationToken) throw new ManagedCreatorError(409,
        'CREATOR_DELETE_PREVIEW_CHANGED', '博主资料已变化，请重新检查并确认删除');
      // Keep a detached snapshot before removing the exact previewed whitelist.
      // Its names are historical evidence, never live aliases or name reservations.
      const snapshot = creatorDeletionRows(this.database, id);
      this.database.prepare(`INSERT INTO creator_deletion_audits
        (creator_id,canonical_name,confirmation_token,scope_json,snapshot_json,deleted_at) VALUES(?,?,?,?,?,?)`)
        .run(id, preview.name, preview.confirmationToken, JSON.stringify(preview.removalScope),
          JSON.stringify(snapshot), new Date().toISOString());
      for (const row of snapshot.archive_catalog_source_works)
        this.database.prepare('DELETE FROM archive_catalog_source_works WHERE id=?').run(Number(row.id));
      this.database.prepare('DELETE FROM archive_catalog_works WHERE creator_id=?').run(id);
      this.database.prepare('DELETE FROM archive_catalog_collections WHERE creator_id=?').run(id);
      this.database.prepare('DELETE FROM archive_catalog_creator_sources WHERE creator_id=?').run(id);
      this.database.prepare('DELETE FROM archive_catalog_creator_aliases WHERE creator_id=?').run(id);
      this.database.prepare('DELETE FROM archive_catalog_creators WHERE id=?').run(id);
      // Creator/alias delete triggers dirty the catalog: clean AFTER those triggers,
      // atomically invalidate revisions, and reject any stale prepared worker result.
      this.database.prepare('DELETE FROM resource_catalog_rows WHERE creator_id=?').run(id);
      this.database.prepare('DELETE FROM resource_catalog_state WHERE creator_id=?').run(id);
      this.database.prepare('UPDATE resource_catalog_meta SET publication=publication+1 WHERE id=1').run();
      return { deleted: true as const, creatorId: id };
    }, true);
  }

  /** folderId always means the gallery folders.id, never a name or catalog row ID. */
  linkFolder(folderId: number, input: unknown) {
    const { creatorId } = managedFolderLinkSchema.parse(input);
    return this.transaction(() => this.linkFolderRow(folderId, creatorId), true);
  }

  private linkFolderRow(folderId: number, creatorId: number) {
      this.requireCreator(creatorId);
      const folder = this.query.listLocalFolders().find(item => item.id === folderId);
      if (!folder) throw new ManagedCreatorError(404, 'LOCAL_FOLDER_NOT_FOUND', '本地博主目录不存在');
      if (folder.creatorId !== null && folder.creatorId !== creatorId) {
        throw new ManagedCreatorError(409, 'LOCAL_FOLDER_ALREADY_LINKED', '目录已关联其他博主，请先解除关联');
      }
      const absolute = normalizedAbsoluteCreatorPath(folder.folderPath, this.galleryRoot);
      if (!absolute) throw new ManagedCreatorError(409, 'LOCAL_FOLDER_PATH_INVALID', '目录路径无法精确解析');
      const rootAbsolute = normalizedAbsoluteCreatorPath(this.galleryRoot);
      if (!rootAbsolute || !absolute.startsWith(`${rootAbsolute}/`)) {
        throw new ManagedCreatorError(409, 'LOCAL_FOLDER_PATH_INVALID', '目录必须位于正式图库根目录内');
      }
      const rows = this.database.prepare(`SELECT id,root_path,absolute_path,gallery_folder_id,creator_id FROM archive_catalog_local_creator_folders
        WHERE is_active=1`).all() as Array<{id:number;root_path:string;absolute_path:string;gallery_folder_id:number|null;creator_id:number|null}>;
      const matches = rows.filter(row => row.gallery_folder_id === folderId
        || normalizedAbsoluteCreatorPath(row.absolute_path) === absolute);
      if (matches.length > 1 || matches.some(row => row.gallery_folder_id !== null && row.gallery_folder_id !== folderId)) {
        throw new ManagedCreatorError(409, 'LOCAL_FOLDER_LINK_CONFLICT', '存在多个或冲突的精确目录关联');
      }
      const existing = matches[0];
      if (existing && existing.creator_id !== null && existing.creator_id !== creatorId) {
        throw new ManagedCreatorError(409, 'LOCAL_FOLDER_ALREADY_LINKED', '目录已有其他博主关系');
      }
      if (existing) {
        const conflict = this.database.prepare(`SELECT 1 FROM archive_catalog_local_works local JOIN archive_catalog_works works ON works.id=local.work_id
          WHERE local.local_creator_folder_id=? AND works.creator_id<>? LIMIT 1`).get(existing.id, creatorId);
        if (conflict) throw new ManagedCreatorError(409, 'LOCAL_WORK_OWNER_CONFLICT', '已有作品属于其他博主，不能隐式重新归属');
        this.database.prepare(`UPDATE archive_catalog_local_creator_folders SET creator_id=?, gallery_folder_id=?,
          match_status='matched', match_method='manual', updated_at=? WHERE id=?`)
          .run(creatorId, folderId, new Date().toISOString(), existing.id);
      } else {
        const style = /^[a-z]:[\\/]|^(?:\\\\|\/\/)/iu.test(this.galleryRoot) ? path.win32 : path.posix;
        const root = style.resolve(this.galleryRoot);
        const relative = style.relative(root, style.resolve(root, folder.folderPath));
        if (!relative || relative.startsWith('..') || style.isAbsolute(relative)) {
          throw new ManagedCreatorError(409, 'LOCAL_FOLDER_PATH_INVALID', '目录必须位于正式图库根目录内');
        }
        const timestamp = new Date().toISOString();
        this.database.prepare(`INSERT INTO archive_catalog_local_creator_folders
          (creator_id,root_path,relative_path,absolute_path,folder_name,match_status,match_method,is_active,scanned_at,created_at,updated_at,gallery_folder_id)
          VALUES (?,?,?,?,?,'matched','manual',1,?,?,?,?)`).run(creatorId, root, relative, style.resolve(root, folder.folderPath), folder.name,
          timestamp, timestamp, timestamp, folderId);
      }
      return this.requireCreator(creatorId);
  }

  unlinkFolder(folderId: number, input: unknown) {
    managedConfirmationSchema.parse(input);
    return this.transaction(() => this.unlinkFolderRow(folderId), true);
  }

  private unlinkFolderRow(folderId: number) {
      const folder = this.query.listLocalFolders().find(item => item.id === folderId);
      if (!folder) throw new ManagedCreatorError(404, 'LOCAL_FOLDER_NOT_FOUND', '本地博主目录不存在');
      if (folder.creatorId === null || folder.catalogFolderId === null) {
        throw new ManagedCreatorError(409, 'CREATOR_NOT_LINKED', '目录尚未关联博主');
      }
      if (this.database.prepare(`SELECT 1 FROM archive_catalog_creators WHERE preferred_local_creator_folder_id=?`)
        .get(folder.catalogFolderId)) throw new ManagedCreatorError(409, 'INGEST_DESTINATION_REFERENCED',
          '目录仍被用作首选入库目录，请在目录设置中一并调整首选');
      this.database.prepare(`UPDATE archive_catalog_local_creator_folders SET creator_id=NULL,
        match_status='unmatched',match_method='manual-unlinked',updated_at=? WHERE id=?`)
        .run(new Date().toISOString(), folder.catalogFolderId);
      return { folderId, creatorId: null };
  }

  updateFolderRating(folderId: number, input: unknown) {
    const data = managedFolderRatingSchema.parse(input);
    const folder = this.query.listLocalFolders().find(item => item.id === folderId);
    if (!folder) throw new ManagedCreatorError(404, 'LOCAL_FOLDER_NOT_FOUND', '本地博主目录不存在');
    if (folder.creatorId === null) throw new ManagedCreatorError(409, 'CREATOR_NOT_LINKED', '请先在博主库关联此目录');
    return this.update(folder.creatorId, { rating: data.contentRating });
  }
}
