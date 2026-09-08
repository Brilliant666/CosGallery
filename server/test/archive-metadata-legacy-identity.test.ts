import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ArchiveMetadataTaskService } from '../src/services/archive-metadata-task-service.js';

describe('metadata task persisted legacy identity bridge', () => {
  let db: DatabaseSync;
  let service: ArchiveMetadataTaskService;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    service = new ArchiveMetadataTaskService(db);
  });
  afterEach(() => db.close());

  function task(id: number, seedId: string, source = 'hentaiclub', name = 'Same name') {
    db.prepare(`INSERT INTO archive_catalog_creators
      (id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES (?,?,?, ?,?)`).run(id, name, name.toLowerCase(), source, seedId);
    db.prepare(`INSERT INTO archive_catalog_metadata_tasks(id,creator_id,source,status)
      VALUES (?,?,'costuan','pending')`).run(id, id);
    return service.get(id)!;
  }

  it('returns the original seed ID after canonical rename/alias changes, including completed task refresh, without writes', () => {
    task(1, '纸悦Etsuko', 'hentaiclub', 'New canonical name');
    db.prepare(`INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source)
      VALUES (1,'纸悦Etsu_ko','纸悦etsuko','manual')`).run();
    db.prepare("UPDATE archive_catalog_metadata_tasks SET status='completed' WHERE id=1").run();
    const before = db.prepare('SELECT total_changes() AS n').get();
    const expected = { source: 'hentaiclub', sourceCreatorId: '纸悦Etsuko' };
    expect(service.get(1)).toMatchObject({ creatorName: 'New canonical name', legacyIdentity: expected });
    expect(new ArchiveMetadataTaskService(db).list({ status: 'completed' }).items[0])
      .toMatchObject({ status: 'completed', legacyIdentity: expected, aliases: ['纸悦Etsu_ko'] });
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('keeps same-named distinct creators linked to their own exact seed IDs', () => {
    expect(task(1, 'Case_ID').legacyIdentity).toEqual({ source: 'hentaiclub', sourceCreatorId: 'Case_ID' });
    expect(task(2, 'case2id').legacyIdentity).toEqual({ source: 'hentaiclub', sourceCreatorId: 'case2id' });
    expect(service.list().items.map(item => item.legacyIdentity?.sourceCreatorId).sort())
      .toEqual(['Case_ID', 'case2id']);
  });

  it.each(['manual', 'costuan', 'HentaiClub'])('does not infer a legacy identity for unrelated seed source %s', source => {
    expect(task(1, 'existing-legacy-name', source).legacyIdentity).toBeNull();
  });

  it.each(['', '  ', '\t\n', '_—[]', '\u200b'])('fails closed for empty encoded seed ID %j', seedId => {
    expect(task(1, seedId).legacyIdentity).toBeNull();
  });

  it.each(['caseid', 'ＣａｓｅＩＤ', ' Case ID ', 'Case\u200bID', '[Case]—ID'])
    ('rejects globally colliding legacy encoding %j even without a metadata task', alternateSeedId => {
      task(1, 'Case_ID');
      task(2, alternateSeedId, 'hentaiclub', 'Unrelated canonical name');
      db.prepare('DELETE FROM archive_catalog_metadata_tasks WHERE id=2').run();
      db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=2').run();
      expect(service.get(1)?.legacyIdentity).toBeNull();
      expect(service.list({limit:1}).items).toMatchObject([{creatorId:1,legacyIdentity:null}]);
    });

  it('fails closed on duplicate persisted seed identities even if the other creator is inactive', () => {
    // The production unique constraint normally prevents this. Simulate an
    // imported inconsistent schema solely in this in-memory fixture.
    db.close();
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql.replace('UNIQUE(seed_source, seed_source_creator_id),', ''));
    service = new ArchiveMetadataTaskService(db);
    task(1, 'one-legacy-id');
    task(2, 'one-legacy-id', 'hentaiclub', 'Different name');
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=2').run();
    expect(service.get(1)?.legacyIdentity).toBeNull();
    expect(service.get(2)?.legacyIdentity).toBeNull();
  });
});
