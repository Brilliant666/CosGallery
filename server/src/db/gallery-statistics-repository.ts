import type { DatabaseSync } from 'node:sqlite';
import { databaseManager } from './database.js';
import { createUnchangedReadCache } from './unchanged-read-cache.js';
import { VISIBLE_POST_WHERE_SQL } from './repositories.js';

/** Public, unfiltered gallery facts. Counts identities, never directory or Post aliases. */
export interface GalleryStatistics {
  creators: number;
  works: number;
  photos: number;
}

const readUnchanged = createUnchangedReadCache<GalleryStatistics>();

export function getGalleryStatistics(db: DatabaseSync = databaseManager.connection): GalleryStatistics {
  return readUnchanged(db, () => {
    const result = db.prepare(`
      WITH visible_posts AS MATERIALIZED (
        SELECT posts.id, posts.folder_id FROM posts JOIN folders ON folders.id=posts.folder_id
        WHERE ${VISIBLE_POST_WHERE_SQL}
      ), gallery_owners AS (
        -- Same identity eligibility as listFolderCandidates: an offline explicit
        -- primary retains its creator card and explanation, but adds no media.
        SELECT gallery_folder_id, MIN(creator_id) AS creator_id
        FROM archive_catalog_local_creator_folders local
        WHERE match_status='matched' AND creator_id IS NOT NULL
          AND (is_active=1 OR EXISTS (
            SELECT 1 FROM archive_catalog_works work
            JOIN archive_catalog_local_works copy ON copy.id=work.primary_local_work_id
            WHERE copy.local_creator_folder_id=local.id))
        GROUP BY gallery_folder_id HAVING COUNT(DISTINCT creator_id)=1
      ), visible_creators AS (
        SELECT DISTINCT creators.id
        FROM gallery_owners owner
        JOIN archive_catalog_creators creators ON creators.id=owner.creator_id AND creators.is_active=1
        JOIN folders ON folders.id=owner.gallery_folder_id AND folders.role='normal'
        WHERE EXISTS (SELECT 1 FROM visible_posts WHERE folder_id=folders.id)
          OR EXISTS (
            SELECT 1 FROM archive_catalog_works work
            JOIN archive_catalog_local_works copy ON copy.id=work.primary_local_work_id
            JOIN archive_catalog_local_creator_folders local ON local.id=copy.local_creator_folder_id
            WHERE local.gallery_folder_id=folders.id)
      ), local_copies AS MATERIALIZED (
        SELECT work.id AS work_id, work.creator_id, work.primary_local_work_id,
          copy.id AS local_id, copy.is_active AS copy_active, copy.match_status AS copy_match,
          local.is_active AS folder_active, local.match_status AS folder_match,
          local.creator_id AS owner_id, local.gallery_folder_id,
          posts.id AS post_id, posts.folder_id AS post_folder_id,
          posts.is_deleted, posts.is_trashed,
          COUNT(*) FILTER (WHERE COALESCE(posts.is_deleted,0)=0 AND COALESCE(posts.is_trashed,0)=0)
            OVER (PARTITION BY work.id) AS viable_copy_count
        FROM archive_catalog_works work
        JOIN visible_creators creators ON creators.id=work.creator_id
        CROSS JOIN archive_catalog_local_works copy ON copy.work_id=work.id
        CROSS JOIN archive_catalog_local_creator_folders local ON local.id=copy.local_creator_folder_id
        LEFT JOIN posts ON posts.id=COALESCE(copy.post_id, (
          -- Existing resource-catalog legacy linkage: exact indexed source path,
          -- never a title, source number, filename similarity, or a write-back.
          SELECT legacy.id FROM posts legacy WHERE copy.match_status='matched'
            AND legacy.folder_id=local.gallery_folder_id
            AND legacy.source_path=rtrim(replace(local.relative_path,char(92),'/'),'/')
              || '/' || ltrim(replace(copy.relative_path,char(92),'/'),'/')))
        WHERE NOT EXISTS (SELECT 1 FROM work_removals removed WHERE removed.work_id=work.id)
      ), selected_copies AS MATERIALIZED (
        SELECT copy.work_id, copy.post_id
        FROM local_copies copy
        JOIN visible_posts ON visible_posts.id=copy.post_id
        WHERE (copy.primary_local_work_id=copy.local_id
            OR (copy.primary_local_work_id IS NULL AND copy.viable_copy_count=1))
          AND copy.copy_active=1 AND copy.folder_active=1
          AND copy.copy_match='matched' AND copy.folder_match='matched'
          AND copy.owner_id=copy.creator_id AND copy.post_folder_id=copy.gallery_folder_id
          AND NOT EXISTS (
            SELECT 1 FROM archive_catalog_local_creator_folders other
            WHERE other.gallery_folder_id=copy.gallery_folder_id AND other.is_active=1
              AND other.match_status='matched' AND other.creator_id IS NOT NULL
              AND other.creator_id<>copy.creator_id)
      ), visible_media AS MATERIALIZED (
        -- Visit only selected copies' members by PK, not the global image index.
        SELECT copy.work_id, media.id, media.media_type
        FROM selected_copies copy
        CROSS JOIN post_items item ON item.post_id=copy.post_id
        CROSS JOIN images media ON media.id=item.image_id
        WHERE media.is_deleted=0 AND media.is_trashed=0 AND media.media_type IN ('image','video')
          AND NOT EXISTS (SELECT 1 FROM media_trash_entries trash WHERE trash.image_id=media.id AND trash.active=1)
          AND instr('/' || replace(media.relative_path,char(92),'/'),'/_未支持格式原件/')=0
          AND instr('/' || replace(media.relative_path,char(92),'/'),'/.local-admission-attachments/')=0
      )
      SELECT (SELECT COUNT(*) FROM visible_creators) AS creators,
        COUNT(DISTINCT work_id) AS works,
        COUNT(DISTINCT CASE WHEN media_type='image' THEN id END) AS photos
      FROM visible_media
    `).get() as unknown as GalleryStatistics;
    return { creators: Number(result.creators), works: Number(result.works), photos: Number(result.photos) };
  });
}
