-- migrate:up
-- These exact read keys are already backed by UNIQUE or PRIMARY KEY constraints.
-- Keep every constraint and all prefix/partial/expression indexes.
DROP INDEX IF EXISTS idx_images_relative_path;
DROP INDEX IF EXISTS idx_post_items_post_id;
DROP INDEX IF EXISTS idx_post_items_image_id;
DROP INDEX IF EXISTS idx_posts_source_path;
DROP INDEX IF EXISTS idx_folders_slug;
DROP INDEX IF EXISTS idx_places_slug;
DROP INDEX IF EXISTS idx_archive_catalog_download_tasks_source_work;
DROP INDEX IF EXISTS idx_archive_catalog_metadata_tasks_creator;

-- migrate:down
CREATE INDEX IF NOT EXISTS idx_images_relative_path ON images(relative_path);
CREATE INDEX IF NOT EXISTS idx_post_items_post_id ON post_items(post_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_post_items_image_id ON post_items(image_id);
CREATE INDEX IF NOT EXISTS idx_posts_source_path ON posts(source_path);
CREATE INDEX IF NOT EXISTS idx_folders_slug ON folders(slug);
CREATE INDEX IF NOT EXISTS idx_places_slug ON places(slug);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_download_tasks_source_work ON archive_catalog_download_tasks(source_work_id, provider);
CREATE INDEX IF NOT EXISTS idx_archive_catalog_metadata_tasks_creator ON archive_catalog_metadata_tasks(creator_id, source);
