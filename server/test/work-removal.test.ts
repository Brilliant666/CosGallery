import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { requestTestApp } from './http-test-utils.js';

describe.sequential(
  'whole Work removal with durable identity and exact file scope',
  () => {
    let root: string,
      db: DatabaseSync,
      config: any,
      service: any,
      repo: any,
      Deletion: any,
      Interrupted: any,
      storageState: any;
    beforeEach(async () => {
      root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'cosgallery-work-removal-'),
      );
      for (const [name, value] of Object.entries({
        NODE_ENV: 'test',
        DATA_ROOT: root,
        GALLERY_ROOT: path.join(root, 'gallery'),
        DB_DIR: path.join(root, 'db'),
        THUMBNAILS_DIR: path.join(root, 'thumbnails'),
        PREVIEWS_DIR: path.join(root, 'previews'),
      }))
        vi.stubEnv(name, value);
      for (const directory of ['gallery', 'db', 'thumbnails', 'previews'])
        await fs.mkdir(path.join(root, directory), { recursive: true });
      vi.resetModules();
      db = new DatabaseSync(path.join(root, 'db', 'fixture.sqlite'));
      db.exec(schemaSql);
      (globalThis as any)[Symbol.for('foldergram.database.connection')] = db;
      storageState = { libraryAvailable: true, usingInMemoryDatabase: false };
      vi.doMock('../src/services/storage-service.js', () => ({
        storageService: { getState: () => storageState },
      }));
      config = (await import('../src/config/env.js')).appConfig;
      repo = await import('../src/db/repositories.js');
      const permanent =
        await import('../src/services/permanent-deletion-service.js');
      Deletion = permanent.PermanentDeletionService;
      Interrupted = permanent.SimulatedDeletionInterruptionError;
      service = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService();
    });
    afterEach(async () => {
      db.close();
      (globalThis as any)[Symbol.for('foldergram.database.connection')] = null;
      vi.doUnmock('../src/services/storage-service.js');
      vi.unstubAllEnvs();
      vi.resetModules();
      await fs.rm(root, { recursive: true, force: true });
    });
    async function write(file: string, contents = 'synthetic') {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
    }
    async function reopenService() {
      db.close();
      db = new DatabaseSync(path.join(root, "db", "fixture.sqlite"));
      (globalThis as any)[Symbol.for("foldergram.database.connection")] = db;
      return new (
        await import("../src/services/work-removal-service.js")
      ).WorkRemovalService();
    }
    const journalPath = (id: string) =>
      path.join(
        config.galleryRoot,
        ".foldergram-delete-quarantine",
        "journals",
        `${id}.json`,
      );
    const quarantinePath = (id: string) =>
      path.join(
        config.galleryRoot,
        ".foldergram-delete-quarantine",
        "files",
        id,
      );
    async function fixture() {
      const creatorId = Number(
        db
          .prepare(
            "INSERT INTO archive_catalog_creators(canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES('Synthetic','synthetic','test','creator')",
          )
          .run().lastInsertRowid,
      );
      const owner = repo.folderRepository.upsert({
        slug: 'synthetic',
        name: 'Synthetic',
        folderPath: 'Synthetic',
      });
      const localFolderId = Number(
        db
          .prepare(
            `INSERT INTO archive_catalog_local_creator_folders(gallery_folder_id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(?,?,?,'Synthetic',?,'Synthetic','matched',CURRENT_TIMESTAMP)`,
          )
          .run(
            owner.id,
            creatorId,
            config.galleryRoot,
            path.join(config.galleryRoot, 'Synthetic'),
          ).lastInsertRowid,
      );
      const workId = Number(
        db
          .prepare(
            "INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'Album A')",
          )
          .run(creatorId).lastInsertRowid,
      );
      const copies = [];
      for (const name of ['Copy One', 'Copy Two']) {
        const relative = `Synthetic/${name}`;
        const absolute = path.join(config.galleryRoot, relative);
        const folder = repo.folderRepository.upsert({
          slug: name.toLowerCase().replaceAll(' ', '-'),
          name,
          folderPath: relative,
          role: 'carousel_source',
          carouselOwnerFolderId: owner.id,
        });
        const images = [];
        for (const filename of ['01.jpg', '02.jpg']) {
          const relativePath = `${relative}/${filename}`;
          const absolutePath = path.join(config.galleryRoot, relativePath);
          await write(absolutePath);
          const stat = await fs.stat(absolutePath);
          await write(path.join(config.thumbnailsDir, relativePath + '.webp'));
          await write(path.join(config.previewsDir, relativePath + '.webp'));
          images.push(
            repo.imageRepository.upsert({
              folderId: folder.id,
              filename,
              extension: '.jpg',
              relativePath,
              absolutePath,
              fileSize: stat.size,
              width: 10,
              height: 10,
              mediaType: 'image',
              mimeType: 'image/jpeg',
              durationMs: null,
              fingerprint: relativePath,
              mtimeMs: stat.mtimeMs,
              firstSeenAt: new Date().toISOString(),
              sortTimestamp: 1,
              takenAt: 1,
              takenAtSource: 'mtime',
              exifJson: null,
              thumbnailPath: relativePath + '.webp',
              previewPath: relativePath + '.webp',
            }),
          );
        }
        const post = repo.postRepository.upsertPostWithItems(
          {
            folderId: owner.id,
            sourcePath: relative,
            postType: 'carousel',
            sortTimestamp: 1,
            takenAt: 1,
            takenAtSource: 'mtime',
            isDeleted: 0,
            isTrashed: 0,
          },
          images.map((i: any, n: number) => ({
            imageId: i.id,
            position: n + 1,
          })),
        );
        const localId = Number(
          db
            .prepare(
              `INSERT INTO archive_catalog_local_works(local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,image_count,total_bytes,match_status,scanned_at,identity_policy) VALUES(?,?,?,?,?,?,2,18,'matched',CURRENT_TIMESTAMP,'manual')`,
            )
            .run(localFolderId, workId, post.id, name, absolute, name)
            .lastInsertRowid,
        );
        await write(path.join(absolute, 'notes.txt'), 'private attachment');
        copies.push({ localId, post, images, absolute, relative });
      }
      db.prepare(
        'UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=?',
      ).run(copies[0].localId, workId);
      return { creatorId, workId, copies };
    }
    async function act(workId: number, mode: string) {
      const p = await service.preview(workId, mode);
      expect(p.blockers).toEqual([]);
      return service.execute(workId, p.previewToken);
    }
    it('recycles and restores every local copy while retaining an already recycled media item', async () => {
      const f = await fixture();
      const item = f.copies[0].images[1];
      const post = f.copies[0].post;
      const media = new (
        await import('../src/services/media-trash-service.js')
      ).MediaTrashService();
      await media.trash(post.id, item.id);
      const preview = await service.preview(f.workId, 'trash');
      expect(preview.localCopies).toHaveLength(2);
      expect(preview.fileCount).toBe(6);
      await service.execute(f.workId, preview.previewToken);
      expect(
        db.prepare('SELECT is_trashed FROM posts ORDER BY id').all(),
      ).toEqual([{ is_trashed: 1 }, { is_trashed: 1 }]);
      expect(service.listTrash().items).toHaveLength(1);
      for (const c of f.copies)
        expect(
          await fs.readFile(path.join(c.absolute, 'notes.txt'), 'utf8'),
        ).toBe('private attachment');
      await act(f.workId, 'restore');
      expect(db.prepare('SELECT COUNT(*) n FROM work_removals').get()).toEqual({
        n: 0,
      });
      expect(
        db
          .prepare('SELECT is_trashed,is_deleted FROM images WHERE id=?')
          .get(item.id),
      ).toEqual({ is_trashed: 1, is_deleted: 1 });
      expect(db.prepare('SELECT COUNT(*) n FROM post_items').get()).toEqual({
        n: 3,
      });
      expect(await media.restore(post.id, item.id)).toMatchObject({
        remainingMediaCount: 2,
        postTrashed: false,
      });
      expect(
        db
          .prepare(
            'SELECT image_id FROM post_items WHERE post_id=? ORDER BY position',
          )
          .all(post.id),
      ).toEqual(f.copies[0].images.map((i: any) => ({ image_id: i.id })));
    });
    it('permanently removes all copies, original files and attachments but preserves Work and LocalWork IDs', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      const result = await act(f.workId, 'permanent');
      expect(result).toMatchObject({ state: 'completed', filesRemoved: true });
      expect(
        db
          .prepare('SELECT id FROM archive_catalog_works WHERE id=?')
          .get(f.workId),
      ).toBeDefined();
      expect(
        db
          .prepare(
            'SELECT post_id,is_active FROM archive_catalog_local_works ORDER BY id',
          )
          .all(),
      ).toEqual([
        { post_id: null, is_active: 0 },
        { post_id: null, is_active: 0 },
      ]);
      expect(db.prepare('SELECT COUNT(*) n FROM posts').get()).toEqual({
        n: 0,
      });
      expect(db.prepare('SELECT COUNT(*) n FROM images').get()).toEqual({
        n: 0,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      for (const c of f.copies)
        await expect(fs.stat(c.absolute)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      expect((await service.preview(f.workId, 'restore')).canExecute).toBe(
        false,
      );
    });
    it('requires the recycle bin for permanent deletion and protects the old Post delete path', async () => {
      const f = await fixture();
      expect((await service.preview(f.workId, 'permanent')).canExecute).toBe(
        false,
      );
      await expect(
        new Deletion().deletePost(f.copies[0].post.id),
      ).rejects.toThrow('whole-Work');
      expect(db.prepare('SELECT COUNT(*) n FROM posts').get()).toEqual({
        n: 2,
      });
    });
    it('rejects stale plans if files or membership change before confirmation', async () => {
      const f = await fixture();
      const p = await service.preview(f.workId, 'trash');
      await write(path.join(f.copies[0].absolute, 'new.txt'));
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        '变化',
      );
      expect(db.prepare('SELECT COUNT(*) n FROM work_removals').get()).toEqual({
        n: 0,
      });
    });
    it('does not restore changed originals', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      await write(
        path.join(f.copies[0].absolute, '01.jpg'),
        'changed original',
      );
      const p = await service.preview(f.workId, 'restore');
      expect(p.canExecute).toBe(false);
      expect(p.blockers.join(' ')).toContain('变化');
    });
    it('rolls back all quarantined files when an ordinary precommit failure occurs', async () => {
      const f = await fixture();
      const media = new (
        await import('../src/services/media-trash-service.js')
      ).MediaTrashService();
      const post = f.copies[0].post,
        item = f.copies[0].images[1];
      await media.trash(post.id, item.id);
      await act(f.workId, 'trash');
      service = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterQuarantine: () => {
            throw Error('synthetic interruption');
          },
        }),
      );
      const p = await service.preview(f.workId, 'permanent');
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        'synthetic interruption',
      );
      for (const c of f.copies)
        expect(
          await fs.readFile(path.join(c.absolute, 'notes.txt'), 'utf8'),
        ).toBe('private attachment');
      expect(db.prepare('SELECT state FROM work_removals').get()).toEqual({
        state: 'trashed',
      });
      const restoredStat = await fs.stat(
        path.join(f.copies[0].absolute, item.filename),
      );
      const originalIdentity = JSON.parse(
        String(
          db
            .prepare(
              'SELECT original_file_identity FROM media_trash_entries WHERE image_id=?',
            )
            .get(item.id)!.original_file_identity,
        ),
      );
      expect([
        restoredStat.dev,
        restoredStat.ino,
        restoredStat.size,
        restoredStat.mtimeMs,
      ]).toEqual(originalIdentity.slice(0, 4));
      await act(f.workId, 'restore');
      expect(await media.restore(post.id, item.id)).toMatchObject({
        remainingMediaCount: 2,
        postTrashed: false,
      });
    });
    it('recovers an interruption after commit by cleaning files without reviving identity', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      service = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterDatabaseCommit: () => {
            throw new Interrupted();
          },
        }),
      );
      const p = await service.preview(f.workId, 'permanent');
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        'Simulated',
      );
      expect(service.status(p.previewToken).state).toBe('committed');
      await new Deletion().recoverPendingDeletions();
      expect(service.status(p.previewToken)).toMatchObject({
        state: 'completed',
        filesRemoved: true,
      });
      expect(db.prepare('SELECT state FROM work_removals').get()).toEqual({
        state: 'deleted',
      });
    });
    it('rejects overlapping other-Work ownership before moving anything', async () => {
      const f = await fixture();
      const other = Number(
        db
          .prepare(
            "INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'Other')",
          )
          .run(f.creatorId).lastInsertRowid,
      );
      const local = db
        .prepare('SELECT * FROM archive_catalog_local_works LIMIT 1')
        .get()!;
      db.prepare(
        `INSERT INTO archive_catalog_local_works(local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(?,?,'overlap',?,'overlap','matched',CURRENT_TIMESTAMP)`,
      ).run(
        local.local_creator_folder_id,
        other,
        path.join(String(local.absolute_path), 'nested'),
      );
      expect(
        (await service.preview(f.workId, 'trash')).blockers.join(' '),
      ).toContain('重叠');
    });
    it('keeps removed Work absent from rebuilt and cached resource catalog', async () => {
      const f = await fixture();
      const { ResourceCatalogBuilder } =
        await import('../src/services/resource-catalog-builder.js');
      expect(
        new ResourceCatalogBuilder(db).generate(f.creatorId).page.items,
      ).toHaveLength(1);
      await act(f.workId, 'trash');
      expect(
        new ResourceCatalogBuilder(db).generate(f.creatorId).page.items,
      ).toHaveLength(0);
    });
    it('protects every Work HTTP operation with media deletion capability and keeps unrelated API routes usable', async () => {
      const f = await fixture();
      const app = (await import('../src/app.js')).createApp();
      const { authService } = await import('../src/services/auth-service.js');
      authService.setAdminPassword('isolated-admin-only');
      authService.setViewerAccess('password', 'isolated-viewer-only');
      const headers = { 'x-foldergram-intent': '1' };
      const login = await requestTestApp(
        app,
        'POST',
        '/api/auth/login',
        headers,
        { password: 'isolated-viewer-only' },
      );
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const endpoints = [
        ['POST', `/api/works/${f.workId}/removal-preview`, { mode: 'trash' }],
        [
          'POST',
          `/api/works/${f.workId}/removal`,
          { previewToken: '00000000-0000-4000-8000-000000000001' },
        ],
        ['GET', '/api/trash/works', undefined],
        [
          'GET',
          '/api/work-removal-operations/00000000-0000-4000-8000-000000000001',
          undefined,
        ],
        [
          'POST',
          '/api/work-removal-operations/00000000-0000-4000-8000-000000000001/retry',
          undefined,
        ],
      ] as const;
      for (const [method, url, body] of endpoints) {
        expect(
          (await requestTestApp(app, method, url, headers, body)).status,
        ).toBe(401);
        expect(
          (await requestTestApp(app, method, url, { ...headers, cookie }, body))
            .status,
        ).toBe(403);
      }
      expect(
        db.prepare('SELECT COUNT(*) n FROM removal_operations').get(),
      ).toEqual({ n: 0 });
    });
    it('blocks legacy displayed copies until their Post identity is explicitly linked', async () => {
      const f = await fixture();
      db.prepare(
        'UPDATE archive_catalog_local_works SET post_id=NULL WHERE id=?',
      ).run(f.copies[0].localId);
      expect(
        (await service.preview(f.workId, 'trash')).blockers.join(' '),
      ).toContain('尚未关联');
    });
    it('rolls back if a new file appears during quarantine', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      service = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterQuarantine: async () => {
            await write(
              path.join(f.copies[0].absolute, 'late.txt'),
              'new user file',
            );
          },
        }),
      );
      const p = await service.preview(f.workId, 'permanent');
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        '新文件',
      );
      expect(
        await fs.readFile(path.join(f.copies[0].absolute, 'late.txt'), 'utf8'),
      ).toBe('new user file');
      expect(
        await fs.readFile(path.join(f.copies[0].absolute, '01.jpg'), 'utf8'),
      ).toBe('synthetic');
    });
    it('rechecks shared ownership inside the commit transaction after filesystem awaits', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      service = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterQuarantine: () => {
            const local = db
              .prepare('SELECT * FROM archive_catalog_local_works LIMIT 1')
              .get()!;
            const other = Number(
              db
                .prepare(
                  "INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,'Concurrent other identity')",
                )
                .run(f.creatorId).lastInsertRowid,
            );
            db.prepare(
              `INSERT INTO archive_catalog_local_works(local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(?,?,'concurrent',?,'concurrent','matched',CURRENT_TIMESTAMP)`,
            ).run(
              local.local_creator_folder_id,
              other,
              path.join(String(local.absolute_path), 'concurrent'),
            );
          },
        }),
      );
      const p = await service.preview(f.workId, 'permanent');
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        '共享引用',
      );
      expect(
        await fs.readFile(path.join(f.copies[0].absolute, '01.jpg'), 'utf8'),
      ).toBe('synthetic');
      expect(db.prepare('SELECT state FROM work_removals').get()).toEqual({
        state: 'trashed',
      });
    });
    it('blocks a replay while an interrupted precommit quarantine still needs recovery', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      service = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterQuarantine: () => {
            throw new Interrupted();
          },
        }),
      );
      const p = await service.preview(f.workId, 'permanent');
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        'Simulated',
      );
      expect(service.status(p.previewToken)).toMatchObject({
        state: 'recovery_pending',
        recoveryPending: true,
      });
      expect((await service.preview(f.workId, 'permanent')).canExecute).toBe(
        false,
      );
      expect(service.listTrash().pendingOperations).toEqual([
        expect.objectContaining({
          operationId: p.previewToken,
          state: 'recovery_pending',
        }),
      ]);
      await service.retry(p.previewToken);
      expect(service.status(p.previewToken).state).toBe('failed');
      expect(service.listTrash().pendingOperations).toEqual([]);
      expect(
        await fs.readFile(path.join(f.copies[0].absolute, '01.jpg'), 'utf8'),
      ).toBe('synthetic');
    });
    it('lists and retries cleanup after a committed Work disappears from trash, without touching other journals', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      const engine = new Deletion();
      vi.spyOn(engine as any, 'cleanupCommittedJournal').mockRejectedValueOnce(
        new Error('Synthetic disk cleanup failure'),
      );
      service = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService(undefined, engine);
      const p = await service.preview(f.workId, 'permanent');
      expect(await service.execute(f.workId, p.previewToken)).toMatchObject({
        state: 'cleanup_pending',
        cleanupPending: true,
        filesRemoved: false,
      });
      const freshService = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService();
      const trash = freshService.listTrash();
      expect(trash.items).toEqual([]);
      expect(trash.pendingOperations).toEqual([
        expect.objectContaining({
          operationId: p.previewToken,
          title: 'Album A',
          state: 'cleanup_pending',
        }),
      ]);
      const unrelated = path.join(
        config.galleryRoot,
        '.foldergram-delete-quarantine',
        'journals',
        '00000000-0000-4000-8000-000000000009.json',
      );
      await write(unrelated, 'unrelated journal must not even be parsed');
      expect(await freshService.retry(p.previewToken)).toMatchObject({
        state: 'completed',
        filesRemoved: true,
        cleanupPending: false,
      });
      expect(await fs.readFile(unrelated, 'utf8')).toBe(
        'unrelated journal must not even be parsed',
      );
      expect(freshService.listTrash().pendingOperations).toEqual([]);
      expect(await freshService.retry(p.previewToken)).toMatchObject({
        state: 'completed', filesRemoved: true, cleanupPending: false,
      });
      expect(db.prepare('SELECT state FROM work_removals').get()).toEqual({
        state: 'deleted',
      });
    });
    it("recovers after the journal is removed but the final database write fails", async () => {
      const f = await fixture();
      await act(f.workId, "trash");
      const p = await service.preview(f.workId, "permanent");
      db.exec(`CREATE TRIGGER fail_finalization BEFORE UPDATE OF state ON removal_operations
        WHEN NEW.state='completed' AND NEW.mode='permanent'
        BEGIN SELECT RAISE(ABORT,'Synthetic final database write failure'); END`);
      expect(await service.execute(f.workId, p.previewToken)).toMatchObject({
        state: "cleanup_pending",
        cleanupPending: true,
        filesRemoved: true,
      });
      const journal = path.join(
        config.galleryRoot,
        ".foldergram-delete-quarantine",
        "journals",
        `${p.previewToken}.json`,
      );
      await expect(fs.stat(journal)).rejects.toMatchObject({ code: "ENOENT" });
      db.exec("DROP TRIGGER fail_finalization");
      db.close();
      db = new DatabaseSync(path.join(root, "db", "fixture.sqlite"));
      (globalThis as any)[Symbol.for("foldergram.database.connection")] = db;
      const fresh = new (
        await import("../src/services/work-removal-service.js")
      ).WorkRemovalService();
      expect(await fresh.retry(p.previewToken)).toMatchObject({
        state: "completed",
        filesRemoved: true,
        cleanupPending: false,
      });
      expect(fresh.listTrash().pendingOperations).toEqual([]);
      await expect(
        fs.stat(path.join(f.copies[0].absolute, "01.jpg")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it.each([
      ["afterMediaCleanup", false, true],
      ["afterMediaCleanupReceipt", true, true],
      ["afterJournalRemoval", true, false],
    ] as const)(
      "survives process interruption at %s with durable evidence",
      async (hook, filesRemoved, journalExists) => {
        const f = await fixture();
        await act(f.workId, "trash");
        const engine = new Deletion({
          [hook]: () => {
            throw new Interrupted();
          },
        });
        service = new (
          await import("../src/services/work-removal-service.js")
        ).WorkRemovalService(undefined, engine);
        const p = await service.preview(f.workId, "permanent");
        await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
          "Simulated",
        );
        const fresh = await reopenService();
        expect(fresh.status(p.previewToken)).toMatchObject({
          state: "committed",
          filesRemoved,
          cleanupPending: true,
        });
        expect(
          Boolean(await fs.stat(journalPath(p.previewToken)).catch(() => null)),
        ).toBe(journalExists);
        await expect(
          fs.stat(quarantinePath(p.previewToken)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const replacement = path.join(f.copies[0].absolute, "01.jpg");
        await write(replacement, "new original after committed deletion");
        await new Deletion().recoverPendingDeletions();
        expect(fresh.status(p.previewToken)).toMatchObject({
          state: "completed",
          filesRemoved: true,
          cleanupPending: false,
        });
        await new Deletion().recoverPendingDeletions();
        expect(await fresh.retry(p.previewToken)).toMatchObject({
          state: "completed",
        });
        expect(await fresh.execute(f.workId, p.previewToken)).toMatchObject({
          state: "completed",
        });
        expect(fresh.listTrash().pendingOperations).toEqual([]);
        expect(await fs.readFile(replacement, "utf8")).toBe(
          "new original after committed deletion",
        );
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n FROM archive_catalog_work_decisions WHERE work_id=? AND kind='work_permanent'",
            )
            .get(f.workId),
        ).toEqual({ n: 1 });
      },
    );
    it("retains the journal if saving the media cleanup receipt fails", async () => {
      const f = await fixture();
      await act(f.workId, "trash");
      const p = await service.preview(f.workId, "permanent");
      db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF payload_json ON removal_operations
        WHEN json_extract(NEW.payload_json,'$.mediaCleanupReceipt') IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'Synthetic receipt write failure'); END`);
      expect(await service.execute(f.workId, p.previewToken)).toMatchObject({
        state: "cleanup_pending",
        filesRemoved: false,
        cleanupPending: true,
      });
      expect((await fs.stat(journalPath(p.previewToken))).isFile()).toBe(true);
      await expect(
        fs.stat(quarantinePath(p.previewToken)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      db.exec("DROP TRIGGER fail_receipt");
      const fresh = await reopenService();
      expect(await fresh.retry(p.previewToken)).toMatchObject({
        state: "completed",
        filesRemoved: true,
        cleanupPending: false,
      });
    });
    it.each(["marker unlink", "journal unlink", "journal directory sync"])(
      "recovers a %s failure after the media receipt",
      async (stage) => {
        const f = await fixture();
        await act(f.workId, "trash");
        let armed = false;
        const engine = new Deletion({
          afterMediaCleanupReceipt: () => {
            armed = true;
          },
        });
        const unlink = engine.unlinkInternalFileIfPresent.bind(engine);
        vi.spyOn(engine, "unlinkInternalFileIfPresent").mockImplementation(
          (...args: any[]) => {
            if (
              armed &&
              ((stage === "marker unlink" &&
                args[2] === "Deletion move marker") ||
                (stage === "journal unlink" && args[2] === "Deletion journal"))
            )
              throw new Error(`Synthetic ${stage}`);
            return unlink(...args);
          },
        );
        const sync = engine.syncDirectoryIfSupported.bind(engine);
        vi.spyOn(engine, "syncDirectoryIfSupported").mockImplementation(
          async (directory: any) => {
            if (
              armed &&
              stage === "journal directory sync" &&
              directory === path.dirname(journalPath("unused"))
            )
              throw new Error("Synthetic journal directory sync");
            return sync(directory);
          },
        );
        service = new (
          await import("../src/services/work-removal-service.js")
        ).WorkRemovalService(undefined, engine);
        const p = await service.preview(f.workId, "permanent");
        expect(await service.execute(f.workId, p.previewToken)).toMatchObject({
          state: "cleanup_pending",
          filesRemoved: true,
          cleanupPending: true,
        });
        const fresh = await reopenService();
        expect(fresh.listTrash().pendingOperations).toEqual([
          expect.objectContaining({
            operationId: p.previewToken,
            filesRemoved: true,
            cleanupPending: true,
          }),
        ]);
        expect(
          Boolean(await fs.stat(journalPath(p.previewToken)).catch(() => null)),
        ).toBe(stage !== "journal directory sync");
        const unrelated = journalPath("00000000-0000-4000-8000-000000000009");
        await write(unrelated, "other operation");
        expect(await fresh.retry(p.previewToken)).toMatchObject({
          state: "completed",
          filesRemoved: true,
          cleanupPending: false,
        });
        expect(await fs.readFile(unrelated, "utf8")).toBe("other operation");
        expect(fresh.listTrash().pendingOperations).toEqual([]);
      },
    );
    it("resumes partial committed media cleanup without claiming remaining files were removed", async () => {
      const f = await fixture();
      await act(f.workId, "trash");
      const engine = new Deletion();
      const unlink = engine.unlinkValidatedFile.bind(engine);
      let count = 0;
      vi.spyOn(engine, "unlinkValidatedFile").mockImplementation(
        (...args: any[]) => {
          if (++count === 2) throw new Error("Synthetic partial media unlink");
          return unlink(...args);
        },
      );
      service = new (
        await import("../src/services/work-removal-service.js")
      ).WorkRemovalService(undefined, engine);
      const p = await service.preview(f.workId, "permanent");
      expect(await service.execute(f.workId, p.previewToken)).toMatchObject({
        state: "cleanup_pending",
        filesRemoved: false,
        cleanupPending: true,
      });
      const journal = JSON.parse(
        await fs.readFile(journalPath(p.previewToken), "utf8"),
      );
      let remaining = 0;
      for (const entry of journal.entries) {
        const rootPath =
          entry.root === "gallery"
            ? config.galleryRoot
            : entry.root === "thumbnails"
              ? config.thumbnailsDir
              : config.previewsDir;
        if (
          await fs
            .stat(path.join(rootPath, entry.quarantineRelativePath))
            .catch(() => null)
        )
          remaining++;
      }
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(
        journal.entries.filter((e: any) => e.wasPresent).length,
      );
      const fresh = await reopenService();
      expect(await fresh.retry(p.previewToken)).toMatchObject({
        state: "completed",
        filesRemoved: true,
        cleanupPending: false,
      });
      expect(db.prepare("SELECT state FROM work_removals").get()).toEqual({
        state: "deleted",
      });
    });
    it.each(["changed identity", "unknown material", "missing journal"])(
      "blocks committed cleanup with %s and preserves unexplained files",
      async (failure) => {
        const f = await fixture();
        await act(f.workId, "trash");
        let evidence = "";
        const engine = new Deletion({
          afterDatabaseCommit: async (journal: any) => {
            const entry = journal.entries.find(
              (e: any) => e.root === "gallery" && e.wasPresent,
            );
            evidence = path.join(
              config.galleryRoot,
              entry.quarantineRelativePath,
            );
            if (failure === "changed identity")
              await fs.writeFile(evidence, "different identity; must survive");
            if (failure === "unknown material") {
              evidence = path.join(
                quarantinePath(journal.operationId),
                "unknown",
              );
              await write(evidence, "unknown; must survive");
            }
            if (failure === "missing journal") {
              await fs.unlink(journalPath(journal.operationId));
              throw new Interrupted();
            }
          },
        });
        service = new (
          await import("../src/services/work-removal-service.js")
        ).WorkRemovalService(undefined, engine);
        const p = await service.preview(f.workId, "permanent");
        if (failure === "missing journal")
          await expect(
            service.execute(f.workId, p.previewToken),
          ).rejects.toThrow("Simulated");
        else
          expect(await service.execute(f.workId, p.previewToken)).toMatchObject(
            { state: "cleanup_pending", filesRemoved: false },
          );
        const before = await fs.readFile(evidence, "utf8");
        const fresh = await reopenService();
        expect(await fresh.retry(p.previewToken)).toMatchObject({
          filesRemoved: false,
          cleanupPending: true,
        });
        expect(await fs.readFile(evidence, "utf8")).toBe(before);
        expect(fresh.listTrash().pendingOperations).toHaveLength(1);
        if (failure === "missing journal")
          expect(fresh.status(p.previewToken).message).toContain("没有可验证");
      },
    );
    it("rejects a cleanup receipt whose confirmed snapshot has changed", async () => {
      const f = await fixture();
      await act(f.workId, "trash");
      service = new (
        await import("../src/services/work-removal-service.js")
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterJournalRemoval: () => {
            throw new Interrupted();
          },
        }),
      );
      const p = await service.preview(f.workId, "permanent");
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        "Simulated",
      );
      const row = db
        .prepare(
          "SELECT payload_json FROM removal_operations WHERE operation_id=?",
        )
        .get(p.previewToken)!;
      const payload = JSON.parse(String(row.payload_json));
      payload.snapshot.files[0].identity = "unverified replacement";
      db.prepare(
        "UPDATE removal_operations SET payload_json=? WHERE operation_id=?",
      ).run(JSON.stringify(payload), p.previewToken);
      const fresh = await reopenService();
      expect(await fresh.retry(p.previewToken)).toMatchObject({
        state: "committed",
        filesRemoved: false,
        cleanupPending: true,
      });
      expect(fresh.status(p.previewToken).message).toContain(
        "凭据与原确认范围不符",
      );
    });
    it("rejects a receipt with a damaged marker count even without its journal", async () => {
      const f = await fixture();
      await act(f.workId, "trash");
      service = new (
        await import("../src/services/work-removal-service.js")
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterMediaCleanupReceipt: () => {
            throw new Interrupted();
          },
        }),
      );
      const p = await service.preview(f.workId, "permanent");
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        "Simulated",
      );
      const marker = path.join(
        path.dirname(journalPath(p.previewToken)),
        `${p.previewToken}.0.moved`,
      );
      const before = await fs.readFile(marker, "utf8");
      await fs.unlink(journalPath(p.previewToken));
      const payload = JSON.parse(
        String(
          db
            .prepare(
              "SELECT payload_json FROM removal_operations WHERE operation_id=?",
            )
            .get(p.previewToken)!.payload_json,
        ),
      );
      payload.mediaCleanupReceipt.entryCount = 0;
      db.prepare(
        "UPDATE removal_operations SET payload_json=? WHERE operation_id=?",
      ).run(JSON.stringify(payload), p.previewToken);
      const fresh = await reopenService();
      expect(await fresh.retry(p.previewToken)).toMatchObject({
        state: "committed",
        filesRemoved: false,
        cleanupPending: true,
      });
      expect(await fs.readFile(marker, "utf8")).toBe(before);
      expect(fresh.listTrash().pendingOperations).toHaveLength(1);
    });
    it("preserves offline startup without journals and refuses offline recovery with a journal", async () => {
      storageState.usingInMemoryDatabase = true;
      const offlineRoot = path.join(root, 'gallery-offline');
      await fs.rename(config.galleryRoot, offlineRoot);
      await expect(new Deletion().recoverPendingDeletions()).resolves.toBeUndefined();
      await fs.rename(offlineRoot, config.galleryRoot);
      await expect(
        new Deletion().recoverPendingDeletions(),
      ).resolves.toBeUndefined();
      const filename = journalPath("00000000-0000-4000-8000-000000000009");
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await expect(
        new Deletion().recoverPendingDeletions(),
      ).resolves.toBeUndefined();
      await write(filename, "offline recovery material");
      await expect(new Deletion().recoverPendingDeletions()).rejects.toThrow(
        "offline",
      );
      expect(await fs.readFile(filename, "utf8")).toBe(
        "offline recovery material",
      );
    });
    it("reports receipted cleanup consistently through status, trash and retry HTTP routes", async () => {
      const f = await fixture();
      await act(f.workId, "trash");
      service = new (
        await import("../src/services/work-removal-service.js")
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterJournalRemoval: () => {
            throw new Interrupted();
          },
        }),
      );
      const p = await service.preview(f.workId, "permanent");
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        "Simulated",
      );
      await reopenService();
      const app = (await import("../src/app.js")).createApp();
      const headers = { "x-foldergram-intent": "1" };
      const status = await requestTestApp(
        app,
        "GET",
        `/api/work-removal-operations/${p.previewToken}`,
        headers,
      );
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        state: "committed",
        filesRemoved: true,
        cleanupPending: true,
      });
      const trash = await requestTestApp(
        app,
        "GET",
        "/api/trash/works",
        headers,
      );
      expect(trash.body).toMatchObject({
        pendingOperations: [
          {
            operationId: p.previewToken,
            filesRemoved: true,
            cleanupPending: true,
          },
        ],
      });
      const retry = await requestTestApp(
        app,
        "POST",
        `/api/work-removal-operations/${p.previewToken}/retry`,
        headers,
      );
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({
        state: "completed",
        filesRemoved: true,
        cleanupPending: false,
      });
      expect(
        (await requestTestApp(app, "GET", "/api/trash/works", headers)).body,
      ).toMatchObject({ pendingOperations: [] });
    });
    it('keeps blocked startup recovery and retries visible instead of overwriting a new original', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      service = new (
        await import('../src/services/work-removal-service.js')
      ).WorkRemovalService(
        undefined,
        new Deletion({
          afterQuarantine: () => {
            throw new Interrupted();
          },
        }),
      );
      const p = await service.preview(f.workId, 'permanent');
      await expect(service.execute(f.workId, p.previewToken)).rejects.toThrow(
        'Simulated',
      );
      await write(path.join(f.copies[0].absolute, '01.jpg'), 'new occupant');
      db.prepare(
        "UPDATE removal_operations SET state='executing' WHERE operation_id=?",
      ).run(p.previewToken);
      await new Deletion().recoverPendingDeletions();
      expect(service.status(p.previewToken)).toMatchObject({
        state: 'recovery_pending',
        recoveryPending: true,
      });
      const result = await service.retry(p.previewToken);
      expect(result).toMatchObject({
        state: 'recovery_pending',
        recoveryPending: true,
      });
      expect(result.message).toContain('Unable to restore');
      expect(service.listTrash().pendingOperations).toHaveLength(1);
      expect(
        await fs.readFile(path.join(f.copies[0].absolute, '01.jpg'), 'utf8'),
      ).toBe('new occupant');
    });
    it('resolves an executing operation without a journal only after proving originals unchanged and quarantine empty', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      const p = await service.preview(f.workId, 'permanent');
      db.prepare(
        "UPDATE removal_operations SET state='executing' WHERE operation_id=?",
      ).run(p.previewToken);
      await new Deletion().recoverPendingDeletions();
      expect(service.status(p.previewToken).state).toBe('failed');
      expect((await service.preview(f.workId, 'permanent')).canExecute).toBe(
        true,
      );
      expect(
        await fs.readFile(path.join(f.copies[0].absolute, '01.jpg'), 'utf8'),
      ).toBe('synthetic');
      db.prepare(
        "UPDATE removal_operations SET state='committed' WHERE operation_id=?",
      ).run(p.previewToken);
      await new Deletion().recoverPendingDeletions();
      expect(service.status(p.previewToken)).toMatchObject({
        state: 'committed',
        filesRemoved: false,
      });
    });
    it('keeps executing operations pending when their journal is lost but quarantine files remain', async () => {
      const f = await fixture();
      await act(f.workId, 'trash');
      const p = await service.preview(f.workId, 'permanent');
      db.prepare(
        "UPDATE removal_operations SET state='executing' WHERE operation_id=?",
      ).run(p.previewToken);
      const material = path.join(
        config.galleryRoot,
        '.foldergram-delete-quarantine',
        'files',
        p.previewToken,
        'unexplained-file',
      );
      await write(material, 'recovery evidence');
      await new Deletion().recoverPendingDeletions();
      expect(service.status(p.previewToken)).toMatchObject({
        state: 'recovery_pending',
        recoveryPending: true,
      });
      expect(await fs.readFile(material, 'utf8')).toBe('recovery evidence');
    });
    it('blocks preview, confirmed execution and retry while library storage is unavailable', async () => {
      const f = await fixture();
      const p = await service.preview(f.workId, 'trash');
      storageState.libraryAvailable = false;
      await expect(service.preview(f.workId, 'trash')).rejects.toMatchObject({
        status: 503,
        code: 'STORAGE_UNAVAILABLE',
      });
      await expect(
        service.execute(f.workId, p.previewToken),
      ).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
      await expect(service.retry(p.previewToken)).rejects.toMatchObject({
        status: 503,
        code: 'STORAGE_UNAVAILABLE',
      });
      expect(db.prepare('SELECT COUNT(*) n FROM work_removals').get()).toEqual({
        n: 0,
      });
      expect(
        await fs.readFile(path.join(f.copies[0].absolute, '01.jpg'), 'utf8'),
      ).toBe('synthetic');
    });
  },
);
