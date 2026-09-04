import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export function normalizedAbsoluteCreatorPath(value: string, root?: string): string | null {
  if (!value || /^[a-z]:(?![\\/])/iu.test(value)) return null;
  const windows = /^[a-z]:[\\/]|^\\\\|^\/\//iu.test(root ?? value);
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(root ?? value)) return null;
  const resolved = root ? paths.resolve(root, value) : paths.resolve(value);
  const normalized = resolved.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return windows ? normalized.toLocaleLowerCase() : normalized;
}

export type FolderBridgeResult = {
  catalogFolderId: number;
  galleryFolderId: number | null;
  status: 'exact' | 'missing' | 'ambiguous' | 'conflict';
  candidates: number[];
};

export class LocalCreatorFolderBridgeService {
  constructor(private readonly database: DatabaseSync) {}

  preview(galleryRoot: string, catalogFolderIds?: number[]): FolderBridgeResult[] {
    const gallery = this.database.prepare("SELECT id, folder_path FROM folders WHERE role='normal'").all() as Array<{id:number;folder_path:string}>;
    const locals = this.database.prepare('SELECT id, absolute_path, gallery_folder_id FROM archive_catalog_local_creator_folders WHERE is_active=1').all() as Array<{id:number;absolute_path:string;gallery_folder_id:number|null}>;
    const results = locals.map(local => {
      const absolute = normalizedAbsoluteCreatorPath(local.absolute_path);
      const candidates = absolute === null ? [] : gallery.filter(folder => normalizedAbsoluteCreatorPath(folder.folder_path, galleryRoot) === absolute).map(folder => folder.id);
      let status: FolderBridgeResult['status'] = candidates.length === 1 ? 'exact' : candidates.length ? 'ambiguous' : 'missing';
      if (local.gallery_folder_id !== null && (candidates.length !== 1 || candidates[0] !== local.gallery_folder_id)) status = 'conflict';
      return {catalogFolderId:local.id,galleryFolderId:local.gallery_folder_id,status,candidates};
    });
    for (const result of results) {
      if (result.status !== 'exact') continue;
      if (results.some(other => other.catalogFolderId !== result.catalogFolderId && (other.galleryFolderId === result.candidates[0] || other.candidates.includes(result.candidates[0])))) result.status = 'conflict';
    }
    return results.filter(result => catalogFolderIds === undefined || catalogFolderIds.includes(result.catalogFolderId));
  }

  backfill(galleryRoot: string, catalogFolderIds?: number[]): FolderBridgeResult[] {
    const results = this.preview(galleryRoot, catalogFolderIds);
    const update = this.database.prepare('UPDATE archive_catalog_local_creator_folders SET gallery_folder_id=? WHERE id=? AND gallery_folder_id IS NULL');
    this.database.exec('SAVEPOINT creator_folder_backfill');
    try {
      for (const result of results) {
        if (result.status === 'exact' && result.galleryFolderId === null) {
          update.run(result.candidates[0], result.catalogFolderId);
          result.galleryFolderId = result.candidates[0];
        }
      }
      this.database.exec('RELEASE creator_folder_backfill');
    } catch (error) {
      this.database.exec('ROLLBACK TO creator_folder_backfill; RELEASE creator_folder_backfill');
      throw error;
    }
    return results;
  }
}
