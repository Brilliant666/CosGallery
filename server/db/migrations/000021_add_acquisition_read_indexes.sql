-- migrate:up
-- Filter accepted versions before evaluating their complete media snapshots.
CREATE INDEX IF NOT EXISTS idx_archive_fulfillments_source_work_state
  ON archive_catalog_local_fulfillments(source_work_id, work_id, state);
-- A manual decision prevents implicit legacy coverage, including revoked rows.
CREATE INDEX IF NOT EXISTS idx_archive_decisions_local_work
  ON archive_catalog_work_decisions(local_work_id);

-- migrate:down
DROP INDEX IF EXISTS idx_archive_decisions_local_work;
DROP INDEX IF EXISTS idx_archive_fulfillments_source_work_state;
