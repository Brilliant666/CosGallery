import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';
import { ArchiveDownloadTaskService } from '../src/services/archive-download-task-service.js';
import { seedCreators } from './creator-fixtures.js';

describe('legacy reconciliation consumes shared identity evidence', () => {
  let db: DatabaseSync;
  let root: string;
  let catalog: ArchiveCatalogService;
  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'title-boundary-'));
    catalog = new ArchiveCatalogService(db);
    seedCreators(db, [{name:'Synthetic',preference:'liked',rating:'R15'}]);
  });
  afterEach(async () => { db.close(); await fs.rm(root, {recursive:true,force:true}); });
  function source(label: string) {
    catalog.importCostuanRecord({creatorName:'Synthetic',costuan:{postId:'synthetic',title:'Synthetic collection',
      works:[{order:1,sourceOrder:'NO.001',label}]},baidu:{sourceFolderName:'synthetic',destinationPath:'fixture',status:'saved'}});
  }
  async function local(name: string) {
    const directory = path.join(root,'Synthetic',name);
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,'one.jpg'),'synthetic');
    return directory;
  }
  it.each([
    ['Synthetic 001 Summer','Summer'],
    ['Synthetic summer','Summer'],
    ['Synthetic Summer-Night','Summer Night'],
    ['Synthetic NO.001 Summer Night Extra','Summer Night'],
    ['Synthetic NO.001 黑咝自怕','黑丝自拍'],
    ['Synthetic 黑咝自怕','黑丝自拍'],
    ['Synthetic NO.001 Theme 2','Theme 3']
  ])('holds %s for review without guessing Work identity or creating acquisition', async (name,title) => {
    source(title);
    const count = db.prepare('SELECT COUNT(*) AS count FROM archive_catalog_works').get();
    await local(name);
    expect(await catalog.reconcileLocalRoot(root)).toMatchObject({matchedWorks:0,ambiguousWorks:1,unmatchedWorks:0});
    expect(db.prepare('SELECT work_id,match_status FROM archive_catalog_local_works').get())
      .toEqual({work_id:null,match_status:'ambiguous'});
    const tasks = new ArchiveDownloadTaskService(db);
    expect(tasks.planMissing({targetRoot:path.join(root,'inbox')})).toMatchObject({created:0,reconciledLocal:0});
    expect(tasks.claim({workerId:'fixture',limit:1})).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM archive_catalog_work_decisions').get()).toEqual({count:0});
    expect(db.prepare('SELECT COUNT(*) AS count FROM archive_catalog_local_fulfillments').get()).toEqual({count:0});
    expect(db.prepare('SELECT COUNT(*) AS count FROM archive_catalog_works').get()).toEqual(count);
  });
  it('blocks existing pending acquisition without changing its execution history, then releases only a resolved row', async () => {
    source('Summer');
    const tasks = new ArchiveDownloadTaskService(db);
    expect(tasks.planMissing({targetRoot:path.join(root,'inbox')})).toMatchObject({created:1});
    const before = db.prepare('SELECT * FROM archive_catalog_download_tasks').get();
    const directory = await local('Synthetic 001 Summer');
    await catalog.reconcileLocalRoot(root);
    expect(tasks.list().items[0]?.acquisitionState).toBe('review_required');
    expect(tasks.claim({workerId:'fixture',limit:1})).toEqual([]);
    expect(db.prepare('SELECT * FROM archive_catalog_download_tasks').get()).toEqual(before);
    await fs.rename(directory,path.join(root,'Synthetic','Synthetic NO.009 Summer'));
    // Local/source numbering differs, but the unique conservative title is exact.
    expect(await catalog.reconcileLocalRoot(root)).toMatchObject({matchedWorks:1,ambiguousWorks:0});
    expect(db.prepare("SELECT work_id,match_method FROM archive_catalog_local_works WHERE is_active=1").get())
      .toMatchObject({work_id:expect.any(Number),match_method:'shared-exact-title'});
    expect(tasks.planMissing({targetRoot:path.join(root,'inbox')})).toMatchObject({created:0,reconciledLocal:1});
  });
  it('does not use a source number to disambiguate two separate Work identities with the same title', async () => {
    catalog.importCostuanRecord({creatorName:'Synthetic',costuan:{postId:'synthetic',title:'Synthetic collection',
      works:[{order:1,sourceOrder:'NO.001',label:'Summer'},{order:2,sourceOrder:'NO.002',label:'Winter'}]}});
    // Simulate legacy identities; current imports already reject duplicate titles.
    db.prepare("UPDATE archive_catalog_source_works SET source_title='Summer' WHERE source_work_id='NO.002'").run();
    db.prepare("UPDATE archive_catalog_works SET display_title='Summer' WHERE display_title='Winter'").run();
    await local('Synthetic NO.001 Summer');
    expect(await catalog.reconcileLocalRoot(root)).toMatchObject({matchedWorks:0,ambiguousWorks:1});
    expect(db.prepare('SELECT work_id FROM archive_catalog_local_works').get()).toEqual({work_id:null});
  });
});
