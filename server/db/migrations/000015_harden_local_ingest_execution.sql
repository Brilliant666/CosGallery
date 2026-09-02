-- migrate:up
ALTER TABLE local_ingest_jobs ADD COLUMN claim_token TEXT NULL;
ALTER TABLE local_ingest_jobs ADD COLUMN claimed_at TEXT NULL;
ALTER TABLE local_ingest_jobs ADD COLUMN claim_heartbeat_at TEXT NULL;

CREATE INDEX idx_local_ingest_jobs_claim
  ON local_ingest_jobs(claim_token, claim_heartbeat_at, id);

CREATE TABLE local_ingest_file_observations (
  source_archive_path TEXT PRIMARY KEY COLLATE NOCASE,
  creator_id INTEGER NOT NULL,
  source_archive_name TEXT NOT NULL,
  observed_size INTEGER NOT NULL,
  observed_mtime REAL NOT NULL,
  stable_since TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE,
  CHECK (observed_size >= 0)
);

CREATE INDEX idx_local_ingest_file_observations_creator
  ON local_ingest_file_observations(creator_id, last_observed_at);

-- migrate:down
DROP INDEX idx_local_ingest_file_observations_creator;
DROP TABLE local_ingest_file_observations;
DROP INDEX idx_local_ingest_jobs_claim;
ALTER TABLE local_ingest_jobs DROP COLUMN claim_heartbeat_at;
ALTER TABLE local_ingest_jobs DROP COLUMN claimed_at;
ALTER TABLE local_ingest_jobs DROP COLUMN claim_token;
