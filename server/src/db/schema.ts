export const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'normal',
  story_owner_folder_id INTEGER NULL,
  carousel_owner_folder_id INTEGER NULL,
  description TEXT NULL,
  avatar_image_id INTEGER NULL,
  avatar_source TEXT NOT NULL DEFAULT 'auto',
  share_password_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (avatar_image_id) REFERENCES images(id),
  FOREIGN KEY (story_owner_folder_id) REFERENCES folders(id) ON DELETE SET NULL,
  FOREIGN KEY (carousel_owner_folder_id) REFERENCES folders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL,
  place_id INTEGER NULL,
  asset_key TEXT NULL,
  filename TEXT NOT NULL,
  extension TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  absolute_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  display_orientation INTEGER NULL,
  media_type TEXT NOT NULL DEFAULT 'image',
  mime_type TEXT NOT NULL,
  duration_ms REAL NULL,
  is_animated INTEGER NULL,
  checksum_or_fingerprint TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  first_seen_at TEXT NOT NULL,
  sort_timestamp INTEGER NOT NULL,
  taken_at INTEGER NULL,
  taken_at_source TEXT NULL,
  caption TEXT NULL,
  exif_json TEXT NULL,
  thumbnail_path TEXT NOT NULL,
  preview_path TEXT NOT NULL,
  playback_strategy TEXT NOT NULL DEFAULT 'preview',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NULL,
  is_trashed INTEGER NOT NULL DEFAULT 0,
  trashed_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL,
  place_id INTEGER NULL,
  source_path TEXT NOT NULL UNIQUE,
  post_type TEXT NOT NULL DEFAULT 'single',
  content_rating TEXT NOT NULL DEFAULT 'R15',
  caption TEXT NULL,
  sort_timestamp INTEGER NOT NULL,
  taken_at INTEGER NULL,
  taken_at_source TEXT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NULL,
  is_trashed INTEGER NOT NULL DEFAULT 0,
  trashed_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE SET NULL,
  CHECK (post_type IN ('single', 'carousel')),
  CHECK (content_rating IN ('R15', 'R18'))
);

CREATE TABLE IF NOT EXISTS post_items (
  post_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  PRIMARY KEY (post_id, position),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
  CHECK (position >= 1)
);

CREATE TABLE IF NOT EXISTS creator_rating_sources (
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

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  source_confidence REAL NULL,
  provider TEXT NULL,
  provider_place_id TEXT NULL,
  latitude REAL NULL,
  longitude REAL NULL,
  city_name TEXT NULL,
  admin1_name TEXT NULL,
  country_name TEXT NULL,
  country_code TEXT NULL,
  geonames_id INTEGER NULL,
  is_approximate INTEGER NOT NULL DEFAULT 1,
  name_override TEXT NULL,
  description TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT NULL,
  status TEXT NOT NULL,
  scanned_files INTEGER NOT NULL DEFAULT 0,
  new_files INTEGER NOT NULL DEFAULT 0,
  updated_files INTEGER NOT NULL DEFAULT 0,
  removed_files INTEGER NOT NULL DEFAULT 0,
  error_text TEXT NULL,
  warning_count INTEGER NOT NULL DEFAULT 0,
  warning_text TEXT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_scan_state (
  folder_path TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  max_mtime_ms REAL NOT NULL,
  total_size INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (collection_id, post_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS folder_share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NULL,
  expires_at TEXT NULL,
  revoked_at TEXT NULL,
  allow_original_downloads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT NULL,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS folder_share_passwords (
  folder_id INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS archive_catalog_creators (
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

CREATE TABLE IF NOT EXISTS archive_catalog_creator_aliases (
  creator_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (creator_id, source, normalized_alias),
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS archive_catalog_creator_sources (
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

CREATE TABLE IF NOT EXISTS archive_catalog_collections (
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

CREATE TABLE IF NOT EXISTS archive_catalog_deliveries (
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

CREATE TABLE IF NOT EXISTS archive_catalog_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  display_title TEXT NOT NULL,
  content_rating TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES archive_catalog_creators(id) ON DELETE CASCADE,
  CHECK (content_rating IS NULL OR content_rating IN ('R15', 'R18'))
);

CREATE TABLE IF NOT EXISTS archive_catalog_source_works (
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

CREATE TABLE IF NOT EXISTS archive_catalog_local_creator_folders (
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

CREATE TABLE IF NOT EXISTS archive_catalog_local_works (
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

CREATE TABLE IF NOT EXISTS archive_catalog_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_format TEXT NOT NULL,
  source_version TEXT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  stats_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_catalog_download_tasks (
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

CREATE INDEX IF NOT EXISTS idx_folders_slug ON folders(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_folder_path ON folders(folder_path);
CREATE INDEX IF NOT EXISTS idx_folders_role ON folders(role);
CREATE INDEX IF NOT EXISTS idx_folders_story_owner_role ON folders(story_owner_folder_id, role, folder_path COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_folders_carousel_owner ON folders(carousel_owner_folder_id);

CREATE INDEX IF NOT EXISTS idx_images_folder_id ON images(folder_id);
CREATE INDEX IF NOT EXISTS idx_images_place_id ON images(place_id);
CREATE INDEX IF NOT EXISTS idx_images_sort_timestamp ON images(sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_images_taken_at ON images(taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_taken_at_source ON images(is_deleted, taken_at_source);
CREATE INDEX IF NOT EXISTS idx_images_folder_sort ON images(folder_id, is_deleted, sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_images_folder_media_sort ON images(folder_id, media_type, is_deleted, sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_images_is_deleted ON images(is_deleted);
CREATE INDEX IF NOT EXISTS idx_images_media_type ON images(media_type, is_deleted, sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_images_visibility_flags ON images(is_deleted, is_trashed);
CREATE INDEX IF NOT EXISTS idx_images_taken_at_source_visibility ON images(is_deleted, is_trashed, taken_at_source);
CREATE INDEX IF NOT EXISTS idx_images_folder_visible_sort ON images(folder_id, is_deleted, is_trashed, sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_images_folder_media_visible_sort ON images(folder_id, media_type, is_deleted, is_trashed, sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_images_media_visible_sort ON images(media_type, is_deleted, is_trashed, sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_images_trashed_listing ON images(is_trashed, is_deleted, trashed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_relative_path ON images(relative_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_asset_key ON images(asset_key) WHERE asset_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_images_deleted_at ON images(deleted_at);

CREATE INDEX IF NOT EXISTS idx_posts_folder_visible_sort ON posts(folder_id, is_deleted, is_trashed, sort_timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_visible_sort ON posts(is_deleted, is_trashed, sort_timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_type_visibility ON posts(post_type, is_deleted, is_trashed);
CREATE INDEX IF NOT EXISTS idx_posts_place_visibility ON posts(place_id, is_deleted, is_trashed, sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_posts_source_path ON posts(source_path);
CREATE INDEX IF NOT EXISTS idx_posts_trashed_listing ON posts(is_trashed, is_deleted, trashed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_content_rating_visible_sort ON posts(content_rating, is_deleted, is_trashed, sort_timestamp DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_items_image_id ON post_items(image_id);
CREATE INDEX IF NOT EXISTS idx_post_items_post_id ON post_items(post_id, position);
CREATE INDEX IF NOT EXISTS idx_creator_rating_sources_folder ON creator_rating_sources(folder_id, is_manual, rating);
CREATE INDEX IF NOT EXISTS idx_creator_rating_sources_source ON creator_rating_sources(source, source_creator_id);

CREATE INDEX IF NOT EXISTS idx_places_slug ON places(slug);
CREATE INDEX IF NOT EXISTS idx_places_display_name ON places(display_name);
CREATE INDEX IF NOT EXISTS idx_places_geonames_id ON places(geonames_id);
CREATE INDEX IF NOT EXISTS idx_folder_scan_state_updated_at ON folder_scan_state(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_likes_created_at ON likes(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_single_default ON collections(is_default) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_collections_updated_at ON collections(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_items_post ON collection_items(post_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_created ON collection_items(collection_id, created_at DESC, post_id DESC);
CREATE INDEX IF NOT EXISTS idx_folder_share_links_folder_id ON folder_share_links(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_share_links_expires_at ON folder_share_links(expires_at);

CREATE INDEX IF NOT EXISTS idx_archive_catalog_creators_normalized_name ON archive_catalog_creators(normalized_name);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_aliases_normalized ON archive_catalog_creator_aliases(normalized_alias, creator_id);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_sources_creator ON archive_catalog_creator_sources(creator_id, source);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_collections_creator ON archive_catalog_collections(creator_id, source, is_active);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_deliveries_collection ON archive_catalog_deliveries(collection_id, provider);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_works_creator ON archive_catalog_works(creator_id);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_source_works_order ON archive_catalog_source_works(collection_id, is_active, source_order);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_source_works_creator ON archive_catalog_source_works(work_id, is_active);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_local_folders_creator ON archive_catalog_local_creator_folders(creator_id, is_active);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_local_works_work ON archive_catalog_local_works(work_id, is_active);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_local_works_folder ON archive_catalog_local_works(local_creator_folder_id, is_active);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_import_runs_source ON archive_catalog_import_runs(source, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_download_tasks_status ON archive_catalog_download_tasks(status, provider, id);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_download_tasks_source_work ON archive_catalog_download_tasks(source_work_id, provider);

`;
