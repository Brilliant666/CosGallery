-- migrate:up
CREATE INDEX IF NOT EXISTS idx_images_thumbnail_path ON images(thumbnail_path);
CREATE INDEX IF NOT EXISTS idx_images_preview_path ON images(preview_path);

-- migrate:down
DROP INDEX IF EXISTS idx_images_preview_path;
DROP INDEX IF EXISTS idx_images_thumbnail_path;
