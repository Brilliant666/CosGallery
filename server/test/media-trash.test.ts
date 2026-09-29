import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { MediaTrashService } from '../src/services/media-trash-service.js';

describe('single media trash with retained originals', () => {
  let db: DatabaseSync;
  let root: string;
  let service: MediaTrashService;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosgallery-media-trash-'));
    service = new MediaTrashService(db, root, root);
    db.exec(`INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'creator','Creator','creator');
      INSERT INTO posts(id,folder_id,source_path,post_type,caption,sort_timestamp) VALUES(10,1,'creator/album','carousel','Album',100);
      INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'Creator','creator','manual','1');
      INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Album');`);
    db.prepare(
      `INSERT INTO archive_catalog_local_creator_folders(id,gallery_folder_id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(1,1,1,?,'creator',?,'Creator','matched','now')`,
    ).run(root, path.join(root, 'creator'));
    db.prepare(
      `INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,image_count,video_count,total_bytes,match_status,scanned_at) VALUES(1,1,1,10,'album',?,'Album',2,1,9,'matched','now')`,
    ).run(path.join(root, 'creator/album'));
    for (const [index, id] of [21, 22, 23].entries()) {
      const relative = `creator/album/${id}.jpg`;
      const filename = path.join(root, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, 'abc');
      const stat = fs.statSync(filename);
      db.prepare(
        `INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,media_type,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
        VALUES(?,1,?,'jpg',?,?,3,100,100,?,'image/jpeg','fixture',?,'now',100,?,?)`,
      ).run(
        id,
        `${id}.jpg`,
        relative,
        filename,
        id === 23 ? 'video' : 'image',
        stat.mtimeMs,
        relative,
        relative,
      );
      db.prepare(
        'INSERT INTO post_items(post_id,image_id,position) VALUES(10,?,?)',
      ).run(id, index + 1);
    }
    db.exec(
      'UPDATE archive_catalog_works SET primary_local_work_id=1 WHERE id=1',
    );
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const members = () =>
    db
      .prepare(
        'SELECT image_id,position FROM post_items WHERE post_id=10 ORDER BY position',
      )
      .all();
  const post = () =>
    db
      .prepare('SELECT post_type,is_deleted,is_trashed FROM posts WHERE id=10')
      .get();

  it('only removes the selected middle member, preserves original files, and restores original order', async () => {
    const before = fs.readFileSync(path.join(root, 'creator/album/22.jpg'));
    expect(await service.trash(10, 22)).toEqual({
      ok: true,
      postId: 10,
      mediaId: 22,
      remainingMediaCount: 2,
      postTrashed: false,
    });
    expect(members()).toEqual([
      { image_id: 21, position: 1 },
      { image_id: 23, position: 2 },
    ]);
    expect(fs.readFileSync(path.join(root, 'creator/album/22.jpg'))).toEqual(
      before,
    );
    expect(service.list()).toMatchObject({
      total: 1,
      items: [
        {
          mediaId: 22,
          postId: 10,
          creatorId: 1,
          postTitle: 'Album',
          filename: '22.jpg',
        },
      ],
    });
    expect(service.thumbnail(22)).toBe(path.join(root, 'creator/album/22.jpg'));
    await service.restore(10, 22);
    expect(members()).toEqual([
      { image_id: 21, position: 1 },
      { image_id: 22, position: 2 },
      { image_id: 23, position: 3 },
    ]);
    expect(service.list().total).toBe(0);
    expect(
      db
        .prepare(
          'SELECT image_count,video_count,total_bytes FROM archive_catalog_local_works WHERE id=1',
        )
        .get(),
    ).toEqual({ image_count: 2, video_count: 1, total_bytes: 9 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('reselects representative, converts two to one, confirms the last member and restores out of removal order', async () => {
    db.exec(
      "UPDATE folders SET avatar_image_id=21,avatar_source='manual' WHERE id=1",
    );
    await service.trash(10, 22);
    await service.trash(10, 21);
    expect(post()).toEqual({
      post_type: 'single',
      is_deleted: 0,
      is_trashed: 0,
    });
    expect(members()).toEqual([{ image_id: 23, position: 1 }]);
    expect(
      db.prepare('SELECT avatar_image_id FROM folders WHERE id=1').get(),
    ).toEqual({ avatar_image_id: null });
    await expect(service.trash(10, 23)).rejects.toMatchObject({
      code: 'LAST_MEDIA_CONFIRMATION_REQUIRED',
    });
    expect(members()).toHaveLength(1);
    await service.trash(10, 23, true);
    expect(post()).toEqual({
      post_type: 'single',
      is_deleted: 1,
      is_trashed: 1,
    });
    expect(members()).toEqual([]);
    await service.restore(10, 22);
    await service.restore(10, 21);
    await service.restore(10, 23);
    expect(members()).toEqual([
      { image_id: 21, position: 1 },
      { image_id: 22, position: 2 },
      { image_id: 23, position: 3 },
    ]);
    expect(post()).toEqual({
      post_type: 'carousel',
      is_deleted: 0,
      is_trashed: 0,
    });
  });

  it('rejects wrong gallery, is idempotent, and does not restore changed or missing originals', async () => {
    await expect(service.trash(999, 22)).rejects.toMatchObject({
      code: 'MEDIA_NOT_IN_GALLERY',
    });
    await service.trash(10, 22);
    await service.trash(10, 22);
    expect(service.list().total).toBe(1);
    fs.writeFileSync(path.join(root, 'creator/album/22.jpg'), 'changed');
    await expect(service.restore(10, 22)).rejects.toMatchObject({
      code: 'MEDIA_ORIGINAL_CHANGED',
    });
    fs.unlinkSync(path.join(root, 'creator/album/22.jpg'));
    await expect(service.restore(10, 22)).rejects.toMatchObject({
      code: 'MEDIA_ORIGINAL_CHANGED',
    });
    expect(service.list().total).toBe(1);
    expect(members()).toHaveLength(2);
  });

  it('does not revive a Work that has been moved to trash', async () => {
    await service.trash(10, 22);
    db.exec(`INSERT INTO removal_operations(operation_id,kind,target_id,mode,state,payload_json,created_at,updated_at) VALUES('op','work',1,'trash','committed','{}','now','now');
      INSERT INTO work_removals(work_id,state,operation_id,snapshot_json,created_at) VALUES(1,'trashed','op','{}','now');`);
    await expect(service.restore(10, 22)).rejects.toMatchObject({
      code: 'WORK_IN_TRASH',
    });
    await expect(service.trash(10, 21)).rejects.toMatchObject({
      code: 'WORK_IN_TRASH',
    });
    expect(service.list().total).toBe(0);
    expect(service.thumbnail(22)).toBeNull();
    db.exec('DELETE FROM work_removals');
    await service.restore(10, 22);
    expect(members()).toHaveLength(3);
  });

  it('rolls all member and image changes back when a dependent update fails', async () => {
    db.exec(
      "CREATE TRIGGER fail_post_change BEFORE UPDATE ON posts BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    await expect(service.trash(10, 22)).rejects.toThrow('fixture failure');
    expect(members()).toHaveLength(3);
    expect(service.list().total).toBe(0);
    expect(
      db.prepare('SELECT is_deleted,is_trashed FROM images WHERE id=22').get(),
    ).toEqual({ is_deleted: 0, is_trashed: 0 });
  });

  it('does not expose a thumbnail whose stored path escapes its configured root', async () => {
    await service.trash(10, 22);
    db.exec("UPDATE images SET thumbnail_path='../outside.jpg' WHERE id=22");
    expect(service.thumbnail(22)).toBeNull();
  });
});
