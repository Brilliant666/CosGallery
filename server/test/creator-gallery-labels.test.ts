import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { CreatorGalleryLabelService } from '../src/services/creator-gallery-label-service.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';

describe('000031 optional creator gallery labels', () => {
  it('upgrades the real through-000030 chain without classifying existing creators', () => {
    const db = new DatabaseSync(':memory:');
    const migrations = new URL('../db/migrations/', import.meta.url);
    try {
      for (const name of fs.readdirSync(migrations).filter(name => name.endsWith('.sql') && name < '000031').sort()) {
        db.exec(fs.readFileSync(new URL(name, migrations), 'utf8').split('-- migrate:down')[0].replace('-- migrate:up', ''));
      }
      db.exec(`PRAGMA foreign_keys=ON;
        INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id,preference,effective_rating)
        VALUES(1,'Sample','sample','fixture','one','liked','R18');`);
      const before = db.prepare('SELECT * FROM archive_catalog_creators').get();
      const [up, down] = fs.readFileSync(new URL('000031_creator_gallery_labels.sql', migrations), 'utf8').replace('-- migrate:up', '').split('-- migrate:down');
      db.exec(up);
      expect(db.prepare('SELECT * FROM archive_catalog_creators').get()).toEqual({ ...before, gallery_labels_revision: 0 });
      expect(db.prepare('SELECT * FROM archive_catalog_creator_gallery_labels').all()).toEqual([]);
      db.exec("INSERT INTO archive_catalog_creator_gallery_labels VALUES(1,'cosplay'),(1,'portrait')");
      expect(() => db.exec("INSERT INTO archive_catalog_creator_gallery_labels VALUES(1,'cosplay')")).toThrow();
      expect(() => db.exec("INSERT INTO archive_catalog_creator_gallery_labels VALUES(1,'unknown')")).toThrow();
      expect(() => db.exec("INSERT INTO archive_catalog_creator_gallery_labels VALUES(999,'selfie')")).toThrow();
      db.exec('DELETE FROM archive_catalog_creators WHERE id=1');
      expect(db.prepare('SELECT * FROM archive_catalog_creator_gallery_labels').all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      db.exec(down);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='archive_catalog_creator_gallery_labels'").get()).toBeUndefined();
    } finally { db.close(); }
  });
});

describe('creator labels metadata and independent concurrency scope', () => {
  let db: DatabaseSync, service: CreatorGalleryLabelService, managed: ManagedCreatorService, id: number;
  beforeEach(() => {
    db = new DatabaseSync(':memory:'); db.exec(schemaSql);
    service = new CreatorGalleryLabelService(db);
    managed = new ManagedCreatorService(db);
    id = managed.create({ name: 'Sample', preference: 'liked', rating: 'R18' }).id;
  });
  afterEach(() => db.close());
  const save = (galleryLabels: string[]) => service.update(id, { galleryLabels, expectedRevision: service.get(id).revision });

  it('saves all or empty labels in stable order without changing other metadata', () => {
    const original = db.prepare('SELECT preference,effective_rating,updated_at FROM archive_catalog_creators WHERE id=?').get(id);
    expect(service.get(id).galleryLabels).toEqual([]);
    expect(save(['fuliji', 'selfie', 'portrait', 'cosplay']).galleryLabels).toEqual(['cosplay', 'portrait', 'selfie', 'fuliji']);
    expect(save([]).galleryLabels).toEqual([]);
    expect(db.prepare('SELECT preference,effective_rating,updated_at FROM archive_catalog_creators WHERE id=?').get(id)).toEqual(original);
    expect(db.prepare('SELECT count(*) n FROM archive_catalog_works').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM archive_catalog_creator_sources').get()).toEqual({ n: 0 });
  });

  it('rejects stale, ABA, wrong-creator and invalid writes atomically', () => {
    const initial = service.get(id);
    save(['cosplay']); save([]);
    expect(() => service.update(id, { galleryLabels: ['portrait'], expectedRevision: initial.revision })).toThrow('重新读取');
    const other = managed.create({ name: 'Other' }).id;
    expect(() => service.update(other, { galleryLabels: ['selfie'], expectedRevision: service.get(id).revision })).toThrow('重新读取');
    for (const galleryLabels of [['invalid'], ['cosplay', 'cosplay'], ['cosplay', 'portrait', 'selfie', 'fuliji', 'cosplay']]) {
      expect(() => save(galleryLabels)).toThrow();
      expect(service.get(id).galleryLabels).toEqual([]);
    }
    const revision = service.get(id).revision;
    managed.update(id, { name: 'Renamed', preference: 'kept' });
    expect(service.update(id, { galleryLabels: ['selfie'], expectedRevision: revision }).galleryLabels).toEqual(['selfie']);
    expect(() => service.get(999)).toThrow('博主不存在');
  });

  it('rolls back partial label writes when persistence fails', () => {
    const before = save(['cosplay']);
    db.exec(`CREATE TRIGGER reject_label BEFORE INSERT ON archive_catalog_creator_gallery_labels
      WHEN NEW.label='portrait' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
    expect(() => service.update(id, { galleryLabels: ['cosplay', 'portrait'], expectedRevision: before.revision })).toThrow('fixture failure');
    expect(service.get(id)).toEqual(before);
  });

  it('includes labels in controlled creator deletion scope, token and audit', () => {
    managed.setActive(id, false, { confirm: true });
    const old = managed.deletionPreview(id);
    save(['cosplay', 'portrait']);
    const preview = managed.deletionPreview(id);
    expect(preview.eligible).toBe(true);
    expect(preview.removalScope).toContainEqual({ kind: 'galleryLabels', label: '图库标签', count: 2 });
    expect(() => managed.deleteUnusedManualCreator(id, { confirm: true, confirmationToken: old.confirmationToken })).toThrow('重新检查');
    managed.deleteUnusedManualCreator(id, { confirm: true, confirmationToken: preview.confirmationToken });
    expect(db.prepare('SELECT * FROM archive_catalog_creator_gallery_labels').all()).toEqual([]);
    const audit = db.prepare('SELECT snapshot_json FROM creator_deletion_audits WHERE creator_id=?').get(id)!;
    expect(JSON.parse(String(audit.snapshot_json)).archive_catalog_creator_gallery_labels).toEqual([
      { creator_id: id, label: 'cosplay' }, { creator_id: id, label: 'portrait' }
    ]);
  });
});
