import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';
describe.sequential('read-only own resource catalog', () => {
  let root: string;
  let db: (typeof import('../src/db/database.js'))['databaseManager'];
  let repos: typeof import('../src/db/repositories.js');
  let service: import('../src/services/resource-catalog-service.js').ResourceCatalogService;
  let publishedService: import('../src/services/resource-catalog-service.js').ResourceCatalogService;
  let app: express.Application;
  let auth: (typeof import('../src/services/auth-service.js'))['authService'];
  let generate: (creatorId: number) => void;
  let flush: () => void;
  const samples: Array<{
    work: number;
    local: number;
    post: number;
    image: number;
  }> = [];
  let add: (
    creator: number,
    title: string,
    time: number,
    existingWork?: number,
  ) => (typeof samples)[number];
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-catalog-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COS_GALLERY_MODE', '1');
    for (const key of [
      'DATA_ROOT',
      'GALLERY_ROOT',
      'DB_DIR',
      'THUMBNAILS_DIR',
      'PREVIEWS_DIR',
    ]) {
      const directory = path.join(root, key);
      await fs.mkdir(directory, { recursive: true });
      vi.stubEnv(key, directory);
    }
    vi.resetModules();
    ({ databaseManager: db } = await import('../src/db/database.js'));
    repos = await import('../src/db/repositories.js');
    const { ResourceCatalogService } =
      await import('../src/services/resource-catalog-service.js');
    const { ResourceCatalogBuilder } = await import('../src/services/resource-catalog-builder.js');
    const { ResourceCatalogReadModel } = await import('../src/services/resource-catalog-read-model.js');
    generate = creatorId => { new ResourceCatalogBuilder(db.connection).generate(creatorId); };
    // These legacy contract tests explicitly finish background publication after
    // fixture writes. Production reads never generate; lifecycle tests cover stale reads.
    flush = () => {
      const model = new ResourceCatalogReadModel(db.connection);
      for (const creator of model.pending(10000)) model.rebuildCreator(creator);
    };
    const reader = new ResourceCatalogService();
    publishedService = reader;
    service = new Proxy(reader, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (...args: unknown[]) => { flush(); return value.apply(target, args); }
          : value;
      },
    });
    ({ authService: auth } = await import('../src/services/auth-service.js'));
    app = (await import('../src/app.js')).createApp();
    db.connection
      .exec(`INSERT INTO archive_catalog_creators (id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES (1,'测试博主','test','test','1'),(2,'Other','other','test','2');`);
    for (const creator of [1, 2]) {
      const folder = repos.folderRepository.upsert({
        slug: `creator-${creator}`,
        name: `Creator${creator}`,
        folderPath: `Creator${creator}`,
      });
      db.connection
        .prepare(
          `INSERT INTO archive_catalog_local_creator_folders
        (id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
        VALUES (?,?,?,?,?,?,?,'matched','2026-01-01')`,
        )
        .run(
          creator,
          creator,
          folder.id,
          root,
          `Creator${creator}`,
          path.join(root, `Creator${creator}`),
          `Creator${creator}`,
        );
    }
    let sequence = 0;
    add = (creator, title, time, existingWork) => {
      const seq = ++sequence;
      const folderId = Number(
        db.connection
          .prepare(
            'SELECT gallery_folder_id id FROM archive_catalog_local_creator_folders WHERE id=?',
          )
          .get(creator)!.id,
      );
      const work =
        existingWork ??
        Number(
          db.connection
            .prepare(
              'INSERT INTO archive_catalog_works(creator_id,display_title) VALUES (?,?)',
            )
            .run(creator, title).lastInsertRowid,
        );
      const directory = `Original-${seq}`;
      const sourcePath = `Creator${creator}/${directory}`;
      const source = repos.folderRepository.upsert({
        slug: `source-${seq}`,
        name: directory,
        folderPath: sourcePath,
        role: 'carousel_source',
        carouselOwnerFolderId: folderId,
      });
      const image = repos.imageRepository.upsert({
        folderId: source.id,
        filename: `${seq}.jpg`,
        extension: '.jpg',
        relativePath: `${sourcePath}/image.jpg`,
        absolutePath: path.join(root, sourcePath, 'image.jpg'),
        fileSize: 1234,
        width: 20,
        height: 30,
        mediaType: 'image',
        mimeType: 'image/jpeg',
        durationMs: null,
        isAnimated: false,
        fingerprint: `image-${seq}`,
        mtimeMs: time,
        firstSeenAt: '2026-01-01',
        sortTimestamp: time,
        takenAt: null,
        takenAtSource: 'mtime',
        exifJson: null,
        thumbnailPath: `${seq}.webp`,
        previewPath: `${seq}.webp`,
        playbackStrategy: 'preview',
      });
      const post = repos.postRepository.upsertPostWithItems(
        {
          folderId,
          sourcePath,
          postType: 'single',
          sortTimestamp: time,
          takenAt: null,
          takenAtSource: 'mtime',
        },
        [{ imageId: image.id, position: 1 }],
      );
      const local = Number(
        db.connection
          .prepare(
            `INSERT INTO archive_catalog_local_works
        (local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,match_status,scanned_at,total_bytes,other_file_count)
        VALUES (?,?,?,?,?,?,'matched','2026-01-01',9999999,2)`,
          )
          .run(
            creator,
            work,
            post.id,
            directory,
            path.join(root, sourcePath),
            directory,
          ).lastInsertRowid,
      );
      if (!existingWork)
        db.connection
          .prepare(
            'UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=?',
          )
          .run(local, work);
      return { work, local, post: post.id, image: image.id };
    };
    for (let n = 0; n < 1005; n++)
      samples.push(
        add(1, n < 2 ? 'Same title' : `Title ${n}`, 1000 + Math.floor(n / 2)),
      );
    add(2, 'Separate', 1000);
  }, 60000);
  afterAll(async () => {
    db?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('reports uninitialized scope without generating rows or exporting a partial catalog', () => {
    const page = publishedService.list(null);
    expect(page.items).toEqual([]);
    expect(page.readModel).toMatchObject({ status: 'uninitialized', complete: false, initializedCreators: 0, totalCreators: 2 });
    expect(() => publishedService.export(null, 'txt', 'all')).toThrow('目录尚未完成更新');
  });
  it('numbers full collection before paging/filtering and handles >999 without identity writes', () => {
    expect(service.searchCreators('测试').items[0]?.enabled).toBe(true);
    const first = service.list(1);
    const last = service.list(1, { page: 21 });
    expect(first.summary.numberedWorks).toBe(1005);
    expect(first.items[0]!.no).toBe('NO.1005');
    expect(last.items.at(-1)!.no).toBe('NO.001');
    expect(service.list(2).items[0]!.no).toBe('NO.001');
    expect(service.list(1, { q: 'NO.1005' }).items).toEqual([
      first.items[0],
    ]);
    const two = service.list(1, { q: 'Same title' }).items;
    expect(two).toHaveLength(2);
    expect(two[0]!.workId).not.toBe(two[1]!.workId);
    expect(
      service.list(1, { page: 2, revision: first.revision }).items[0]!.no,
    ).toBe('NO.955');
  });
  it('keeps chronological NOs across display directions, tied times and exports', () => {
    const newest = service.list(1, { q: 'Same title' });
    expect(newest.items.map(row => [row.workId, row.no])).toEqual([
      [samples[1]!.work, 'NO.002'],
      [samples[0]!.work, 'NO.001'],
    ]);
    const newestText = service.export(1, 'txt', 'filtered', { q: 'Same title' });
    const newestCsv = service.export(1, 'csv', 'filtered', { q: 'Same title' });
    expect(newestText).toContain('编目顺序：按已有排序时间从早到晚编号');
    expect(newestText).toContain('展示顺序：最新优先');
    expect(newestText.indexOf('NO.002')).toBeLessThan(newestText.indexOf('NO.001'));
    repos.appSettingsRepository.set('folder.default_image_order', 'oldest');
    try {
      const oldest = service.list(1, { q: 'Same title' });
      expect(oldest.items).toEqual([...newest.items].reverse());
      expect(service.list(1, { page: 2 }).items[0]!.no).toBe('NO.051');
      const oldestCsv = service.export(1, 'csv', 'filtered', { q: 'Same title' });
      expect(oldestCsv.split('\r\n').slice(1)).toEqual(newestCsv.split('\r\n').slice(1).reverse());
      expect(service.detail(1, samples[0]!.work).item.no).toBe('NO.001');
      expect(service.export(1, 'txt', 'filtered', { q: 'Same title' })).toContain('展示顺序：最早优先');
      expect(() => service.list(1, { revision: newest.revision })).toThrow('作品数据已更新');
    } finally {
      repos.appSettingsRepository.set('folder.default_image_order', 'newest');
    }
  });
  it('reads old Costuan matched copies via exact scoped source path without writing postId', () => {
    const sample = samples[0]!;
    db.connection
      .prepare('UPDATE archive_catalog_local_works SET post_id=NULL WHERE id=?')
      .run(sample.local);
    db.connection
      .prepare(
        'UPDATE archive_catalog_works SET primary_local_work_id=NULL WHERE id=?',
      )
      .run(sample.work);
    const row = service.detail(1, sample.work).item;
    expect(row).toMatchObject({
      primaryPostId: sample.post,
      primaryLocalWorkId: sample.local,
      imageCount: 1,
      mediaBytes: 1234,
      localState: 'indexed',
    });
    expect(
      db.connection
        .prepare('SELECT post_id FROM archive_catalog_local_works WHERE id=?')
        .get(sample.local)!.post_id,
    ).toBeNull();
    expect(service.list(1).summary.legacyPosts).toBe(0);
  });
  it('counts only primary indexed media and preserves inactive primary rather than promote secondary', () => {
    const first = samples[1]!;
    const secondary = add(1, 'Same title', 9000, first.work);
    const page = service.list(1);
    const detail = service.detail(1, first.work);
    expect(page.summary.totalWorks).toBe(1005);
    expect(detail.item).toMatchObject({
      copyCount: 2,
      mediaBytes: 1234,
      primaryPostId: first.post,
    });
    expect(detail.copies.map((c) => c.primary)).toEqual([true, false]);
    db.connection.prepare('UPDATE posts SET is_trashed=1 WHERE id=?').run(secondary.post);
    expect(publishedService.detail(1, first.work).copies[1]).toMatchObject({ postId: null, indexedAvailable: false });
    db.connection.prepare('UPDATE posts SET is_trashed=0 WHERE id=?').run(secondary.post);
    db.connection
      .prepare('UPDATE archive_catalog_local_works SET is_active=0 WHERE id=?')
      .run(first.local);
    expect(service.detail(1, first.work).item).toMatchObject({
      localState: 'unavailable',
      statisticsBasis: 'last-indexed',
      mediaBytes: 1234,
      primaryPostId: first.post,
    });
    expect(service.detail(1, first.work).item.primaryPostId).not.toBe(
      secondary.post,
    );
  });
  it('keeps uncertain primaries/time unarranged and explicitly deleted works outside directory', () => {
    const sample = samples[2]!;
    add(1, 'copy', 5000, sample.work);
    db.connection
      .prepare(
        'UPDATE archive_catalog_works SET primary_local_work_id=NULL WHERE id=?',
      )
      .run(sample.work);
    expect(service.detail(1, sample.work).item).toMatchObject({
      no: null,
      localState: 'unarranged',
      primaryPostId: null,
    });
    db.connection
      .prepare('UPDATE posts SET sort_timestamp=0 WHERE id=?')
      .run(samples[3]!.post);
    expect(service.detail(1, samples[3]!.work).item).toMatchObject({
      no: null,
      sortTimestamp: null,
      localState: 'unarranged',
    });
    db.connection
      .prepare('UPDATE posts SET is_trashed=1 WHERE id=?')
      .run(samples[4]!.post);
    expect(service.list(1).summary.excludedDeletedWorks).toBe(1);
    expect(() => service.detail(1, samples[4]!.work)).toThrow(
      '该作品不在当前本地目录中',
    );
  });
  it('shows concrete legacy identity gaps and excludes source-only works', () => {
    db.connection
      .prepare('UPDATE archive_catalog_local_works SET work_id=NULL WHERE id=?')
      .run(samples[5]!.local);
    expect(service.list(1).legacyGaps).toContainEqual(
      expect.objectContaining({ postId: samples[5]!.post }),
    );
    db.connection
      .exec(`INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,source_url,observed_at)
      VALUES(1,1,'another-platform','1','Collection','https://user:secret@example.com/item?id=12&pwd=secret&token=secret#password','2026-01-01');
      INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES (99999,1,'Only source');
      INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_order,source_title,media_summary,first_seen_at,last_seen_at)
      VALUES(99999,1,'another-platform','only',5,'Source-only','30P','2026-01-01','2026-01-01');`);
    expect(service.list(1).summary.sourceOnlyWorks).toBe(1);
    expect(() => service.detail(1, 99999)).toThrow();
  });
  it('preserves NO on source changes, rejects stale pages/details/exports, and exports all rows safely', () => {
    const work = samples[6]!.work;
    const before = service.list(1);
    const no = service.detail(1, work).item.no;
    db.connection
      .prepare(
        `INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_order,source_title,media_summary,first_seen_at,last_seen_at)
      VALUES(?,1,'another-platform','local',30,'Declared title','31P','2026-01-01','2026-01-01')`,
      )
      .run(work);
    const after = service.list(1);
    expect(after.revision).not.toBe(before.revision);
    expect(service.detail(1, work).item.no).toBe(no);
    expect(() =>
      service.list(1, { page: 2, revision: before.revision }),
    ).toThrow('作品数据已更新');
    expect(() => service.detail(1, work, before.revision)).toThrow(
      '作品数据已更新',
    );
    expect(() =>
      service.export(1, 'txt', 'all', { revision: before.revision }),
    ).toThrow('作品数据已更新');
    const filtered = service.export(1, 'txt', 'filtered', {
      q: no!,
      revision: after.revision,
    });
    expect(filtered).toContain(no!);
    const csv = service.export(1, 'csv', 'all', { revision: after.revision });
    expect(csv.split('\r\n')).toHaveLength(after.summary.totalWorks + 1);
    expect(csv).toContain('another-platform');
    expect(csv).toContain('https://example.com/item?id=12');
    expect(csv).not.toContain('secret');
    expect(csv).not.toContain(root);
    db.connection
      .prepare('UPDATE archive_catalog_works SET display_title=? WHERE id=?')
      .run('=1+1,"中文"\n换行', work);
    expect(service.export(1, 'csv', 'all')).toContain(`"'=1+1,""中文""\n换行"`);
  });
  it('reorders after insertion/order change without updating historical IDs and uses constant query count', () => {
    const previous = service.detail(1, samples[7]!.work).item.no;
    const newer = add(1, 'Inserted', 99999);
    expect(service.list(1).items[0]!.workId).toBe(newer.work);
    expect(service.detail(1, samples[7]!.work).item.no).toBe(previous);
    const newestNo = service.detail(1, newer.work).item.no;
    repos.appSettingsRepository.set('folder.default_image_order', 'oldest');
    const a = service.list(1);
    expect(a.sortOrder).toBe('oldest');
    expect(a.items[0]!.workId).toBe(samples[0]!.work);
    expect(service.detail(1, samples[7]!.work).item.no).toBe(previous);
    expect(service.detail(1, newer.work).item.no).toBe(newestNo);
    const prepare = vi.spyOn(db.connection, 'prepare');
    const hydrate = vi.spyOn(repos.postRepository, 'hydratePostItems');
    service.list(1);
    const count = prepare.mock.calls.length;
    expect(count).toBeLessThanOrEqual(10);
    expect(hydrate).not.toHaveBeenCalled();
    expect(
      prepare.mock.calls.every(
        ([sql]) => !sql.includes('exif_json') && !sql.includes('fulfillment'),
      ),
    ).toBe(true);
    prepare.mockRestore();
    hydrate.mockRestore();
  });
  it('enforces management access for directory, detail and export, and validates revision transport', async () => {
    flush();
    const capability = vi.spyOn(auth, 'hasCapability').mockReturnValue(false);
    for (const url of [
      '/1',
      '/all',
      '/1/works/1',
      '/1/export?format=txt&scope=all',
      '/creators',
    ]) {
      const response = await requestTestApp(
        app,
        'GET',
        `/api/admin/archive-catalog/resource-catalog${url}`,
      );
      expect([401, 403]).toContain(response.status);
    }
    capability.mockRestore();
    const response = await requestTestApp(
      app,
      'GET',
      '/api/admin/archive-catalog/resource-catalog/1',
    );
    expect(response.status).toBe(200);
    const invalid = await requestTestApp(
      app,
      'GET',
      '/api/admin/archive-catalog/resource-catalog/1/export?format=txt&scope=all',
    );
    expect(invalid.status).toBe(400);
    expect(
      (
        await requestTestApp(
          app,
          'GET',
          `/api/admin/archive-catalog/resource-catalog/1/export?format=txt&scope=all&revision=${response.body.revision}`,
        )
      ).status,
    ).toBe(200);
    const all = await requestTestApp(app, 'GET', '/api/admin/archive-catalog/resource-catalog/all');
    expect(all.status).toBe(200);
    const csv = await requestTestApp(app, 'GET',
      `/api/admin/archive-catalog/resource-catalog/all/export?format=csv&scope=all&revision=${all.body.revision}`);
    expect(csv.status).toBe(200);
    const metadata = JSON.parse(decodeURIComponent(String(csv.headers.get('x-resource-catalog-metadata'))));
    expect(metadata).toMatchObject({ revision: all.body.revision, creatorId: null, rowCount: all.body.total });
  });
  it('does not treat ambiguous local ownership or a cross-work primary as confirmed', () => {
    const sample = samples[8]!;
    db.connection
      .prepare(
        "UPDATE archive_catalog_local_works SET match_status='ambiguous' WHERE id=?",
      )
      .run(sample.local);
    expect(service.detail(1, sample.work).item).toMatchObject({
      localState: 'unarranged',
      no: null,
      primaryPostId: null,
      imageCount: null,
      videoCount: null,
      mediaBytes: null,
      statisticsBasis: 'unknown',
    });
    db.connection
      .prepare(
        "UPDATE archive_catalog_local_works SET match_status='matched' WHERE id=?",
      )
      .run(sample.local);
    const secondFolderId = Number(
      db.connection
        .prepare(
          'SELECT gallery_folder_id id FROM archive_catalog_local_creator_folders WHERE id=2',
        )
        .get()!.id,
    );
    const firstFolderId = Number(
      db.connection
        .prepare(
          'SELECT gallery_folder_id id FROM archive_catalog_local_creator_folders WHERE id=1',
        )
        .get()!.id,
    );
    db.connection.exec('DROP INDEX idx_catalog_folder_gallery_active');
    try {
      db.connection
        .prepare(
          'UPDATE archive_catalog_local_creator_folders SET gallery_folder_id=? WHERE id=2',
        )
        .run(firstFolderId);
      expect(service.detail(1, sample.work).item).toMatchObject({
        localState: 'unarranged',
        no: null,
      });
    } finally {
      db.connection
        .prepare(
          'UPDATE archive_catalog_local_creator_folders SET gallery_folder_id=? WHERE id=2',
        )
        .run(secondFolderId);
      db.connection.exec(
        'CREATE UNIQUE INDEX idx_catalog_folder_gallery_active ON archive_catalog_local_creator_folders(gallery_folder_id) WHERE is_active=1 AND gallery_folder_id IS NOT NULL',
      );
    }
    db.connection
      .prepare(
        'UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=?',
      )
      .run(samples[9]!.local, sample.work);
    expect(service.detail(1, sample.work).item).toMatchObject({
      localState: 'unarranged',
      no: null,
      primaryLocalWorkId: null,
      primaryPostId: null,
    });
    db.connection
      .prepare(
        'UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=?',
      )
      .run(sample.local, sample.work);
  });
  it('keeps retained originals outside media counts and records only safe retention metadata', () => {
    const sample = samples[10]!;
    db.connection
      .prepare(
        `INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,reason,payload_json)
      VALUES('retention-test','admission_file_removal',?,?,'approved',?)`,
      )
      .run(
        sample.work,
        sample.local,
        JSON.stringify({
          retainOriginal: true,
          entry: { relativePath: 'private.tiff' },
          preservedAt: 'G:/private/original',
        }),
      );
    db.connection
      .prepare('UPDATE images SET relative_path=? WHERE id=?')
      .run(`Creator1/Original/_未支持格式原件/image.jpg`, sample.image);
    const detail = service.detail(1, sample.work);
    expect(detail.item).toMatchObject({
      imageCount: null,
      videoCount: null,
      mediaBytes: null,
    });
    expect(detail.copies[0]!.retainedOriginalCount).toBe(1);
    expect(JSON.stringify(detail)).not.toContain('private');
    db.connection
      .prepare('UPDATE images SET relative_path=? WHERE id=?')
      .run(`Creator1/Original-${sample.local}/image.jpg`, sample.image);
  });
  it('uses creator-scoped joins and unique source-path/primary-key lookup rather than scanning all Posts', () => {
    const prepare = vi.spyOn(db.connection, 'prepare');
    generate(1);
    const statements = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    const localSql = statements.find((sql) =>
      sql.includes('AS localMatchStatus'),
    )!;
    const mediaSql = statements.find((sql) => sql.includes('AS memberCount'))!;
    const gapsSql = statements.find(sql => sql.includes('SELECT DISTINCT p.id AS postId'))!;
    const gapPlan = db.connection.prepare(`EXPLAIN QUERY PLAN ${gapsSql}`).all(1).map(row => String(row.detail));
    expect(gapPlan.some(row => /SEARCH pi USING.*post_id=\?/.test(row))).toBe(true);
    expect(gapPlan.some(row => /SEARCH i USING INTEGER PRIMARY KEY/.test(row))).toBe(true);
    // SQLite may choose a covering visibility index, but only with the member's
    // rowid bound; scanning all visible images for every Post is the regression.
    expect(gapPlan.filter(row => /SEARCH i USING/.test(row)).every(row => row.includes('rowid=?')),
      gapPlan.join('\n')).toBe(true);
    for (const sql of [localSql, mediaSql]) {
      const plan = db.connection
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(1)
        .map((row) => String(row.detail));
      expect(
        plan.some((row) =>
          /SEARCH legacy USING INDEX sqlite_autoindex_posts_1 \(source_path=\?\)/.test(
            row,
          ),
        ),
      ).toBe(true);
      expect(
        plan.some((row) => /SEARCH p USING INTEGER PRIMARY KEY/.test(row)),
      ).toBe(true);
      expect(plan.some((row) => /SCAN (p|legacy)\b/.test(row))).toBe(false);
    }
    expect(statements).toHaveLength(10);
  });
  it('reads Stage3 retained originals only from matching completed target/work evidence', () => {
    const sample = samples[11]!;
    const sourceId = Number(
      db.connection
        .prepare(
          `INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at)
      VALUES(?,1,'test','stage3','Stage3 original','2026-01-01','2026-01-01')`,
        )
        .run(sample.work).lastInsertRowid,
    );
    const absolute = String(
      db.connection
        .prepare(
          'SELECT absolute_path FROM archive_catalog_local_works WHERE id=?',
        )
        .get(sample.local)!.absolute_path,
    );
    const insert = db.connection
      .prepare(`INSERT INTO local_ingest_jobs(source_work_id,creator_id,source_archive_path,source_archive_name,source_archive_size,source_archive_mtime,
      source_archive_sha256,status,phase,target_path,summary_json) VALUES(?,1,?,'synthetic.7z',10,1,?,'ingested','done',?,?)`);
    insert.run(
      sourceId,
      'private-archive',
      'hash1',
      absolute,
      JSON.stringify({
        retainedOriginalCount: 2,
        retainedOriginalDirectory: 'G:/private/retained',
      }),
    );
    insert.run(
      sourceId,
      'other-archive',
      'hash2',
      `${absolute}-different`,
      JSON.stringify({ retainedOriginalCount: 999 }),
    );
    const detail = service.detail(1, sample.work);
    expect(detail.copies[0]!.retainedOriginalCount).toBe(2);
    expect(detail.item.mediaBytes).toBe(1234);
    expect(JSON.stringify(detail)).not.toContain('private');
  });
  it('reads global published rows by creator alias, title and original name without generation or media hydration', () => {
    db.connection.exec(`INSERT INTO archive_catalog_creator_aliases(creator_id,source,alias,normalized_alias)
      VALUES(2,'manual','别名二','别名二')`);
    flush();
    const prepare = vi.spyOn(db.connection, 'prepare');
    const global = publishedService.list(null, { order: 'oldest' });
    expect(global.creator).toBeNull();
    expect(global.readModel).toMatchObject({ complete: true, status: 'ready', pendingCreators: 0 });
    const alias = publishedService.list(null, { q: '别名二' });
    expect(alias.items).toHaveLength(1);
    expect(alias.items[0]).toMatchObject({ creatorId: 2, title: 'Separate', no: 'NO.001' });
    expect(publishedService.list(null, { q: 'Separate' }).items).toEqual(alias.items);
    expect(publishedService.list(null, { q: alias.items[0]!.originalDirectory! }).items).toEqual(alias.items);
    expect(publishedService.detail(2, alias.items[0]!.workId, global.revision, 'all').item).toEqual(alias.items[0]);
    expect(publishedService.list(null, { page: 2, revision: global.revision }).items).toHaveLength(50);
    const exported = publishedService.exportBundle(null, 'txt', 'filtered', { q: '别名二', revision: global.revision });
    expect(exported.metadata).toMatchObject({ creatorId: null, rowCount: 1 });
    expect(exported.body).toContain('Other');
    expect(exported.body).toContain(`Work #${alias.items[0]!.workId}`);
    const queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    expect(queries.some(sql => /\b(post_items|images|archive_catalog_local_works)\b/.test(sql))).toBe(false);
    expect(queries.some(sql => /\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
  it('exposes pending completion and stale-page conflicts while enforcing deletion before publication', () => {
    flush();
    const sample = samples[12]!;
    const before = publishedService.list(null);
    const title = publishedService.detail(1, sample.work).item.title;
    db.connection.prepare('UPDATE archive_catalog_works SET display_title=? WHERE id=?').run('Changed in another entry', sample.work);
    expect(publishedService.list(null).readModel).toMatchObject({ status: 'updating', complete: false, pendingCreators: 1 });
    expect(publishedService.detail(1, sample.work).item.title).toBe(title);
    expect(() => publishedService.list(null, { page: 2, revision: before.revision })).toThrow('作品数据已更新');
    expect(() => publishedService.export(null, 'csv', 'all')).toThrow('目录尚未完成更新');
    db.connection.prepare('UPDATE posts SET is_trashed=1 WHERE id=?').run(sample.post);
    expect(() => publishedService.detail(1, sample.work)).toThrow('该作品不在当前本地目录中');
    db.connection.prepare('UPDATE posts SET is_trashed=0 WHERE id=?').run(sample.post);
    flush();
    expect(publishedService.detail(1, sample.work).item.title).toBe('Changed in another entry');
    expect(publishedService.list(null).readModel.complete).toBe(true);
  });
  it('does not parse a publication from a newer incompatible rule version', () => {
    flush();
    db.connection.exec('UPDATE resource_catalog_state SET rule_version=2 WHERE creator_id=1');
    try {
      expect(() => publishedService.list(null)).toThrow('目录已由较新版本生成');
      expect(() => publishedService.detail(1, samples[12]!.work)).toThrow('目录已由较新版本生成');
    } finally {
      db.connection.exec('UPDATE resource_catalog_state SET rule_version=1 WHERE creator_id=1');
    }
  });
});
