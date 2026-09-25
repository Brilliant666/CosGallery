import { seedCreators } from './creator-fixtures.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';
import { parseCostuanDirectoryText } from '../src/services/costuan-numbering-service.js';
import { songHanaDirectory, songHanaTitle } from './fixtures/costuan-song-hana-directory.js';

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

  it('imports the mixed 23-row article into an isolated catalog idempotently without publisher-volume collisions',()=>{
    seedCreators(database,[{name:'SongHana',preference:'liked',rating:'R15'}]);
    const {id}=database.prepare('SELECT id FROM archive_catalog_creators WHERE normalized_name=?').get('songhana') as {id:number};
    const service=new ArchiveCatalogService(database);
    // Synthetic article identity; the host intentionally exercises the real host check, never network access.
    const record={creatorName:'SongHana',aliases:[],costuan:{postId:'fixture-mixed-numbering',title:songHanaTitle,collectionCount:23,
      resourceDirectoryText:songHanaDirectory,works:parseCostuanDirectoryText(songHanaDirectory),
      identityEvidence:{version:1,pageUrl:'https://www.costuan.com/fixture-mixed-numbering.html',creatorTags:[{name:'Song Hana',url:'https://www.costuan.com/tag/142'}]},
      directoryVerification:{complete:true,checkedAt:'2026-09-20T00:00:00Z',parsedWorkCount:23}
    }};
    const validated=service.validateCompleteCostuanDirectory(record,id);
    expect(service.importCostuanRecord(validated.record,{expectedCreatorId:id})).toMatchObject({addedWorks:23,importedWorks:23});
    const before=database.prepare('SELECT id,work_id,source_work_id,raw_title FROM archive_catalog_source_works ORDER BY id').all();
    expect(service.importCostuanRecord(validated.record,{expectedCreatorId:id})).toMatchObject({addedWorks:0,importedWorks:23});
    expect(database.prepare('SELECT id,work_id,source_work_id,raw_title FROM archive_catalog_source_works ORDER BY id').all()).toEqual(before);
    expect(before.map(work=>work.source_work_id)).toEqual(Array.from({length:23},(_,i)=>`NO.${String(i+1).padStart(3,'0')}`));
    expect(before[19].raw_title).toContain('Vol.02 Micro bikini');
    expect(database.prepare('SELECT COUNT(*) AS n FROM archive_catalog_works').get()).toEqual({n:23});
  });

  it.each(['','混合博主 NO.001 单套 [1P-1MB]'])('refuses a range hidden in offline works with raw text %s',async text=>{
    const input=path.join(tempRoot,'range.json');
    seedCreators(database,[{name:'混合博主',preference:'liked',rating:'R15'}]);
    const before=JSON.stringify(database.prepare('SELECT * FROM archive_catalog_works').all());
    await fs.writeFile(input,JSON.stringify({format:'costuan-archive-metadata',version:1,records:{'costuan:range':{
      creatorName:'混合博主',aliases:[],costuan:{postId:'range',title:'混合博主COSPLAY写真合集[3套][持续更新]',collectionCount:3,
        resourceDirectoryText:text,works:[{sourceOrder:'NO.001-NO.003',label:'合计',rawTitle:'混合博主 NO.001 单套'}]}
    }}}));
    await expect(new ArchiveCatalogService(database).importCostuanArchive(input)).rejects.toThrow(/范围声明/);
    expect(JSON.stringify(database.prepare('SELECT * FROM archive_catalog_works').all())).toBe(before);
    expect(database.prepare('SELECT COUNT(*) AS n FROM archive_catalog_source_works').get()).toEqual({n:0});
  });

  it('rebuilds an empty lossy works array from raw VOL/NO text without duplicates', async () => {
    const costuanPath = path.join(tempRoot, 'costuan.json');
    seedCreators(database, [{"name":"混合博主","preference":"liked","rating":"R15"}]);
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

    const service = new ArchiveCatalogService(database);    const first = await service.importCostuanArchive(costuanPath);
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
