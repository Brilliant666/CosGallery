-- migrate:up
CREATE TABLE archive_catalog_creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  preference TEXT NULL,
  effective_rating TEXT NULL,
  seed_source TEXT NOT NULL,
  seed_source_creator_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(seed_source, seed_source_creator_id),
  CHECK (preference IS NULL OR preference IN ('liked', 'kept')),
  CHECK (effective_rating IS NULL OR effective_rating IN ('R15', 'R18'))
);

CREATE TABLE archive_catalog_creator_aliases (
  creator_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (creator_id, source, normalized_alias),
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE
);

CREATE TABLE archive_catalog_creator_sources (
  creator_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_creator_id TEXT NOT NULL,
  source_display_name TEXT NOT NULL,
  source_url TEXT NULL,
  metadata_json TEXT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source, source_creator_id),
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE
);

CREATE TABLE archive_catalog_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_collection_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT NULL,
  declared_work_count INTEGER NULL,
  raw_directory_text TEXT NULL,
  metadata_json TEXT NULL,
  observed_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_collection_id),
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE,
  CHECK (is_active IN (0, 1))
);

CREATE TABLE archive_catalog_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  delivery_type TEXT NOT NULL,
  status TEXT NULL,
  source_folder_name TEXT NULL,
  destination_path TEXT NULL,
  transferred_at TEXT NULL,
  metadata_json TEXT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(collection_id, provider, delivery_key),
  FOREIGN KEY (collection_id) REFERENCES archive_catalog_collections(id) ON DELETE CASCADE
);

CREATE TABLE archive_catalog_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  display_title TEXT NOT NULL,
  content_rating TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE,
  CHECK (content_rating IS NULL OR content_rating IN ('R15', 'R18'))
);

CREATE TABLE archive_catalog_source_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_work_id TEXT NOT NULL,
  source_order INTEGER NULL,
  source_order_label TEXT NULL,
  source_title TEXT NOT NULL,
  raw_title TEXT NULL,
  media_summary TEXT NULL,
  metadata_json TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(collection_id, source_work_id),
  FOREIGN KEY (work_id) REFERENCES archive_catalog_works(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES archive_catalog_collections(id) ON DELETE CASCADE,
  CHECK (source_order IS NULL OR source_order >= 0),
  CHECK (is_active IN (0, 1))
);

CREATE TABLE archive_catalog_local_creator_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NULL,
  root_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  match_status TEXT NOT NULL,
  match_method TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  scanned_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(root_path, relative_path),
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE SET NULL,
  CHECK (match_status IN ('matched', 'unmatched', 'ambiguous')),
  CHECK (is_active IN (0, 1))
);

CREATE TABLE archive_catalog_local_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_creator_folder_id INTEGER NOT NULL,
  work_id INTEGER NULL,
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  parsed_source_order INTEGER NULL,
  image_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  advertisement_file_count INTEGER NOT NULL DEFAULT 0,
  other_file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  match_status TEXT NOT NULL,
  match_method TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  scanned_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(local_creator_folder_id, relative_path),
  FOREIGN KEY (local_creator_folder_id) REFERENCES archive_catalog_local_creator_folders(id) ON DELETE CASCADE,
  FOREIGN KEY (work_id) REFERENCES archive_catalog_works(id) ON DELETE SET NULL,
  CHECK (parsed_source_order IS NULL OR parsed_source_order >= 0),
  CHECK (match_status IN ('matched', 'unmatched', 'ambiguous')),
  CHECK (is_active IN (0, 1))
);

CREATE TABLE archive_catalog_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_format TEXT NOT NULL,
  source_version TEXT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  stats_json TEXT NOT NULL
);

CREATE INDEX idx_archive_catalog_creators_normalized_name
  ON archive_catalog_creators(normalized_name);
CREATE INDEX idx_archive_catalog_aliases_normalized
  ON archive_catalog_creator_aliases(normalized_alias, creator_id);
CREATE INDEX idx_archive_catalog_sources_creator
  ON archive_catalog_creator_sources(creator_id, source);
CREATE INDEX idx_archive_catalog_collections_creator
  ON archive_catalog_collections(creator_id, source, is_active);
CREATE INDEX idx_archive_catalog_deliveries_collection
  ON archive_catalog_deliveries(collection_id, provider);
CREATE INDEX idx_archive_catalog_works_creator
  ON archive_catalog_works(creator_id);
CREATE INDEX idx_archive_catalog_source_works_order
  ON archive_catalog_source_works(collection_id, is_active, source_order);
CREATE INDEX idx_archive_catalog_source_works_creator
  ON archive_catalog_source_works(work_id, is_active);
CREATE INDEX idx_archive_catalog_local_folders_creator
  ON archive_catalog_local_creator_folders(creator_id, is_active);
CREATE INDEX idx_archive_catalog_local_works_work
  ON archive_catalog_local_works(work_id, is_active);
CREATE INDEX idx_archive_catalog_local_works_folder
  ON archive_catalog_local_works(local_creator_folder_id, is_active);
CREATE INDEX idx_archive_catalog_import_runs_source
  ON archive_catalog_import_runs(source, imported_at DESC);

-- migrate:down
DROP TABLE archive_catalog_import_runs;
DROP TABLE archive_catalog_local_works;
DROP TABLE archive_catalog_local_creator_folders;
DROP TABLE archive_catalog_source_works;
DROP TABLE archive_catalog_works;
DROP TABLE archive_catalog_deliveries;
DROP TABLE archive_catalog_collections;
DROP TABLE archive_catalog_creator_sources;
DROP TABLE archive_catalog_creator_aliases;
DROP TABLE archive_catalog_creators;
