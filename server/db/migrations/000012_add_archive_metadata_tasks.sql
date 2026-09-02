-- migrate:up
CREATE TABLE archive_catalog_metadata_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  claimed_by TEXT NULL,
  claimed_at TEXT NULL,
  completed_at TEXT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(creator_id, source),
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE,
  CHECK (status IN ('pending', 'claimed', 'completed', 'not_found', 'failed', 'cancelled')),
  CHECK (attempt_count >= 0)
);

CREATE INDEX idx_archive_catalog_metadata_tasks_status
  ON archive_catalog_metadata_tasks(status, source, id);
CREATE INDEX idx_archive_catalog_metadata_tasks_creator
  ON archive_catalog_metadata_tasks(creator_id, source);

-- migrate:down
DROP TABLE archive_catalog_metadata_tasks;
