-- migrate:up

CREATE TABLE IF NOT EXISTS removal_operations (
 operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id INTEGER NOT NULL,
 mode TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS work_removals (
 work_id INTEGER PRIMARY KEY REFERENCES archive_catalog_works(id),
 state TEXT NOT NULL CHECK(state IN ('trashed','deleted')),
 operation_id TEXT NOT NULL REFERENCES removal_operations(operation_id),
 snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_removal_paths (
 work_id INTEGER NOT NULL REFERENCES archive_catalog_works(id),
 local_work_id INTEGER NOT NULL REFERENCES archive_catalog_local_works(id),
 absolute_path TEXT NOT NULL, relative_path TEXT NOT NULL,
 PRIMARY KEY(work_id,local_work_id)
);
CREATE TABLE IF NOT EXISTS media_trash_entries (
 image_id INTEGER PRIMARY KEY REFERENCES images(id),
 post_id INTEGER NOT NULL REFERENCES posts(id),
 original_position INTEGER NOT NULL, original_post_type TEXT NOT NULL,
 original_order_json TEXT NOT NULL DEFAULT '[]',
 original_file_identity TEXT,
 previous_image_id INTEGER, next_image_id INTEGER,
 trashed_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 restored_at TEXT
);
CREATE TABLE IF NOT EXISTS media_fulfillment_adjustments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 fulfillment_id INTEGER NOT NULL REFERENCES archive_catalog_local_fulfillments(id),
 before_snapshot_json TEXT NOT NULL, after_snapshot_json TEXT NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_media_fulfillment_adjustments_latest ON media_fulfillment_adjustments(fulfillment_id,id DESC);
CREATE TRIGGER IF NOT EXISTS work_removal_dirty_insert AFTER INSERT ON work_removals BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM archive_catalog_works WHERE id=NEW.work_id
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER IF NOT EXISTS work_removal_dirty_delete AFTER DELETE ON work_removals BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM archive_catalog_works WHERE id=OLD.work_id
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER IF NOT EXISTS work_removal_prevent_local_insert BEFORE INSERT ON archive_catalog_local_works
WHEN EXISTS(SELECT 1 FROM work_removals WHERE work_id=NEW.work_id)
BEGIN SELECT RAISE(ABORT,'Removed Work cannot acquire local copies'); END;
CREATE TRIGGER IF NOT EXISTS work_removal_preserve_local BEFORE UPDATE OF work_id,is_active,post_id ON archive_catalog_local_works
WHEN EXISTS(SELECT 1 FROM work_removals WHERE work_id=OLD.work_id)
 AND (NEW.work_id IS NOT OLD.work_id OR NEW.is_active<>0 OR (NEW.post_id IS NOT NULL AND NEW.post_id IS NOT OLD.post_id))
BEGIN SELECT RAISE(ABORT,'Removed Work cannot be reactivated'); END;

-- migrate:down
-- Removal history and user decisions are intentionally not discarded on downgrade.
