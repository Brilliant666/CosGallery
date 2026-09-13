import { seedCreators } from './creator-fixtures.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import {
  ArchiveCatalogService,
  parseArchiveSourceOrder
} from '../src/services/archive-catalog-service.js';
import { ArchiveCatalogPipelineService } from '../src/services/archive-catalog-pipeline-service.js';
import { ArchiveCatalogQueryService } from '../src/services/archive-catalog-query-service.js';
import {
  ArchiveDownloadTaskService,
  sanitizeArchiveDirectoryName
} from '../src/services/archive-download-task-service.js';
import { ArchiveBridgeService } from '../src/services/archive-bridge-service.js';
import { ArchiveMetadataTaskService } from '../src/services/archive-metadata-task-service.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';

describe('archive catalog first-stage pipeline', () => {
  let tempRoot: string;
  let database: DatabaseSync;
  let service: ArchiveCatalogService;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-catalog-'));
    database = new DatabaseSync(':memory:');
    database.exec(schemaSql);
    service = new ArchiveCatalogService(database);
  });

  afterEach(async () => {
    database.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('preserves stable folder IDs on canonical rename and fails closed on physical path changes', async () => {
    const galleryRoot = path.join(tempRoot, 'gallery');
    const managed = new ManagedCreatorService(database, galleryRoot);
    const creator = managed.create({name:'Original'});
    service.importCostuanRecord({creatorName:'Original',costuan:{postId:'fixed',title:'Original collection',works:[{order:1,sourceOrder:'NO.001',label:'First'}]}});
    const work = path.join(galleryRoot,'Original','Original NO.001 First');
    await fs.mkdir(work,{recursive:true});
    await fs.writeFile(path.join(work,'image.jpg'),'synthetic');
    const folderId = Number(database.prepare("INSERT INTO folders(slug,name,folder_path) VALUES('fixed','Original','Original')").run().lastInsertRowid);
    await service.reconcileLocalRoot(galleryRoot);
    const snapshot = () => JSON.stringify(['archive_catalog_local_creator_folders','archive_catalog_local_works'].map(table=>database.prepare('SELECT * FROM '+table+' ORDER BY id').all()));
    const before = snapshot();
    managed.update(creator.id,{name:'Chosen'});
    await service.reconcileLocalRoot(galleryRoot);
    expect(snapshot()).toBe(before);
    managed.unlinkFolder(folderId,{confirm:true});
    const unlinked = snapshot();
    await service.reconcileLocalRoot(galleryRoot);
    expect(snapshot()).toBe(unlinked);
    managed.linkFolder(folderId,{creatorId:creator.id});
    const linked = snapshot();
    await fs.rename(path.join(galleryRoot,'Original'),path.join(galleryRoot,'NewPath'));
    database.prepare("UPDATE folders SET folder_path='NewPath' WHERE id=?").run(folderId);
    const result=await service.reconcileLocalRoot(galleryRoot);
    expect(result.bridgeReview).toEqual([expect.objectContaining({status:'path-changed',candidates:[folderId]})]);
    expect(snapshot()).toBe(linked);
    await expect(service.reconcileLocalCreators({rootPath:galleryRoot,creators:[{creatorId:creator.id,folderName:'NewPath'}]})).rejects.toThrow();
    expect(snapshot()).toBe(linked);
  });

  it('imports seed creators before media exists and reconciles a partial local archive read-only', async () => {
    const costuanPath = path.join(tempRoot, 'costuan.json');
    const galleryRoot = path.join(tempRoot, 'gallery');
    seedCreators(database, [{"name":"rua阮阮","preference":"liked","rating":"R18"},{"name":"lunana","preference":"kept","rating":"R15"}]);
    await fs.writeFile(costuanPath, JSON.stringify({
      format: 'costuan-archive-metadata',
      version: 1,
      exportedAt: '2026-08-31T00:00:00.000Z',
      records: {
        'costuan:10049': {
          creatorId: 'rua阮阮',
          creatorName: 'rua阮阮',
          aliases: ['rua阮阮'],
          costuan: {
            postId: '10049',
            title: 'rua阮阮COSPLAY写真图片包合集[3套][持续更新]',
            url: 'https://www.costuan.com/10049.html',
            collectionCount: 3,
            works: [
              { order: 1, sourceOrder: 'NO.001', label: '第一套' },
              { order: 2, sourceOrder: 'NO.002', label: '第二套' },
              { order: 3, sourceOrder: 'NO.003', label: '第三套' }
            ]
          },
          baidu: {
            sourceFolderName: '360',
            destinationPath: '我的网盘/cos图集',
            status: 'saved'
          }
        },
        'costuan:10352': {
          creatorId: 'lunana',
          creatorName: 'lunana',
          aliases: ['lunana'],
          costuan: {
            postId: '10352',
            title: 'lunananya COSPLAY写真图片包合集[1套][持续更新]',
            collectionCount: 1,
            works: [{ order: 1, sourceOrder: 'NO.001', label: '地雷系' }]
          }
        }
      }
    }));

    const ruaFirst = path.join(galleryRoot, 'rua阮阮', 'rua阮阮 001 第一套');
    const ruaThird = path.join(galleryRoot, 'rua阮阮', 'rua阮阮 NO.003 第三套');
    const lunanaFirst = path.join(galleryRoot, 'lunananya', 'lunana NO.001 地雷系');
    await Promise.all([
      fs.mkdir(ruaFirst, { recursive: true }),
      fs.mkdir(ruaThird, { recursive: true }),
      fs.mkdir(lunanaFirst, { recursive: true })
    ]);
    await Promise.all([
      fs.writeFile(path.join(ruaFirst, '01.jpg'), 'image'),
      fs.writeFile(path.join(ruaFirst, 'costuan.txt'), 'advertisement'),
      fs.writeFile(path.join(ruaFirst, '孔雀海.URL'), '[InternetShortcut]\nURL=https://example.invalid/ad'),
      fs.writeFile(path.join(ruaThird, '01.mp4'), 'video'),
      fs.writeFile(path.join(lunanaFirst, '01.png'), 'image')
    ]);
    const before = await fs.readdir(ruaFirst);

    const costuanResult = await service.importCostuanArchive(costuanPath);
    const localResult = await service.reconcileLocalRoot(galleryRoot);
    const report = service.buildReconciliationReport(galleryRoot);
    expect(costuanResult).toMatchObject({ matchedCreators: 2, importedWorks: 4, addedWorks: 4, deliveries: 1 });
    expect(localResult).toMatchObject({
      creatorFolders: 2,
      matchedCreatorFolders: 2,
      localWorks: 3,
      matchedWorks: 3,
      unmatchedWorks: 0,
      ambiguousWorks: 0
    });
    const rua = report.creators.find((creator) => creator.creatorName === 'rua阮阮');
    expect(rua).toMatchObject({ remoteWorks: 3, localWorks: 2, matchedWorks: 2, rating: 'R18' });
    expect(rua?.missingWorks.map((work) => work.sourceOrder)).toEqual([2]);
    const lunana = report.creators.find((creator) => creator.creatorName === 'lunana');
    expect(lunana).toMatchObject({ remoteWorks: 1, localWorks: 1, matchedWorks: 1, rating: 'R15' });
    expect(await fs.readdir(ruaFirst)).toEqual(before);

    const localMetadata = database.prepare(
      `SELECT image_count, video_count, advertisement_file_count
       FROM archive_catalog_local_works
       WHERE folder_name = 'rua阮阮 001 第一套'`
    ).get();
    expect(localMetadata).toEqual({ image_count: 1, video_count: 0, advertisement_file_count: 2 });

    const secondCostuanImport = await service.importCostuanArchive(costuanPath);
    expect(secondCostuanImport).toMatchObject({ importedWorks: 4, addedWorks: 0, updatedWorks: 4 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_works').get()).toEqual({ count: 4 });

    const queryService = new ArchiveCatalogQueryService(database);
    const catalog = queryService.listCreators({ page: 1, limit: 50, state: 'missing' });
    expect(catalog.summary).toMatchObject({
      creators: 2,
      liked: 1,
      kept: 1,
      sourceCollections: 2,
      remoteWorks: 4,
      localWorks: 3,
      matchedWorks: 3,
      missingWorks: 1
    });
    expect(catalog.total).toBe(1);
    expect(catalog.items[0]).toMatchObject({
      name: 'rua阮阮',
      preference: 'liked',
      rating: 'R18',
      remoteWorks: 3,
      localWorks: 2,
      missingWorks: 1
    });
    expect(queryService.listCreators({ page: 1, limit: 50, query: 'lunananya' }).items[0]?.name).toBe('lunana');

    const detail = queryService.getCreatorDetail(catalog.items[0].id);
    expect(detail?.collections).toHaveLength(1);
    expect(detail?.collections[0].deliveries).toHaveLength(1);
    expect(detail?.missing).toEqual([
      expect.objectContaining({ sourceOrder: 2, sourceOrderLabel: 'NO.002', title: '第二套' })
    ]);
    expect(queryService.getCreatorDetail(999_999)).toBeNull();

    database.prepare(
      `UPDATE archive_catalog_local_works
       SET is_active = 0
       WHERE folder_name = 'rua阮阮 NO.003 第三套'`
    ).run();
    const downloadService = new ArchiveDownloadTaskService(database);
    expect(downloadService.planMissing({ targetRoot: 'G:\\cos待入库' })).toEqual({
      created: 2,
      existing: 0,
      removedOutOfScope: 0,
      reconciledLocal: 0,
      skippedWithoutOrder: 0,
      skippedWithoutDelivery: 0,
      targetRoot: 'G:\\cos待入库'
    });
    expect(downloadService.planMissing({ targetRoot: 'G:\\cos待入库' })).toMatchObject({
      created: 0,
      existing: 2
    });
    database.prepare(
      `UPDATE archive_catalog_local_creator_folders
       SET is_active = 0
       WHERE creator_id = (SELECT id FROM archive_catalog_creators WHERE canonical_name = 'rua阮阮')`
    ).run();
    expect(downloadService.planMissing({ targetRoot: 'G:\\cos待入库' })).toMatchObject({
      created: 1,
      existing: 2,
      removedOutOfScope: 0
    });
    database.prepare(
      `UPDATE archive_catalog_local_creator_folders
       SET is_active = 1
       WHERE creator_id = (SELECT id FROM archive_catalog_creators WHERE canonical_name = 'rua阮阮')`
    ).run();
    expect(downloadService.planMissing({ targetRoot: 'G:\\cos待入库' })).toMatchObject({
      created: 0,
      existing: 2,
      removedOutOfScope: 0,
      reconciledLocal: 1
    });
    const pendingTasks = downloadService.list({ status: 'pending' });
    expect(pendingTasks.summary).toMatchObject({ total: 3, pending: 2, ingested: 1 });
    expect(pendingTasks.items[0]).toMatchObject({
      creatorName: 'rua阮阮',
      sourceOrder: 2,
      sourceFolderName: '360',
      targetRoot: 'G:\\cos待入库',
      targetRelativeDirectory: 'rua阮阮',
      targetFilename: '002.7z'
    });
    const firstClaim = downloadService.claim({ workerId: 'test-extension', limit: 1 });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({ status: 'claimed', attemptCount: 1, claimedBy: 'test-extension' });
    const expandedClaim = downloadService.claim({
      workerId: 'test-extension',
      limit: 500,
      seedTaskId: firstClaim[0].id
    });
    expect(expandedClaim).toHaveLength(2);
    expect(expandedClaim.map((task) => task.targetFilename)).toEqual(['002.7z', '003.7z']);
    for (const task of expandedClaim) {
      expect(downloadService.update(task.id, {
        status: 'staged',
        workerId: 'test-extension'
      })).toMatchObject({ status: 'staged' });
    }
    expect(downloadService.list().summary).toMatchObject({ staged: 2, claimed: 0 });

    const bridge = new ArchiveBridgeService(database);
    expect(bridge.isConfigured()).toBe(false);
    const token = bridge.rotateToken();
    expect(bridge.isConfigured()).toBe(true);
    expect(bridge.verifyToken(token)).toBe(true);
    expect(bridge.verifyToken(`${token}x`)).toBe(false);
  });

  it('plans and claims every remote work when the creator has no local folder yet', async () => {
    const costuanPath = path.join(tempRoot, 'remote-only-costuan.json');
    seedCreators(database, [{"name":"整位未下载博主","preference":"liked","rating":"R15"}]);
    await fs.writeFile(costuanPath, JSON.stringify({
      format: 'costuan-archive-metadata',
      version: 1,
      records: {
        'costuan:432': {
          creatorName: '整位未下载博主',
          aliases: [],
          costuan: {
            postId: '432',
            title: '整位未下载博主写真合集[2套][持续更新]',
            works: [
              { order: 1, sourceOrder: 'NO.001', label: '第一套' },
              { order: 2, sourceOrder: 'NO.002', label: '第二套' }
            ]
          },
          baidu: {
            sourceFolderName: '432',
            destinationPath: '我的网盘/cos图集',
            status: 'saved'
          }
        }
      }
    }));    await service.importCostuanArchive(costuanPath);

    const downloadService = new ArchiveDownloadTaskService(database);
    expect(downloadService.planMissing({ targetRoot: 'G:\\cos待入库' })).toMatchObject({
      created: 2,
      existing: 0,
      removedOutOfScope: 0,
      reconciledLocal: 0,
      skippedWithoutDelivery: 0
    });
    const pending = downloadService.list({ status: 'pending' });
    expect(pending.items).toHaveLength(2);
    expect(pending.items.map((task) => task.targetFilename)).toEqual(['001.7z', '002.7z']);
    expect(pending.items[0]).toMatchObject({
      creatorName: '整位未下载博主',
      sourceFolderName: '432',
      targetRelativeDirectory: '整位未下载博主'
    });

    const claimed = downloadService.claim({ workerId: 'test-extension', limit: 500 });
    expect(claimed).toHaveLength(2);
    expect(claimed.every((task) => task.status === 'claimed')).toBe(true);
  });

  it('accepts Costuan zero-order extras while rejecting date-like folder prefixes', () => {
    expect(parseArchiveSourceOrder('000桜桃喵 微博配图')).toBe(0);
    expect(parseArchiveSourceOrder('桜桃喵 NO.226 紫色韵味')).toBe(226);
    expect(parseArchiveSourceOrder('2025.03.24更新')).toBeNull();
    expect(sanitizeArchiveDirectoryName('wendydydydy_酱油')).toBe('wendydydydy_酱油');
    expect(sanitizeArchiveDirectoryName('A/B:*?')).toBe('A_B___');
  });

  it('matches a zero-order extra after removing the creator prefix and reconciles a claimed task', async () => {
    const costuanPath = path.join(tempRoot, 'sakuramomo-costuan.json');
    const galleryRoot = path.join(tempRoot, 'gallery');
    seedCreators(database, [{"name":"桜桃喵","preference":"liked","rating":"R18"}]);
    await fs.writeFile(costuanPath, JSON.stringify({
      format: 'costuan-archive-metadata',
      version: 1,
      records: {
        'costuan:768': {
          creatorName: '桜桃喵',
          aliases: ['桜桃喵'],
          costuan: {
            postId: '768',
            title: '桜桃喵COSPLAY写真图片包合集[226套+微博散图][持续更新]',
            works: [{ order: 0, sourceOrder: 'NO.000', label: '微博配图' }]
          },
          baidu: {
            sourceFolderName: '768',
            destinationPath: '我的网盘/cos图集',
            status: 'saved'
          }
        }
      }
    }));    await service.importCostuanArchive(costuanPath);
    await fs.mkdir(path.join(galleryRoot, '桜桃喵'), { recursive: true });
    await service.reconcileLocalRoot(galleryRoot);

    const downloadService = new ArchiveDownloadTaskService(database);
    expect(downloadService.planMissing({ targetRoot: 'G:\\cos待入库' })).toMatchObject({ created: 1 });
    const [claimedTask] = downloadService.claim({ workerId: 'test-extension', limit: 1 });
    expect(claimedTask).toMatchObject({ targetFilename: '000.7z', status: 'claimed' });

    const localWork = path.join(galleryRoot, '桜桃喵', '桜桃喵 微博配图 [981P-740MB]');
    await fs.mkdir(localWork, { recursive: true });
    await fs.writeFile(path.join(localWork, '01.jpg'), 'image');
    const localResult = await service.reconcileLocalRoot(galleryRoot);
    expect(localResult).toMatchObject({ matchedWorks: 1, unmatchedWorks: 0, ambiguousWorks: 0 });
    expect(database.prepare(
      `SELECT parsed_source_order, match_status, match_method
       FROM archive_catalog_local_works
       WHERE folder_name = ?`
    ).get('桜桃喵 微博配图 [981P-740MB]')).toEqual({
      parsed_source_order: null,
      match_status: 'matched',
      match_method: 'normalized-title-with-creator-prefix'
    });

    expect(downloadService.planMissing({ targetRoot: 'G:\\cos待入库' })).toMatchObject({
      created: 0,
      existing: 0,
      reconciledLocal: 1
    });
    expect(downloadService.get(claimedTask.id)).toMatchObject({
      status: 'ingested',
      claimedBy: null,
      claimedAt: null,
      lastError: null
    });
  });

  it('reconciles the local archive and plans missing tasks idempotently after a gallery scan', async () => {
    const costuanPath = path.join(tempRoot, 'pipeline-costuan.json');
    const galleryRoot = path.join(tempRoot, 'gallery');
    const reportPath = path.join(tempRoot, 'catalog-report.json');
    seedCreators(database, [{"name":"测试博主","preference":"liked","rating":"R15"}]);
    await fs.writeFile(costuanPath, JSON.stringify({
      format: 'costuan-archive-metadata',
      version: 1,
      records: {
        'costuan:1': {
          creatorName: '测试博主',
          aliases: [],
          costuan: {
            postId: '1',
            title: '测试博主写真合集[2套][持续更新]',
            works: [
              { order: 1, sourceOrder: 'NO.001', label: '第一套' },
              { order: 2, sourceOrder: 'NO.002', label: '第二套' }
            ]
          },
          baidu: {
            sourceFolderName: '001',
            destinationPath: '我的网盘/cos图集',
            status: 'saved'
          }
        }
      }
    }));    await service.importCostuanArchive(costuanPath);
    const firstWork = path.join(galleryRoot, '测试博主', '测试博主 NO.001 第一套');
    await fs.mkdir(firstWork, { recursive: true });
    await fs.writeFile(path.join(firstWork, '01.jpg'), 'image');

    const pipeline = new ArchiveCatalogPipelineService(database);
    const first = await pipeline.refreshAfterGalleryScan({
      galleryRoot,
      reportPath,
      defaultInboxRoot: 'G:\\cos待入库'
    });
    expect(first.local).toMatchObject({ matchedCreatorFolders: 1, matchedWorks: 1 });
    expect(first.plan).toMatchObject({ created: 1, existing: 0, targetRoot: 'G:\\cos待入库' });
    expect(first.tasks).toMatchObject({ total: 1, pending: 1 });
    expect(JSON.parse(await fs.readFile(reportPath, 'utf8')).summary).toMatchObject({ missingWorks: 1 });

    const repeated = await pipeline.refreshAfterGalleryScan({
      galleryRoot,
      reportPath,
      defaultInboxRoot: 'D:\\ignored'
    });
    expect(repeated.plan).toMatchObject({ created: 0, existing: 1, targetRoot: 'G:\\cos待入库' });

    const secondWork = path.join(galleryRoot, '测试博主', '测试博主 NO.002 第二套');
    await fs.mkdir(secondWork, { recursive: true });
    await fs.writeFile(path.join(secondWork, '01.png'), 'image');
    const completed = await pipeline.refreshAfterGalleryScan({ galleryRoot, reportPath });
    expect(completed.plan).toMatchObject({ created: 0, existing: 0, reconciledLocal: 1 });
    expect(completed.tasks).toMatchObject({ total: 1, pending: 0, ingested: 1 });
  });

  it('collects metadata for a local-only creator before reconciling and planning missing works', async () => {
    const galleryRoot = path.join(tempRoot, 'gallery');
    const reportPath = path.join(tempRoot, 'metadata-report.json');
    seedCreators(database, [{"name":"本地博主","preference":"liked","rating":"R18"}]);    const localWork = path.join(galleryRoot, '本地博主', '本地博主 NO.001 已有作品');
    await fs.mkdir(localWork, { recursive: true });
    await fs.writeFile(path.join(localWork, '01.jpg'), 'image');
    await service.reconcileLocalRoot(galleryRoot);

    const metadataService = new ArchiveMetadataTaskService(database);
    expect(metadataService.planLocalOnly()).toMatchObject({
      candidates: 1,
      created: 1,
      summary: { pending: 1, actionable: 1 }
    });
    const [task] = metadataService.claim({ workerId: 'costuan-extension', limit: 100 });
    expect(task).toMatchObject({
      creatorName: '本地博主',
      localWorks: 1,
      status: 'claimed',
      claimedBy: 'costuan-extension'
    });
    const completed = metadataService.complete({
      id: task.id,
      workerId: 'costuan-extension',
      record: {
        creatorId: '本地博主',
        creatorName: '本地博主',
        aliases: ['本地博主'],
        costuan: {
          postId: '9527',
          title: '本地博主COSPLAY写真图片包合集[2套][持续更新]',
          url: 'https://www.costuan.com/9527.html',
          collectionCount: 2,
          works: [
            { order: 1, sourceOrder: 'NO.001', label: '已有作品' },
            { order: 2, sourceOrder: 'NO.002', label: '新增作品' }
          ]
        },
        baidu: {
          sourceFolderName: '9527',
          destinationPath: '我的网盘/cos图集',
          status: 'saved'
        }
      }
    });
    expect(completed.task).toMatchObject({ status: 'completed', claimedBy: null });
    expect(completed.importResult).toMatchObject({ matchedCreators: 1, importedWorks: 2, deliveries: 1 });

    const pipeline = new ArchiveCatalogPipelineService(database);
    const finalized = await pipeline.refreshAfterGalleryScan({
      galleryRoot,
      reportPath,
      defaultInboxRoot: 'G:\\cos待入库'
    });
    expect(finalized.local).toMatchObject({ matchedWorks: 1, unmatchedWorks: 0 });
    expect(finalized.report).toMatchObject({ remoteWorks: 2, localWorks: 1, missingWorks: 1 });
    expect(finalized.plan).toMatchObject({ created: 1, skippedWithoutDelivery: 0 });
    expect(finalized.metadata.summary).toMatchObject({ completed: 1, actionable: 0 });
  });
});
