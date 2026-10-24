-- migrate:up
-- Optional, administrator-maintained discovery labels. No automatic classification.
ALTER TABLE archive_catalog_creators ADD COLUMN gallery_labels_revision INTEGER NOT NULL DEFAULT 0
  CHECK (gallery_labels_revision >= 0);
CREATE TABLE archive_catalog_creator_gallery_labels (
  creator_id INTEGER NOT NULL REFERENCES archive_catalog_creators(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (label IN ('cosplay', 'portrait', 'selfie', 'fuliji')),
  PRIMARY KEY (creator_id, label)
);

-- migrate:down
DROP TABLE archive_catalog_creator_gallery_labels;
ALTER TABLE archive_catalog_creators DROP COLUMN gallery_labels_revision;
