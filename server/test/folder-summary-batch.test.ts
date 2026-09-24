import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';

describe('batched physical folder summaries', () => {
  let db: DatabaseSync;
  let repository: typeof import('../src/db/repositories.js')['folderRepository'];
  const databaseKey = Symbol.for('foldergram.database.connection');
  const globals = globalThis as unknown as Record<symbol, DatabaseSync | null>;

  beforeEach(async () => {
    const root = path.join(os.tmpdir(), 'folder-summary-in-memory-only');
    vi.stubEnv('NODE_ENV', 'test');
    for (const [key, leaf] of Object.entries({ DATA_ROOT: 'data', DB_DIR: 'db', GALLERY_ROOT: 'gallery', THUMBNAILS_DIR: 'thumbs', PREVIEWS_DIR: 'previews' })) {
      vi.stubEnv(key, path.join(root, leaf));
    }
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    globals[databaseKey] = db;
    ({ folderRepository: repository } = await import('../src/db/repositories.js'));
    for (let id = 1; id <= 9; id++) {
      db.prepare('INSERT INTO folders(id,slug,name,folder_path) VALUES(?,?,?,?)').run(id, `f-${id}`, `Folder ${id}`, `/fixture/${id}`);
    }
    db.prepare("INSERT INTO folders(id,slug,name,folder_path,role,carousel_owner_folder_id) VALUES(10,'carousel','Carousel','/fixture/1/work','carousel_source',1)").run();
    db.prepare("INSERT INTO folders(id,slug,name,folder_path,role,story_owner_folder_id) VALUES(11,'story','Story','/fixture/story','story_capsule',1)").run();
    const image = (id: number, owner: number, name: string, media = 'image', deleted = 0, trashed = 0) => {
      db.prepare(`INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,media_type,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path,is_deleted,is_trashed)
        VALUES(?,?,?,'.jpg',?,?,1,1,1,?,'fixture','fixture',?,'fixture',?,?,?, ?,?)`).run(id, owner, name, `file-${id}`, `/fixture/file-${id}`, media, id * 100, id * 100, `thumb-${id}`, `preview-${id}`, deleted, trashed);
    };
    const post = (id: number, owner: number, imageIds: number[], type = 'carousel', deleted = 0, trashed = 0) => {
      db.prepare('INSERT INTO posts(id,folder_id,source_path,post_type,content_rating,sort_timestamp,is_deleted,is_trashed) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, owner, `post-${id}`, type, id === 1 ? 'R18' : 'R15', id * 100, deleted, trashed);
      imageIds.forEach((imageId, index) => db.prepare('INSERT INTO post_items VALUES(?,?,?)').run(id, imageId, index + 1));
    };
    image(1, 10, 'photo.jpg'); image(2, 10, 'video.mp4', 'video'); post(1, 1, [1, 2]);
    image(3, 1, 'cover.png'); image(4, 1, 'cover.jpg'); post(2, 1, [4], 'single');
    image(5, 11, 'story.jpg');
    db.prepare('UPDATE folders SET avatar_image_id=1 WHERE id=1').run();
    image(6, 2, 'cover.png'); image(7, 2, 'cover.jpg'); image(8, 2, 'cover.jpeg');
    image(9, 3, 'normal.jpg'); post(3, 3, [9], 'single');
    // A deleted explicit avatar falls back to a retained explicit cover.
    image(10, 2, 'deleted.jpg', 'image', 1); db.prepare('UPDATE folders SET avatar_image_id=10 WHERE id=2').run();
    // Cross-owner avatar must not turn an empty physical folder into a card.
    db.prepare('UPDATE folders SET avatar_image_id=9 WHERE id=4').run();
    image(11, 5, 'video.mp4', 'video'); post(4, 5, [11], 'single');
    image(12, 6, 'deleted-post.jpg'); post(5, 6, [12], 'single', 1);
    image(13, 6, 'trashed-post.jpg'); post(6, 6, [13], 'single', 0, 1);
    // Preserve old projection semantics even for a retained post with deleted media.
    image(14, 7, 'deleted-member.jpg', 'image', 1); post(7, 7, [14], 'single');
    image(15, 8, 'cover.gif', 'image', 0, 1);
    image(16, 9, 'cover.webp');
    // A zero-member deleted historical post contributes nothing.
    post(36520, 3, [], 'carousel', 1);
  });

  afterEach(() => {
    if (globals[databaseKey] === db) {
      db.close();
      globals[databaseKey] = null;
    }
    vi.unstubAllEnvs();
  });

  it('matches every legacy single-folder field across avatar, story, cover and deletion cases', () => {
    const actual = repository.getAllSummaries();
    expect(actual.map(row => row.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 7, 9]);
    for (const row of actual) expect(row).toEqual(repository.getSummaryBySlug(row.slug));
    expect(actual.find(row => row.id === 1)).toMatchObject({ content_rating: 'R18', post_count: 2, image_count: 1, carousel_count: 1, video_count: 0, has_avatar_story: 1, summary_avatar_image_id: 1 });
    expect(actual.find(row => row.id === 2)?.summary_avatar_image_id).toBe(7);
    expect(actual.find(row => row.id === 5)?.video_count).toBe(1);
    expect(actual.find(row => row.id === 7)?.summary_avatar_image_id).toBe(14);
  });

  it('assembles all summaries using one statement and retains stable ordering', () => {
    const prepare = vi.spyOn(db, 'prepare');
    const actual = repository.getAllSummaries();
    // One aggregate; the other two statements observe SQLite change versions.
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('WITH active_posts AS MATERIALIZED'))).toHaveLength(1);
    prepare.mockRestore();
    const expected = [...actual].sort((a, b) => (b.latest_image_mtime_ms ?? -Infinity) - (a.latest_image_mtime_ms ?? -Infinity)
      || a.name.localeCompare(b.name) || a.folder_path.localeCompare(b.folder_path));
    expect(actual.map(row => row.id)).toEqual(expected.map(row => row.id));
    expect(repository.getAllSummaries()).toEqual(actual);
  });

  it('invalidates the projection after changed folder/media facts without a scan', () => {
    const before = repository.getAllSummaries();
    const prepare = vi.spyOn(db, 'prepare');
    expect(repository.getAllSummaries()).toEqual(before);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('WITH active_posts AS MATERIALIZED'))).toHaveLength(0);
    prepare.mockRestore();
    db.exec("UPDATE folders SET name='Renamed' WHERE id=1; UPDATE images SET mtime_ms=999999 WHERE id=1");
    expect(repository.getAllSummaries().find(row => row.id === 1)).toMatchObject({ name: 'Renamed', latest_image_mtime_ms: 999999 });
    db.exec('UPDATE posts SET is_deleted=1 WHERE id=3');
    expect(repository.getAllSummaries().find(row => row.id === 3)).toBeUndefined();
  });
});
