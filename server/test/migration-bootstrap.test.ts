import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { resolveBinary } from 'dbmate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type MigrationModule = typeof import('../src/db/migration.js');
type DatabaseModule = typeof import('../src/db/database.js');

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, '..');
const bundledMigrationsDirectory = path.join(serverRoot, 'db', 'migrations');

function listAppliedVersions(database: DatabaseSync): string[] {
  if (!tableExists(database, 'schema_migrations')) {
    return [];
  }

  return (database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>)
    .map((row) => row.version);
}

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;

  return row?.name === name;
}

function tableHasColumn(database: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }

  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function getColumnInfo(database: DatabaseSync, tableName: string, columnName: string): { notnull: number; dflt_value: string | null } | null {
  if (!tableExists(database, tableName)) {
    return null;
  }

  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const row = rows.find((entry) => entry.name === columnName);
  return row ? { notnull: row.notnull, dflt_value: row.dflt_value } : null;
}

function listForeignKeySignatures(database: DatabaseSync, tableName: string): string[] {
  if (!tableExists(database, tableName)) {
    return [];
  }

  const rows = database.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;

  return rows
    .map((row) => `${row.from}->${row.table}.${row.to}:${row.on_delete}`)
    .sort();
}

function insertPostValidationFolder(
  database: DatabaseSync,
  id: number,
  folderPath: string,
  role: 'normal' | 'carousel_source' = 'normal',
  ownerFolderId: number | null = null
): void {
  database.prepare(
    `INSERT INTO folders (id, slug, name, folder_path, role, carousel_owner_folder_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `validation-folder-${id}`, folderPath.split('/').at(-1)!, folderPath, role, ownerFolderId);
}

function insertPostValidationImage(database: DatabaseSync, id: number, folderId: number, relativePath: string): void {
  const filename = relativePath.split('/').at(-1)!;
  database.prepare(
    `INSERT INTO images (
       id, folder_id, filename, extension, relative_path, absolute_path, file_size, width, height,
       media_type, mime_type, checksum_or_fingerprint, mtime_ms, first_seen_at, sort_timestamp,
       thumbnail_path, preview_path
     ) VALUES (?, ?, ?, '.jpg', ?, ?, ?, 100, 100, 'image', 'image/jpeg', ?, ?,
       '2026-01-01T00:00:00.000Z', ?, ?, ?)`
  ).run(
    id,
    folderId,
    filename,
    relativePath,
    `temp/${relativePath}`,
    id * 10,
    `validation-fingerprint-${id}`,
    id * 1000,
    id * 1000,
    `thumb-${id}.jpg`,
    `preview-${id}.jpg`
  );
}

function insertPostValidationPost(
  database: DatabaseSync,
  id: number,
  folderId: number,
  sourcePath: string,
  options: {
    postType?: 'single' | 'carousel';
    isDeleted?: number;
    isTrashed?: number;
  } = {}
): void {
  database.prepare(
    `INSERT INTO posts (
       id, folder_id, source_path, post_type, sort_timestamp, is_deleted, is_trashed
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    folderId,
    sourcePath,
    options.postType ?? 'single',
    id * 1000,
    options.isDeleted ?? 0,
    options.isTrashed ?? 0
  );
}

async function createTestMigrationsDirectory(rootDirectory: string, extraMigrations: Array<[filename: string, sql: string]> = []): Promise<string> {
  const targetDirectory = path.join(rootDirectory, 'migrations');
  await fs.mkdir(targetDirectory, { recursive: true });
  const bundledFiles = await fs.readdir(bundledMigrationsDirectory);

  for (const bundledFile of bundledFiles) {
    await fs.copyFile(path.join(bundledMigrationsDirectory, bundledFile), path.join(targetDirectory, bundledFile));
  }

  for (const [filename, sql] of extraMigrations) {
    await fs.writeFile(path.join(targetDirectory, filename), sql);
  }

  return targetDirectory;
}

describe.sequential('dbmate startup migrations', () => {
  let tempRoot = '';

  function stubBaseEnv(): void {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  }

  async function importMigrationModule(): Promise<MigrationModule> {
    return import('../src/db/migration.js');
  }

  async function importDatabaseModule(): Promise<DatabaseModule> {
    return import('../src/db/database.js');
  }

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-migrations-'));
  });

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.doUnmock('../src/db/migration.js');
    vi.doUnmock('../src/services/log-service.js');
    vi.resetModules();
    vi.restoreAllMocks();

    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });
    stubBaseEnv();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('runs the baseline migration for a fresh database', async () => {
    const { BASELINE_MIGRATION_VERSION, runStartupMigrations } = await importMigrationModule();

    const result = runStartupMigrations();

    expect(result.usedInMemoryDatabase).toBe(false);

    const database = new DatabaseSync(path.join(tempRoot, 'db', 'gallery.sqlite'));

    try {
      expect(tableExists(database, 'folders')).toBe(true);
      expect(tableExists(database, 'images')).toBe(true);
      expect(tableExists(database, 'posts')).toBe(true);
      expect(tableExists(database, 'post_items')).toBe(true);
      expect(tableExists(database, 'collections')).toBe(true);
      expect(tableHasColumn(database, 'images', 'caption')).toBe(true);
      expect(tableHasColumn(database, 'likes', 'post_id')).toBe(true);
      expect(tableHasColumn(database, 'collection_items', 'post_id')).toBe(true);
      expect(tableHasColumn(database, 'scan_runs', 'warning_count')).toBe(true);
      expect(tableHasColumn(database, 'scan_runs', 'warning_text')).toBe(true);
      expect(listAppliedVersions(database)).toEqual([BASELINE_MIGRATION_VERSION, '000002', '000004', '000005', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014', '000015', '000016', '000017', '000018', '000019']);
      expect(tableExists(database, 'archive_catalog_creators')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('marks an existing pre-dbmate database as baseline without dropping indexed data', async () => {
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });

    const legacyDatabase = new DatabaseSync(databasePath);

    try {
      legacyDatabase.exec(`
        CREATE TABLE folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          folder_path TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder_id INTEGER NOT NULL,
          filename TEXT NOT NULL,
          extension TEXT NOT NULL,
          relative_path TEXT NOT NULL UNIQUE,
          absolute_path TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          checksum_or_fingerprint TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          first_seen_at TEXT NOT NULL,
          sort_timestamp INTEGER NOT NULL,
          thumbnail_path TEXT NOT NULL,
          preview_path TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );
      `);

      legacyDatabase
        .prepare('INSERT INTO folders(slug, name, folder_path) VALUES (?, ?, ?)')
        .run('legacy-folder', 'Legacy Folder', 'legacy-folder');
      legacyDatabase.prepare(`
        INSERT INTO images(
          folder_id,
          filename,
          extension,
          relative_path,
          absolute_path,
          file_size,
          width,
          height,
          mime_type,
          checksum_or_fingerprint,
          mtime_ms,
          first_seen_at,
          sort_timestamp,
          thumbnail_path,
          preview_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        1,
        'photo-1.jpg',
        '.jpg',
        'legacy-folder/photo-1.jpg',
        path.join(tempRoot, 'gallery', 'legacy-folder', 'photo-1.jpg'),
        1234,
        1200,
        900,
        'image/jpeg',
        'legacy-folder/photo-1.jpg:1234',
        Date.parse('2026-05-01T10:00:00.000Z'),
        '2026-05-01T10:00:00.000Z',
        Date.parse('2026-05-01T10:00:00.000Z'),
        'legacy-folder/photo-1.webp',
        'legacy-folder/photo-1.webp'
      );
    } finally {
      legacyDatabase.close();
    }

    const { BASELINE_MIGRATION_VERSION, runStartupMigrations } = await importMigrationModule();
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);

    try {
      expect(listAppliedVersions(database)).toEqual([BASELINE_MIGRATION_VERSION, '000002', '000004', '000005', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014', '000015', '000016', '000017', '000018', '000019']);
      expect(tableExists(database, 'collections')).toBe(true);
      expect(tableHasColumn(database, 'folders', 'avatar_image_id')).toBe(true);
      expect(tableHasColumn(database, 'folders', 'avatar_source')).toBe(true);
      expect(tableHasColumn(database, 'images', 'playback_strategy')).toBe(true);
      expect(tableHasColumn(database, 'images', 'caption')).toBe(true);
      expect(tableExists(database, 'folder_share_links')).toBe(true);
      expect(tableExists(database, 'folder_share_passwords')).toBe(true);
      expect(tableHasColumn(database, 'folders', 'share_password_version')).toBe(true);
      expect(tableExists(database, 'posts')).toBe(true);
      expect(tableExists(database, 'post_items')).toBe(true);
      expect(tableHasColumn(database, 'collection_items', 'post_id')).toBe(true);
      expect(database.prepare('SELECT COUNT(*) AS count FROM posts').get()).toEqual({ count: 1 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM post_items').get()).toEqual({ count: 1 });
      expect(listForeignKeySignatures(database, 'folders')).toEqual([
        'avatar_image_id->images.id:NO ACTION',
        'carousel_owner_folder_id->folders.id:SET NULL',
        'story_owner_folder_id->folders.id:SET NULL'
      ]);
      expect(listForeignKeySignatures(database, 'images')).toEqual([
        'folder_id->folders.id:CASCADE',
        'place_id->places.id:SET NULL'
      ]);
      expect(getColumnInfo(database, 'images', 'playback_strategy')).toEqual({
        notnull: 1,
        dflt_value: "'preview'"
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM images').get()).toEqual({ count: 1 });
      expect(database.prepare('SELECT playback_strategy AS playbackStrategy FROM images WHERE id = 1').get()).toEqual({
        playbackStrategy: 'preview'
      });
    } finally {
      database.close();
    }
  });

  it('recognizes complete pre-dbmate folder-sharing schema without rerunning 000004', async () => {
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const legacyDatabase = new DatabaseSync(databasePath);

    try {
      legacyDatabase.exec(`
        CREATE TABLE folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          folder_path TEXT NOT NULL,
          share_password_version INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder_id INTEGER NOT NULL,
          filename TEXT NOT NULL,
          extension TEXT NOT NULL,
          relative_path TEXT NOT NULL UNIQUE,
          absolute_path TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          checksum_or_fingerprint TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          first_seen_at TEXT NOT NULL,
          sort_timestamp INTEGER NOT NULL,
          thumbnail_path TEXT NOT NULL,
          preview_path TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE TABLE folder_share_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder_id INTEGER NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          token_prefix TEXT NULL,
          expires_at TEXT NULL,
          revoked_at TEXT NULL,
          allow_original_downloads INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at TEXT NULL,
          FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE TABLE folder_share_passwords (
          folder_id INTEGER PRIMARY KEY,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );
      `);
    } finally {
      legacyDatabase.close();
    }

    const { runStartupMigrations } = await importMigrationModule();
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      expect(tableExists(database, 'folder_share_links')).toBe(true);
      expect(tableExists(database, 'folder_share_passwords')).toBe(true);
      expect(tableHasColumn(database, 'folders', 'share_password_version')).toBe(true);
      expect(listAppliedVersions(database)).toEqual(['000001', '000002', '000004', '000005', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014', '000015', '000016', '000017', '000018', '000019']);
    } finally {
      database.close();
    }
  });

  it('runs a pending migration once and records its version', async () => {
    const { BASELINE_MIGRATION_VERSION, runStartupMigrations } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const migrationsDirectory = await createTestMigrationsDirectory(tempRoot, [
      [
        '000003_add_test_note.sql',
        `-- migrate:up

ALTER TABLE images ADD COLUMN migration_note TEXT NULL;

-- migrate:down

-- Forward-only for test coverage.
`
      ]
    ]);

    runStartupMigrations({
      databasePath,
      migrationsDirectory
    });

    const database = new DatabaseSync(databasePath);

    try {
      expect(tableHasColumn(database, 'images', 'migration_note')).toBe(true);
      expect(listAppliedVersions(database)).toEqual([BASELINE_MIGRATION_VERSION, '000002', '000003', '000004', '000005', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014', '000015', '000016', '000017', '000018', '000019']);
    } finally {
      database.close();
    }
  });

  it('baselines an existing pre-dbmate database before applying later migrations', async () => {
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const legacyDatabase = new DatabaseSync(databasePath);

    try {
      legacyDatabase.exec(`
        CREATE TABLE folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          folder_path TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder_id INTEGER NOT NULL,
          filename TEXT NOT NULL,
          extension TEXT NOT NULL,
          relative_path TEXT NOT NULL UNIQUE,
          absolute_path TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          checksum_or_fingerprint TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          first_seen_at TEXT NOT NULL,
          sort_timestamp INTEGER NOT NULL,
          thumbnail_path TEXT NOT NULL,
          preview_path TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );
      `);

      legacyDatabase
        .prepare('INSERT INTO folders(slug, name, folder_path) VALUES (?, ?, ?)')
        .run('legacy-folder', 'Legacy Folder', 'legacy-folder');
      legacyDatabase.prepare(`
        INSERT INTO images(
          folder_id,
          filename,
          extension,
          relative_path,
          absolute_path,
          file_size,
          width,
          height,
          mime_type,
          checksum_or_fingerprint,
          mtime_ms,
          first_seen_at,
          sort_timestamp,
          thumbnail_path,
          preview_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        1,
        'photo-1.jpg',
        '.jpg',
        'legacy-folder/photo-1.jpg',
        path.join(tempRoot, 'gallery', 'legacy-folder', 'photo-1.jpg'),
        1234,
        1200,
        900,
        'image/jpeg',
        'legacy-folder/photo-1.jpg:1234',
        Date.parse('2026-05-01T10:00:00.000Z'),
        '2026-05-01T10:00:00.000Z',
        Date.parse('2026-05-01T10:00:00.000Z'),
        'legacy-folder/photo-1.webp',
        'legacy-folder/photo-1.webp'
      );
    } finally {
      legacyDatabase.close();
    }

    const { runStartupMigrations } = await importMigrationModule();
    const migrationsDirectory = await createTestMigrationsDirectory(tempRoot, [
      [
        '000006_add_test_note.sql',
        `-- migrate:up

ALTER TABLE images ADD COLUMN migration_note TEXT NULL;

-- migrate:down

-- Forward-only for test coverage.
`
      ]
    ]);

    runStartupMigrations({ databasePath, migrationsDirectory });

    const database = new DatabaseSync(databasePath);

    try {
      expect(listAppliedVersions(database)).toEqual(['000001', '000002', '000004', '000005', '000006', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014', '000015', '000016', '000017', '000018', '000019']);
      expect(tableHasColumn(database, 'images', 'migration_note')).toBe(true);
      expect(tableHasColumn(database, 'images', 'caption')).toBe(true);
      expect(database.prepare('SELECT playback_strategy AS playbackStrategy FROM images WHERE id = 1').get()).toEqual({
        playbackStrategy: 'preview'
      });
    } finally {
      database.close();
    }
  });

  it('is idempotent on a second migration run', async () => {
    const { runStartupMigrations } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const migrationsDirectory = await createTestMigrationsDirectory(tempRoot, [
      [
        '000003_add_test_note.sql',
        `-- migrate:up

ALTER TABLE images ADD COLUMN migration_note TEXT NULL;

-- migrate:down

        -- Forward-only for test coverage.
`
      ]
    ]);

    runStartupMigrations({ databasePath, migrationsDirectory });
    runStartupMigrations({ databasePath, migrationsDirectory });

    const database = new DatabaseSync(databasePath);

    try {
      expect(listAppliedVersions(database)).toEqual(['000001', '000002', '000003', '000004', '000005', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014', '000015', '000016', '000017', '000018', '000019']);
      expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 18 });
    } finally {
      database.close();
    }
  });

  it('rolls 000014 down and up without losing same-hash jobs for different source works', async () => {
    const { runStartupMigrations } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const through000014 = await createTestMigrationsDirectory(path.join(tempRoot, 'through-000014'));
    await fs.rm(path.join(through000014, '000015_harden_local_ingest_execution.sql'));
    await fs.rm(path.join(through000014, '000016_managed_creator_roster_and_folder_bridge.sql'));
    await fs.rm(path.join(through000014, '000017_add_preferred_local_creator_folder.sql'));
    await fs.rm(path.join(through000014, '000018_add_image_move_signature_index.sql'));
    await fs.rm(path.join(through000014, '000019_local_work_identity.sql'));
    runStartupMigrations({ databasePath, migrationsDirectory: through000014 });

    const database = new DatabaseSync(databasePath);
    const now = new Date().toISOString();
    try {
      database.prepare(
        `INSERT INTO archive_catalog_creators (
           id, canonical_name, normalized_name, seed_source, seed_source_creator_id, created_at, updated_at
         ) VALUES (1, 'Creator', 'creator', 'test', 'creator-1', ?, ?)`
      ).run(now, now);
      database.prepare(
        `INSERT INTO archive_catalog_collections (
           id, creator_id, source, source_collection_id, title, observed_at, created_at, updated_at
         ) VALUES (1, 1, 'test', 'collection-1', 'Collection', ?, ?, ?)`
      ).run(now, now, now);
      for (const id of [1, 2]) {
        database.prepare(
          'INSERT INTO archive_catalog_works (id, creator_id, display_title, created_at, updated_at) VALUES (?, 1, ?, ?, ?)'
        ).run(id, `Work ${id}`, now, now);
        database.prepare(
          `INSERT INTO archive_catalog_source_works (
             id, work_id, collection_id, source, source_work_id, source_title, first_seen_at, last_seen_at
           ) VALUES (?, ?, 1, 'test', ?, ?, ?, ?)`
        ).run(id, id, `source-${id}`, `Work ${id}`, now, now);
        database.prepare(
          `INSERT INTO local_ingest_jobs (
             source_work_id, creator_id, source_archive_path, source_archive_name,
             source_archive_size, source_archive_mtime, source_archive_sha256,
             created_at, updated_at
           ) VALUES (?, 1, ?, ?, 1, 1, 'SAME-SHA256', ?, ?)`
        ).run(id, path.join(tempRoot, `${id}.7z`), `${id}.7z`, now, now);
      }
    } finally {
      database.close();
    }

    const down = spawnSync(
      resolveBinary(),
      [
        '--url', `sqlite:${pathToFileURL(databasePath).pathname}`,
        '--migrations-dir', through000014,
        '--no-dump-schema',
        'down'
      ],
      { cwd: serverRoot, encoding: 'utf8' }
    );
    expect(down.status, `${down.stdout}\n${down.stderr}`).toBe(0);

    const rolledBack = new DatabaseSync(databasePath);
    try {
      expect(rolledBack.prepare('SELECT id, source_work_id FROM local_ingest_jobs ORDER BY id').all()).toEqual([
        { id: 1, source_work_id: 1 },
        { id: 2, source_work_id: 2 }
      ]);
      expect(listAppliedVersions(rolledBack).at(-1)).toBe('000013');
    } finally {
      rolledBack.close();
    }

    runStartupMigrations({ databasePath, migrationsDirectory: through000014 });
    const repeated = new DatabaseSync(databasePath);
    try {
      expect(repeated.prepare('SELECT COUNT(*) AS count FROM local_ingest_jobs').get()).toEqual({ count: 2 });
      expect(listAppliedVersions(repeated).at(-1)).toBe('000014');
      expect(repeated.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    } finally {
      repeated.close();
    }
  });

  it('repairs a falsely recorded 000004 migration when all folder-sharing schema is absent', async () => {
    const { runStartupMigrations } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });

    runStartupMigrations({ databasePath });

    const brokenDatabase = new DatabaseSync(databasePath);
    try {
      brokenDatabase.exec(`
        DROP TABLE folder_share_passwords;
        DROP TABLE folder_share_links;
        ALTER TABLE folders DROP COLUMN share_password_version;
      `);
    } finally {
      brokenDatabase.close();
    }

    runStartupMigrations({ databasePath });

    const repairedDatabase = new DatabaseSync(databasePath);
    try {
      expect(tableExists(repairedDatabase, 'folder_share_links')).toBe(true);
      expect(tableExists(repairedDatabase, 'folder_share_passwords')).toBe(true);
      expect(tableHasColumn(repairedDatabase, 'folders', 'share_password_version')).toBe(true);
      expect(listAppliedVersions(repairedDatabase)).toEqual(['000001', '000002', '000004', '000005', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014', '000015', '000016', '000017', '000018', '000019']);
    } finally {
      repairedDatabase.close();
    }
  });

  it('resumes 000005 when an interrupted run recorded only additive columns', async () => {
    const { runStartupMigrations } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const throughFolderSharesMigrations = await createTestMigrationsDirectory(path.join(tempRoot, 'through-folder-shares'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000005_add_posts_and_carousels.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000007_add_cos_gallery_fields.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000008_add_creator_rating_sources.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000009_add_archive_catalog.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000010_add_archive_download_tasks.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000011_add_staged_download_status.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000016_managed_creator_roster_and_folder_bridge.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000017_add_preferred_local_creator_folder.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000018_add_image_move_signature_index.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000019_local_work_identity.sql'));

    runStartupMigrations({
      databasePath,
      migrationsDirectory: throughFolderSharesMigrations
    });

    const interruptedDatabase = new DatabaseSync(databasePath);
    try {
      interruptedDatabase.exec(`
        ALTER TABLE folders ADD COLUMN carousel_owner_folder_id INTEGER NULL REFERENCES folders(id) ON DELETE SET NULL;
        ALTER TABLE scan_runs ADD COLUMN warning_count INTEGER NOT NULL DEFAULT 0;
      `);
      interruptedDatabase.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run('000005');
    } finally {
      interruptedDatabase.close();
    }

    runStartupMigrations({ databasePath });

    const repairedDatabase = new DatabaseSync(databasePath);
    try {
      expect(tableExists(repairedDatabase, 'posts')).toBe(true);
      expect(tableExists(repairedDatabase, 'post_items')).toBe(true);
      expect(tableHasColumn(repairedDatabase, 'likes', 'post_id')).toBe(true);
      expect(tableHasColumn(repairedDatabase, 'collection_items', 'post_id')).toBe(true);
      expect(tableHasColumn(repairedDatabase, 'folders', 'carousel_owner_folder_id')).toBe(true);
      expect(tableHasColumn(repairedDatabase, 'scan_runs', 'warning_count')).toBe(true);
      expect(tableHasColumn(repairedDatabase, 'scan_runs', 'warning_text')).toBe(true);
      expect(listAppliedVersions(repairedDatabase)).toEqual(['000001', '000002', '000004', '000005', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014', '000015', '000016', '000017', '000018', '000019']);
    } finally {
      repairedDatabase.close();
    }
  });

  it('throws when a pending migration fails', async () => {
    const { runStartupMigrations } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const migrationsDirectory = await createTestMigrationsDirectory(tempRoot, [
      [
        '000003_broken.sql',
        `-- migrate:up

THIS IS NOT VALID SQL;

-- migrate:down

-- Forward-only for test coverage.
`
      ]
    ]);

    expect(() =>
      runStartupMigrations({
        databasePath,
        migrationsDirectory
      })
    ).toThrow(/Dbmate exited with status/i);
  });

  it('exits the migration script when startup migrations fail', async () => {
    const exitError = new Error('process.exit:1');
    const scriptPath = path.join(serverRoot, 'src', 'scripts', 'migrate.ts');
    const originalArgv1 = process.argv[1];
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const logErrorMock = vi.fn();

    try {
      process.argv[1] = scriptPath;

      vi.doMock('../src/db/migration.js', () => ({
        runStartupMigrations: () => {
          throw exitError;
        }
      }));
      vi.doMock('../src/services/log-service.js', () => ({
        log: {
          info: vi.fn(),
          error: logErrorMock,
          table: vi.fn()
        }
      }));

      await expect(import('../src/scripts/migrate.js')).rejects.toThrow('process.exit:1');

      expect(logErrorMock).toHaveBeenCalledWith(
        'Database migration failed. Foldergram will not start until the issue is resolved.',
        'process.exit:1'
      );
    } finally {
      process.argv[1] = originalArgv1;
      processExitSpy.mockRestore();
      vi.doUnmock('../src/db/migration.js');
      vi.doUnmock('../src/services/log-service.js');
      vi.resetModules();
    }
  });

  it('keeps the in-memory fallback when the database directory is unavailable', async () => {
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'occupied-file'));
    await fs.writeFile(path.join(tempRoot, 'occupied-file'), 'not-a-directory');
    vi.resetModules();

    const { runStartupMigrations } = await importMigrationModule();
    const result = runStartupMigrations();

    expect(result.usedInMemoryDatabase).toBe(true);
    expect(result.databasePath).toBe(':memory:');

    const { databaseManager } = await importDatabaseModule();
    expect(tableExists(databaseManager.connection, 'folders')).toBe(true);
  });

  it('adds share_password_version to folders and creates folder_share_passwords in consolidated 000004 migration', async () => {
    const { runStartupMigrations } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'gallery.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });

    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);

    try {
      expect(tableHasColumn(database, 'folders', 'share_password_version')).toBe(true);

      const columnInfo = getColumnInfo(database, 'folders', 'share_password_version');
      expect(columnInfo).not.toBeNull();
      expect(columnInfo?.notnull).toBe(1);
      expect(columnInfo?.dflt_value).toBe('0');

      database
        .prepare('INSERT INTO folders(slug, name, folder_path) VALUES (?, ?, ?)')
        .run('test-folder', 'Test Folder', 'test-folder');

      const inserted = database
        .prepare('SELECT share_password_version FROM folders WHERE slug = ?')
        .get('test-folder') as { share_password_version: number };

      expect(inserted.share_password_version).toBe(0);
      expect(tableExists(database, 'folder_share_passwords')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('rejects superficially complete migration 000005 when indexes or invariants are missing', async () => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'corrupt.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });

    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);

    try {
      // Drop index to simulate corruption
      database.exec('DROP INDEX IF EXISTS idx_posts_folder_visible_sort');
      expect(() => validatePostsMigrationCompleteness(database)).toThrow('missing required index idx_posts_folder_visible_sort');
    } finally {
      database.close();
    }
  });

  it('rejects a required index with the right name but wrong uniqueness or column order', async () => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'wrong-index.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP INDEX idx_post_items_image_id;
        CREATE INDEX idx_post_items_image_id ON post_items(post_id, image_id);
      `);
      expect(() => validatePostsMigrationCompleteness(database)).toThrow(
        'index idx_post_items_image_id has an incorrect uniqueness or column order'
      );
    } finally {
      database.close();
    }
  });

  it('allows harmless additive columns after migration 000005', async () => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'future-column.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      database.exec('ALTER TABLE posts ADD COLUMN future_note TEXT NULL');
      expect(() => validatePostsMigrationCompleteness(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it('preserves all convertible posts, likes, collection memberships, IDs, and timestamps in migration 000005', async () => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'rich-legacy.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const throughFolderSharesMigrations = await createTestMigrationsDirectory(path.join(tempRoot, 'through-folder-shares'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000005_add_posts_and_carousels.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000007_add_cos_gallery_fields.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000008_add_creator_rating_sources.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000009_add_archive_catalog.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000010_add_archive_download_tasks.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000011_add_staged_download_status.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000016_managed_creator_roster_and_folder_bridge.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000017_add_preferred_local_creator_folder.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000018_add_image_move_signature_index.sql'));
    await fs.rm(path.join(throughFolderSharesMigrations, '000019_local_work_identity.sql'));
    runStartupMigrations({ databasePath, migrationsDirectory: throughFolderSharesMigrations });

    const legacyDatabase = new DatabaseSync(databasePath);
    try {
      legacyDatabase.exec(`
        INSERT INTO folders(id, slug, name, folder_path, role) VALUES
          (1, 'album', 'Album', 'album', 'normal'),
          (2, 'stories', 'Stories', 'album/stories', 'story_capsule');

        INSERT INTO images(
          id, folder_id, filename, extension, relative_path, absolute_path, file_size, width, height,
          mime_type, checksum_or_fingerprint, mtime_ms, first_seen_at, sort_timestamp, caption,
          thumbnail_path, preview_path, created_at, updated_at
        ) VALUES
          (1, 1, 'one.jpg', '.jpg', 'album/one.jpg', 'temp/album/one.jpg', 101, 1000, 800,
           'image/jpeg', 'fp-1', 1001, '2026-01-01T00:00:00.000Z', 1001, 'One',
           'album/one.webp', 'album/one.webp', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'),
          (2, 1, 'two.jpg', '.jpg', 'album/two.jpg', 'temp/album/two.jpg', 102, 1000, 800,
           'image/jpeg', 'fp-2', 1002, '2026-01-02T00:00:00.000Z', 1002, 'Two',
           'album/two.webp', 'album/two.webp', '2026-01-02T00:00:01.000Z', '2026-01-02T00:00:02.000Z'),
          (3, 1, 'cover.jpg', '.jpg', 'album/cover.jpg', 'temp/album/cover.jpg', 103, 1000, 800,
           'image/jpeg', 'fp-3', 1003, '2026-01-03T00:00:00.000Z', 1003, NULL,
           'album/cover.webp', 'album/cover.webp', '2026-01-03T00:00:01.000Z', '2026-01-03T00:00:02.000Z'),
          (4, 2, 'story.jpg', '.jpg', 'album/stories/story.jpg', 'temp/album/stories/story.jpg', 104, 1000, 800,
           'image/jpeg', 'fp-4', 1004, '2026-01-04T00:00:00.000Z', 1004, NULL,
           'album/stories/story.webp', 'album/stories/story.webp', '2026-01-04T00:00:01.000Z', '2026-01-04T00:00:02.000Z');

        INSERT INTO likes(image_id, created_at) VALUES
          (1, '2026-02-01T00:00:00.000Z'),
          (2, '2026-02-02T00:00:00.000Z'),
          (3, '2026-02-03T00:00:00.000Z');
        INSERT INTO collections(id, slug, name, is_default) VALUES
          (1, 'saved', 'Saved', 1),
          (2, 'trip', 'Trip', 0);
        INSERT INTO collection_items(collection_id, image_id, created_at) VALUES
          (1, 1, '2026-03-01T00:00:00.000Z'),
          (2, 1, '2026-03-02T00:00:00.000Z'),
          (2, 2, '2026-03-03T00:00:00.000Z'),
          (2, 3, '2026-03-04T00:00:00.000Z');
      `);
    } finally {
      legacyDatabase.close();
    }

    runStartupMigrations({ databasePath });
    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare('SELECT id, caption, created_at, updated_at FROM posts ORDER BY id').all()).toEqual([
        { id: 1, caption: 'One', created_at: '2026-01-01T00:00:01.000Z', updated_at: '2026-01-01T00:00:02.000Z' },
        { id: 2, caption: 'Two', created_at: '2026-01-02T00:00:01.000Z', updated_at: '2026-01-02T00:00:02.000Z' }
      ]);
      expect(database.prepare('SELECT post_id, image_id, position FROM post_items ORDER BY post_id').all()).toEqual([
        { post_id: 1, image_id: 1, position: 1 },
        { post_id: 2, image_id: 2, position: 1 }
      ]);
      expect(database.prepare('SELECT post_id, created_at FROM likes ORDER BY post_id').all()).toEqual([
        { post_id: 1, created_at: '2026-02-01T00:00:00.000Z' },
        { post_id: 2, created_at: '2026-02-02T00:00:00.000Z' }
      ]);
      expect(database.prepare('SELECT collection_id, post_id, created_at FROM collection_items ORDER BY collection_id, post_id').all()).toEqual([
        { collection_id: 1, post_id: 1, created_at: '2026-03-01T00:00:00.000Z' },
        { collection_id: 2, post_id: 1, created_at: '2026-03-02T00:00:00.000Z' },
        { collection_id: 2, post_id: 2, created_at: '2026-03-03T00:00:00.000Z' }
      ]);
      expect(() => validatePostsMigrationCompleteness(database)).not.toThrow();

      database.prepare('DELETE FROM post_items WHERE post_id = 2').run();
      expect(() => validatePostsMigrationCompleteness(database)).toThrow('lack a representative position 1 item');
    } finally {
      database.close();
    }
  });

  it.each([
    ['visible', 0],
    ['trashed', 1]
  ])('accepts an active %s Post with a representative position 1 item', async (_label, isTrashed) => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', `active-valid-${isTrashed}.sqlite`);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      insertPostValidationFolder(database, 1, 'creator');
      insertPostValidationImage(database, 101, 1, 'creator/one.jpg');
      insertPostValidationPost(database, 201, 1, 'creator/work-one', { isTrashed });
      database.prepare('INSERT INTO post_items (post_id, image_id, position) VALUES (201, 101, 1)').run();

      expect(() => validatePostsMigrationCompleteness(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it.each([
    ['visible', 0],
    ['trashed', 1]
  ])('rejects an active %s Post without any item', async (_label, isTrashed) => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', `active-empty-${isTrashed}.sqlite`);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      insertPostValidationFolder(database, 1, 'creator');
      insertPostValidationPost(database, 201, 1, 'creator/empty', { isTrashed });

      expect(() => validatePostsMigrationCompleteness(database)).toThrow('lack a representative position 1 item');
    } finally {
      database.close();
    }
  });

  it('rejects an active Post whose first item starts at position 2', async () => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'active-position-two.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      insertPostValidationFolder(database, 1, 'creator');
      insertPostValidationImage(database, 101, 1, 'creator/one.jpg');
      insertPostValidationPost(database, 201, 1, 'creator/position-two');
      database.prepare('INSERT INTO post_items (post_id, image_id, position) VALUES (201, 101, 2)').run();

      expect(() => validatePostsMigrationCompleteness(database)).toThrow('lack a representative position 1 item');
    } finally {
      database.close();
    }
  });

  it('allows an empty soft-deleted Post to remain as retired history', async () => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'soft-deleted-empty.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      insertPostValidationFolder(database, 1, 'creator');
      insertPostValidationPost(database, 201, 1, 'creator/retired', { isDeleted: 1 });

      expect(() => validatePostsMigrationCompleteness(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it('continues to reject malformed item ordering on a soft-deleted Post that retains members', async () => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'soft-deleted-malformed.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      insertPostValidationFolder(database, 1, 'creator');
      insertPostValidationImage(database, 101, 1, 'creator/one.jpg');
      insertPostValidationPost(database, 201, 1, 'creator/retired-malformed', {
        postType: 'carousel',
        isDeleted: 1
      });
      database.prepare('INSERT INTO post_items (post_id, image_id, position) VALUES (201, 101, 2)').run();

      expect(() => validatePostsMigrationCompleteness(database)).toThrow('non-contiguous item positions');
    } finally {
      database.close();
    }
  });

  it('continues to reject foreign-key corruption after allowing empty soft-deleted Posts', async () => {
    const { runStartupMigrations, validatePostsMigrationCompleteness } = await importMigrationModule();
    const databasePath = path.join(tempRoot, 'db', 'soft-deleted-foreign-key.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      database.exec('PRAGMA foreign_keys = OFF');
      database.prepare('INSERT INTO post_items (post_id, image_id, position) VALUES (999, 999, 1)').run();
      database.exec('PRAGMA foreign_keys = ON');

      expect(() => validatePostsMigrationCompleteness(database)).toThrow('foreign_key_check found');
    } finally {
      database.close();
    }
  });

  it('reopens a migrated database after real topology reconciliation retires an empty legacy Post', async () => {
    const { runStartupMigrations } = await importMigrationModule();
    const { reconcileCreatorWorkPostTopology } = await import('../src/services/creator-work-post-topology-service.js');
    const databasePath = path.join(tempRoot, 'db', 'topology-restart.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    runStartupMigrations({ databasePath });

    const database = new DatabaseSync(databasePath);
    try {
      insertPostValidationFolder(database, 1, 'creator');
      insertPostValidationFolder(database, 11, 'creator/work-a', 'carousel_source', 1);
      insertPostValidationFolder(database, 12, 'creator/work-b', 'carousel_source', 1);
      insertPostValidationImage(database, 101, 11, 'creator/work-a/a-1.jpg');
      insertPostValidationImage(database, 102, 11, 'creator/work-a/a-2.jpg');
      insertPostValidationImage(database, 103, 12, 'creator/work-b/b-1.jpg');
      insertPostValidationImage(database, 104, 12, 'creator/work-b/b-2.jpg');
      insertPostValidationImage(database, 105, 12, 'creator/work-b/b-3.jpg');
      insertPostValidationPost(database, 900, 1, 'creator/merged-work', { postType: 'carousel' });
      const insertItem = database.prepare('INSERT INTO post_items (post_id, image_id, position) VALUES (?, ?, ?)');
      [101, 102, 103, 104, 105].forEach((imageId, index) => insertItem.run(900, imageId, index + 1));

      const entries = [
        {
          ownerFolderId: 1,
          workFolderId: 11,
          sourcePath: 'creator/work-a',
          postType: 'carousel' as const,
          sortTimestamp: 102_000,
          takenAt: null,
          takenAtSource: null,
          placeId: null,
          items: [{ imageId: 101, position: 1 }, { imageId: 102, position: 2 }]
        },
        {
          ownerFolderId: 1,
          workFolderId: 12,
          sourcePath: 'creator/work-b',
          postType: 'carousel' as const,
          sortTimestamp: 105_000,
          takenAt: null,
          takenAtSource: null,
          placeId: null,
          items: [
            { imageId: 103, position: 1 },
            { imageId: 104, position: 2 },
            { imageId: 105, position: 3 }
          ]
        }
      ];
      const input = {
        ownerFolderId: 1,
        creatorPath: 'creator',
        entries,
        pathExists: (relativePath: string) => relativePath !== 'creator/merged-work'
      };
      const plan = reconcileCreatorWorkPostTopology(input, { dryRun: true }, database);
      expect(plan).toMatchObject({ postsToCreate: 2, itemsToTransfer: 5, postsToRetire: 1, conflicts: [] });
      reconcileCreatorWorkPostTopology(input, { dryRun: false, expectedRevision: plan.revision }, database);
      expect(database.prepare('SELECT is_deleted FROM posts WHERE id = 900').get()).toEqual({ is_deleted: 1 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM post_items WHERE post_id = 900').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }

    const beforeRestart = new DatabaseSync(databasePath, { readOnly: true });
    const stableRows = JSON.stringify({
      posts: beforeRestart.prepare('SELECT * FROM posts ORDER BY id').all(),
      items: beforeRestart.prepare('SELECT * FROM post_items ORDER BY post_id, position').all()
    });
    beforeRestart.close();

    runStartupMigrations({ databasePath });
    runStartupMigrations({ databasePath });

    const afterRestart = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(JSON.stringify({
        posts: afterRestart.prepare('SELECT * FROM posts ORDER BY id').all(),
        items: afterRestart.prepare('SELECT * FROM post_items ORDER BY post_id, position').all()
      })).toBe(stableRows);
      expect(afterRestart.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      afterRestart.close();
    }
  });
});
