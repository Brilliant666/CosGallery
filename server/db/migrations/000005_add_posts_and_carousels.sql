-- migrate:up
ALTER TABLE folders ADD COLUMN carousel_owner_folder_id INTEGER NULL REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE scan_runs ADD COLUMN warning_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN warning_text TEXT NULL;

CREATE TEMP TABLE foldergram_000005_expected_counts (
  normal_posts INTEGER NOT NULL,
  likes INTEGER NOT NULL,
  collection_items INTEGER NOT NULL
);

INSERT INTO foldergram_000005_expected_counts (normal_posts, likes, collection_items)
SELECT
  (
    SELECT COUNT(*)
    FROM images AS img
    JOIN folders AS f ON f.id = img.folder_id
    WHERE f.role = 'normal'
      AND LOWER(img.filename) NOT IN ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'cover.avif', 'cover.gif')
  ),
  (
    SELECT COUNT(DISTINCT l.image_id)
    FROM likes AS l
    JOIN images AS img ON img.id = l.image_id
    JOIN folders AS f ON f.id = img.folder_id
    WHERE f.role = 'normal'
      AND LOWER(img.filename) NOT IN ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'cover.avif', 'cover.gif')
  ),
  (
    SELECT COUNT(*)
    FROM collection_items AS ci
    JOIN images AS img ON img.id = ci.image_id
    JOIN folders AS f ON f.id = img.folder_id
    WHERE f.role = 'normal'
      AND LOWER(img.filename) NOT IN ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'cover.avif', 'cover.gif')
  );

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL,
  place_id INTEGER NULL,
  source_path TEXT NOT NULL UNIQUE,
  post_type TEXT NOT NULL DEFAULT 'single',
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
  CHECK (post_type IN ('single', 'carousel'))
);

CREATE TABLE IF NOT EXISTS post_items (
  post_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  PRIMARY KEY (post_id, position),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
  CHECK (position >= 1 AND position <= 20)
);

-- Backfill posts for existing normal images (excluding cover images)
INSERT INTO posts (
  id,
  folder_id,
  place_id,
  source_path,
  post_type,
  caption,
  sort_timestamp,
  taken_at,
  taken_at_source,
  is_deleted,
  deleted_at,
  is_trashed,
  trashed_at,
  created_at,
  updated_at
)
SELECT
  img.id,
  img.folder_id,
  img.place_id,
  img.relative_path,
  'single',
  img.caption,
  img.sort_timestamp,
  img.taken_at,
  img.taken_at_source,
  img.is_deleted,
  img.deleted_at,
  img.is_trashed,
  img.trashed_at,
  img.created_at,
  img.updated_at
FROM images AS img
JOIN folders AS f ON img.folder_id = f.id
WHERE f.role = 'normal'
  AND LOWER(img.filename) NOT IN ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'cover.avif', 'cover.gif');

-- Backfill post_items for migrated single posts
INSERT INTO post_items (post_id, image_id, position)
SELECT id, id, 1
FROM posts;

-- Rebuild likes table keyed by post_id
CREATE TABLE new_likes (
  post_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

INSERT INTO new_likes (post_id, created_at)
SELECT DISTINCT pi.post_id, l.created_at
FROM likes l
JOIN post_items pi ON l.image_id = pi.image_id;

DROP TABLE likes;
ALTER TABLE new_likes RENAME TO likes;

-- Rebuild collection_items table keyed by post_id
CREATE TABLE new_collection_items (
  collection_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (collection_id, post_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

INSERT INTO new_collection_items (collection_id, post_id, created_at)
SELECT DISTINCT ci.collection_id, pi.post_id, ci.created_at
FROM collection_items ci
JOIN post_items pi ON ci.image_id = pi.image_id;

DROP TABLE collection_items;
ALTER TABLE new_collection_items RENAME TO collection_items;

CREATE TEMP TABLE foldergram_000005_assertions (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO foldergram_000005_assertions (valid)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM posts) = expected.normal_posts
  AND (SELECT COUNT(*) FROM post_items) = expected.normal_posts
  AND NOT EXISTS (
    SELECT 1
    FROM posts
    LEFT JOIN post_items ON post_items.post_id = posts.id
    WHERE post_items.post_id IS NULL OR posts.id <> post_items.image_id OR post_items.position <> 1
  )
  AND (SELECT COUNT(*) FROM likes) = expected.likes
  AND (SELECT COUNT(*) FROM collection_items) = expected.collection_items
THEN 1 ELSE 0 END
FROM foldergram_000005_expected_counts AS expected;

DROP TABLE foldergram_000005_assertions;
DROP TABLE foldergram_000005_expected_counts;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_posts_folder_visible_sort ON posts(folder_id, is_deleted, is_trashed, sort_timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_visible_sort ON posts(is_deleted, is_trashed, sort_timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_type_visibility ON posts(post_type, is_deleted, is_trashed);
CREATE INDEX IF NOT EXISTS idx_posts_place_visibility ON posts(place_id, is_deleted, is_trashed, sort_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_posts_source_path ON posts(source_path);
CREATE INDEX IF NOT EXISTS idx_posts_trashed_listing ON posts(is_trashed, is_deleted, trashed_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_items_image_id ON post_items(image_id);
CREATE INDEX IF NOT EXISTS idx_post_items_post_id ON post_items(post_id, position);

CREATE INDEX IF NOT EXISTS idx_likes_created_at ON likes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_items_post ON collection_items(post_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_created ON collection_items(collection_id, created_at DESC, post_id DESC);
CREATE INDEX IF NOT EXISTS idx_folders_carousel_owner ON folders(carousel_owner_folder_id);

-- migrate:down
DROP TABLE IF EXISTS post_items;
DROP TABLE IF EXISTS posts;
