import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.sequential('local-first admission reuses source identity through application services', () => {
  let root: string, input: string, gallery: string, creator: number, creatorName: string;
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  let admission: import('../src/services/local-folder-admission-service.js').LocalFolderAdmissionService;
  let catalog: import('../src/services/archive-catalog-service.js').ArchiveCatalogService;
  let downloads: import('../src/services/archive-download-task-service.js').ArchiveDownloadTaskService;
  let sequence = 0;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-first-reuse-'));
    input = path.join(root, 'inbox'); gallery = path.join(root, 'gallery');
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('COS_GALLERY_MODE', '1'); vi.stubEnv('PUBLIC_DEMO_MODE', '1');
    for (const [key, dir] of Object.entries({ DATA_ROOT: path.join(root, 'data'), GALLERY_ROOT: gallery,
      DB_DIR: path.join(root, 'db'), THUMBNAILS_DIR: path.join(root, 'thumbs'), PREVIEWS_DIR: path.join(root, 'previews') })) {
      vi.stubEnv(key, dir); await fs.mkdir(dir, { recursive: true });
    }
    await fs.mkdir(input); vi.resetModules();
    ({ databaseManager: manager } = await import('../src/db/database.js'));
  });
  beforeEach(async () => {
    creatorName = `ReuseFixture${++sequence}`;
    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    creator = new ManagedCreatorService(manager.connection, gallery).create({ name: creatorName, rating: 'R15', preference: 'liked' }).id;
    const { LocalFolderAdmissionService } = await import('../src/services/local-folder-admission-service.js');
    const { ArchiveCatalogService } = await import('../src/services/archive-catalog-service.js');
    const { ArchiveDownloadTaskService } = await import('../src/services/archive-download-task-service.js');
    admission = new LocalFolderAdmissionService(manager.connection, gallery);
    catalog = new ArchiveCatalogService(manager.connection); downloads = new ArchiveDownloadTaskService(manager.connection);
  });
  afterAll(async () => { manager.close(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

  const sources = () => manager.connection.prepare(`SELECT s.* FROM archive_catalog_source_works s
    JOIN archive_catalog_collections c ON c.id=s.collection_id WHERE c.creator_id=? ORDER BY s.id`).all(creator);
  const works = () => manager.connection.prepare('SELECT * FROM archive_catalog_works WHERE creator_id=? ORDER BY id').all(creator);
  function record(labels: string[]) {
    const entries = labels.map((label, n) => ({ order: n + 1, sourceOrder: `NO.${String(n + 1).padStart(3, '0')}`, label,
      mediaSummary: '2P-1MB', rawTitle: `${creatorName} NO.${String(n + 1).padStart(3, '0')} ${label} [2P-1MB]` }));
    return { creatorName, costuan: { postId: `reuse-${creator}`, title: `${creatorName}COSPLAY写真图片包合集[${labels.length}套][持续更新]`,
      collectionCount: labels.length, works: entries, resourceDirectoryText: entries.map(e => e.rawTitle).join('\n'),
      directoryVerification: { complete: true, checkedAt: '2026-09-14T00:00:00Z', parsedWorkCount: labels.length } },
      baidu: { transport: 'direct-share', status: 'share-verified', shareUrl: 'https://pan.baidu.com/s/1synthetic',
        sourceFolderName: `fixture-${creator}`, verification: { method: 'share-read', complete: true,
          checkedAt: '2026-09-14T00:00:00Z', checkRoundId: `synthetic-round-${creator}`,
          files: entries.map(e => `${String(e.order).padStart(3, '0')}.7z`) } } };
  }
  async function preview(title: string, options: { accepted?: boolean; localOnly?: boolean; sourceWorkId?: number } = {}) {
    const name = `${creatorName} NO.${String(++sequence).padStart(3, '0')} ${title} [1P-1MB]`;
    const dir = path.join(input, name); await fs.mkdir(dir);
    await sharp({ create: { width: 16, height: 24, channels: 3, background: '#2468ac' } }).jpeg().toFile(path.join(dir, 'one.jpg'));
    const p = await admission.preview({ creatorId: creator, inputRoot: input, directories: [name] });
    return { ...p, confirmed: true as const, items: p.items.map(item => ({ ...item, displayTitle: title,
      identity: options.sourceWorkId ? { kind: 'existing' as const, sourceWorkId: options.sourceWorkId } : { kind: 'new' as const },
      reason: 'Synthetic user accepts this existing local version, not byte-identical source contents',
      localOnly: options.localOnly ?? false, acceptExistingVersion: options.accepted ?? true })) };
  }

  it('admits without a source, then excludes the accepted exact-name set before import and preserves all local IDs', async () => {
    const p = await preview('Blue Nurse'); const result = await admission.apply(p);
    const workId = result.items[0].work_id; expect(sources()).toHaveLength(0);
    const localBefore = manager.connection.prepare('SELECT * FROM archive_catalog_local_works WHERE work_id=?').all(workId);
    const r = record(['Blue Nurse', 'New Set']);
    expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual(['002.7z']);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(sources()[0].work_id).toBe(workId); expect(works()).toHaveLength(2);
    expect(manager.connection.prepare('SELECT * FROM archive_catalog_local_works WHERE work_id=?').all(workId)).toEqual(localBefore);
    expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(1);
    expect(downloads.list({ creatorId: creator }).items.map(t => t.targetFilename)).toEqual(['002.7z']);
    const before = works();
    // Import legitimately refreshes auto-title updated_at; do not rely on both
    // imports happening within the same SQLite CURRENT_TIMESTAMP second.
    const refreshTime = '2030-01-02 03:04:05';
    manager.connection.function('current_timestamp', () => refreshTime);
    try { catalog.importCostuanRecord(r, { expectedCreatorId: creator }); }
    finally {
      manager.connection.function('current_timestamp', () => new Date().toISOString().slice(0, 19).replace('T', ' '));
    }
    const refreshed = works();
    expect(refreshed).toEqual(before.map(work => work.title_policy === 'auto' ? { ...work, updated_at: refreshTime } : work));
    await admission.apply(p); expect(works()).toEqual(refreshed);
    expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual(['002.7z']);
  });

  it('source-first explicit admission retains SourceWork and Work IDs and staged execution history', async () => {
    const r = record(['Foreign Number Nurse']); catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    const source = sources()[0]; downloads.planMissing({ creatorIds: [creator], targetRoot: input });
    const task = manager.connection.prepare('SELECT id FROM archive_catalog_download_tasks WHERE source_work_id=?').get(source.id)!;
    // Synthetic historic staging; no production claim or task is touched.
    manager.connection.prepare("UPDATE archive_catalog_download_tasks SET status='staged',claimed_by='historical-worker',attempt_count=2 WHERE id=?").run(task.id);
    const history = manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(task.id);
    const p = await preview('Foreign Number Nurse', { sourceWorkId: Number(source.id) });
    p.items[0].acceptVersions = [{ sourceWorkId: Number(source.id), taskIds: [Number(task.id)], reason: 'Explicit synthetic source version acceptance' }];
    const result = await admission.apply(p); expect(result.items[0].work_id).toBe(source.work_id);
    expect(downloads.get(Number(task.id))?.acquisitionState).toBe('local_satisfied');
    expect(manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(task.id)).toEqual(history);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(sources()[0].id).toBe(source.id); expect(works()).toHaveLength(1);
    expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual([]);
  });

  it.each(['bare-order', 'spaced-creator', 'bracketed-name', 'media-tail'] as const)(
    'retains %s source facts for review, not duplicate identity or acquisition', async variant => {
      const formattedName = creatorName.replace('ReuseFixture', 'Reuse Fixture');
      const titles = {
        'bare-order': '001 - [Studio] Blue Apron',
        'spaced-creator': `${formattedName} 001 [Studio] Blue Apron`,
        'bracketed-name': `${formattedName}(모델) NO.001 [Studio] Blue Apron`,
        'media-tail': '001 - [Studio] Blue Apron [61P／766MB]',
      };
      manager.connection.prepare('INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(?,?,?,?)')
        .run(creator, '모델', `fixture-alias-${creator}`, 'test');
      const local = await admission.apply(await preview(titles[variant]));
      const r = record(['[Studio] Blue Apron', 'Unrelated New Moon']);
      const proof = catalog.validateCompleteCostuanDirectory(r, creator);
      expect(proof.localSourceReuse[0]).toMatchObject({ status: 'review', satisfied: false, candidateWorkIds: [local.items[0].work_id] });
      expect(proof.requiredFilenames).toEqual(['002.7z']);
      const before = manager.connection.prepare('SELECT * FROM archive_catalog_local_works WHERE work_id=?').all(local.items[0].work_id);
      catalog.importCostuanRecord(r, { expectedCreatorId: creator });
      expect(sources().map(s => s.source_order)).toEqual([2]);
      expect(works()).toHaveLength(2);
      expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(1);
      expect(downloads.list({ creatorId: creator }).items.map(t => t.targetFilename)).toEqual(['002.7z']);
      const collection = manager.connection.prepare('SELECT metadata_json FROM archive_catalog_collections WHERE creator_id=?').get(creator)!;
      const metadata = JSON.parse(String(collection.metadata_json));
      expect(metadata.works).toHaveLength(2); // unresolved source fact is retained
      expect(metadata.localSourceReuse[0].status).toBe('review');
      const ids = works().map(w => w.id), sourceIds = sources().map(s => s.id);
      catalog.importCostuanRecord(r, { expectedCreatorId: creator });
      expect(works().map(w => w.id)).toEqual(ids); expect(sources().map(s => s.id)).toEqual(sourceIds);
      expect(manager.connection.prepare('SELECT * FROM archive_catalog_local_works WHERE work_id=?').all(local.items[0].work_id)).toEqual(before);
    });

  it('does not auto-pick an exact name when a different local Work is a formatted candidate', async () => {
    await admission.apply(await preview('Blue Apron'));
    await admission.apply(await preview('001 - Blue Apron'));
    const r = record(['Blue Apron']);
    expect(catalog.validateCompleteCostuanDirectory(r, creator).localSourceReuse[0]).toMatchObject({ status: 'review', satisfied: false });
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(works()).toHaveLength(2); expect(sources()).toHaveLength(0);
  });

  it('holds source-first formatted conflicts while retaining historical task/Work identities and active claims', async () => {
    const r = record(['[Studio] Blue Apron']); catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    downloads.planMissing({ creatorIds: [creator], targetRoot: input });
    const task = downloads.list({ creatorId: creator }).items[0], source = sources()[0];
    manager.connection.prepare("UPDATE archive_catalog_download_tasks SET status='claimed',claimed_by='active-fixture',attempt_count=1 WHERE id=?").run(task.id);
    const history = manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(task.id);
    await admission.apply(await preview('001 - [Studio] Blue Apron'));
    const ids = works().map(w => w.id);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(downloads.get(task.id)?.acquisitionState).toBe('review_required');
    expect(manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(task.id)).toEqual(history);
    expect(works().map(w => w.id)).toEqual(ids);
    expect(sources()[0]).toMatchObject({ id: source.id, work_id: source.work_id });
    expect(() => downloads.claim({ workerId: 'other', seedTaskId: task.id })).toThrow();
  });

  it('keeps an established exact relationship when another formatted local candidate later appears', async () => {
    const first = await admission.apply(await preview('Blue Apron'));
    const r = record(['Blue Apron']); catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    const source = sources()[0];
    await admission.apply(await preview('001 - Blue Apron'));
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(sources()[0]).toMatchObject({ id: source.id, work_id: first.items[0].work_id });
    expect(catalog.validateCompleteCostuanDirectory(r, creator).localSourceReuse[0]).toMatchObject({ status: 'existing', satisfied: true });
    expect(works()).toHaveLength(2);
  });

  it.each([{ accepted: false, localOnly: false }, { accepted: true, localOnly: true }])(
    'holds a title candidate without acceptance or with local-only policy: %j', async options => {
      await admission.apply(await preview('Held Set', options));
      const r = record(['Held Set']);
      expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual([]);
      catalog.importCostuanRecord(r, { expectedCreatorId: creator });
      expect(works()).toHaveLength(1); expect(sources()).toHaveLength(0);
      expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(0);
    });

  it('keeps two same-title local sets distinct and holds the ambiguous source without creating a third Work', async () => {
    await admission.apply(await preview('Same Theme')); await admission.apply(await preview('Same Theme'));
    const ids = works().map(w => w.id); expect(new Set(ids).size).toBe(2);
    const r = record(['Same Theme']); expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual([]);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(works().map(w => w.id)).toEqual(ids); expect(sources()).toHaveLength(0);
    const metadata = manager.connection.prepare('SELECT metadata_json FROM archive_catalog_collections WHERE creator_id=?').get(creator)!;
    expect(JSON.parse(String(metadata.metadata_json)).localSourceReuse).toBeTruthy();
  });

  it('does not reuse another creator or collapse a title variant into an exact-name match', async () => {
    await admission.apply(await preview('Nurse Night'));
    const r = record(['Nurse Night Special']);
    expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual(['001.7z']);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator }); expect(works()).toHaveLength(2);
    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    const other = new ManagedCreatorService(manager.connection, gallery).create({ name: 'OtherReuseFixture', preference: 'liked' }).id;
    const otherRecord = { creatorName: 'OtherReuseFixture', costuan: { postId: 'other-reuse', title: 'OtherReuseFixtureCOSPLAY写真图片包合集[1套][持续更新]', works: [{ order: 1, sourceOrder: 'NO.001', label: 'Nurse Night' }] } };
    catalog.importCostuanRecord(otherRecord, { expectedCreatorId: other });
    expect(manager.connection.prepare('SELECT COUNT(*) n FROM archive_catalog_works WHERE creator_id=?').get(other)?.n).toBe(1);
  });

  it('holds duplicate names in the complete source list even when only one local Work matches', async () => {
    await admission.apply(await preview('Repeated Source Title'));
    const r = record(['Repeated Source Title', 'Repeated Source Title']);
    expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual([]);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(works()).toHaveLength(1); expect(sources()).toHaveLength(0);
    expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(0);
  });

  it('reuses a single Work with two explicitly confirmed copies, not two competing Work identities', async () => {
    const a = await preview('Shared Copies'), b = await preview('Shared Copies');
    b.items[0].identity = { kind: 'same-as', itemKey: a.items[0].key } as typeof b.items[0]['identity'];
    const plan = { ...a, items: [...a.items, ...b.items] };
    const result = await admission.apply(plan);
    expect(result.items[0].work_id).toBe(result.items[1].work_id);
    const r = record(['Shared Copies']);
    expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual([]);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(sources()).toHaveLength(1); expect(sources()[0].work_id).toBe(result.items[0].work_id);
    expect(manager.connection.prepare('SELECT COUNT(*) n FROM archive_catalog_local_works WHERE work_id=?').get(result.items[0].work_id)?.n).toBe(2);
  });

  it.each(['offline', 'unfinished'] as const)('holds %s local assets instead of reporting them satisfied', async condition => {
    const p = await preview('Unavailable'); const result = await admission.apply(p);
    if (condition === 'offline') await fs.rename(p.items[0].targetPath, `${p.items[0].targetPath}-offline`);
    else manager.connection.prepare("UPDATE archive_local_admission_items SET state='files_verified' WHERE plan_id=?").run(p.planId);
    const { LocalSourceReuseService } = await import('../src/services/local-source-reuse-service.js');
    const decision = new LocalSourceReuseService(manager.connection).evaluate(creator, `reuse-${creator}`, [{ sourceOrder: 'NO.001', label: 'Unavailable' }])[0];
    expect(decision).toMatchObject({ status: 'review', satisfied: false, workId: result.items[0].work_id });
    catalog.importCostuanRecord(record(['Unavailable']), { expectedCreatorId: creator });
    expect(sources()).toHaveLength(0); expect(works()).toHaveLength(1);
  });

  it('preserves a revoked unique-name decision on a fresh service and repeated source import', async () => {
    await admission.apply(await preview('Revocable'));
    const r = record(['Revocable']); catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    const source = sources()[0];
    const decision = manager.connection.prepare("SELECT id FROM archive_catalog_work_decisions WHERE source_work_id=? AND kind='unique_name'").get(source.id)!;
    const { WorkIdentityService } = await import('../src/services/work-identity-service.js');
    new WorkIdentityService(manager.connection).revoke(Number(decision.id), 'Synthetic user revoked automatic relation');
    const { LocalSourceReuseService } = await import('../src/services/local-source-reuse-service.js');
    expect(new LocalSourceReuseService(manager.connection).evaluate(creator, `reuse-${creator}`, r.costuan.works)[0])
      .toMatchObject({ status: 'review', satisfied: false, workId: source.work_id });
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(sources()[0].id).toBe(source.id); expect(works()).toHaveLength(1);
    expect(manager.connection.prepare('SELECT state FROM archive_catalog_work_decisions WHERE id=?').get(decision.id)?.state).toBe('revoked');
    expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(0);
  });

  it('checks the entire source list beyond 100 entries for a repeated title', async () => {
    await admission.apply(await preview('Beyond First Page'));
    const labels = Array.from({ length: 105 }, (_, index) => `Distinct Set ${index + 1}`);
    labels[0] = 'Beyond First Page'; labels[104] = 'Beyond First Page';
    const r = record(labels), proof = catalog.validateCompleteCostuanDirectory(r, creator);
    expect(proof.requiredFilenames).toHaveLength(103);
    expect(proof.requiredFilenames).not.toContain('001.7z'); expect(proof.requiredFilenames).not.toContain('105.7z');
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(sources()).toHaveLength(103); expect(works()).toHaveLength(104);
    expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(103);
  });

  it('rechecks indexed file changes between prepare and complete instead of using stale satisfied evidence', async () => {
    const p = await preview('Changed After Prepare'); await admission.apply(p);
    const r = record(['Changed After Prepare']);
    expect(catalog.validateCompleteCostuanDirectory(r, creator).requiredFilenames).toEqual([]);
    await fs.appendFile(path.join(p.items[0].targetPath, 'one.jpg'), 'synthetic mutation after preparation');
    catalog.importCostuanRecord(r, { expectedCreatorId: creator, completeCheckRoundId: `synthetic-round-${creator}` });
    expect(sources()).toHaveLength(0); expect(works()).toHaveLength(1);
    const metadata = manager.connection.prepare('SELECT metadata_json FROM archive_catalog_collections WHERE creator_id=?').get(creator)!;
    expect(JSON.parse(String(metadata.metadata_json)).localSourceReuse).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'review', satisfied: false })
    ]));
    expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(0);
    expect(manager.connection.prepare(`SELECT COUNT(*) n FROM archive_catalog_local_fulfillments f
      JOIN archive_catalog_source_works s ON s.id=f.source_work_id JOIN archive_catalog_works w ON w.id=s.work_id WHERE w.creator_id=?`).get(creator)?.n).toBe(0);
  });

  it('returns only missing filenames through the metadata task prepare and real completion receipt protocol', async () => {
    await admission.apply(await preview('Protocol Local Set'));
    const { ArchiveMetadataTaskService } = await import('../src/services/archive-metadata-task-service.js');
    const metadata = new ArchiveMetadataTaskService(manager.connection);
    const planned = metadata.planSelected({ creatorIds: [creator], requestId: `protocol-${creator}` });
    const initial = planned.items[0].task!;
    const task = metadata.claim({ workerId: 'synthetic-metadata-worker', taskIds: planned.taskIds,
      rounds: [{ taskId: initial.id, checkRoundId: initial.checkRoundId! }] })[0];
    const r = record(['Protocol Local Set', 'Protocol Missing Set']);
    r.baidu.verification.checkRoundId = task.checkRoundId!;
    const payload = { id: task.id, workerId: 'synthetic-metadata-worker', canonicalCreatorId: creator,
      expectedAttempt: task.attemptCount, receiptId: `synthetic-receipt-${creator}`, record: r };
    const prepared = metadata.validateDirectory(payload);
    expect(prepared.requiredFilenames).toEqual(['002.7z']);
    // Existing plugin contract remains just the required filenames; the synthetic
    // receipt only proves the missing file, never a duplicate local archive.
    r.baidu.verification.files = ['002.7z'];
    metadata.complete(payload);
    expect(sources()).toHaveLength(2);
    expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(1);
    const tasks = downloads.list({ creatorId: creator }).items;
    expect(tasks.map(t => t.targetFilename)).toEqual(['002.7z']);
    const ids = sources().map(s => s.id); metadata.complete(payload);
    expect(sources().map(s => s.id)).toEqual(ids);
  });

  it('holds a historical source/local Work conflict without merging IDs or rewriting its pending task', async () => {
    const r = record(['Historical Separate Identity']);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    const source = sources()[0];
    expect(downloads.planMissing({ creatorIds: [creator], targetRoot: input }).created).toBe(1);
    const task = downloads.list({ creatorId: creator }).items[0];
    const history = manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(task.id);
    // Deliberately construct an existing historical conflict, not a supported
    // automatic merge: both independent stable identities must be retained.
    const local = await admission.apply(await preview('Historical Separate Identity'));
    expect(local.items[0].work_id).not.toBe(source.work_id);
    const ids = works().map(w => w.id);
    const { LocalSourceReuseService } = await import('../src/services/local-source-reuse-service.js');
    expect(new LocalSourceReuseService(manager.connection).evaluate(creator, `reuse-${creator}`, r.costuan.works)[0])
      .toMatchObject({ status: 'review', satisfied: false });
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    expect(works().map(w => w.id)).toEqual(ids);
    expect(sources()[0]).toMatchObject({ id: source.id, work_id: source.work_id });
    expect(downloads.get(task.id)?.acquisitionState).toBe('review_required');
    expect(() => downloads.claim({ workerId: 'must-not-claim-conflict', seedTaskId: task.id })).toThrow();
    expect(manager.connection.prepare('SELECT * FROM archive_catalog_download_tasks WHERE id=?').get(task.id)).toEqual(history);
  });

  it('lets a newer explicit binding and acceptance supersede a revoked automatic name decision', async () => {
    const local = await admission.apply(await preview('Corrected Manual Identity'));
    const r = record(['Corrected Manual Identity']);
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    const source = sources()[0];
    const automatic = manager.connection.prepare("SELECT id FROM archive_catalog_work_decisions WHERE source_work_id=? AND kind='unique_name'").get(source.id)!;
    const { WorkIdentityService } = await import('../src/services/work-identity-service.js');
    const identity = new WorkIdentityService(manager.connection);
    identity.revoke(Number(automatic.id), 'Synthetic correction: require an explicit relationship');
    identity.bindSource({ workId: Number(source.work_id), collectionId: Number(source.collection_id),
      sourceWorkId: String(source.source_work_id), key: `manual-correction-${creator}`, reason: 'User explicitly confirms the same source and Work' });
    const { ArchiveLocalFulfillmentService } = await import('../src/services/archive-local-fulfillment-service.js');
    new ArchiveLocalFulfillmentService(manager.connection).accept({ decisionKey: `manual-correction-accept-${creator}`,
      sourceWorkId: Number(source.id), localWorkId: local.items[0].local_work_id!, taskIds: [], reason: 'User accepts the existing local version after explicit correction' });
    catalog.importCostuanRecord(r, { expectedCreatorId: creator });
    const { LocalSourceReuseService } = await import('../src/services/local-source-reuse-service.js');
    expect(new LocalSourceReuseService(manager.connection).evaluate(creator, `reuse-${creator}`, r.costuan.works)[0])
      .toMatchObject({ status: 'existing', satisfied: true, workId: source.work_id });
    expect(manager.connection.prepare('SELECT state FROM archive_catalog_work_decisions WHERE id=?').get(automatic.id)?.state).toBe('revoked');
    expect(manager.connection.prepare(`SELECT f.state FROM archive_catalog_local_fulfillments f
      JOIN archive_catalog_work_decisions d ON d.id=f.decision_id WHERE d.decision_key=?`).get(`manual-correction-accept-${creator}`)?.state).toBe('active');
    expect(sources()[0]).toMatchObject({ id: source.id, work_id: source.work_id });
    expect(works()).toHaveLength(1);
  });
});
