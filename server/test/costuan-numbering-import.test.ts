import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';

describe('Costuan mixed-numbering metadata import', () => {
  let database: DatabaseSync;
  let tempRoot: string;

  beforeEach(async () => {
    database = new DatabaseSync(':memory:');
    database.exec(schemaSql);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'costuan-numbering-import-'));
  });

  afterEach(async () => {
    database.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rebuilds an empty lossy works array from raw VOL/NO text without duplicates', async () => {
    const hcfPath = path.join(tempRoot, 'hcf.json');
    const costuanPath = path.join(tempRoot, 'costuan.json');
    await fs.writeFile(hcfPath, JSON.stringify({
      format: 'hcf-tag-preferences',
      version: 1,
      state: { liked: ['混合博主'], kept: [] },
      contentRatings: { entries: [{ name: '混合博主', rating: 'r15' }] }
    }));
    await fs.writeFile(costuanPath, JSON.stringify({
      format: 'costuan-archive-metadata',
      version: 1,
      records: {
        'costuan:mixed': {
          creatorName: '混合博主',
          aliases: [],
          costuan: {
            postId: 'mixed',
            title: '混合博主合集[2套][持续更新]',
            collectionCount: 2,
            works: [],
            resourceDirectoryText: [
              '混合博主 NO.013 黑护士 [10P-20MB]',
              '混合博主 VOL.013 白蕾丝姐姐 [20P-30MB]'
            ].join('\n')
          }
        }
      }
    }));

    const service = new ArchiveCatalogService(database);
    await service.importHentaiclubSeed(hcfPath);
    const first = await service.importCostuanArchive(costuanPath);
    const second = await service.importCostuanArchive(costuanPath);

    expect(first).toMatchObject({ importedWorks: 2, addedWorks: 2 });
    expect(second).toMatchObject({ importedWorks: 2, addedWorks: 0, updatedWorks: 2 });
    const rows = database.prepare(
      `SELECT source_work_id, source_order, source_order_label, raw_title, metadata_json
       FROM archive_catalog_source_works ORDER BY source_work_id`
    ).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.source_work_id)).toEqual(['NO.013', 'VOL.013']);
    expect(rows.map((row) => JSON.parse(String(row.metadata_json)).sourceOrderKey)).toEqual([
      'NO:013',
      'VOL:013'
    ]);
    expect(rows.every((row) => typeof row.raw_title === 'string')).toBe(true);
    expect(database.prepare('SELECT COUNT(*) AS count FROM archive_catalog_works').get()).toEqual({ count: 2 });
  });
});
