// Kept byte-equivalent to migration 000022; the migration test verifies this.
export const resourceCatalogSchemaSql = `
CREATE TABLE IF NOT EXISTS resource_catalog_state (
 creator_id INTEGER PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1,
 built_generation INTEGER NOT NULL DEFAULT 0, rule_version INTEGER NOT NULL DEFAULT 0,
 revision TEXT, generated_at TEXT, creator_name TEXT NOT NULL DEFAULT '',
 aliases_text TEXT NOT NULL DEFAULT '', summary_json TEXT, gaps_json TEXT NOT NULL DEFAULT '[]',
 last_error TEXT, failed_generation INTEGER, retry_after TEXT
);
CREATE TABLE IF NOT EXISTS resource_catalog_rows (
 work_id INTEGER PRIMARY KEY, creator_id INTEGER NOT NULL, no_number INTEGER,
 sort_timestamp REAL, primary_post_id INTEGER, local_state TEXT NOT NULL,
 has_source INTEGER NOT NULL, search_text TEXT NOT NULL,
 row_json TEXT NOT NULL, copies_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_catalog_meta (
 id INTEGER PRIMARY KEY CHECK(id=1), publication INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO resource_catalog_meta(id,publication) VALUES(1,0);
INSERT OR IGNORE INTO resource_catalog_state(creator_id) SELECT id FROM archive_catalog_creators;
CREATE INDEX IF NOT EXISTS idx_resource_catalog_rows_creator_no ON resource_catalog_rows(creator_id,no_number,work_id);
CREATE INDEX IF NOT EXISTS idx_resource_catalog_rows_state ON resource_catalog_rows(local_state,creator_id,no_number);
CREATE INDEX IF NOT EXISTS idx_resource_catalog_rows_source ON resource_catalog_rows(has_source,creator_id,no_number);
CREATE INDEX IF NOT EXISTS idx_resource_catalog_state_pending ON resource_catalog_state(generation,built_generation);

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_creators_insert
AFTER INSERT ON archive_catalog_creators
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT NEW.id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_creators_update
AFTER UPDATE OF canonical_name,is_active,preference,effective_rating ON archive_catalog_creators WHEN OLD.canonical_name IS NOT NEW.canonical_name OR OLD.is_active IS NOT NEW.is_active OR OLD.preference IS NOT NEW.preference OR OLD.effective_rating IS NOT NEW.effective_rating
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.id AS creator_id UNION SELECT NEW.id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_creators_delete
BEFORE DELETE ON archive_catalog_creators
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_creator_aliases_insert
AFTER INSERT ON archive_catalog_creator_aliases
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT NEW.creator_id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_creator_aliases_update
AFTER UPDATE OF creator_id,alias,normalized_alias ON archive_catalog_creator_aliases WHEN OLD.creator_id IS NOT NEW.creator_id OR OLD.alias IS NOT NEW.alias OR OLD.normalized_alias IS NOT NEW.normalized_alias
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.creator_id AS creator_id UNION SELECT NEW.creator_id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_creator_aliases_delete
BEFORE DELETE ON archive_catalog_creator_aliases
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.creator_id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_works_insert
AFTER INSERT ON archive_catalog_works
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT NEW.creator_id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_works_update
AFTER UPDATE OF creator_id,display_title,primary_local_work_id ON archive_catalog_works WHEN OLD.creator_id IS NOT NEW.creator_id OR OLD.display_title IS NOT NEW.display_title OR OLD.primary_local_work_id IS NOT NEW.primary_local_work_id
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.creator_id AS creator_id UNION SELECT NEW.creator_id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_works_delete
BEFORE DELETE ON archive_catalog_works
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.creator_id AS creator_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_local_works_insert
AFTER INSERT ON archive_catalog_local_works
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=NEW.work_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE id=NEW.local_creator_folder_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_local_works_update
AFTER UPDATE OF work_id,local_creator_folder_id,post_id,folder_name,relative_path,absolute_path,match_status,is_active,other_file_count ON archive_catalog_local_works WHEN OLD.work_id IS NOT NEW.work_id OR OLD.local_creator_folder_id IS NOT NEW.local_creator_folder_id OR OLD.post_id IS NOT NEW.post_id OR OLD.folder_name IS NOT NEW.folder_name OR OLD.relative_path IS NOT NEW.relative_path OR OLD.absolute_path IS NOT NEW.absolute_path OR OLD.match_status IS NOT NEW.match_status OR OLD.is_active IS NOT NEW.is_active OR OLD.other_file_count IS NOT NEW.other_file_count
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=OLD.work_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE id=OLD.local_creator_folder_id UNION SELECT creator_id FROM archive_catalog_works WHERE id=NEW.work_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE id=NEW.local_creator_folder_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_local_works_delete
BEFORE DELETE ON archive_catalog_local_works
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=OLD.work_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE id=OLD.local_creator_folder_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_local_creator_folders_insert
AFTER INSERT ON archive_catalog_local_creator_folders
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT NEW.creator_id AS creator_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=NEW.gallery_folder_id UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.local_creator_folder_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_local_creator_folders_update
AFTER UPDATE OF creator_id,gallery_folder_id,relative_path,match_status,is_active ON archive_catalog_local_creator_folders WHEN OLD.creator_id IS NOT NEW.creator_id OR OLD.gallery_folder_id IS NOT NEW.gallery_folder_id OR OLD.relative_path IS NOT NEW.relative_path OR OLD.match_status IS NOT NEW.match_status OR OLD.is_active IS NOT NEW.is_active
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.creator_id AS creator_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=OLD.gallery_folder_id UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.local_creator_folder_id=OLD.id UNION SELECT NEW.creator_id AS creator_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=NEW.gallery_folder_id UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.local_creator_folder_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_local_creator_folders_delete
BEFORE DELETE ON archive_catalog_local_creator_folders
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.creator_id AS creator_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=OLD.gallery_folder_id UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.local_creator_folder_id=OLD.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_folders_insert
AFTER INSERT ON folders
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=NEW.id UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_folders_update
AFTER UPDATE OF role ON folders WHEN OLD.role IS NOT NEW.role
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=OLD.id UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=OLD.id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=NEW.id UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_folders_delete
BEFORE DELETE ON folders
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=OLD.id UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=OLD.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_posts_insert
AFTER INSERT ON posts
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=NEW.folder_id UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=NEW.folder_id UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_posts_update
AFTER UPDATE OF folder_id,source_path,caption,sort_timestamp,is_deleted,is_trashed ON posts WHEN OLD.folder_id IS NOT NEW.folder_id OR OLD.source_path IS NOT NEW.source_path OR OLD.caption IS NOT NEW.caption OR OLD.sort_timestamp IS NOT NEW.sort_timestamp OR OLD.is_deleted IS NOT NEW.is_deleted OR OLD.is_trashed IS NOT NEW.is_trashed
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=OLD.folder_id UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=OLD.folder_id UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=OLD.id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=NEW.folder_id UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=NEW.folder_id UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_posts_delete
BEFORE DELETE ON posts
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=OLD.folder_id UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=OLD.folder_id UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=OLD.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_post_items_insert
AFTER INSERT ON post_items
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=(SELECT folder_id FROM posts WHERE id=NEW.post_id) UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=(SELECT folder_id FROM posts WHERE id=NEW.post_id) UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=NEW.post_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_post_items_update
AFTER UPDATE OF post_id,image_id,position ON post_items WHEN OLD.post_id IS NOT NEW.post_id OR OLD.image_id IS NOT NEW.image_id OR OLD.position IS NOT NEW.position
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=(SELECT folder_id FROM posts WHERE id=OLD.post_id) UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=(SELECT folder_id FROM posts WHERE id=OLD.post_id) UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=OLD.post_id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=(SELECT folder_id FROM posts WHERE id=NEW.post_id) UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=(SELECT folder_id FROM posts WHERE id=NEW.post_id) UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=NEW.post_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_post_items_delete
BEFORE DELETE ON post_items
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=(SELECT folder_id FROM posts WHERE id=OLD.post_id) UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=(SELECT folder_id FROM posts WHERE id=OLD.post_id) UNION SELECT w.creator_id FROM archive_catalog_local_works l JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.post_id=OLD.post_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_images_insert
AFTER INSERT ON images
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=(SELECT p.folder_id FROM post_items pi JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=NEW.id) UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=(SELECT p.folder_id FROM post_items pi JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=NEW.id) UNION SELECT w.creator_id FROM post_items pi JOIN archive_catalog_local_works l ON l.post_id=pi.post_id JOIN archive_catalog_works w ON w.id=l.work_id WHERE pi.image_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_images_update
AFTER UPDATE OF folder_id,filename,relative_path,media_type,file_size,is_deleted,is_trashed ON images WHEN OLD.folder_id IS NOT NEW.folder_id OR OLD.filename IS NOT NEW.filename OR OLD.relative_path IS NOT NEW.relative_path OR OLD.media_type IS NOT NEW.media_type OR OLD.file_size IS NOT NEW.file_size OR OLD.is_deleted IS NOT NEW.is_deleted OR OLD.is_trashed IS NOT NEW.is_trashed
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=(SELECT p.folder_id FROM post_items pi JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=OLD.id) UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=(SELECT p.folder_id FROM post_items pi JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=OLD.id) UNION SELECT w.creator_id FROM post_items pi JOIN archive_catalog_local_works l ON l.post_id=pi.post_id JOIN archive_catalog_works w ON w.id=l.work_id WHERE pi.image_id=OLD.id UNION SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=(SELECT p.folder_id FROM post_items pi JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=NEW.id) UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=(SELECT p.folder_id FROM post_items pi JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=NEW.id) UNION SELECT w.creator_id FROM post_items pi JOIN archive_catalog_local_works l ON l.post_id=pi.post_id JOIN archive_catalog_works w ON w.id=l.work_id WHERE pi.image_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_images_delete
BEFORE DELETE ON images
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_local_creator_folders WHERE gallery_folder_id=(SELECT p.folder_id FROM post_items pi JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=OLD.id) UNION SELECT w.creator_id FROM archive_catalog_local_creator_folders f JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id JOIN archive_catalog_works w ON w.id=l.work_id WHERE f.gallery_folder_id=(SELECT p.folder_id FROM post_items pi JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=OLD.id) UNION SELECT w.creator_id FROM post_items pi JOIN archive_catalog_local_works l ON l.post_id=pi.post_id JOIN archive_catalog_works w ON w.id=l.work_id WHERE pi.image_id=OLD.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_source_works_insert
AFTER INSERT ON archive_catalog_source_works
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=NEW.work_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_source_works_update
AFTER UPDATE OF work_id,collection_id,source,source_order,source_order_label,source_title,media_summary,is_active ON archive_catalog_source_works WHEN OLD.work_id IS NOT NEW.work_id OR OLD.collection_id IS NOT NEW.collection_id OR OLD.source IS NOT NEW.source OR OLD.source_order IS NOT NEW.source_order OR OLD.source_order_label IS NOT NEW.source_order_label OR OLD.source_title IS NOT NEW.source_title OR OLD.media_summary IS NOT NEW.media_summary OR OLD.is_active IS NOT NEW.is_active
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=OLD.work_id UNION SELECT creator_id FROM archive_catalog_works WHERE id=NEW.work_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_source_works_delete
BEFORE DELETE ON archive_catalog_source_works
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=OLD.work_id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_collections_insert
AFTER INSERT ON archive_catalog_collections
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT w.creator_id FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id WHERE s.collection_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_collections_update
AFTER UPDATE OF source_url ON archive_catalog_collections WHEN OLD.source_url IS NOT NEW.source_url
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT w.creator_id FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id WHERE s.collection_id=OLD.id UNION SELECT w.creator_id FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id WHERE s.collection_id=NEW.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_collections_delete
BEFORE DELETE ON archive_catalog_collections
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT w.creator_id FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id WHERE s.collection_id=OLD.id) WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_work_decisions_insert
AFTER INSERT ON archive_catalog_work_decisions
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=NEW.work_id AND NEW.kind='admission_file_removal') WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_work_decisions_update
AFTER UPDATE OF work_id,local_work_id,kind,state,payload_json ON archive_catalog_work_decisions WHEN OLD.work_id IS NOT NEW.work_id OR OLD.local_work_id IS NOT NEW.local_work_id OR OLD.kind IS NOT NEW.kind OR OLD.state IS NOT NEW.state OR OLD.payload_json IS NOT NEW.payload_json
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=OLD.work_id AND OLD.kind='admission_file_removal' UNION SELECT creator_id FROM archive_catalog_works WHERE id=NEW.work_id AND NEW.kind='admission_file_removal') WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_archive_catalog_work_decisions_delete
BEFORE DELETE ON archive_catalog_work_decisions
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT creator_id FROM archive_catalog_works WHERE id=OLD.work_id AND OLD.kind='admission_file_removal') WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_local_ingest_jobs_insert
AFTER INSERT ON local_ingest_jobs
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT NEW.creator_id AS creator_id WHERE NEW.status='ingested') WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_local_ingest_jobs_update
AFTER UPDATE OF creator_id,source_work_id,status,target_path,summary_json ON local_ingest_jobs WHEN OLD.creator_id IS NOT NEW.creator_id OR OLD.source_work_id IS NOT NEW.source_work_id OR OLD.status IS NOT NEW.status OR OLD.target_path IS NOT NEW.target_path OR
 (CASE WHEN json_valid(OLD.summary_json) THEN json_extract(OLD.summary_json,'$.retainedOriginalCount') END) IS NOT
 (CASE WHEN json_valid(NEW.summary_json) THEN json_extract(NEW.summary_json,'$.retainedOriginalCount') END) OR
 (CASE WHEN json_valid(OLD.summary_json) THEN json_type(OLD.summary_json,'$.retainedOriginalCount') END) IS NOT
 (CASE WHEN json_valid(NEW.summary_json) THEN json_type(NEW.summary_json,'$.retainedOriginalCount') END)
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.creator_id AS creator_id WHERE OLD.status='ingested' UNION SELECT NEW.creator_id AS creator_id WHERE NEW.status='ingested') WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;

CREATE TRIGGER IF NOT EXISTS rc_dirty_local_ingest_jobs_delete
BEFORE DELETE ON local_ingest_jobs
BEGIN
 INSERT INTO resource_catalog_state(creator_id,generation)
 SELECT creator_id,1 FROM (SELECT OLD.creator_id AS creator_id WHERE OLD.status='ingested') WHERE creator_id IS NOT NULL
 ON CONFLICT(creator_id) DO UPDATE SET generation=generation+1,last_error=NULL,failed_generation=NULL,retry_after=NULL;
END;
`;
