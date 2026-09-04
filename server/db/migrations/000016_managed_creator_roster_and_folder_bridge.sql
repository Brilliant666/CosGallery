-- migrate:up
ALTER TABLE archive_catalog_creators
  ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
ALTER TABLE archive_catalog_creators ADD COLUMN deactivated_at TEXT NULL;
CREATE INDEX idx_managed_creators_active ON archive_catalog_creators(is_active);
CREATE INDEX idx_managed_creators_preference ON archive_catalog_creators(preference);
CREATE INDEX idx_managed_creators_rating ON archive_catalog_creators(effective_rating);

ALTER TABLE archive_catalog_local_creator_folders
  ADD COLUMN gallery_folder_id INTEGER NULL REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX idx_catalog_folder_gallery ON archive_catalog_local_creator_folders(gallery_folder_id);
CREATE UNIQUE INDEX idx_catalog_folder_gallery_active
  ON archive_catalog_local_creator_folders(gallery_folder_id)
  WHERE is_active = 1 AND gallery_folder_id IS NOT NULL;

-- Preserve every existing metadata field, including explicitly present nulls.
-- Read only the already-persisted canonical values: no external seed file.
UPDATE archive_catalog_creator_sources
SET metadata_json = json_insert(COALESCE(metadata_json, '{}'),
  '$.initialPreference', (SELECT preference FROM archive_catalog_creators WHERE id = creator_id),
  '$.initialRating', (SELECT effective_rating FROM archive_catalog_creators WHERE id = creator_id),
  '$.retiredAsAuthorityAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  '$.authorityStatus', 'historical-seed')
WHERE source = 'hentaiclub'
  AND (metadata_json IS NULL OR CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json) = 'object' ELSE 0 END);

-- Full-path resolution / legacy manual conflict reporting are the deterministic
-- post-migration phase of the existing migrate/startup command, not a scan.

-- migrate:down
DELETE FROM app_settings WHERE key = 'managed_creators.migration_000016';
DROP INDEX idx_catalog_folder_gallery_active;
DROP INDEX idx_catalog_folder_gallery;
ALTER TABLE archive_catalog_local_creator_folders DROP COLUMN gallery_folder_id;
DROP INDEX idx_managed_creators_rating;
DROP INDEX idx_managed_creators_preference;
DROP INDEX idx_managed_creators_active;
ALTER TABLE archive_catalog_creators DROP COLUMN deactivated_at;
ALTER TABLE archive_catalog_creators DROP COLUMN is_active;
-- Historical source snapshots intentionally survive down/up; never discard them.
