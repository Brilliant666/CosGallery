-- migrate:up
ALTER TABLE archive_catalog_download_tasks RENAME TO archive_catalog_download_tasks_old;

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
  CHECK (status IN ('pending', 'claimed', 'staged', 'downloading', 'downloaded', 'ingested', 'failed', 'cancelled')),
  CHECK (attempt_count >= 0)
);

INSERT INTO archive_catalog_download_tasks (
  id, source_work_id, provider, target_root, target_relative_directory,
  target_filename, status, claimed_by, claimed_at, started_at, completed_at,
  download_id, attempt_count, last_error, created_at, updated_at
)
SELECT id, source_work_id, provider, target_root, target_relative_directory,
       target_filename, status, claimed_by, claimed_at, started_at, completed_at,
       download_id, attempt_count, last_error, created_at, updated_at
FROM archive_catalog_download_tasks_old;

DROP TABLE archive_catalog_download_tasks_old;

CREATE INDEX idx_archive_catalog_download_tasks_status
  ON archive_catalog_download_tasks(status, provider, id);
CREATE INDEX idx_archive_catalog_download_tasks_source_work
  ON archive_catalog_download_tasks(source_work_id, provider);

-- migrate:down
UPDATE archive_catalog_download_tasks SET status = 'pending' WHERE status = 'staged';

ALTER TABLE archive_catalog_download_tasks RENAME TO archive_catalog_download_tasks_new;

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

INSERT INTO archive_catalog_download_tasks (
  id, source_work_id, provider, target_root, target_relative_directory,
  target_filename, status, claimed_by, claimed_at, started_at, completed_at,
  download_id, attempt_count, last_error, created_at, updated_at
)
SELECT id, source_work_id, provider, target_root, target_relative_directory,
       target_filename, status, claimed_by, claimed_at, started_at, completed_at,
       download_id, attempt_count, last_error, created_at, updated_at
FROM archive_catalog_download_tasks_new;

DROP TABLE archive_catalog_download_tasks_new;

CREATE INDEX idx_archive_catalog_download_tasks_status
  ON archive_catalog_download_tasks(status, provider, id);
CREATE INDEX idx_archive_catalog_download_tasks_source_work
  ON archive_catalog_download_tasks(source_work_id, provider);
