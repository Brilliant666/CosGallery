-- migrate:up
CREATE TABLE archive_catalog_download_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_work_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  target_root TEXT NOT NULL,
  target_relative_directory TEXT NOT NULL,
  target_filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  claimed_by TEXT NULL,
  claimed_at TEXT NULL,
  started_at TEXT NULL,
  completed_at TEXT NULL,
  download_id TEXT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_work_id, provider),
  FOREIGN KEY (source_work_id) REFERENCES archive_catalog_source_works(id) ON DELETE CASCADE,
  CHECK (status IN ('pending', 'claimed', 'downloading', 'downloaded', 'ingested', 'failed', 'cancelled')),
  CHECK (attempt_count >= 0)
);

CREATE INDEX idx_archive_catalog_download_tasks_status
  ON archive_catalog_download_tasks(status, provider, id);
CREATE INDEX idx_archive_catalog_download_tasks_source_work
  ON archive_catalog_download_tasks(source_work_id, provider);

-- migrate:down
DROP TABLE archive_catalog_download_tasks;
