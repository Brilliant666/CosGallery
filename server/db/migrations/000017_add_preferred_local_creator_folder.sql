-- migrate:up
ALTER TABLE archive_catalog_creators
  ADD COLUMN preferred_local_creator_folder_id INTEGER NULL
  REFERENCES archive_catalog_local_creator_folders(id) ON DELETE RESTRICT;

CREATE INDEX idx_archive_catalog_creators_preferred_local_folder
  ON archive_catalog_creators(preferred_local_creator_folder_id);

-- migrate:down
DROP INDEX idx_archive_catalog_creators_preferred_local_folder;
ALTER TABLE archive_catalog_creators DROP COLUMN preferred_local_creator_folder_id;
