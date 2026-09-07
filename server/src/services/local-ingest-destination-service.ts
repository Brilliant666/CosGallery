import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { appConfig } from '../config/env.js';
import { databaseManager } from '../db/database.js';
import {
  assertPathInsideLocalIngestRoot,
  canonicalizeLocalIngestPath,
  LocalIngestPathError
} from '../utils/local-ingest-paths.js';

type CreatorDirectoryRow = {
  creator_id: number;
  canonical_name: string;
  preferred_local_creator_folder_id: number | null;
  catalog_folder_id: number | null;
  gallery_folder_id: number | null;
  root_path: string | null;
  relative_path: string | null;
  absolute_path: string | null;
  folder_name: string | null;
  match_status: string | null;
  local_folder_active: number | null;
  gallery_folder_path: string | null;
  gallery_folder_name: string | null;
  gallery_folder_role: string | null;
  work_count: number;
};

export type LocalIngestDestinationCandidate = {
  localCreatorFolderId: number;
  galleryFolderId: number;
  name: string;
  folderPath: string;
  absolutePath: string;
  workCount: number;
  valid: boolean;
  unavailableReason: string | null;
};

export type LocalIngestDestinationPreference = {
  creatorId: number;
  creatorName: string;
  preferredLocalCreatorFolderId: number | null;
  mode: 'explicit' | 'single-linked' | 'new-creator' | 'selection-required' | 'preferred-unavailable' | 'linked-folders-unavailable';
  resolvedLocalCreatorFolderId: number | null;
  resolvedGalleryFolderId: number | null;
  resolvedCreatorDirectory: string | null;
  message: string;
  candidates: LocalIngestDestinationCandidate[];
};

export type LocalIngestTargetPlan = {
  creatorId: number;
  creatorName: string;
  targetPath: string;
  creatorDirectory: string;
  localCreatorFolderId: number | null;
  galleryFolderId: number | null;
  resolution: 'explicit' | 'single-linked' | 'new-creator';
};

export class LocalIngestDestinationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'LocalIngestDestinationError';
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

export function sanitizeLocalIngestDirectoryName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!sanitized) {
    throw new LocalIngestDestinationError('INVALID_TARGET_NAME', 'The mapped work has no usable directory name');
  }
  const bounded = sanitized.slice(0, 220).replace(/[. ]+$/g, '');
  const deviceStem = bounded.split('.')[0]!.toLocaleUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceStem)) {
    throw new LocalIngestDestinationError('INVALID_TARGET_NAME', 'The mapped name is reserved by Windows');
  }
  return bounded;
}

async function lstatDirectory(pathname: string): Promise<{ available: boolean; reason: string | null }> {
  try {
    const stats = await fs.lstat(pathname);
    if (!stats.isDirectory()) return { available: false, reason: '路径不是目录' };
    if (stats.isSymbolicLink()) return { available: false, reason: '目录是符号链接或重解析点' };
    await fs.access(pathname, fsConstants.R_OK | fsConstants.W_OK);
    return { available: true, reason: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { available: false, reason: '目录不存在或磁盘离线' };
    return { available: false, reason: error instanceof Error ? error.message : '目录不可用' };
  }
}

/**
 * Resolves creator roots for new jobs and validates the immutable target plan of
 * existing jobs. It never creates, moves, scans, or removes a directory.
 */
export class LocalIngestDestinationService {
  constructor(
    private readonly database: DatabaseSync = databaseManager.connection,
    private readonly libraryRoot = appConfig.galleryRoot
  ) {}

  private requireCreator(creatorId: number): CreatorDirectoryRow {
    const row = this.database.prepare(
      `SELECT creators.id AS creator_id,
              creators.canonical_name,
              creators.preferred_local_creator_folder_id,
              NULL AS catalog_folder_id,
              NULL AS gallery_folder_id,
              NULL AS root_path,
              NULL AS relative_path,
              NULL AS absolute_path,
              NULL AS folder_name,
              NULL AS match_status,
              NULL AS local_folder_active,
              NULL AS gallery_folder_path,
              NULL AS gallery_folder_name,
              NULL AS gallery_folder_role,
              0 AS work_count
       FROM archive_catalog_creators AS creators
       WHERE creators.id = ?`
    ).get(creatorId) as CreatorDirectoryRow | undefined;
    if (!row) throw new LocalIngestDestinationError('CREATOR_NOT_FOUND', '博主不存在', 404);
    return row;
  }

  private rowsForCreator(creatorId: number): CreatorDirectoryRow[] {
    const creator = this.requireCreator(creatorId);
    const rows = this.database.prepare(
      `SELECT creators.id AS creator_id,
              creators.canonical_name,
              creators.preferred_local_creator_folder_id,
              local.id AS catalog_folder_id,
              local.gallery_folder_id,
              local.root_path,
              local.relative_path,
              local.absolute_path,
              local.folder_name,
              local.match_status,
              local.is_active AS local_folder_active,
              folders.folder_path AS gallery_folder_path,
              folders.name AS gallery_folder_name,
              folders.role AS gallery_folder_role,
              (SELECT COUNT(DISTINCT posts.id)
                 FROM posts
                WHERE posts.folder_id = folders.id
                  AND posts.is_deleted = 0
                  AND posts.is_trashed = 0) AS work_count
       FROM archive_catalog_creators AS creators
       LEFT JOIN archive_catalog_local_creator_folders AS local ON local.creator_id = creators.id
       LEFT JOIN folders ON folders.id = local.gallery_folder_id
       WHERE creators.id = ?
       ORDER BY local.id`
    ).all(creatorId) as CreatorDirectoryRow[];
    return rows.length > 0 ? rows : [creator];
  }

  private async validateCandidate(row: CreatorDirectoryRow): Promise<LocalIngestDestinationCandidate | null> {
    if (
      row.catalog_folder_id === null
      || row.gallery_folder_id === null
      || row.root_path === null
      || row.relative_path === null
      || row.absolute_path === null
      || row.gallery_folder_path === null
    ) return null;

    const base: Omit<LocalIngestDestinationCandidate, 'valid' | 'unavailableReason'> = {
      localCreatorFolderId: row.catalog_folder_id,
      galleryFolderId: row.gallery_folder_id,
      name: row.gallery_folder_name ?? row.folder_name ?? row.relative_path,
      folderPath: row.gallery_folder_path,
      absolutePath: row.absolute_path,
      workCount: Number(row.work_count)
    };
    const invalid = (reason: string): LocalIngestDestinationCandidate => ({
      ...base,
      valid: false,
      unavailableReason: reason
    });
    if (row.local_folder_active !== 1 || row.match_status !== 'matched') return invalid('目录关系已失效或未确认');
    if (row.gallery_folder_role !== 'normal') return invalid('目标不是图库的博主根目录');

    try {
      const checkedBridge = await assertPathInsideLocalIngestRoot(this.libraryRoot, row.absolute_path, {
        directChild: true,
        label: 'Creator destination'
      });
      const checkedFolder = await assertPathInsideLocalIngestRoot(
        this.libraryRoot,
        path.resolve(this.libraryRoot, row.gallery_folder_path),
        { directChild: true, label: 'Gallery creator folder' }
      );
      const checkedRelative = await assertPathInsideLocalIngestRoot(
        this.libraryRoot,
        path.resolve(row.root_path, row.relative_path),
        { directChild: true, label: 'Catalog creator folder' }
      );
      const checkedRoot = await canonicalizeLocalIngestPath(row.root_path);
      const libraryRoot = await canonicalizeLocalIngestPath(this.libraryRoot);
      if (!samePath(checkedRoot, libraryRoot)) return invalid('目录关系属于另一个图库根目录');
      if (!samePath(checkedBridge.candidate, checkedFolder.candidate)) return invalid('目录桥接与图库 Folder 路径不一致');
      if (!samePath(checkedBridge.candidate, checkedRelative.candidate)) return invalid('目录桥接的相对路径与绝对路径不一致');
      const onDisk = await lstatDirectory(checkedBridge.candidate);
      if (!onDisk.available) return invalid(onDisk.reason ?? '目录不可用');
      return { ...base, absolutePath: checkedBridge.candidate, valid: true, unavailableReason: null };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : '目录路径无效');
    }
  }

  async getPreference(creatorId: number): Promise<LocalIngestDestinationPreference> {
    const rows = this.rowsForCreator(creatorId);
    const creator = rows[0]!;
    const candidates = (await Promise.all(rows.map((row) => this.validateCandidate(row))))
      .filter((candidate): candidate is LocalIngestDestinationCandidate => candidate !== null);
    const valid = candidates.filter((candidate) => candidate.valid);
    const preferredId = creator.preferred_local_creator_folder_id;
    if (preferredId !== null) {
      const preferred = candidates.find((candidate) => candidate.localCreatorFolderId === preferredId);
      if (!preferred?.valid) {
        return {
          creatorId,
          creatorName: creator.canonical_name,
          preferredLocalCreatorFolderId: preferredId,
          mode: 'preferred-unavailable',
          resolvedLocalCreatorFolderId: null,
          resolvedGalleryFolderId: null,
          resolvedCreatorDirectory: null,
          message: preferred
            ? `已选择的入库目录不可用：${preferred.unavailableReason ?? '未知原因'}`
            : '已选择的入库目录关系不存在或已解除，必须重新确认',
          candidates
        };
      }
      return {
        creatorId,
        creatorName: creator.canonical_name,
        preferredLocalCreatorFolderId: preferredId,
        mode: 'explicit',
        resolvedLocalCreatorFolderId: preferred.localCreatorFolderId,
        resolvedGalleryFolderId: preferred.galleryFolderId,
        resolvedCreatorDirectory: preferred.absolutePath,
        message: '使用显式选择的首选入库目录',
        candidates
      };
    }
    if (valid.length === 1) {
      return {
        creatorId,
        creatorName: creator.canonical_name,
        preferredLocalCreatorFolderId: null,
        mode: 'single-linked',
        resolvedLocalCreatorFolderId: valid[0]!.localCreatorFolderId,
        resolvedGalleryFolderId: valid[0]!.galleryFolderId,
        resolvedCreatorDirectory: valid[0]!.absolutePath,
        message: '未显式选择；自动沿用唯一有效的已关联目录',
        candidates
      };
    }
    if (valid.length > 1) {
      return {
        creatorId,
        creatorName: creator.canonical_name,
        preferredLocalCreatorFolderId: null,
        mode: 'selection-required',
        resolvedLocalCreatorFolderId: null,
        resolvedGalleryFolderId: null,
        resolvedCreatorDirectory: null,
        message: '该博主有多个有效本地目录，请先选择首选入库目录',
        candidates
      };
    }
    if (candidates.length > 0 || rows.some((row) => row.catalog_folder_id !== null)) {
      return {
        creatorId,
        creatorName: creator.canonical_name,
        preferredLocalCreatorFolderId: null,
        mode: 'linked-folders-unavailable',
        resolvedLocalCreatorFolderId: null,
        resolvedGalleryFolderId: null,
        resolvedCreatorDirectory: null,
        message: '该博主存在历史目录关系，但当前没有可用入库目录',
        candidates
      };
    }
    return {
      creatorId,
      creatorName: creator.canonical_name,
      preferredLocalCreatorFolderId: null,
      mode: 'new-creator',
      resolvedLocalCreatorFolderId: null,
      resolvedGalleryFolderId: null,
      resolvedCreatorDirectory: null,
      message: '该博主尚无本地目录；首次任务将在提交时建立目录与桥接',
      candidates
    };
  }

  async setPreferred(creatorId: number, localCreatorFolderId: number | null): Promise<LocalIngestDestinationPreference> {
    const creator = this.requireCreator(creatorId);
    if (localCreatorFolderId !== null) {
      const preference = await this.getPreference(creatorId);
      const candidate = preference.candidates.find((item) => item.localCreatorFolderId === localCreatorFolderId);
      if (!candidate) {
        throw new LocalIngestDestinationError('INGEST_DESTINATION_NOT_OWNED', '所选目录不属于该博主');
      }
      if (!candidate.valid) {
        throw new LocalIngestDestinationError(
          'INGEST_DESTINATION_UNAVAILABLE',
          `所选目录不可用：${candidate.unavailableReason ?? '未知原因'}`
        );
      }
    }
    if (creator.preferred_local_creator_folder_id === localCreatorFolderId) {
      return this.getPreference(creatorId);
    }
    this.database.prepare(
      `UPDATE archive_catalog_creators
       SET preferred_local_creator_folder_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(localCreatorFolderId, new Date().toISOString(), creatorId);
    return this.getPreference(creatorId);
  }

  private async assertNewCreatorDirectoryAvailable(creatorId: number, creatorDirectory: string): Promise<void> {
    const canonicalTarget = await canonicalizeLocalIngestPath(creatorDirectory);
    const linked = this.database.prepare(
      `SELECT creator_id, absolute_path
       FROM archive_catalog_local_creator_folders
       WHERE is_active = 1 AND creator_id IS NOT NULL`
    ).all() as Array<{ creator_id: number; absolute_path: string }>;
    for (const row of linked) {
      if (samePath(await canonicalizeLocalIngestPath(row.absolute_path), canonicalTarget) && row.creator_id !== creatorId) {
        throw new LocalIngestDestinationError('INGEST_DESTINATION_OWNER_CONFLICT', '目标目录已经属于其他博主');
      }
    }
    const planned = this.database.prepare(
      `SELECT creator_id, target_path
       FROM local_ingest_jobs
       WHERE target_path IS NOT NULL AND status <> 'ingested'`
    ).all() as Array<{ creator_id: number; target_path: string }>;
    let sameCreatorPlan = false;
    for (const row of planned) {
      const plannedRoot = path.dirname(await canonicalizeLocalIngestPath(row.target_path));
      if (samePath(plannedRoot, canonicalTarget)) {
        if (row.creator_id !== creatorId) {
          throw new LocalIngestDestinationError('INGEST_DESTINATION_PLAN_CONFLICT', '另一个博主已有相同目标目录计划');
        }
        sameCreatorPlan = true;
      }
    }
    const existing = await lstatDirectory(creatorDirectory);
    if (existing.available && !sameCreatorPlan) {
      throw new LocalIngestDestinationError(
        'UNCONFIRMED_CREATOR_DIRECTORY_EXISTS',
        '同名目录已经存在但尚未确认归属，不能自动接管'
      );
    }
    if (!existing.available && existing.reason && !existing.reason.includes('不存在') && !existing.reason.includes('离线')) {
      throw new LocalIngestDestinationError('INGEST_DESTINATION_UNAVAILABLE', existing.reason);
    }
  }

  private async assertTargetPlanAvailable(
    creatorId: number,
    targetPath: string,
    excludeJobId?: number
  ): Promise<void> {
    const canonicalTarget = await canonicalizeLocalIngestPath(targetPath);
    const planned = this.database.prepare(
      `SELECT id, creator_id, target_path
       FROM local_ingest_jobs
       WHERE target_path IS NOT NULL AND status <> 'ingested'`
    ).all() as Array<{ id: number; creator_id: number; target_path: string }>;
    for (const row of planned) {
      if (row.id === excludeJobId) continue;
      if (!samePath(await canonicalizeLocalIngestPath(row.target_path), canonicalTarget)) continue;
      throw new LocalIngestDestinationError(
        row.creator_id === creatorId ? 'INGEST_TARGET_PLAN_CONFLICT' : 'INGEST_DESTINATION_PLAN_CONFLICT',
        row.creator_id === creatorId
          ? '该博主已有未完成任务使用相同的作品目标目录'
          : '另一个博主已有相同的作品目标目录计划'
      );
    }
  }

  async resolveNewTarget(
    creatorId: number,
    workTitle: string,
    excludeJobId?: number
  ): Promise<LocalIngestTargetPlan> {
    const preference = await this.getPreference(creatorId);
    if (preference.mode === 'selection-required') {
      throw new LocalIngestDestinationError('PREFERRED_INGEST_DIRECTORY_REQUIRED', preference.message);
    }
    if (preference.mode === 'preferred-unavailable' || preference.mode === 'linked-folders-unavailable') {
      throw new LocalIngestDestinationError('INGEST_DESTINATION_UNAVAILABLE', preference.message);
    }
    let creatorDirectory = preference.resolvedCreatorDirectory;
    if (preference.mode === 'new-creator') {
      const creatorDirectoryName = sanitizeLocalIngestDirectoryName(preference.creatorName);
      if (creatorDirectoryName !== preference.creatorName.trim()) {
        throw new LocalIngestDestinationError('INVALID_TARGET_NAME', 'Creator name contains path or reserved filename characters');
      }
      creatorDirectory = path.join(this.libraryRoot, creatorDirectoryName);
      await assertPathInsideLocalIngestRoot(this.libraryRoot, creatorDirectory, {
        directChild: true,
        label: 'Target creator directory'
      });
      await this.assertNewCreatorDirectoryAvailable(creatorId, creatorDirectory);
    }
    if (!creatorDirectory) {
      throw new LocalIngestDestinationError('INGEST_DESTINATION_UNAVAILABLE', '无法确定入库目录');
    }
    const targetPath = path.join(creatorDirectory, sanitizeLocalIngestDirectoryName(workTitle));
    await assertPathInsideLocalIngestRoot(this.libraryRoot, targetPath, { label: 'Target directory' });
    await this.assertTargetPlanAvailable(creatorId, targetPath, excludeJobId);
    return {
      creatorId,
      creatorName: preference.creatorName,
      targetPath,
      creatorDirectory,
      localCreatorFolderId: preference.resolvedLocalCreatorFolderId,
      galleryFolderId: preference.resolvedGalleryFolderId,
      resolution: preference.mode
    };
  }

  async validatePersistedTarget(input: {
    creatorId: number;
    targetPath: string | null;
    workTitle: string;
    requireCreatorDirectory?: boolean;
  }): Promise<LocalIngestTargetPlan> {
    if (!input.targetPath) {
      throw new LocalIngestDestinationError('TARGET_PLAN_MISSING', 'The ingest job has no persisted target plan');
    }
    let checked: Awaited<ReturnType<typeof assertPathInsideLocalIngestRoot>>;
    try {
      checked = await assertPathInsideLocalIngestRoot(this.libraryRoot, input.targetPath, {
        code: 'TARGET_PATH_OUTSIDE_LIBRARY',
        label: 'Persisted target directory'
      });
    } catch (error) {
      if (error instanceof LocalIngestPathError) {
        throw new LocalIngestDestinationError(error.code, error.message);
      }
      throw error;
    }
    // assertPathInsideLocalIngestRoot compares case-insensitively on Windows.
    // Recompute the relative path from the preserved canonical values so a Job
    // planned for "Creator Alpha" never becomes "creator alpha" at rescan time.
    const actualRelative = path.relative(checked.root, checked.candidate);
    const segments = actualRelative.split(path.sep).filter(Boolean);
    if (segments.length !== 2) {
      throw new LocalIngestDestinationError('TARGET_PATH_OUTSIDE_LIBRARY', 'Persisted target must be a direct work directory under a creator root');
    }
    // The leaf name is an immutable decision already stored on the Job. Source
    // metadata may be corrected later, but must never silently retarget it.
    if (!segments[1]!.trim()) {
      throw new LocalIngestDestinationError('TARGET_PLAN_SOURCE_MISMATCH', 'Persisted target has no work-directory name');
    }
    const creatorDirectory = path.join(checked.root, segments[0]!);
    const bridgeRows = this.database.prepare(
      `SELECT local.id AS catalog_folder_id,
              local.gallery_folder_id,
              local.creator_id,
              local.root_path,
              local.relative_path,
              local.absolute_path,
              local.is_active,
              local.match_status,
              folders.folder_path,
              folders.role
       FROM archive_catalog_local_creator_folders AS local
       LEFT JOIN folders ON folders.id = local.gallery_folder_id
       WHERE local.creator_id = ?`
    ).all(input.creatorId) as Array<{
      catalog_folder_id: number;
      gallery_folder_id: number | null;
      creator_id: number | null;
      root_path: string;
      relative_path: string;
      absolute_path: string;
      is_active: number;
      match_status: string;
      folder_path: string | null;
      role: string | null;
    }>;
    let matchingBridge: typeof bridgeRows[number] | undefined;
    for (const row of bridgeRows) {
      if (samePath(await canonicalizeLocalIngestPath(row.absolute_path), creatorDirectory)) {
        matchingBridge = row;
        break;
      }
    }
    if (matchingBridge) {
      if (
        matchingBridge.is_active !== 1
        || matchingBridge.match_status !== 'matched'
        || (matchingBridge.gallery_folder_id !== null
          && (matchingBridge.role !== 'normal' || !matchingBridge.folder_path))
      ) {
        throw new LocalIngestDestinationError('INGEST_DESTINATION_UNAVAILABLE', 'The persisted creator directory relationship is no longer valid');
      }
      const checkedRoot = await canonicalizeLocalIngestPath(matchingBridge.root_path);
      const checkedLibrary = await canonicalizeLocalIngestPath(this.libraryRoot);
      const relativeDirectory = await assertPathInsideLocalIngestRoot(
        this.libraryRoot,
        path.resolve(matchingBridge.root_path, matchingBridge.relative_path),
        { directChild: true, label: 'Persisted catalog creator directory' }
      );
      const galleryDirectory = matchingBridge.folder_path
        ? await assertPathInsideLocalIngestRoot(
            this.libraryRoot,
            path.resolve(this.libraryRoot, matchingBridge.folder_path),
            { directChild: true, label: 'Persisted gallery creator directory' }
          )
        : null;
      if (
        !samePath(checkedRoot, checkedLibrary)
        || !samePath(relativeDirectory.candidate, creatorDirectory)
        || (galleryDirectory !== null && !samePath(galleryDirectory.candidate, creatorDirectory))
      ) {
        throw new LocalIngestDestinationError(
          'TARGET_PLAN_OWNER_MISMATCH',
          'The persisted target no longer matches its creator directory bridge'
        );
      }
    } else {
      // Older Jobs and the guarded manual-placement flow can legitimately have
      // a fixed target before the physical Folder bridge is created. Preserve
      // that plan unless another creator already owns the root; reconciliation
      // will establish the exact bridge after the directory is indexed.
      const otherRows = this.database.prepare(
        `SELECT creator_id, absolute_path
         FROM archive_catalog_local_creator_folders
         WHERE is_active = 1 AND creator_id IS NOT NULL AND creator_id <> ?`
      ).all(input.creatorId) as Array<{ creator_id: number; absolute_path: string }>;
      for (const row of otherRows) {
        if (samePath(await canonicalizeLocalIngestPath(row.absolute_path), creatorDirectory)) {
          throw new LocalIngestDestinationError('TARGET_PLAN_OWNER_MISMATCH', 'The persisted target creator root belongs to another creator');
        }
      }
    }
    if (matchingBridge || input.requireCreatorDirectory) {
      const onDisk = await lstatDirectory(creatorDirectory);
      if (!onDisk.available) {
        throw new LocalIngestDestinationError('INGEST_DESTINATION_UNAVAILABLE', onDisk.reason ?? 'The persisted creator directory is unavailable');
      }
    }
    const creator = this.requireCreator(input.creatorId);
    return {
      creatorId: input.creatorId,
      creatorName: creator.canonical_name,
      targetPath: checked.candidate,
      creatorDirectory,
      localCreatorFolderId: matchingBridge?.catalog_folder_id ?? null,
      galleryFolderId: matchingBridge?.gallery_folder_id ?? null,
      resolution: matchingBridge ? 'single-linked' : 'new-creator'
    };
  }
}
