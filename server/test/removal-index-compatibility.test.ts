import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { databaseManager } from '../src/db/database.js';
import {
  maintenanceRepository,
  folderRepository,
} from '../src/db/repositories.js';
import { galleryService } from '../src/services/gallery-service.js';
import { assertLegacyPostRemovalAllowed } from '../src/services/media-trash-service.js';
import { scannerService } from '../src/services/scanner-service.js';
import { watcherService } from '../src/services/watcher-service.js';
import { authService } from '../src/services/auth-service.js';
import { apiRouter } from '../src/routes/api.js';
import { createHttpErrorHandler } from '../src/middleware/http-errors.js';

describe('retained removal identities and legacy restore compatibility', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    vi.spyOn(databaseManager, 'connection', 'get').mockReturnValue(db);
    db.exec(`INSERT INTO folders(id,slug,name,folder_path,avatar_image_id) VALUES(1,'synthetic','Synthetic','Synthetic',NULL);
      INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(1,1,'Synthetic/Album',1);
      INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
      VALUES(1,1,'a.jpg','.jpg','Synthetic/Album/a.jpg','/synthetic/a.jpg',1,1,1,'image/jpeg','fixture',1,'now',1,'a.webp','a-preview.webp');
      INSERT INTO post_items(post_id,image_id,position) VALUES(1,1,1);
      UPDATE folders SET avatar_image_id=1,avatar_source='manual';`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function addWork() {
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'Synthetic','synthetic','fixture','one');
      INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Album');
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(1,1,1,'/synthetic','Synthetic','/synthetic/Synthetic','Synthetic','matched','now');
      INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,1,1,'Album','/synthetic/Synthetic/Album','Album','matched','now');`);
  }
  function addMediaHistory(active: number) {
    db.prepare(
      `INSERT INTO media_trash_entries(image_id,post_id,original_position,original_post_type,original_order_json,active,trashed_at)
      VALUES(1,1,1,'single','[1]',?,'now')`,
    ).run(active);
  }
  function tombstone() {
    db.exec(`INSERT INTO removal_operations(operation_id,kind,target_id,mode,state,payload_json,created_at,updated_at) VALUES('removed','work',1,'trash','completed','{}','now','now');
      INSERT INTO work_removals(work_id,state,operation_id,snapshot_json,created_at) VALUES(1,'trashed','removed','{}','now');
      INSERT INTO work_removal_paths(work_id,local_work_id,absolute_path,relative_path) VALUES(1,1,'/synthetic/Synthetic/Album','Synthetic/Album');`);
  }
  const index = () =>
    ['folders', 'images', 'posts', 'post_items'].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );

  it.each(['work', 'active media', 'restored media', 'permanent Work'])(
    'rejects index reset with %s evidence before deleting anything',
    (kind) => {
      if (kind === 'work' || kind === 'permanent Work') addWork();
      else addMediaHistory(kind === 'active media' ? 1 : 0);
      if (kind === 'permanent Work') {
        tombstone();
        db.exec(
          "UPDATE work_removals SET state='deleted'; UPDATE archive_catalog_local_works SET post_id=NULL,is_active=0",
        );
      }
      const before = index();
      expect(() => maintenanceRepository.resetLibraryIndex()).toThrow(
        /独立作品身份或回收记录/,
      );
      expect(index()).toEqual(before);
      expect(db.isTransaction).toBe(false);
    },
  );

  it('rolls back all index changes if an unexpected later delete fails', () => {
    db.exec(
      "CREATE TRIGGER synthetic_reset_failure BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END",
    );
    const before = index();
    expect(() => maintenanceRepository.resetLibraryIndex()).toThrow(
      'synthetic delete failure',
    );
    expect(index()).toEqual(before);
    expect(db.isTransaction).toBe(false);
    db.exec('DROP TRIGGER synthetic_reset_failure');
    maintenanceRepository.resetLibraryIndex();
    expect(index()).toEqual([[], [], [], []]);
  });

  it('rejects the actual rebuild API with a clear error before stopping the watcher or invoking rebuild', async () => {
    addWork();
    vi.spyOn(authService, 'isAuthenticatedRequest').mockReturnValue(true);
    vi.spyOn(authService, 'hasCapability').mockReturnValue(true);
    vi.spyOn(scannerService, 'getProgress').mockReturnValue({
      isScanning: false,
    } as ReturnType<typeof scannerService.getProgress>);
    const stop = vi.spyOn(watcherService, 'stop').mockResolvedValue();
    const rebuild = vi.spyOn(scannerService, 'rebuildLibraryIndex');
    const app = express();
    app.use(apiRouter);
    app.use(createHttpErrorHandler());
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('No synthetic port');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/admin/rebuild-index`,
        { method: 'POST' },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'LIBRARY_REBUILD_RETAINED_IDENTITIES',
        message: expect.stringContaining('普通扫描'),
      });
      expect(stop).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('allows restoring an old trashed Post bound to a Work, while still forbidding old whole-Post removal', () => {
    addWork();
    db.exec('UPDATE posts SET is_trashed=1; UPDATE images SET is_trashed=1');
    expect(() => assertLegacyPostRemovalAllowed(1)).toThrow();
    expect(galleryService.restoreImage(1)).toEqual({
      id: 1,
      folderSlug: 'synthetic',
    });
    expect(db.prepare('SELECT is_trashed FROM posts').get()).toEqual({
      is_trashed: 0,
    });
    expect(db.prepare('SELECT is_trashed FROM images').get()).toEqual({
      is_trashed: 0,
    });
  });

  it.each(['work', 'legacy path', 'media'])(
    'blocks the old restore API for new %s removal records',
    (kind) => {
      addWork();
      db.exec('UPDATE posts SET is_trashed=1; UPDATE images SET is_trashed=1');
      if (kind === 'media') addMediaHistory(1);
      else tombstone();
      if (kind === 'legacy path')
        db.exec(
          'UPDATE archive_catalog_local_works SET post_id=NULL,is_active=0',
        );
      expect(() => galleryService.restoreImage(1)).toThrow(
        /对应的独立作品或单张媒体/,
      );
      expect(db.prepare('SELECT is_trashed FROM posts').get()).toEqual({
        is_trashed: 1,
      });
    },
  );

  it('excludes a trashed avatar from folder summaries while retaining its recoverable selection', () => {
    db.exec('UPDATE posts SET is_trashed=1; UPDATE images SET is_trashed=1');
    expect(folderRepository.getSummaryBySlug('synthetic')).toMatchObject({
      avatar_image_id: 1,
      summary_avatar_image_id: null,
    });
  });
});
