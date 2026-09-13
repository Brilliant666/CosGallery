import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';
import { ArchiveCatalogPipelineService } from '../src/services/archive-catalog-pipeline-service.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';

describe('single-work local ledger reconciliation', () => {
  let tempRoot: string;
  let galleryRoot: string;
  let database: DatabaseSync;
  let service: ArchiveCatalogService;
  let creatorId: number;
  const creatorName = 'Scoped';
  const first = 'Scoped NO.001 First';
  const second = 'Scoped NO.002 Second';
  const workPath = (name: string) => path.join(galleryRoot, creatorName, name);
  const rows = () => database.prepare('SELECT * FROM archive_catalog_local_works ORDER BY id').all();
  const scope = (workFolderName: string) => ({
    rootPath: galleryRoot, creators: [{ creatorId, folderName: creatorName }], workFolderName
  });

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-work-scope-'));
    galleryRoot = path.join(tempRoot, 'gallery');
    database = new DatabaseSync(':memory:');
    database.exec(schemaSql);
    service = new ArchiveCatalogService(database);
    creatorId = new ManagedCreatorService(database, galleryRoot).create({ name: creatorName }).id;
    service.importCostuanRecord({ creatorName, costuan: {
      postId: 'work-scope', title: 'Scoped collection', works: [
        { order: 1, sourceOrder: 'NO.001', label: 'First' },
        { order: 2, sourceOrder: 'NO.002', label: 'Second' }
      ]
    } });
    for (const name of [first, second]) {
      await fs.mkdir(workPath(name), { recursive: true });
      await fs.writeFile(path.join(workPath(name), '01.jpg'), 'synthetic');
    }
    await service.reconcileLocalCreators({ rootPath: galleryRoot, creators: [{ creatorId, folderName: creatorName }] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    database.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('updates only the chosen work and leaves an absent sibling byte-for-byte unchanged', async () => {
    const before = rows();
    await fs.rename(workPath(second), path.join(tempRoot, 'absent-sibling'));
    await fs.writeFile(path.join(workPath(first), '02.jpg'), 'synthetic');
    const readdir = vi.spyOn(fs, 'readdir');
    const result = await service.reconcileLocalCreators(scope(first));
    expect(result).toMatchObject({ creatorFolders: 1, localWorks: 1, matchedWorks: 1 });
    expect(rows()[1]).toEqual(before[1]);
    expect(rows()[0]).toMatchObject({ image_count: 2, work_id: before[0].work_id });
    expect(readdir.mock.calls.map(([directory]) => String(directory))).not.toContain(workPath(second));
    expect(readdir.mock.calls.map(([directory]) => String(directory))).not.toContain(path.dirname(workPath(first)));
    readdir.mockRestore();

    // The ordinary creator-wide refresh still deactivates an absent work.
    await service.reconcileLocalCreators({ rootPath: galleryRoot, creators: [{ creatorId, folderName: creatorName }] });
    expect(rows()[1]).toMatchObject({ is_active: 0 });
  });

  it('reserves existing sibling work identities when the selected folder duplicates a source work', async () => {
    const before = rows();
    await fs.rename(workPath(first), path.join(tempRoot, 'absent-original'));
    const duplicate = 'NO.001 First';
    await fs.mkdir(workPath(duplicate));
    await fs.writeFile(path.join(workPath(duplicate), '01.jpg'), 'synthetic');
    const result = await service.reconcileLocalCreators(scope(duplicate));
    expect(result).toMatchObject({ localWorks: 1, matchedWorks: 0, ambiguousWorks: 1 });
    expect(rows().slice(0, 2)).toEqual(before);
    expect(rows()[2]).toMatchObject({ work_id: null, match_status: 'ambiguous' });
  });

  it('passes the chosen work through creator pipeline refresh', async () => {
    const before = rows();
    await fs.rename(workPath(second), path.join(tempRoot, 'absent-sibling'));
    const result = await new ArchiveCatalogPipelineService(database).refreshAfterCreatorGalleryScan({
      galleryRoot, creatorId, creatorFolderName: creatorName, workFolderName: first,
      defaultInboxRoot: path.join(tempRoot, 'inbox')
    });
    expect(result.local).toMatchObject({ localWorks: 1, matchedWorks: 1 });
    expect(rows()[1]).toEqual(before[1]);
  });

  it('rejects unsafe, absent, non-directory and multi-creator targets without ledger mutation', async () => {
    const before = rows();
    for (const name of ['', '.', '..', '../outside', 'nested/work', 'nested\\work', 'C:outside', ` ${first}`, 'missing']) {
      await expect(service.reconcileLocalCreators(scope(name))).rejects.toThrow();
    }
    await fs.writeFile(workPath('file'), 'synthetic');
    await expect(service.reconcileLocalCreators(scope('file'))).rejects.toThrow();
    await expect(service.reconcileLocalCreators({ ...scope(first), creators: [
      { creatorId, folderName: creatorName }, { creatorId, folderName: creatorName }
    ] })).rejects.toThrow('只能指定一个博主');
    expect(rows()).toEqual(before);
  });

  it('rejects junction or symlink work targets without following them', async () => {
    const before = rows();
    const outside = path.join(tempRoot, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, '01.jpg'), 'synthetic');
    await fs.symlink(outside, workPath('linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.reconcileLocalCreators(scope('linked'))).rejects.toThrow('直接文件夹');
    expect(rows()).toEqual(before);
  });
});
