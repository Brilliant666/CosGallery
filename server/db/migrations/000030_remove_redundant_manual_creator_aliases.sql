-- migrate:up
-- Dbmate runs this migration in one transaction. Existing databases are
-- protected by runStartupMigrations' pre-migration application recovery point.
-- Only redundant user-maintained aliases are removed. Source evidence and
-- history, including identically spelled aliases from other sources, remain.
DELETE FROM archive_catalog_creator_aliases
WHERE source COLLATE BINARY = 'manual'
  AND EXISTS (
    SELECT 1 FROM archive_catalog_creators creator
    WHERE creator.id = archive_catalog_creator_aliases.creator_id
      AND archive_catalog_creator_aliases.alias COLLATE BINARY = creator.canonical_name COLLATE BINARY
  );

-- migrate:down
-- Removed rows cannot be reconstructed faithfully from current creator names:
-- their original normalization and timestamps are part of the original facts.
-- Restore the pre-migration application recovery point with compatible code.
-- Deliberately fail rather than mark a data downgrade as successfully undone.
SELECT manual_alias_cleanup_downgrade_requires_pre_migration_recovery_point();
