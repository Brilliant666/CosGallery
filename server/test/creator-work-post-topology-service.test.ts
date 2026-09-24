import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import {
  CreatorWorkPostTopologyError,
  reconcileCreatorWorkPostTopology,
  type CreatorWorkPostTopologyEntry
} from '../src/services/creator-work-post-topology-service.js';

interface Fixture {
  database: DatabaseSync;
  entries: CreatorWorkPostTopologyEntry[];
  presentPaths: Set<string>;
}

function insertFolder(
  database: DatabaseSync,
  id: number,
  folderPath: string,
  role: 'normal' | 'carousel_source',
  ownerFolderId: number | null = null
): void {
  database.prepare(
    `INSERT INTO folders (id, slug, name, folder_path, role, carousel_owner_folder_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `folder-${id}`, folderPath.split('/').at(-1)!, folderPath, role, ownerFolderId);
}

function insertImage(database: DatabaseSync, id: number, folderId: number, relativePath: string): void {
  const filename = relativePath.split('/').at(-1)!;
  database.prepare(
    `INSERT INTO images (
       id, folder_id, filename, extension, relative_path, absolute_path, file_size, width, height,
       media_type, mime_type, checksum_or_fingerprint, mtime_ms, first_seen_at, sort_timestamp,
       thumbnail_path, preview_path
     ) VALUES (?, ?, ?, '.jpg', ?, ?, ?, 100, 100, 'image', 'image/jpeg', ?, ?, '2026-01-01T00:00:00.000Z', ?, ?, ?)`
  ).run(
    id,
    folderId,
    filename,
    relativePath,
    `G:/gallery/${relativePath}`,
    id * 10,
    `fingerprint-${id}`,
    id * 1000,
    id * 1000,
    `thumb-${id}.jpg`,
    `preview-${id}.jpg`
  );
}

function insertPost(
  database: DatabaseSync,
  id: number,
  folderId: number,
  sourcePath: string,
  imageIds: number[],
  overrides: { caption?: string; isTrashed?: number; contentRating?: 'R15' | 'R18'; placeId?: number } = {}
): void {
  database.prepare(
    `INSERT INTO posts (
       id, folder_id, place_id, source_path, post_type, content_rating, caption, sort_timestamp,
       is_deleted, is_trashed, trashed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1000, 0, ?, ?, '2026-01-01T00:00:00.000Z')`
  ).run(
    id,
    folderId,
    overrides.placeId ?? null,
    sourcePath,
    imageIds.length > 1 ? 'carousel' : 'single',
    overrides.contentRating ?? 'R15',
    overrides.caption ?? null,
    overrides.isTrashed ?? 0,
    overrides.isTrashed ? '2026-01-01T00:00:00.000Z' : null
  );
  const insertItem = database.prepare('INSERT INTO post_items (post_id, image_id, position) VALUES (?, ?, ?)');
  imageIds.forEach((imageId, index) => insertItem.run(id, imageId, index + 1));
}

function createFixture(): Fixture {
  const database = new DatabaseSync(':memory:');
  database.exec(schemaSql);
  insertFolder(database, 1, 'creator', 'normal');
  insertFolder(database, 11, 'creator/work-a', 'carousel_source', 1);
  insertFolder(database, 12, 'creator/work-b', 'carousel_source', 1);
  insertImage(database, 101, 11, 'creator/work-a/a-1.jpg');
  insertImage(database, 102, 11, 'creator/work-a/a-2.jpg');
  insertImage(database, 103, 12, 'creator/work-b/b-1.jpg');
  insertImage(database, 104, 12, 'creator/work-b/b-2.jpg');
  insertImage(database, 105, 12, 'creator/work-b/b-3.jpg');
  const presentPaths = new Set([
    'creator/work-a',
    'creator/work-b',
    'creator/work-a/a-1.jpg',
    'creator/work-a/a-2.jpg',
    'creator/work-b/b-1.jpg',
    'creator/work-b/b-2.jpg',
    'creator/work-b/b-3.jpg'
  ]);
  return {
    database,
    presentPaths,
    entries: [
      {
        ownerFolderId: 1,
        workFolderId: 11,
        sourcePath: 'creator/work-a',
        postType: 'carousel',
        sortTimestamp: 102_000,
        takenAt: null,
        takenAtSource: null,
        placeId: null,
        items: [{ imageId: 101, position: 1 }, { imageId: 102, position: 2 }]
      },
      {
        ownerFolderId: 1,
        workFolderId: 12,
        sourcePath: 'creator/work-b',
        postType: 'carousel',
        sortTimestamp: 105_000,
        takenAt: null,
        takenAtSource: null,
        placeId: null,
        items: [
          { imageId: 103, position: 1 },
          { imageId: 104, position: 2 },
          { imageId: 105, position: 3 }
        ]
      }
    ]
  };
}

function run(fixture: Fixture, dryRun: boolean, expectedRevision?: string) {
  return reconcileCreatorWorkPostTopology({
    ownerFolderId: 1,
    creatorPath: 'creator',
    entries: fixture.entries,
    pathExists: (relativePath) => fixture.presentPaths.has(relativePath)
  }, { dryRun, expectedRevision }, fixture.database);
}

function rowSnapshot(database: DatabaseSync): string {
  return JSON.stringify({
    posts: database.prepare('SELECT * FROM posts ORDER BY id').all(),
    items: database.prepare('SELECT * FROM post_items ORDER BY post_id, position').all(),
    likes: database.prepare('SELECT * FROM likes ORDER BY post_id').all(),
    collections: database.prepare('SELECT * FROM collection_items ORDER BY collection_id, post_id').all()
  });
}

describe('creator work Post topology reconciliation', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.database.close();
  });

  it('atomically splits a merged legacy Post and is strictly idempotent', () => {
    insertPost(fixture.database, 900, 1, 'creator/merged-work', [101, 102, 103, 104, 105]);

    const dryRun = run(fixture, true);
    expect(dryRun).toMatchObject({
      canApply: true,
      destinationWorks: 2,
      destinationExistingPosts: 0,
      postsToCreate: 2,
      itemsToTransfer: 5,
      postsToRetire: 1,
      conflicts: []
    });
    const result = run(fixture, false, dryRun.revision);
    expect(result).toMatchObject({ createdPosts: 2, transferredItems: 5, retiredPosts: 1 });
    expect(fixture.database.prepare('SELECT is_deleted, deleted_at FROM posts WHERE id = 900').get()).toMatchObject({
      is_deleted: 1
    });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM post_items WHERE post_id = 900').get()).toEqual({ count: 0 });
    expect(fixture.database.prepare('SELECT image_id, COUNT(*) AS owners FROM post_items GROUP BY image_id ORDER BY image_id').all())
      .toEqual([101, 102, 103, 104, 105].map((image_id) => ({ image_id, owners: 1 })));
    // 000027 removes the redundant explicit index, not image membership uniqueness.
    expect(fixture.database.prepare("SELECT name, [unique], origin, partial FROM pragma_index_list('post_items') WHERE name = 'sqlite_autoindex_post_items_1'").get())
      .toEqual({ name: 'sqlite_autoindex_post_items_1', unique: 1, origin: 'u', partial: 0 });
    expect(fixture.database.prepare("SELECT name, coll, [desc] FROM pragma_index_xinfo('sqlite_autoindex_post_items_1') WHERE [key]=1").all())
      .toEqual([{ name: 'image_id', coll: 'BINARY', desc: 0 }]);

    const stableSnapshot = rowSnapshot(fixture.database);
    const secondDryRun = run(fixture, true);
    expect(secondDryRun).toMatchObject({ postsToCreate: 0, itemsToTransfer: 0, postsToRetire: 0, conflicts: [] });
    expect(run(fixture, false, secondDryRun.revision)).toMatchObject({
      createdPosts: 0,
      updatedPosts: 0,
      transferredItems: 0,
      retiredPosts: 0
    });
    expect(rowSnapshot(fixture.database)).toBe(stableSnapshot);
  });

  it('reuses a partial destination and preserves its Post-level state', () => {
    insertPost(fixture.database, 901, 1, 'creator/work-a', [101], {
      caption: 'keep me',
      isTrashed: 1,
      contentRating: 'R18'
    });
    fixture.database.prepare("INSERT INTO collections (id, slug, name, is_default) VALUES (1, 'saved', 'Saved', 1)").run();
    fixture.database.prepare('INSERT INTO collection_items (collection_id, post_id) VALUES (1, 901)').run();
    insertPost(fixture.database, 900, 1, 'creator/merged-work', [102, 103, 104, 105]);

    const dryRun = run(fixture, true);
    expect(dryRun.canApply).toBe(true);
    run(fixture, false, dryRun.revision);
    expect(fixture.database.prepare('SELECT id, caption, is_trashed, content_rating FROM posts WHERE source_path = ?').get('creator/work-a'))
      .toEqual({ id: 901, caption: 'keep me', is_trashed: 1, content_rating: 'R18' });
    expect(fixture.database.prepare('SELECT image_id FROM post_items WHERE post_id = 901 ORDER BY position').all())
      .toEqual([{ image_id: 101 }, { image_id: 102 }]);
    expect(fixture.database.prepare('SELECT collection_id, post_id FROM collection_items').all())
      .toEqual([{ collection_id: 1, post_id: 901 }]);
  });

  it('fails closed when an active Post owns a desired image', () => {
    insertPost(fixture.database, 900, 1, 'creator/still-active', [101]);
    fixture.presentPaths.add('creator/still-active');
    const before = rowSnapshot(fixture.database);
    const dryRun = run(fixture, true);
    expect(dryRun.activeOwnerConflicts[0]?.code).toBe('POST_ITEM_ACTIVE_OWNER_CONFLICT');
    expect(() => run(fixture, false, dryRun.revision)).toThrowError(CreatorWorkPostTopologyError);
    expect(rowSnapshot(fixture.database)).toBe(before);
  });

  it('does not repurpose an exact-media Post while its previous source path still exists', () => {
    insertPost(fixture.database, 900, 1, 'creator/previous-work', [101, 102]);
    fixture.presentPaths.add('creator/previous-work');
    const before = rowSnapshot(fixture.database);

    const dryRun = run(fixture, true);

    expect(dryRun.activeOwnerConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'POST_ITEM_ACTIVE_OWNER_CONFLICT',
        legacyPostId: 900,
        targetSourcePath: 'creator/work-a'
      })
    ]));
    expect(() => run(fixture, false, dryRun.revision)).toThrowError(/POST_ITEM_ACTIVE_OWNER_CONFLICT/);
    expect(rowSnapshot(fixture.database)).toBe(before);
  });

  it('fails closed when one image appears in multiple desired works', () => {
    fixture.entries[1]!.items = [
      { imageId: 101, position: 1 },
      { imageId: 103, position: 2 },
      { imageId: 104, position: 3 },
      { imageId: 105, position: 4 }
    ];
    const before = rowSnapshot(fixture.database);

    const dryRun = run(fixture, true);

    expect(dryRun.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LEGACY_POST_SPLIT_AMBIGUOUS', imageIds: [101] })
    ]));
    expect(() => run(fixture, false, dryRun.revision)).toThrowError(/LEGACY_POST_SPLIT_AMBIGUOUS/);
    expect(rowSnapshot(fixture.database)).toBe(before);
  });

  it.each([
    ['caption', (database: DatabaseSync) => database.prepare("UPDATE posts SET caption = 'legacy note' WHERE id = 900").run()],
    ['like', (database: DatabaseSync) => database.prepare('INSERT INTO likes (post_id) VALUES (900)').run()],
    ['Saved collection', (database: DatabaseSync) => {
      database.prepare("INSERT INTO collections (id, slug, name, is_default) VALUES (1, 'saved', 'Saved', 1)").run();
      database.prepare('INSERT INTO collection_items (collection_id, post_id) VALUES (1, 900)').run();
    }],
    ['custom collection', (database: DatabaseSync) => {
      database.prepare("INSERT INTO collections (id, slug, name, is_default) VALUES (2, 'custom', 'Custom', 0)").run();
      database.prepare('INSERT INTO collection_items (collection_id, post_id) VALUES (2, 900)').run();
    }],
    ['trash state', (database: DatabaseSync) => database.prepare("UPDATE posts SET is_trashed = 1, trashed_at = CURRENT_TIMESTAMP WHERE id = 900").run()],
    ['manual content rating', (database: DatabaseSync) => database.prepare("UPDATE posts SET content_rating = 'R18' WHERE id = 900").run()],
    ['manual place', (database: DatabaseSync) => {
      database.prepare("INSERT INTO places (id, slug, display_name, kind, source) VALUES (1, 'place', 'Place', 'manual', 'manual')").run();
      database.prepare('UPDATE posts SET place_id = 1 WHERE id = 900').run();
    }],
    ['other Post foreign key', (database: DatabaseSync) => {
      database.exec('CREATE TABLE external_post_refs (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id))');
      database.prepare('INSERT INTO external_post_refs (id, post_id) VALUES (1, 900)').run();
    }]
  ])('requires review rather than distributing legacy %s', (_label, addState) => {
    insertPost(fixture.database, 900, 1, 'creator/merged-work', [101, 102, 103, 104, 105]);
    addState(fixture.database);
    const before = rowSnapshot(fixture.database);
    const dryRun = run(fixture, true);
    expect(dryRun.userStateConflicts[0]?.code).toBe('LEGACY_POST_SPLIT_REQUIRES_REVIEW');
    expect(() => run(fixture, false, dryRun.revision)).toThrowError(/LEGACY_POST_SPLIT_REQUIRES_REVIEW/);
    expect(rowSnapshot(fixture.database)).toBe(before);
  });

  it('blocks a legacy member that cannot be mapped to an active work', () => {
    insertImage(fixture.database, 106, 11, 'creator/work-a/unmapped.jpg');
    fixture.presentPaths.add('creator/work-a/unmapped.jpg');
    insertPost(fixture.database, 900, 1, 'creator/merged-work', [101, 102, 103, 104, 105, 106]);
    const before = rowSnapshot(fixture.database);
    const dryRun = run(fixture, true);
    expect(dryRun.unmappedItems[0]).toMatchObject({ code: 'LEGACY_POST_SPLIT_UNMAPPED_ITEM', imageIds: [106] });
    expect(() => run(fixture, false, dryRun.revision)).toThrowError(/LEGACY_POST_SPLIT_UNMAPPED_ITEM/);
    expect(rowSnapshot(fixture.database)).toBe(before);
  });

  it('blocks ownership transfer across creators', () => {
    insertFolder(fixture.database, 2, 'other-creator', 'normal');
    insertPost(fixture.database, 900, 2, 'other-creator/legacy', [101]);
    const before = rowSnapshot(fixture.database);
    const dryRun = run(fixture, true);
    expect(dryRun.conflicts.some((conflict) => conflict.code === 'LEGACY_POST_SPLIT_CROSS_CREATOR')).toBe(true);
    expect(() => run(fixture, false, dryRun.revision)).toThrowError(/LEGACY_POST_SPLIT_CROSS_CREATOR/);
    expect(rowSnapshot(fixture.database)).toBe(before);
  });

  it('rolls back all Post and item writes after a mid-transaction failure', () => {
    insertPost(fixture.database, 900, 1, 'creator/merged-work', [101, 102, 103, 104, 105]);
    const before = rowSnapshot(fixture.database);
    const dryRun = run(fixture, true);
    fixture.database.exec(`
      CREATE TRIGGER fail_split_insert
      BEFORE INSERT ON post_items
      WHEN NEW.image_id = 103
      BEGIN
        SELECT RAISE(ABORT, 'synthetic split failure');
      END;
    `);
    expect(() => run(fixture, false, dryRun.revision)).toThrowError(/synthetic split failure/);
    expect(rowSnapshot(fixture.database)).toBe(before);
  });

  it('rejects a stale dry-run revision without applying the changed plan', () => {
    insertPost(fixture.database, 900, 1, 'creator/merged-work', [101, 102, 103, 104, 105]);
    const dryRun = run(fixture, true);
    fixture.database.prepare("UPDATE posts SET updated_at = '2026-02-01T00:00:00.000Z' WHERE id = 900").run();
    const before = rowSnapshot(fixture.database);
    expect(() => run(fixture, false, dryRun.revision)).toThrowError(/LEGACY_POST_SPLIT_CONCURRENT_CHANGE/);
    expect(rowSnapshot(fixture.database)).toBe(before);
  });
});
