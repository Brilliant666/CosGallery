-- migrate:up
CREATE INDEX IF NOT EXISTS idx_images_move_signature
  ON images(file_size, ROUND(mtime_ms), LOWER(extension), id)
  WHERE is_deleted = 0 AND is_trashed = 0;

-- migrate:down
DROP INDEX IF EXISTS idx_images_move_signature;
