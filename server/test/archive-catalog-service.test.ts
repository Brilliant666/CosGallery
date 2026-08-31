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
import { ArchiveCatalogQueryService } from '../src/services/archive-catalog-query-service.js';

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

  it('imports seed creators before media exists and reconciles a partial local archive read-only', async () => {
    const hcfPath = path.join(tempRoot, 'hcf.json');
    const costuanPath = path.join(tempRoot, 'costuan.json');
    const galleryRoot = path.join(tempRoot, 'gallery');
    await fs.writeFile(hcfPath, JSON.stringify({
      format: 'hcf-tag-preferences',
      version: 6,
      exportedAt: '2026-08-30T00:00:00.000Z',
      state: { liked: ['rua阮阮'], kept: ['lunana'] },
      contentRatings: {
        entries: [
          { name: 'rua阮阮', rating: 'r18', checkedAt: 1 },
          { name: 'lunana', rating: 'r15', checkedAt: 2 }
        ]
      }
    }));
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
      fs.writeFile(path.join(ruaThird, '01.mp4'), 'video'),
      fs.writeFile(path.join(lunanaFirst, '01.png'), 'image')
    ]);
    const before = await fs.readdir(ruaFirst);

    const hcfResult = await service.importHentaiclubSeed(hcfPath);
    const costuanResult = await service.importCostuanArchive(costuanPath);
    const localResult = await service.reconcileLocalRoot(galleryRoot);
    const report = service.buildReconciliationReport(galleryRoot);

    expect(hcfResult).toMatchObject({ total: 2, created: 2, liked: 1, kept: 1 });
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
    expect(localMetadata).toEqual({ image_count: 1, video_count: 0, advertisement_file_count: 1 });

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
  });

  it('accepts Costuan zero-order extras while rejecting date-like folder prefixes', () => {
    expect(parseArchiveSourceOrder('000桜桃喵 微博配图')).toBe(0);
    expect(parseArchiveSourceOrder('桜桃喵 NO.226 紫色韵味')).toBe(226);
    expect(parseArchiveSourceOrder('2025.03.24更新')).toBeNull();
  });
});
