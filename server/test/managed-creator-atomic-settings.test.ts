import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';
import { LocalIngestDestinationService } from '../src/services/local-ingest-destination-service.js';

describe('managed creator atomic editing scopes', () => {
  let root: string, db: DatabaseSync, service: ManagedCreatorService, id: number;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'creator-atomic-'));
    db = new DatabaseSync(path.join(root, 'fixture.sqlite'));
    db.exec(schemaSql);
    service = new ManagedCreatorService(db, root);
    id = service.create({ name: 'Original', aliases: ['Old alias'] }).id;
  });
  afterEach(async () => { vi.restoreAllMocks(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const snapshot = () => ['archive_catalog_creators', 'archive_catalog_creator_aliases', 'archive_catalog_local_creator_folders',
    'resource_catalog_state', 'resource_catalog_meta'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  async function folder(name: string) {
    await fs.mkdir(path.join(root, name));
    return Number(db.prepare('INSERT INTO folders(slug,name,folder_path) VALUES(?,?,?)').run(name, name, name).lastInsertRowid);
  }
  async function profile() {
    return { expectedRevision: (await service.editingState(id)).profileRevision,
      name: 'Changed', preference: 'liked', rating: 'R18', manualAliases: ['New alias'], confirmDistinct: false };
  }
  async function directory(linkedFolderIds: number[], preferredGalleryFolderId: number | null = null) {
    return { linkedFolderIds, preferredGalleryFolderId, expectedRevision: (await service.editingState(id)).directoriesRevision };
  }

  it('commits profile fields and the complete manual alias draft, preserving source/history rows', async () => {
    db.prepare(`INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source)
      VALUES(?,'Source name','sourcename','costuan')`).run(id);
    const result = service.saveProfile(id, await profile());
    expect(result.creator).toMatchObject({ name: 'Changed', preference: 'liked', rating: 'R18' });
    expect(result.creator.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: 'Source name', source: 'costuan', editable: false }),
      expect.objectContaining({ alias: 'Original', source: 'manual-history', editable: false }),
      expect.objectContaining({ alias: 'New alias', source: 'manual', editable: true })
    ]));
    expect(result.creator.aliases.some(alias => alias.alias === 'Old alias')).toBe(false);
    expect(() => service.deleteAlias(id, result.creator.aliases.find(alias => alias.source === 'costuan')!.id)).toThrow('只读');
  });

  it('rolls every field, alias, and invalidation back if the final profile write fails', async () => {
    const body = await profile(), before = snapshot();
    db.exec(`CREATE TRIGGER reject_profile BEFORE UPDATE OF canonical_name ON archive_catalog_creators
      BEGIN SELECT RAISE(ABORT, 'profile failure'); END`);
    expect(() => service.saveProfile(id, body)).toThrow('profile failure');
    expect(snapshot()).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });

  it('requires explicit identity collision confirmation and rejects forged source alias edits', async () => {
    const other = service.create({ name: 'Another', aliases: ['Clashing'] });
    const body = { ...await profile(), manualAliases: ['Clashing'] }, before = snapshot();
    expect(() => service.saveProfile(id, body)).toThrow('名称或别名');
    expect(snapshot()).toEqual(before);
    expect(() => service.saveProfile(id, { ...body, aliases: [{ source: 'costuan', alias: 'x' }] })).toThrow();
    service.saveProfile(id, { ...body, confirmDistinct: true });
    expect(service.create({ name: 'Independent' }).id).not.toBe(other.id);
    const current = await service.editingState(id);
    expect(service.saveProfile(id, { ...body, preference: 'kept', expectedRevision: current.profileRevision }).creator.preference).toBe('kept');
  });

  it('rejects stale/repeated submissions, including changes from an independent connection', async () => {
    const body = await profile();
    service.saveProfile(id, body);
    const after = snapshot();
    expect(() => service.saveProfile(id, body)).toThrow('其他操作修改');
    expect(snapshot()).toEqual(after);
    const next = await profile();
    const other = new DatabaseSync(path.join(root, 'fixture.sqlite'));
    try { other.prepare('UPDATE archive_catalog_creators SET preference=? WHERE id=?').run('kept', id); }
    finally { other.close(); }
    expect(() => service.saveProfile(id, next)).toThrow('其他操作修改');
  });

  it('keeps independent profile and directory revisions, and no-op saves do not publish invalidations', async () => {
    const first = await service.editingState(id), f = await folder('New directory');
    const body = await profile();
    await service.saveDirectories(id, await directory([f], f));
    expect(service.saveProfile(id, body).creator.name).toBe('Changed');
    const current = await service.editingState(id);
    expect(current.directoriesRevision).not.toBe(first.directoriesRevision);
    const before = snapshot();
    service.saveProfile(id, { ...body, expectedRevision: current.profileRevision });
    await service.saveDirectories(id, await directory([f], f));
    expect(snapshot()).toEqual(before);
  });

  it('links a new directory and selects its new bridge in one save; atomically replaces the preferred relation', async () => {
    const a = await folder('A'), b = await folder('B');
    const first = await service.saveDirectories(id, await directory([a], a));
    expect(first.linkedFolderIds).toEqual([a]);
    expect(first.preferredLocalCreatorFolderId).not.toBeNull();
    expect(() => service.unlinkFolder(a, { confirm: true })).toThrow('首选');
    const body = await directory([b], b);
    const final = await service.saveDirectories(id, body);
    expect(final.linkedFolderIds).toEqual([b]);
    expect(final.preferredLocalCreatorFolderId).not.toBe(first.preferredLocalCreatorFolderId);
    expect((await service.editingState(id)).destination).toMatchObject({ mode: 'explicit', resolvedGalleryFolderId: b });
    const before = snapshot();
    await expect(service.saveDirectories(id, body)).rejects.toThrow('其他操作修改');
    expect(snapshot()).toEqual(before);
    expect((await fs.stat(path.join(root, 'A'))).isDirectory()).toBe(true);
  });

  it('rolls new links and preferred changes back if unlink fails late in the transaction', async () => {
    const a = await folder('A'), b = await folder('B');
    await service.saveDirectories(id, await directory([a], a));
    const body = await directory([b], b), before = snapshot();
    db.exec(`CREATE TRIGGER reject_unlink BEFORE UPDATE OF creator_id ON archive_catalog_local_creator_folders
      WHEN NEW.creator_id IS NULL BEGIN SELECT RAISE(ABORT, 'unlink failure'); END`);
    await expect(service.saveDirectories(id, body)).rejects.toThrow('unlink failure');
    expect(snapshot()).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });

  it('rejects directory ownership, primary reference, and on-disk availability conflicts without partial writes', async () => {
    const a = await folder('A'), b = await folder('B'), other = service.create({ name: 'Other' }).id;
    service.linkFolder(b, { creatorId: other });
    const before = snapshot();
    await expect(service.saveDirectories(id, await directory([a, b], a))).rejects.toThrow('已关联');
    expect(snapshot()).toEqual(before);
    await expect(service.saveDirectories(id, await directory([a], b))).rejects.toThrow('保存后的关联');
    await fs.rmdir(path.join(root, 'A'));
    await expect(service.saveDirectories(id, await directory([a], a))).rejects.toThrow('不可用');
    expect(snapshot()).toEqual(before);
  });

  it('does not hold a transaction over IO, and rejects concurrent preference or folder changes before committing', async () => {
    const a = await folder('A');
    service.linkFolder(a, { creatorId: id });
    const body = await directory([a], a);
    const inspect = LocalIngestDestinationService.prototype.inspectGalleryFolder;
    vi.spyOn(LocalIngestDestinationService.prototype, 'inspectGalleryFolder').mockImplementation(async function (folderId) {
      const result = await inspect.call(this, folderId);
      expect(db.isTransaction).toBe(false);
      const other = new DatabaseSync(path.join(root, 'fixture.sqlite'));
      try { other.prepare(`UPDATE folders SET folder_path='changed' WHERE id=?`).run(folderId); }
      finally { other.close(); }
      return result;
    });
    await expect(service.saveDirectories(id, body)).rejects.toThrow('其他操作修改');
    expect(db.prepare('SELECT preferred_local_creator_folder_id AS preferred FROM archive_catalog_creators WHERE id=?').get(id)).toEqual({ preferred: null });
  });

  it('preserves caller-owned transactions and protects active persisted admission tasks', async () => {
    const a = await folder('A'), body = await profile();
    db.exec('BEGIN');
    service.saveProfile(id, body);
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect((await service.editingState(id)).creator.name).toBe('Original');
    db.prepare(`INSERT INTO local_admission_web_batches(id,creator_id,input_root,state,created_at,updated_at,context_json)
      VALUES('active',?,'fixture','running','fixed','fixed','{}')`).run(id);
    await expect(service.saveDirectories(id, await directory([a], a))).rejects.toThrow('活动入库');
    expect((await service.editingState(id)).linkedFolderIds).toEqual([]);
  });
});
