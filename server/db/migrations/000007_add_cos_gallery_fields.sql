-- migrate:up
ALTER TABLE posts ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'R15'
  CHECK (content_rating IN ('R15', 'R18'));

CREATE TABLE new_post_items (
  post_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  PRIMARY KEY (post_id, position),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
  CHECK (position >= 1)
);

INSERT INTO new_post_items (post_id, image_id, position)
SELECT post_id, image_id, position FROM post_items;

DROP TABLE post_items;
ALTER TABLE new_post_items RENAME TO post_items;

CREATE UNIQUE INDEX idx_post_items_image_id ON post_items(image_id);
CREATE INDEX idx_post_items_post_id ON post_items(post_id, position);
CREATE INDEX idx_posts_content_rating_visible_sort
  ON posts(content_rating, is_deleted, is_trashed, sort_timestamp DESC, id DESC);

-- migrate:down
DROP INDEX IF EXISTS idx_posts_content_rating_visible_sort;
ALTER TABLE posts DROP COLUMN content_rating;
