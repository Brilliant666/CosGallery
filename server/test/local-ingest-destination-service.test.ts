import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import {
  LocalIngestDestinationError,
  LocalIngestDestinationService,
  sanitizeLocalIngestDirectoryName
} from '../src/services/local-ingest-destination-service.js';

describe('canonical creator local-ingest destination', () => {
  let database: DatabaseSync;
  let root: string;
  let service: LocalIngestDestinationService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-ingest-destination-'));
    database = new DatabaseSync(':memory:');
    database.exec(schemaSql);
    service = new LocalIngestDestinationService(database, root);
  });

  afterEach(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  function creator(id: number, name: string) {
    database.prepare(
      `INSERT INTO archive_catalog_creators
       (id, canonical_name, normalized_name, seed_source, seed_source_creator_id)
       VALUES (?, ?, ?, 'test', ?)`
    ).run(id, name, name.toLocaleLowerCase(), `creator-${id}`);
  }

  async function linkedDirectory(input: {
    bridgeId: number;
    folderId: number;
    creatorId: number;
    directoryName: string;
  }) {
    const absolute = path.join(root, input.directoryName);
    await fs.mkdir(absolute);
    database.prepare(
      `INSERT INTO folders (id, slug, name, folder_path, role)
       VALUES (?, ?, ?, ?, 'normal')`
    ).run(input.folderId, `folder-${input.folderId}`, input.directoryName, input.directoryName);
    database.prepare(
      `INSERT INTO archive_catalog_local_creator_folders
       (id, gallery_folder_id, creator_id, root_path, relative_path, absolute_path,
        folder_name, match_status, match_method, is_active, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'matched', 'test', 1, 'fixed')`
    ).run(
      input.bridgeId,
      input.folderId,
      input.creatorId,
      root,
      input.directoryName,
      absolute,
      input.directoryName
    );
    return fs.realpath(absolute);
  }

  it('fails closed for multiple directories, then uses and persists the explicit bridge selection', async () => {
    creator(166, 'lunana');
    const historical = await linkedDirectory({ bridgeId: 8, folderId: 1, creatorId: 166, directoryName: 'lunananya' });
    const preferred = await linkedDirectory({ bridgeId: 1004, folderId: 2290, creatorId: 166, directoryName: 'lunana' });

    await expect(service.resolveNewTarget(166, 'lunana NO.047')).rejects.toMatchObject<Partial<LocalIngestDestinationError>>({
      code: 'PREFERRED_INGEST_DIRECTORY_REQUIRED'
    });
    expect((await service.getPreference(166)).mode).toBe('selection-required');

    const saved = await service.setPreferred(166, 1004);
    expect(saved).toMatchObject({
      preferredLocalCreatorFolderId: 1004,
      resolvedCreatorDirectory: preferred,
      mode: 'explicit'
    });
    const plan = await service.resolveNewTarget(166, 'lunana NO.047');
    expect(plan).toMatchObject({
      targetPath: path.join(preferred, 'lunana NO.047'),
      localCreatorFolderId: 1004,
      galleryFolderId: 2290,
      resolution: 'explicit'
    });
    expect(plan.creatorDirectory).not.toBe(historical);

    const reloaded = new LocalIngestDestinationService(database, root);
    expect((await reloaded.getPreference(166)).preferredLocalCreatorFolderId).toBe(1004);
  });

  it('uses the only valid alias directory and never derives it again from the canonical name', async () => {
    creator(1, 'Canonical Name');
    const aliasDirectory = await linkedDirectory({ bridgeId: 2, folderId: 3, creatorId: 1, directoryName: 'legacy-alias' });
    await expect(service.resolveNewTarget(1, 'Work A')).resolves.toMatchObject({
      creatorDirectory: aliasDirectory,
      targetPath: path.join(aliasDirectory, 'Work A'),
      resolution: 'single-linked'
    });
  });

  it('keeps an existing Job target stable after canonical rename and preference change', async () => {
    creator(1, 'Before');
    const original = await linkedDirectory({ bridgeId: 2, folderId: 3, creatorId: 1, directoryName: 'original-root' });
    const newPreferred = await linkedDirectory({
      bridgeId: 4,
      folderId: 5,
      creatorId: 1,
      directoryName: 'new-preferred-root'
    });
    const persistedTarget = path.join(original, 'Original target title');

    database.prepare(
      `UPDATE archive_catalog_creators
       SET canonical_name = 'After', preferred_local_creator_folder_id = 4
       WHERE id = 1`
    ).run();

    await expect(service.validatePersistedTarget({
      creatorId: 1,
      targetPath: persistedTarget,
      workTitle: 'Corrected source title'
    })).resolves.toMatchObject({
      targetPath: persistedTarget,
      creatorDirectory: original,
      localCreatorFolderId: 2
    });
    expect((await service.resolveNewTarget(1, 'New work')).creatorDirectory).toBe(newPreferred);

    database.prepare(
      `UPDATE archive_catalog_local_creator_folders
       SET relative_path = 'mismatched-original-root'
       WHERE id = 2`
    ).run();
    await expect(service.validatePersistedTarget({
      creatorId: 1,
      targetPath: persistedTarget,
      workTitle: 'Corrected source title'
    })).rejects.toMatchObject<Partial<LocalIngestDestinationError>>({
      code: 'TARGET_PLAN_OWNER_MISMATCH'
    });
  });

  it('rejects invalid, cross-creator, stale and out-of-root selections without silently falling back', async () => {
    creator(1, 'One');
    creator(2, 'Two');
    await linkedDirectory({ bridgeId: 10, folderId: 11, creatorId: 1, directoryName: 'one' });
    await linkedDirectory({ bridgeId: 20, folderId: 21, creatorId: 2, directoryName: 'two' });
    await expect(service.setPreferred(1, 20)).rejects.toMatchObject<Partial<LocalIngestDestinationError>>({
      code: 'INGEST_DESTINATION_NOT_OWNED'
    });

    await service.setPreferred(1, 10);
    database.prepare(
      `UPDATE archive_catalog_local_creator_folders
       SET relative_path = 'mismatched-one'
       WHERE id = 10`
    ).run();
    expect((await service.getPreference(1))).toMatchObject({
      mode: 'preferred-unavailable',
      candidates: [expect.objectContaining({ valid: false, unavailableReason: '目录桥接的相对路径与绝对路径不一致' })]
    });
    database.prepare(
      `UPDATE archive_catalog_local_creator_folders
       SET relative_path = 'one'
       WHERE id = 10`
    ).run();
    await fs.rm(path.join(root, 'one'), { recursive: true });
    const unavailable = await service.getPreference(1);
    expect(unavailable.mode).toBe('preferred-unavailable');
    await expect(service.resolveNewTarget(1, 'Work')).rejects.toMatchObject<Partial<LocalIngestDestinationError>>({
      code: 'INGEST_DESTINATION_UNAVAILABLE'
    });
  });

  it('plans a true zero-directory creator once, blocks unconfirmed collisions, and preserves same-creator plans', async () => {
    creator(1, 'New Creator');
    const plan = await service.resolveNewTarget(1, 'First');
    expect(plan).toMatchObject({
      creatorDirectory: path.join(root, 'New Creator'),
      targetPath: path.join(root, 'New Creator', 'First'),
      resolution: 'new-creator'
    });
    database.prepare(
      `INSERT INTO local_ingest_jobs
       (creator_id, source_archive_path, source_archive_name, source_archive_size,
        source_archive_mtime, source_archive_sha256, status, phase, target_path)
       VALUES (1, 'inbox/first.7z', 'first.7z', 1, 1, ?, 'queued', 'discovered', ?)`
    ).run('a'.repeat(64), plan.targetPath);
    await fs.mkdir(path.join(root, 'New Creator'));
    await expect(service.resolveNewTarget(1, 'First')).rejects.toMatchObject<Partial<LocalIngestDestinationError>>({
      code: 'INGEST_TARGET_PLAN_CONFLICT'
    });
    await expect(service.resolveNewTarget(1, 'Second')).resolves.toMatchObject({
      targetPath: path.join(root, 'New Creator', 'Second')
    });

    creator(2, 'Collision');
    await fs.mkdir(path.join(root, 'Collision'));
    await expect(service.resolveNewTarget(2, 'First')).rejects.toMatchObject<Partial<LocalIngestDestinationError>>({
      code: 'UNCONFIRMED_CREATOR_DIRECTORY_EXISTS'
    });
  });

  it('never treats a stale historical bridge as a zero-directory creator', async () => {
    creator(1, 'Historical');
    database.prepare(
      `INSERT INTO archive_catalog_local_creator_folders
       (id, creator_id, root_path, relative_path, absolute_path, folder_name,
        match_status, match_method, is_active, scanned_at)
       VALUES (9, 1, ?, 'missing', ?, 'missing', 'matched', 'old', 0, 'fixed')`
    ).run(root, path.join(root, 'missing'));
    expect((await service.getPreference(1)).mode).toBe('linked-folders-unavailable');
    await expect(service.resolveNewTarget(1, 'Work')).rejects.toMatchObject<Partial<LocalIngestDestinationError>>({
      code: 'INGEST_DESTINATION_UNAVAILABLE'
    });
  });

  it('rejects Windows device names before creating a target plan', () => {
    for (const name of ['CON', 'con.txt', 'PRN', 'AUX.jpg', 'NUL', 'COM1', 'LPT9.png']) {
      expect(() => sanitizeLocalIngestDirectoryName(name)).toThrowError(LocalIngestDestinationError);
    }
    expect(sanitizeLocalIngestDirectoryName('COM10')).toBe('COM10');
  });
});
