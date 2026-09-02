-- migrate:up
CREATE TABLE local_ingest_jobs_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_download_task_id INTEGER NULL,
  source_work_id INTEGER NULL,
  creator_id INTEGER NOT NULL,
  source_archive_path TEXT NOT NULL,
  source_archive_name TEXT NOT NULL,
  source_archive_size INTEGER NOT NULL,
  source_archive_mtime REAL NOT NULL,
  source_archive_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'discovered',
  validation_status TEXT NOT NULL DEFAULT 'unknown',
  cleanup_status TEXT NOT NULL DEFAULT 'not_ready',
  processing_path TEXT NULL,
  target_path TEXT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NULL,
  error_detail TEXT NULL,
  summary_json TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT NULL,
  FOREIGN KEY (archive_download_task_id) REFERENCES archive_catalog_download_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (source_work_id) REFERENCES archive_catalog_source_works(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE,
  CHECK (status IN ('queued', 'running', 'awaiting_review', 'reconciling', 'ingested', 'failed')),
  CHECK (phase IN (
    'discovered', 'waiting_stable', 'mapping', 'testing_outer', 'extracting_outer',
    'detecting_inner', 'renaming_inner', 'testing_inner', 'extracting_inner',
    'validating', 'awaiting_commit', 'committing', 'rescanning', 'reconciling',
    'cleanup', 'done'
  )),
  CHECK (validation_status IN ('unknown', 'passed', 'warning', 'failed')),
  CHECK (cleanup_status IN ('not_ready', 'pending', 'recycling', 'recycled', 'failed')),
  CHECK (attempt_count >= 0),
  CHECK (source_archive_size >= 0)
);

INSERT INTO local_ingest_jobs_v2 (
  id, archive_download_task_id, source_work_id, creator_id,
  source_archive_path, source_archive_name, source_archive_size,
  source_archive_mtime, source_archive_sha256, status, phase,
  validation_status, cleanup_status, processing_path, target_path,
  attempt_count, error_code, error_detail, summary_json,
  created_at, updated_at, completed_at
)
SELECT
  id, archive_download_task_id, source_work_id, creator_id,
  source_archive_path, source_archive_name, source_archive_size,
  source_archive_mtime, source_archive_sha256, status, phase,
  validation_status, cleanup_status, processing_path, target_path,
  attempt_count, error_code, error_detail, summary_json,
  created_at, updated_at, completed_at
FROM local_ingest_jobs;

DROP TABLE local_ingest_jobs;
ALTER TABLE local_ingest_jobs_v2 RENAME TO local_ingest_jobs;

CREATE INDEX idx_local_ingest_jobs_status
  ON local_ingest_jobs(status, phase, id);
CREATE INDEX idx_local_ingest_jobs_creator
  ON local_ingest_jobs(creator_id, status, id);
CREATE INDEX idx_local_ingest_jobs_archive_hash
  ON local_ingest_jobs(source_archive_sha256, source_work_id);
CREATE UNIQUE INDEX idx_local_ingest_jobs_source_hash
  ON local_ingest_jobs(source_work_id, source_archive_sha256)
  WHERE source_work_id IS NOT NULL;
CREATE UNIQUE INDEX idx_local_ingest_jobs_unmapped_path_hash
  ON local_ingest_jobs(creator_id, source_archive_path, source_archive_sha256)
  WHERE source_work_id IS NULL;

-- migrate:down
DROP INDEX idx_local_ingest_jobs_unmapped_path_hash;
DROP INDEX idx_local_ingest_jobs_source_hash;

CREATE TABLE local_ingest_jobs_v1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_download_task_id INTEGER NULL,
  source_work_id INTEGER NULL,
  creator_id INTEGER NOT NULL,
  source_archive_path TEXT NOT NULL,
  source_archive_name TEXT NOT NULL,
  source_archive_size INTEGER NOT NULL,
  source_archive_mtime REAL NOT NULL,
  source_archive_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'discovered',
  validation_status TEXT NOT NULL DEFAULT 'unknown',
  cleanup_status TEXT NOT NULL DEFAULT 'not_ready',
  processing_path TEXT NULL,
  target_path TEXT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NULL,
  error_detail TEXT NULL,
  summary_json TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT NULL,
  FOREIGN KEY (archive_download_task_id) REFERENCES archive_catalog_download_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (source_work_id) REFERENCES archive_catalog_source_works(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE,
  CHECK (status IN ('queued', 'running', 'awaiting_review', 'reconciling', 'ingested', 'failed')),
  CHECK (phase IN (
    'discovered', 'waiting_stable', 'mapping', 'testing_outer', 'extracting_outer',
    'detecting_inner', 'renaming_inner', 'testing_inner', 'extracting_inner',
    'validating', 'awaiting_commit', 'committing', 'rescanning', 'reconciling',
    'cleanup', 'done'
  )),
  CHECK (validation_status IN ('unknown', 'passed', 'warning', 'failed')),
  CHECK (cleanup_status IN ('not_ready', 'pending', 'recycling', 'recycled', 'failed')),
  CHECK (attempt_count >= 0),
  CHECK (source_archive_size >= 0)
);

-- The pre-000014 creator/hash uniqueness cannot represent two legitimate source
-- works which happen to contain the same archive bytes.  A rollback therefore
-- retains the source-aware uniqueness rules instead of deleting either row or
-- failing after destructive DDL has started.
INSERT INTO local_ingest_jobs_v1 (
  id, archive_download_task_id, source_work_id, creator_id,
  source_archive_path, source_archive_name, source_archive_size,
  source_archive_mtime, source_archive_sha256, status, phase,
  validation_status, cleanup_status, processing_path, target_path,
  attempt_count, error_code, error_detail, summary_json,
  created_at, updated_at, completed_at
)
SELECT
  id, archive_download_task_id, source_work_id, creator_id,
  source_archive_path, source_archive_name, source_archive_size,
  source_archive_mtime, source_archive_sha256, status, phase,
  validation_status, cleanup_status, processing_path, target_path,
  attempt_count, error_code, error_detail, summary_json,
  created_at, updated_at, completed_at
FROM local_ingest_jobs;
DROP TABLE local_ingest_jobs;
ALTER TABLE local_ingest_jobs_v1 RENAME TO local_ingest_jobs;

CREATE INDEX idx_local_ingest_jobs_status
  ON local_ingest_jobs(status, phase, id);
CREATE INDEX idx_local_ingest_jobs_creator
  ON local_ingest_jobs(creator_id, status, id);
CREATE INDEX idx_local_ingest_jobs_archive_hash
  ON local_ingest_jobs(source_archive_sha256, source_work_id);
CREATE UNIQUE INDEX idx_local_ingest_jobs_source_hash
  ON local_ingest_jobs(source_work_id, source_archive_sha256)
  WHERE source_work_id IS NOT NULL;
CREATE UNIQUE INDEX idx_local_ingest_jobs_unmapped_path_hash
  ON local_ingest_jobs(creator_id, source_archive_path, source_archive_sha256)
  WHERE source_work_id IS NULL;
