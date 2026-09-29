import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ApplicationRecoveryService } from '../src/services/application-recovery-core.js';

const migrations = new URL('../db/migrations/', import.meta.url);
const filename = '000030_remove_redundant_manual_creator_aliases.sql';
const [up, down] = fs
  .readFileSync(new URL(filename, migrations), 'utf8')
  .replace('-- migrate:up', '')
  .split('-- migrate:down');

function seed(db: DatabaseSync) {
  db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
    VALUES(1,'Artist-A','artist-a','test','1'),(2,'作品名','作品名','test','2');
    INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source,created_at,updated_at) VALUES
    (1,'Artist-A','artist-a','manual','created','updated'),
    (1,'artist-a','case-variant','manual','created','updated'),
    (1,'Artist.A','punctuation-variant','manual','created','updated'),
    (1,' Artist-A ','whitespace-variant','manual','created','updated'),
    (1,'Ａrtist-A','width-variant','manual','created','updated'),
    (1,'Artist-A','artist-a','source','created','updated'),
    (1,'Artist-A','artist-a','history','created','updated'),
    (1,'Artist-A','artist-a','Manual','created','updated'),
    (2,'作品名','historical-normalization','manual','created','updated');
    INSERT INTO archive_catalog_creator_sources(creator_id,source,source_creator_id,source_display_name,first_seen_at,last_seen_at)
    VALUES(1,'source','1','Artist-A','first','last');`);
}
function aliases(db: DatabaseSync) {
  return db
    .prepare(
      'SELECT * FROM archive_catalog_creator_aliases ORDER BY creator_id,source,normalized_alias',
    )
    .all();
}

describe('000030 exact manual creator alias cleanup', () => {
  it('uses binary exact matching, preserves evidence and variants, repeats safely, and refuses a fake downgrade', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(schemaSql);
      seed(db);
      const before = aliases(db);
      const expected = before.filter(
        (row) =>
          !(
            row.source === 'manual' &&
            (row.alias === 'Artist-A' || row.alias === '作品名')
          ),
      );
      const sources = db
        .prepare('SELECT * FROM archive_catalog_creator_sources')
        .all();
      const schema = db
        .prepare('SELECT name,sql FROM sqlite_master ORDER BY name')
        .all();
      db.exec(up);
      expect(aliases(db)).toEqual(expected);
      db.exec(up);
      expect(aliases(db)).toEqual(expected);
      expect(
        db.prepare('SELECT * FROM archive_catalog_creator_sources').all(),
      ).toEqual(sources);
      expect(
        db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
      ).toEqual(schema);
      expect(() => db.exec(down)).toThrow(
        'manual_alias_cleanup_downgrade_requires_pre_migration_recovery_point',
      );
      expect(aliases(db)).toEqual(expected);
      db.exec('DELETE FROM archive_catalog_creators WHERE id=1');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe.sequential(
  '000029 upgrade with the existing recovery protocol',
  () => {
    let root: string;
    let service: ApplicationRecoveryService;
    let run: (typeof import('../src/db/migration.js'))['runStartupMigrations'];
    beforeEach(async () => {
      vi.resetModules();
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-alias-migration-'));
      for (const [key, value] of Object.entries({
        NODE_ENV: 'test',
        DATA_ROOT: 'data',
        GALLERY_ROOT: 'gallery',
        DB_DIR: 'db',
        THUMBNAILS_DIR: 'thumbnails',
        PREVIEWS_DIR: 'previews',
      }))
        vi.stubEnv(key, key === 'NODE_ENV' ? value : path.join(root, value));
      service = new ApplicationRecoveryService({
        sourceDbPath: path.join(root, 'gallery.sqlite'),
        backupRoot: path.join(root, 'backups'),
        instanceId: 'isolated-alias-upgrade',
        codeVersion: 'test',
        configFiles: [],
        forbiddenRoots: [],
        automatic: { enabled: false },
      });
      vi.doMock('../src/services/application-recovery-service.js', () => ({
        createApplicationRecoveryService: () => service,
      }));
      ({ runStartupMigrations: run } = await import('../src/db/migration.js'));
      const previous = path.join(root, 'through-000029');
      fs.mkdirSync(previous);
      for (const name of fs.readdirSync(migrations))
        if (name !== filename)
          fs.copyFileSync(new URL(name, migrations), path.join(previous, name));
      run({
        databasePath: service.config.sourceDbPath,
        migrationsDirectory: previous,
      });
      const db = new DatabaseSync(service.config.sourceDbPath);
      try {
        seed(db);
      } finally {
        db.close();
      }
    });
    afterEach(() => {
      vi.doUnmock('../src/services/application-recovery-service.js');
      vi.unstubAllEnvs();
      vi.resetModules();
      fs.rmSync(root, { recursive: true, force: true });
    });
    function inspect<T>(action: (db: DatabaseSync) => T): T {
      const db = new DatabaseSync(service.config.sourceDbPath);
      try {
        return action(db);
      } finally {
        db.close();
      }
    }
    it('records the exact removed rows in the pre-migration recovery point and keeps repeated startup unchanged', () => {
      const before = inspect(aliases);
      run({ databasePath: service.config.sourceDbPath });
      const point = service.getStatus().points[0]!;
      expect(point.reason).toBe('pre-migration');
      expect(point.schemaVersions).toContain('000029');
      expect(point.schemaVersions).not.toContain('000030');
      const original = new DatabaseSync(
        path.join(service.config.backupRoot, point.id, 'gallery.sqlite'),
        { readOnly: true },
      );
      try {
        expect(aliases(original)).toEqual(before);
        expect(original.prepare('PRAGMA integrity_check').get()).toEqual({
          integrity_check: 'ok',
        });
      } finally {
        original.close();
      }
      const after = inspect(aliases);
      expect(after).toHaveLength(before.length - 2);
      expect(
        inspect((db) =>
          db
            .prepare(
              "SELECT version FROM schema_migrations WHERE version='000030'",
            )
            .get(),
        ),
      ).toEqual({ version: '000030' });
      run({ databasePath: service.config.sourceDbPath });
      expect(inspect(aliases)).toEqual(after);
      expect(service.getStatus().points).toHaveLength(1);
    });
    it('blocks all cleanup writes when the recovery point cannot be published', () => {
      const before = inspect(aliases);
      fs.writeFileSync(service.config.backupRoot, 'invalid backup directory');
      expect(() =>
        run({ databasePath: service.config.sourceDbPath }),
      ).toThrow();
      expect(inspect(aliases)).toEqual(before);
      expect(
        inspect((db) =>
          db
            .prepare(
              "SELECT version FROM schema_migrations WHERE version='000030'",
            )
            .get(),
        ),
      ).toBeUndefined();
    });
    it('rolls back the full dbmate cleanup transaction on a later delete failure', () => {
      const before = inspect(aliases);
      inspect((db) =>
        db.exec(
          "CREATE TRIGGER fail_alias_delete BEFORE DELETE ON archive_catalog_creator_aliases WHEN OLD.creator_id=2 BEGIN SELECT RAISE(ABORT,'synthetic alias failure'); END",
        ),
      );
      expect(() =>
        run({ databasePath: service.config.sourceDbPath }),
      ).toThrow();
      expect(inspect(aliases)).toEqual(before);
      expect(
        inspect((db) =>
          db
            .prepare(
              "SELECT version FROM schema_migrations WHERE version='000030'",
            )
            .get(),
        ),
      ).toBeUndefined();
      expect(service.getStatus().points).toHaveLength(1);
    });
  },
);
