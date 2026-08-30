-- migrate:up
CREATE TABLE creator_rating_sources (
  folder_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_creator_id TEXT NOT NULL,
  source_display_name TEXT NOT NULL,
  rating TEXT NOT NULL,
  is_manual INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NULL,
  metadata_json TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (folder_id, source, source_creator_id),
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  CHECK (rating IN ('R15', 'R18')),
  CHECK (is_manual IN (0, 1))
);

CREATE INDEX idx_creator_rating_sources_folder
  ON creator_rating_sources(folder_id, is_manual, rating);
CREATE INDEX idx_creator_rating_sources_source
  ON creator_rating_sources(source, source_creator_id);

-- migrate:down
DROP TABLE creator_rating_sources;
