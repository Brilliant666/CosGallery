import type { DatabaseSync } from 'node:sqlite';
import { LocalCreatorFolderBridgeService } from '../services/local-creator-folder-bridge-service.js';

const KEY = 'managed_creators.migration_000016';

/** The migrate/startup command completes SQL 000016 with OS-aware path logic.
 * No filesystem access, media scan, task planner, or external import occurs here.
 * A persisted one-time marker prevents legacy values overriding later edits.
 */
export function completeManagedCreatorMigration(database: DatabaseSync, galleryRoot: string) {
  if (!(database.prepare("PRAGMA table_info(archive_catalog_creators)").all() as Array<{name:string}>).some(column => column.name === 'is_active')) return null;
  const existing = database.prepare('SELECT value FROM app_settings WHERE key=?').get(KEY) as {value:string}|undefined;
  if (existing && JSON.parse(existing.value).completed === true) return JSON.parse(existing.value);
  const bridges = new LocalCreatorFolderBridgeService(database).backfill(galleryRoot);
  const manual = database.prepare(`SELECT legacy.folder_id, legacy.rating, local.creator_id
    FROM creator_rating_sources legacy
    LEFT JOIN archive_catalog_local_creator_folders local ON local.gallery_folder_id=legacy.folder_id AND local.is_active=1 AND local.match_status='matched'
    WHERE legacy.is_manual=1`).all() as Array<{folder_id:number;rating:string;creator_id:number|null}>;
  const ratings = new Map<number,Set<string>>();
  for (const row of manual) if (row.creator_id !== null) {
    const values=ratings.get(row.creator_id)??new Set<string>(); values.add(row.rating); ratings.set(row.creator_id,values);
  }
  const conflicts=[...ratings].filter(([,values])=>values.size>1).map(([creatorId])=>creatorId);
  const unresolved=manual.filter(row=>row.creator_id===null).map(row=>row.folder_id);
  const invalidSeedMetadata = (database.prepare(`SELECT source_creator_id FROM archive_catalog_creator_sources WHERE source='hentaiclub'
    AND metadata_json IS NOT NULL AND CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json)<>'object' ELSE 1 END`).all());
  const completed = conflicts.length === 0 && invalidSeedMetadata.length === 0;
  const report={completed,bridges,manualRows:manual.length,promotedCreators:completed ? ratings.size : 0,conflicts,unresolved,invalidSeedMetadata};
  database.exec('SAVEPOINT managed_creator_migration');
  try {
    if (report.completed) for(const [creatorId,values] of ratings) {
      const rating=[...values][0];
      database.prepare('UPDATE archive_catalog_creators SET effective_rating=? WHERE id=? AND effective_rating IS NOT ?').run(rating,creatorId,rating);
    }
    database.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY,JSON.stringify(report));
    database.exec('RELEASE managed_creator_migration');
  } catch(error) {database.exec('ROLLBACK TO managed_creator_migration; RELEASE managed_creator_migration');throw error;}
  if (!report.completed) throw new Error(`MANAGED_CREATOR_MIGRATION_CONFLICT: ${JSON.stringify(report)}`);
  return report;
}
