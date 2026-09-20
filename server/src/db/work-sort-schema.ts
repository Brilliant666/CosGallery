// Shared by fresh test databases and migration 000023 (parity is tested).
export const workSortSchemaSql = `
CREATE TABLE IF NOT EXISTS archive_catalog_work_sort_confirmations (
 decision_key TEXT PRIMARY KEY,
 work_id INTEGER NOT NULL REFERENCES archive_catalog_works(id),
 primary_local_work_id INTEGER NOT NULL,
 primary_post_id INTEGER NOT NULL,
 original_timestamp REAL NOT NULL CHECK(original_timestamp > 0),
 adopted_timestamp REAL NOT NULL CHECK(adopted_timestamp > 0),
 evidence_json TEXT NOT NULL,
 confirmation_source TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'confirmed' CHECK(state IN ('confirmed','revoked')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_sort_confirmed ON archive_catalog_work_sort_confirmations(work_id) WHERE state='confirmed';
CREATE TRIGGER IF NOT EXISTS rc_dirty_work_sort_insert
AFTER INSERT ON archive_catalog_work_sort_confirmations

BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM archive_catalog_works WHERE id IN (NEW.work_id)
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;
CREATE TRIGGER IF NOT EXISTS rc_dirty_work_sort_update
AFTER UPDATE ON archive_catalog_work_sort_confirmations
WHEN OLD.work_id IS NOT NEW.work_id OR OLD.adopted_timestamp IS NOT NEW.adopted_timestamp OR OLD.state IS NOT NEW.state
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM archive_catalog_works WHERE id IN (OLD.work_id,NEW.work_id)
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;
CREATE TRIGGER IF NOT EXISTS rc_dirty_work_sort_delete
AFTER DELETE ON archive_catalog_work_sort_confirmations

BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM archive_catalog_works WHERE id IN (OLD.work_id)
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;
`;
