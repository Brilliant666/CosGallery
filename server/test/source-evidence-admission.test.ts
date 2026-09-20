import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.sequential('source evidence through the real local-admission checkpoint flow', () => {
  let root: string, inputRoot: string, gallery: string, creatorId: number, creatorName: string;
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  let admission: import('../src/services/local-folder-admission-service.js').LocalFolderAdmissionService;
  let evidence: import('../src/services/source-evidence-service.js').SourceEvidenceService;
  let sequence = 0;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-evidence-admission-'));
    inputRoot = path.join(root, 'inbox'); gallery = path.join(root, 'gallery');
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('COS_GALLERY_MODE', '1'); vi.stubEnv('PUBLIC_DEMO_MODE', '1');
    for (const [key, dir] of Object.entries({ DATA_ROOT: path.join(root, 'data'), GALLERY_ROOT: gallery,
      DB_DIR: path.join(root, 'db'), THUMBNAILS_DIR: path.join(root, 'thumbs'), PREVIEWS_DIR: path.join(root, 'previews') })) {
      vi.stubEnv(key, dir); await fs.mkdir(dir, { recursive: true });
    }
    await fs.mkdir(inputRoot); vi.resetModules();
    ({ databaseManager: manager } = await import('../src/db/database.js'));
  });
  beforeEach(async () => {
    creatorName = `EvidenceFixture${++sequence}`;
    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    const { LocalFolderAdmissionService } = await import('../src/services/local-folder-admission-service.js');
    const { SourceEvidenceService } = await import('../src/services/source-evidence-service.js');
    creatorId = new ManagedCreatorService(manager.connection, gallery).create({ name: creatorName, preference: 'liked' }).id;
    admission = new LocalFolderAdmissionService(manager.connection, gallery);
    evidence = new SourceEvidenceService(manager.connection);
  });
  afterAll(() => { manager.close(); vi.unstubAllEnvs(); });

  function save(pageUrl = `https://example.test/album/${creatorId}`, platform = 'ecytt', rawDirectoryText = '') {
    const observation = evidence.save({ creatorId, requestId: `fixture-${++sequence}`, record: {
      platform, pageUrl, pageTitle: `${creatorName} 合成资料`, method: 'manual', rawDirectoryText,
      notes: 'User prepared extracted folders; this is not a download receipt.'
    } });
    return evidence.confirmIdentity(observation.id, { creatorId, requestId: `confirm-${sequence}`,
      reason: 'Synthetic explicit page ownership', expectedRevision: observation.identityRevision });
  }
  async function preview(names: string[], sourceEvidenceId?: number) {
    for (const name of names) {
      await fs.mkdir(path.join(inputRoot, name, 'nested'), { recursive: true });
      await sharp({ create: { width: 32, height: 48, channels: 3, background: '#5381b7' } }).jpeg().toFile(path.join(inputRoot, name, 'nested', 'one.jpg'));
      await fs.writeFile(path.join(inputRoot, name, 'keep.txt'), 'Unapproved attachment retained');
    }
    return admission.preview({ creatorId, inputRoot, directories: names, sourceEvidenceId, acceptExistingVersion: true });
  }
  const confirm = (p: Awaited<ReturnType<typeof preview>>) => ({ ...p, confirmed: true,
    items: p.items.map(item => ({ ...item, reason: 'User confirms the selected synthetic independent set and current usable version' })) });
  const rows = (table: string) => manager.connection.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  const counts = () => Object.fromEntries(['archive_catalog_source_works', 'archive_catalog_download_tasks', 'archive_catalog_metadata_tasks', 'local_ingest_jobs', 'archive_catalog_local_fulfillments']
    .map(table => [table, manager.connection.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n]));
  function sourceRecord(title: string, postId: string) {
    const raw = `${creatorName} NO.001 ${title} [1P-1MB]`;
    return { creatorName, costuan: { postId, title: `${creatorName}COSPLAY写真图片包合集[1套][持续更新]`,
      collectionCount: 1, resourceDirectoryText: raw,
      works: [{ order: 1, sourceOrder: 'NO.001', label: title, mediaSummary: '1P-1MB', rawTitle: raw }],
      directoryVerification: { complete: true, checkedAt: '2026-09-20T00:00:00Z', parsedWorkCount: 1 } },
      baidu: { transport: 'direct-share', status: 'share-verified', shareUrl: 'https://pan.baidu.com/s/1synthetic', sourceFolderName: 'fixture',
        verification: { method: 'share-read', complete: true, checkedAt: '2026-09-20T00:00:00Z', checkRoundId: `round-${creatorId}`, files: ['001.7z'] } } };
  }

  it('admits two extracted sets with a page but no list; persists queryable batch links and no acquisition history', async () => {
    const observation = save(); const before = counts();
    const p = await preview([`${creatorName} Blue`, `${creatorName} Red`], observation.id);
    expect(p.confirmed).toBe(false); expect(p.items.every(item => !item.localOnly && item.acceptExistingVersion)).toBe(true);
    expect(evidence.get(observation.id).links).toEqual([]);
    const result = await admission.apply(confirm(p)); expect(result.completed).toBe(true);
    const detail = evidence.get(observation.id); expect(detail.links).toHaveLength(2);
    expect(detail.links.map(link => link.workId)).toEqual(result.items.map(item => item.work_id));
    expect(detail.links.every(link => link.planId === p.planId && link.kind === 'batch')).toBe(true);
    expect(detail.entryMappings).toEqual([]); expect(counts()).toEqual(before);
    for (const item of p.items) {
      await expect(fs.stat(path.join(inputRoot, item.sourceRelativePath))).rejects.toThrow();
      expect(await fs.readFile(path.join(item.targetPath, 'keep.txt'), 'utf8')).toBe('Unapproved attachment retained');
    }
    const { createApp } = await import('../src/app.js'); const { requestTestApp } = await import('./http-test-utils.js');
    const response = await requestTestApp(createApp(), 'GET', `/api/cos-gallery/creators/${creatorId}/works?page=1&limit=24`);
    expect(response.status).toBe(200); expect(response.body.items).toHaveLength(2);
    expect(response.body.items.every((item: Record<string, unknown>) => !('mediaItems' in item))).toBe(true);
  });

  it('rejects an unconfirmed or other-creator reference before any move or admission record', async () => {
    const observation = evidence.save({ creatorId, requestId: 'unconfirmed-page', record: {
      platform: 'sndiary', pageUrl: 'https://example.test/unconfirmed', pageTitle: 'Unconfirmed', method: 'manual', rawDirectoryText: '' } });
    await expect(preview([`${creatorName} Held`], observation.id)).rejects.toThrow('确认');
    expect(await fs.stat(path.join(inputRoot, `${creatorName} Held`))).toBeTruthy();
    const other = save(); const p = await preview([`${creatorName} Scope`], other.id);
    const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
    const wrong = new ManagedCreatorService(manager.connection, gallery).create({ name: `Wrong${sequence}`, preference: 'liked' }).id;
    await expect(admission.apply({ ...confirm(p), creatorId: wrong })).rejects.toThrow('确认');
    expect(evidence.get(other.id).links).toHaveLength(0);
  });

  it('posthoc provenance preserves old immutable plans, all media IDs and filesystem; range mapping does not fulfill', async () => {
    const p = confirm(await preview([`${creatorName} First`]));
    expect(p).not.toHaveProperty('sourceEvidenceId');
    const result = await admission.apply(p); const item = result.items[0];
    const oldPlan = manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId);
    const before = { works: rows('archive_catalog_works'), locals: rows('archive_catalog_local_works'), posts: rows('posts'), images: rows('images'), counts: counts() };
    const observation = save(`https://www.costuan.com/${900000 + creatorId}.html`, 'costuan', 'NO.018-NO.026 合集 [9套]');
    const decision = { observationId: observation.id, creatorId, workId: item.work_id!, localWorkId: item.local_work_id!, key: `posthoc-${creatorId}`, reason: 'Explicit provenance only' };
    const link = evidence.linkAdmission(decision); expect(evidence.linkAdmission(decision).id).toBe(link.id);
    evidence.mapEntry({ observationId: observation.id, creatorId, workId: item.work_id!, entryKey: 'line-1', key: `range-${creatorId}`, reason: 'One explicitly identified member, not the entire bundle' });
    expect(evidence.get(observation.id).entryMappings).toHaveLength(1);
    expect(manager.connection.prepare('SELECT * FROM archive_local_admission_plans WHERE plan_id=?').get(p.planId)).toEqual(oldPlan);
    expect({ works: rows('archive_catalog_works'), locals: rows('archive_catalog_local_works'), posts: rows('posts'), images: rows('images'), counts: counts() }).toEqual(before);
    await admission.apply(p); expect(evidence.get(observation.id).links).toHaveLength(1);
    await expect(admission.apply({ ...p, sourceEvidenceId: observation.id })).rejects.toThrow('content changed');
  });

  it('recovers a failed post-index link using the unchanged plan while keeping earlier completed items', async () => {
    const observation = save(); const p = confirm(await preview([`${creatorName} Kept`, `${creatorName} Interrupted`], observation.id));
    const { SourceEvidenceService } = await import('../src/services/source-evidence-service.js');
    const realLink = SourceEvidenceService.prototype.linkAdmission;
    const spy = vi.spyOn(SourceEvidenceService.prototype, 'linkAdmission').mockImplementation(function (this: typeof evidence, args) {
      if (args.itemKey === p.items[1].key) throw new Error('Synthetic provenance writer unavailable');
      return realLink.call(this, args);
    });
    try { await expect(admission.apply(p)).rejects.toThrow('Synthetic provenance'); } finally { spy.mockRestore(); }
    const checkpoints = manager.connection.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? ORDER BY rowid').all(p.planId);
    expect(checkpoints.map(row => row.state)).toEqual(['completed', 'indexed']);
    const identities = ['archive_catalog_works', 'archive_catalog_local_works', 'posts', 'images'].map(table => rows(table).map(row => row.id));
    expect(evidence.get(observation.id).links).toHaveLength(1);
    await admission.apply(p); await admission.apply(p);
    expect(['archive_catalog_works', 'archive_catalog_local_works', 'posts', 'images'].map(table => rows(table).map(row => row.id))).toEqual(identities);
    expect(evidence.get(observation.id).links).toHaveLength(2);
    expect(manager.connection.prepare('SELECT last_error FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(p.planId, p.items[1].key)?.last_error).toBeNull();
  });

  it('reuses an existing SourceWork through real admission, then retains its fulfillment and history after partial observation', async () => {
    const { ArchiveCatalogService } = await import('../src/services/archive-catalog-service.js');
    const { ArchiveDownloadTaskService } = await import('../src/services/archive-download-task-service.js');
    const postId = String(910000 + creatorId); const title = 'Established Work';
    const catalog = new ArchiveCatalogService(manager.connection); catalog.importCostuanRecord(sourceRecord(title, postId), { expectedCreatorId: creatorId });
    const source = manager.connection.prepare('SELECT s.* FROM archive_catalog_source_works s JOIN archive_catalog_collections c ON c.id=s.collection_id WHERE c.creator_id=?').get(creatorId)!;
    const downloads = new ArchiveDownloadTaskService(manager.connection); downloads.planMissing({ creatorIds: [creatorId], targetRoot: inputRoot });
    const task = manager.connection.prepare('SELECT id FROM archive_catalog_download_tasks WHERE source_work_id=?').get(source.id)!;
    manager.connection.prepare("UPDATE archive_catalog_download_tasks SET status='staged',claimed_by='synthetic-history',attempt_count=2 WHERE id=?").run(task.id);
    const history = rows('archive_catalog_download_tasks');
    const observation = save(`https://www.costuan.com/${postId}.html`, 'costuan', `NO.001 ${title}`);
    const p = confirm(await preview([`${creatorName} Local NO.099`], observation.id));
    Object.assign(p.items[0], { displayTitle: title, identity: { kind: 'existing', sourceWorkId: Number(source.id) },
      acceptVersions: [{ sourceWorkId: Number(source.id), taskIds: [Number(task.id)], reason: 'Exact user acceptance, not byte equality' }] });
    const result = await admission.apply(p); expect(result.items[0].work_id).toBe(source.work_id);
    evidence.mapEntry({ observationId: observation.id, creatorId, workId: Number(source.work_id), sourceWorkId: Number(source.id), entryKey: 'line-1', key: `precise-${creatorId}`, reason: 'Confirmed exact source identity' });
    expect(downloads.get(Number(task.id))?.acquisitionState).toBe('local_satisfied');
    const preservedSources = rows('archive_catalog_source_works');
    evidence.save({ creatorId, requestId: `partial-refresh-${creatorId}`, record: { platform: 'costuan', pageUrl: observation.pageUrl,
      pageTitle: observation.pageTitle, method: 'manual', rawDirectoryText: 'Unknown extra content\nNO.018-NO.026 Bundle' } });
    expect(rows('archive_catalog_source_works')).toEqual(preservedSources); expect(rows('archive_catalog_download_tasks')).toEqual(history);
    expect(downloads.get(Number(task.id))?.acquisitionState).toBe('local_satisfied');
    expect(manager.connection.prepare('SELECT COUNT(*) n FROM archive_catalog_works WHERE creator_id=?').get(creatorId)?.n).toBe(1);
  });
});
