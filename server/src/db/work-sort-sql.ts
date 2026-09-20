// These helpers are for work projections only. Never apply them to member
// ordering, media fingerprints, ingestion evidence or fulfillment snapshots.
export function effectiveWorkSortSql(workId: string, fallback: string): string {
  return `COALESCE((SELECT adopted_timestamp FROM archive_catalog_work_sort_confirmations
    WHERE work_id=${workId} AND state='confirmed'),${fallback})`;
}

export function effectivePostSortSql(post = 'posts'): string {
  // Include the existing legacy LocalWork -> Post source-path resolution.
  // Ambiguous ownership must not turn a display correction into identity repair.
  return `COALESCE((SELECT MIN(c.adopted_timestamp)
    FROM archive_catalog_work_sort_confirmations c
    JOIN archive_catalog_works w ON w.id=c.work_id
    JOIN archive_catalog_local_works l ON l.work_id=w.id
    JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id
    WHERE c.state='confirmed' AND f.creator_id=w.creator_id
      AND f.match_status='matched' AND l.match_status='matched'
      AND f.gallery_folder_id=${post}.folder_id
      AND (l.post_id=${post}.id OR (l.post_id IS NULL AND
        ${post}.source_path=rtrim(replace(f.relative_path,char(92),'/'),'/') || '/' || ltrim(replace(l.relative_path,char(92),'/'),'/')))
      AND NOT EXISTS (
        SELECT 1 FROM archive_catalog_local_works other
        JOIN archive_catalog_local_creator_folders owner ON owner.id=other.local_creator_folder_id
        WHERE other.work_id IS NOT NULL AND other.work_id<>w.id
          AND owner.gallery_folder_id=${post}.folder_id
          AND (other.post_id=${post}.id OR (other.post_id IS NULL AND
            ${post}.source_path=rtrim(replace(owner.relative_path,char(92),'/'),'/') || '/' || ltrim(replace(other.relative_path,char(92),'/'),'/')))
      )
    HAVING COUNT(DISTINCT w.id)=1),${post}.sort_timestamp)`;
}
