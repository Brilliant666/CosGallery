import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.sequential('web admission empty-parent finalization', () => {
  let root: string, waiting: string, gallery: string, sequence = 0;
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  let Service: typeof import('../src/services/local-admission-web-service.js')['LocalAdmissionWebService'];
  let CreatorService: typeof import('../src/services/managed-creator-service.js')['ManagedCreatorService'];
  let adapter: typeof import('../src/services/recycle-bin-adapter.js')['recycleBinAdapter'];
  let service: InstanceType<typeof Service>;
  let recycle: ReturnType<typeof vi.spyOn<typeof adapter, 'recycle'>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'admission-parent-web-'));
    waiting = path.join(root, 'cos等待入库'); gallery = path.join(root, 'gallery');
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('COS_GALLERY_MODE', '1'); vi.stubEnv('PUBLIC_DEMO_MODE', '0'); vi.stubEnv('DERIVATIVE_MODE', 'lazy');
    for (const [key, value] of Object.entries({ DATA_ROOT: path.join(root, 'data'), DB_DIR: path.join(root, 'db'), GALLERY_ROOT: gallery, THUMBNAILS_DIR: path.join(root, 'thumbs'), PREVIEWS_DIR: path.join(root, 'previews') })) {
      vi.stubEnv(key, value); await fs.mkdir(value, { recursive: true });
    }
    await fs.mkdir(waiting); vi.resetModules();
    ({ databaseManager: manager } = await import('../src/db/database.js'));
    ({ LocalAdmissionWebService: Service } = await import('../src/services/local-admission-web-service.js'));
    ({ ManagedCreatorService: CreatorService } = await import('../src/services/managed-creator-service.js'));
    ({ recycleBinAdapter: adapter } = await import('../src/services/recycle-bin-adapter.js'));
  }, 30000);
  beforeEach(() => {
    service = new Service(manager.connection, gallery);
    recycle = vi.spyOn(adapter, 'recycle').mockImplementation(async targetPath => {
      await fs.rename(targetPath, path.join(root, `synthetic-recycle-${randomUUID()}`));
      return { targetPath, recycled: true };
    });
  });
  afterEach(async () => { await service.waitForIdle(); vi.restoreAllMocks(); });
  afterAll(async () => { await service?.waitForIdle(); manager?.close(); vi.unstubAllEnvs(); });

  async function preview(extra?: 'defer' | 'attachment') {
    const parent = `合成收尾博主${++sequence}`;
    const creatorId = new CreatorService(manager.connection, gallery).create({ name: parent, rating: 'R15', preference: 'liked' }).id;
    const titles = ['001 明确入库', ...(extra === 'defer' ? ['002 暂缓作品'] : [])];
    for (const title of titles) {
      const directory = path.join(waiting, parent, title); await fs.mkdir(directory, { recursive: true });
      await sharp({ create: { width: 16, height: 24, channels: 3, background: '#334477' } }).jpeg().toFile(path.join(directory, 'photo.jpg'));
    }
    if (extra === 'attachment') { await fs.mkdir(path.join(waiting, parent, '.local-admission-attachments')); await fs.writeFile(path.join(waiting, parent, '.local-admission-attachments', 'keep.txt'), 'historical attachment'); }
    const collection = await service.previewCollection({ scopes: [{ creatorId, parent, directories: titles }] });
    const batchId = collection.batches[0].id;
    const request = { requestKey: randomUUID(), confirmed: true, batches: [{ batchId, acceptExistingVersion: true, actions: service.items(batchId).items.map((item, index) => ({ key: item.key, action: index ? 'defer' : 'new' })) }] };
    return { collection, batchId, creatorId, parent, request };
  }
  type Fixture = Awaited<ReturnType<typeof preview>>;
  const confirmed = (f: Fixture) => manager.connection.prepare('SELECT confirmed_json FROM local_admission_web_batches WHERE id=?').get(f.batchId)!.confirmed_json;
  const facts = (f: Fixture) => ({
    plan: manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(f.batchId),
    items: manager.connection.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? ORDER BY item_key').all(f.batchId),
    confirmed: confirmed(f)
  });
  const cleanup = (f: Fixture) => service.collection(f.collection.id).batches[0].parentCleanup;
  async function execute(f: Fixture) { await service.executeCollection(f.collection.id, f.request); const original = confirmed(f); await service.waitForIdle(); expect(confirmed(f)).toBe(original); return service.collection(f.collection.id); }
  function claim(creatorId: number) {
    const db = manager.connection;
    const work = Number(db.prepare('INSERT INTO archive_catalog_works(creator_id,display_title) VALUES(?,?)').run(creatorId, 'Synthetic active task').lastInsertRowid);
    const collection = Number(db.prepare("INSERT INTO archive_catalog_collections(creator_id,source,source_collection_id,title,observed_at) VALUES(?,'synthetic',?,'synthetic','now')").run(creatorId, randomUUID()).lastInsertRowid);
    const source = Number(db.prepare("INSERT INTO archive_catalog_source_works(work_id,collection_id,source,source_work_id,source_title,first_seen_at,last_seen_at) VALUES(?,?,'synthetic','one','synthetic','now','now')").run(work, collection).lastInsertRowid);
    return Number(db.prepare("INSERT INTO archive_catalog_download_tasks(source_work_id,provider,target_root,target_relative_directory,target_filename,status,claimed_by,attempt_count) VALUES(?,'synthetic','synthetic','synthetic','one.7z','claimed','test-owner',1)").run(source).lastInsertRowid);
  }
  it('finishes real synthetic admission then recycles only its empty parent, never another parent', async () => {
    const f = await preview(); await fs.mkdir(path.join(waiting, '无关空目录'));
    expect(await execute(f)).toMatchObject({ state: 'completed', totals: { completed: 1 } });
    expect(cleanup(f)).toMatchObject({ status: 'recycled' }); expect(recycle).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(waiting, f.parent))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(waiting, '无关空目录'))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(gallery, f.parent, '001 明确入库', 'photo.jpg'))).isFile()).toBe(true);
    const item = service.items(f.batchId).items[0]; expect(item).toMatchObject({ state: 'completed', nextAction: 'none' }); expect(item.workId).toBeTruthy(); expect(item.localWorkId).toBeTruthy(); expect(item.postId).toBeTruthy();
  });
  it.each(['defer', 'attachment'] as const)('keeps a non-empty parent containing %s untouched', async extra => {
    const f = await preview(extra); expect((await execute(f)).state).toBe('completed');
    expect(cleanup(f)).toMatchObject({ status: 'not_empty' }); expect(recycle).not.toHaveBeenCalled();
    const child = extra === 'defer' ? '002 暂缓作品/photo.jpg' : '.local-admission-attachments/keep.txt';
    expect((await fs.stat(path.join(waiting, f.parent, child))).isFile()).toBe(true);
  });
  it('records recycler failure separately and permits idempotent historical cleanup without replaying the immutable plan', async () => {
    recycle.mockRejectedValueOnce(Error('Synthetic recycler unavailable'));
    const f = await preview(); expect((await execute(f)).state).toBe('completed');
    expect(cleanup(f)).toMatchObject({ status: 'failed', message: expect.stringContaining('Synthetic recycler unavailable') });
    const before = facts(f); expect((await fs.stat(path.join(waiting, f.parent))).isDirectory()).toBe(true);
    await service.cleanupEmptyParents(f.collection.id); expect(cleanup(f)).toMatchObject({ status: 'recycled' }); expect(facts(f)).toEqual(before);
    await service.cleanupEmptyParents(f.collection.id); expect(cleanup(f)).toMatchObject({ status: 'recycled' }); expect(recycle).toHaveBeenCalledTimes(2); expect(facts(f)).toEqual(before);
  });
  it('keeps an active claim intact and refuses cleanup of its creator parent', async () => {
    recycle.mockRejectedValueOnce(Error('Keep parent for historical cleanup'));
    const f = await preview(); await execute(f); const before = facts(f), taskId = claim(f.creatorId);
    const task = manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(taskId);
    await service.cleanupEmptyParents(f.collection.id);
    expect(cleanup(f)).toMatchObject({ status: 'failed', message: expect.stringContaining('活动领取') });
    expect(recycle).toHaveBeenCalledTimes(1); expect(facts(f)).toEqual(before); expect(service.collection(f.collection.id).state).toBe('completed');
    expect(manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(taskId)).toEqual(task);
    expect((await fs.stat(path.join(waiting, f.parent))).isDirectory()).toBe(true);
  });
  it('does not downgrade a completed admission if recording the cleanup outcome fails', async () => {
    const f = await preview();
    manager.connection.exec("CREATE TRIGGER synthetic_parent_cleanup_record_failure BEFORE UPDATE OF context_json ON local_admission_web_batches WHEN json_extract(NEW.context_json,'$.parentCleanup') IS NOT NULL BEGIN SELECT RAISE(FAIL,'Synthetic cleanup outcome write failure'); END");
    try {
      expect((await execute(f)).state).toBe('completed');
      expect(service.items(f.batchId).items[0].state).toBe('completed');
      expect(facts(f).items[0].state).toBe('completed');
      expect(recycle).toHaveBeenCalledTimes(1);
    } finally { manager.connection.exec('DROP TRIGGER synthetic_parent_cleanup_record_failure'); }
  });
});
