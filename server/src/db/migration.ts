import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveBinary } from 'dbmate';

import { appConfig, repositoryRoot } from '../config/env.js';
import { completeManagedCreatorMigration } from './managed-creator-migration.js';
import {
  applyBaselineCompatMigrations,
  assertNoLegacySchema,
  rebuildBaselineForeignKeys,
  tableHasColumn,
  tableExists
} from './schema-compat.js';
import { log } from '../services/log-service.js';
import { storageService } from '../services/storage-service.js';

export const BASELINE_MIGRATION_VERSION = '000001';
const CAPTION_MIGRATION_VERSION = '000002';
const FOLDER_SHARES_MIGRATION_VERSION = '000004';
const POSTS_MIGRATION_VERSION = '000005';
const COS_GALLERY_MIGRATION_VERSION = '000007';
const CREATOR_RATINGS_MIGRATION_VERSION = '000008';
export const ARCHIVE_CATALOG_MIGRATION_VERSION = '000009';
const SCHEMA_MIGRATIONS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)';
const APP_SCHEMA_TABLES = [
  'folders',
  'images',
  'posts',
  'post_items',
  'creator_rating_sources',
  'places',
  'scan_runs',
  'app_settings',
  'folder_scan_state',
  'likes',
  'collections',
  'collection_items',
  'folder_share_links',
  'folder_share_passwords'
] as const;

export interface BaselineResult {
  baselineInserted: boolean;
  existingSchemaDetected: boolean;
}

export interface StartupMigrationResult {
  baselineInserted: boolean;
  databasePath: string;
  usedInMemoryDatabase: boolean;
}

export interface StartupMigrationOptions {
  databasePath?: string;
  migrationsDirectory?: string;
  spawnSyncImpl?: typeof spawnSync;
}

function defaultMigrationsDirectory(): string {
  return path.join(repositoryRoot, 'server', 'db', 'migrations');
}

function baselineMigrationPath(migrationsDirectory: string): string {
  return path.join(migrationsDirectory, `${BASELINE_MIGRATION_VERSION}_baseline.sql`);
}

function extractMigrationUpSql(migrationSql: string): string {
  const lines = migrationSql.split(/\r?\n/);
  const upLines: string[] = [];
  let inUpSection = false;

  for (const line of lines) {
    if (/^\s*--\s*migrate:up\b/i.test(line)) {
      inUpSection = true;
      continue;
    }

    if (/^\s*--\s*migrate:down\b/i.test(line)) {
      break;
    }

    if (inUpSection) {
      upLines.push(line);
    }
  }

  if (!inUpSection || upLines.length === 0) {
    throw new Error(`Baseline migration is missing an up section: ${migrationSql}`);
  }

  return upLines.join('\n').trim();
}

function applyBaselineSchema(database: DatabaseSync, migrationsDirectory: string): void {
  const migrationSql = fs.readFileSync(baselineMigrationPath(migrationsDirectory), 'utf8');
  database.exec(extractMigrationUpSql(migrationSql));
}

function buildSqliteDatabaseUrl(databasePath: string): string {
  return `sqlite:${pathToFileURL(databasePath).pathname}`;
}

function hasExistingAppSchema(database: DatabaseSync): boolean {
  return APP_SCHEMA_TABLES.some((tableName) => tableExists(database, tableName));
}

function migrationVersionExists(database: DatabaseSync, version: string): boolean {
  if (!tableExists(database, 'schema_migrations')) {
    return false;
  }

  const row = database
    .prepare('SELECT version FROM schema_migrations WHERE version = ? LIMIT 1')
    .get(version) as { version: string } | undefined;

  return row?.version === version;
}

function removeMigrationVersion(database: DatabaseSync, version: string): void {
  database.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
}

function countRowsMatching(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count: number };
  return row.count;
}

function hasCompleteFolderSharesSchema(database: DatabaseSync): boolean {
  return (
    tableExists(database, 'folder_share_links') &&
    tableExists(database, 'folder_share_passwords') &&
    tableHasColumn(database, 'folders', 'share_password_version')
  );
}

function repairIncorrectFolderSharesMigrationMarker(database: DatabaseSync): void {
  if (!migrationVersionExists(database, FOLDER_SHARES_MIGRATION_VERSION)) {
    return;
  }

  if (hasCompleteFolderSharesSchema(database)) {
    return;
  }

  const hasShareLinks = tableExists(database, 'folder_share_links');
  const hasSharePasswords = tableExists(database, 'folder_share_passwords');
  const hasSharePasswordVersion = tableHasColumn(database, 'folders', 'share_password_version');

  if (!hasShareLinks && !hasSharePasswords && !hasSharePasswordVersion) {
    removeMigrationVersion(database, FOLDER_SHARES_MIGRATION_VERSION);
    log.info('Removed an incomplete migration 000004 marker so folder-sharing tables can be created');
    return;
  }

  throw new Error(
    'Migration 000004 is recorded as applied, but its folder-sharing schema is only partially present. Restore the database from backup before retrying the upgrade.'
  );
}

function repairInterruptedPostsMigrationMarker(database: DatabaseSync, validateBeforeMigration: ((database: DatabaseSync) => void) | null): void {
  if (!migrationVersionExists(database, POSTS_MIGRATION_VERSION)) {
    return;
  }

  const hasCarouselOwner = tableHasColumn(database, 'folders', 'carousel_owner_folder_id');
  const hasWarningCount = tableHasColumn(database, 'scan_runs', 'warning_count');
  const hasWarningText = tableHasColumn(database, 'scan_runs', 'warning_text');
  const hasPosts = tableExists(database, 'posts');
  const hasPostItems = tableExists(database, 'post_items');
  const likesUsePostId = tableHasColumn(database, 'likes', 'post_id');
  const collectionItemsUsePostId = tableHasColumn(database, 'collection_items', 'post_id');

  const migrationComplete =
    hasCarouselOwner &&
    hasWarningCount &&
    hasWarningText &&
    hasPosts &&
    hasPostItems &&
    likesUsePostId &&
    collectionItemsUsePostId;

  if (migrationComplete) {
    // With no pending migration the final validation below is sufficient. Never
    // reuse a pre-migration result across a schema/data-changing migration.
    validateBeforeMigration?.(database);
    return;
  }

  const stillUsesPreMigrationPostSchema =
    !hasPosts &&
    !hasPostItems &&
    tableHasColumn(database, 'likes', 'image_id') &&
    !likesUsePostId &&
    tableHasColumn(database, 'collection_items', 'image_id') &&
    !collectionItemsUsePostId;

  if (!stillUsesPreMigrationPostSchema) {
    throw new Error(
      'Migration 000005 is recorded as applied, but its posts schema is only partially present. Restore the database from backup before retrying the upgrade.'
    );
  }

  if (
    hasCarouselOwner &&
    countRowsMatching(database, 'SELECT COUNT(*) AS count FROM folders WHERE carousel_owner_folder_id IS NOT NULL') > 0
  ) {
    throw new Error('Cannot safely resume migration 000005 because carousel ownership data already exists.');
  }

  if (
    hasWarningCount &&
    countRowsMatching(database, 'SELECT COUNT(*) AS count FROM scan_runs WHERE warning_count <> 0') > 0
  ) {
    throw new Error('Cannot safely resume migration 000005 because scan warning counts already exist.');
  }

  if (
    hasWarningText &&
    countRowsMatching(database, 'SELECT COUNT(*) AS count FROM scan_runs WHERE warning_text IS NOT NULL') > 0
  ) {
    throw new Error('Cannot safely resume migration 000005 because scan warning details already exist.');
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    if (hasCarouselOwner) {
      database.exec('ALTER TABLE folders DROP COLUMN carousel_owner_folder_id');
    }
    if (hasWarningCount) {
      database.exec('ALTER TABLE scan_runs DROP COLUMN warning_count');
    }
    if (hasWarningText) {
      database.exec('ALTER TABLE scan_runs DROP COLUMN warning_text');
    }
    removeMigrationVersion(database, POSTS_MIGRATION_VERSION);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  log.info('Reset an interrupted migration 000005 marker so the posts migration can resume');
}

function repairKnownIncompleteMigrationMarkers(databasePath: string, options: StartupMigrationOptions, validate: (database: DatabaseSync) => void): string[] {
  const database = new DatabaseSync(databasePath);

  try {
    if (!tableExists(database, 'schema_migrations')) {
      return [];
    }

    repairIncorrectFolderSharesMigrationMarker(database);
    const versions = appliedMigrationVersions(database);
    const pending = fs.readdirSync(options.migrationsDirectory ?? defaultMigrationsDirectory())
      .some(name => { const version = /^(\d+)_.*\.sql$/.exec(name)?.[1]; return version !== undefined && !versions.includes(version); });
    repairInterruptedPostsMigrationMarker(database, pending ? validate : null);
    return appliedMigrationVersions(database);
  } finally {
    database.close();
  }
}

function appliedMigrationVersions(database: DatabaseSync): string[] {
  if (!tableExists(database, 'schema_migrations')) return [];
  return (database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {version:string}[]).map(row => row.version);
}

export function baselineExistingDatabaseIfNeeded(databasePath: string, options: StartupMigrationOptions = {}): BaselineResult {
  const database = new DatabaseSync(databasePath);
  const migrationsDirectory = options.migrationsDirectory ?? defaultMigrationsDirectory();

  try {
    assertNoLegacySchema(database);

    const existingSchemaDetected = hasExistingAppSchema(database);
    if (!existingSchemaDetected || migrationVersionExists(database, BASELINE_MIGRATION_VERSION)) {
      return {
        baselineInserted: false,
        existingSchemaDetected
      };
    }

    applyBaselineCompatMigrations(database);
    applyBaselineSchema(database, migrationsDirectory);
    const rebuiltForeignKeys = rebuildBaselineForeignKeys(database);
    if (rebuiltForeignKeys) {
      applyBaselineSchema(database, migrationsDirectory);
    }
    database.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
    // Compatibility work materializes the original baseline and the caption
    // column. Folder-sharing and later feature migrations must still run
    // through Dbmate so their complete schema transformations are applied.
    const baselineVersions = [BASELINE_MIGRATION_VERSION, CAPTION_MIGRATION_VERSION];
    if (hasCompleteFolderSharesSchema(database)) {
      baselineVersions.push(FOLDER_SHARES_MIGRATION_VERSION);
    }
    for (const version of baselineVersions) {
      database.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)').run(version);
    }

    return {
      baselineInserted: true,
      existingSchemaDetected
    };
  } finally {
    database.close();
  }
}

function runDbmateUp(databasePath: string, options: StartupMigrationOptions = {}): void {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(
    resolveBinary(),
    [
      '--url',
      buildSqliteDatabaseUrl(databasePath),
      '--migrations-dir',
      options.migrationsDirectory ?? defaultMigrationsDirectory(),
      '--no-dump-schema',
      'up'
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit'
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Dbmate exited with status ${result.status ?? 'unknown'}`);
  }
}

interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface RequiredColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKeyPosition?: number;
  defaultValue?: string | null;
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeDefaultValue(value: string | null): string | null {
  if (value === null) return null;
  let normalized = value.trim();
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.toUpperCase();
}

function validateRequiredColumns(database: DatabaseSync, tableName: string, requiredColumns: RequiredColumn[]): void {
  if (!tableExists(database, tableName)) {
    throw new Error(`Migration 000005 integrity check failed: missing required table ${tableName}.`);
  }

  const columns = database
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all() as unknown as TableColumnInfo[];
  const byName = new Map(columns.map((column) => [column.name, column]));

  for (const required of requiredColumns) {
    const actual = byName.get(required.name);
    if (!actual) {
      throw new Error(`Migration 000005 integrity check failed: ${tableName}.${required.name} is missing.`);
    }
    if (actual.type.trim().toUpperCase() !== required.type) {
      throw new Error(
        `Migration 000005 integrity check failed: ${tableName}.${required.name} must be declared as ${required.type}.`
      );
    }
    const isNotNull = actual.notnull === 1 || actual.pk > 0;
    if (isNotNull !== required.notNull) {
      throw new Error(
        `Migration 000005 integrity check failed: ${tableName}.${required.name} has incorrect nullability.`
      );
    }
    if (required.primaryKeyPosition !== undefined && actual.pk !== required.primaryKeyPosition) {
      throw new Error(
        `Migration 000005 integrity check failed: ${tableName}.${required.name} has incorrect primary-key position.`
      );
    }
    if (
      required.defaultValue !== undefined &&
      normalizeDefaultValue(actual.dflt_value) !== normalizeDefaultValue(required.defaultValue)
    ) {
      throw new Error(`Migration 000005 integrity check failed: ${tableName}.${required.name} has an incorrect default.`);
    }
  }
}

function getIndexColumns(database: DatabaseSync, indexName: string): string[] {
  return (
    database.prepare(`PRAGMA index_info(${quoteIdentifier(indexName)})`).all() as Array<{ seqno: number; name: string }>
  )
    .sort((left, right) => left.seqno - right.seqno)
    .map((row) => row.name);
}

function validateRequiredIndex(
  database: DatabaseSync,
  tableName: string,
  indexName: string,
  columns: string[],
  unique: boolean
): void {
  const indexes = database
    .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
    .all() as Array<{ name: string; unique: number }>;
  const index = indexes.find((candidate) => candidate.name === indexName);
  if (!index) {
    throw new Error(
      `Migration 000005 integrity check failed: missing required index ${indexName} on table ${tableName}. Restore the database from backup before retrying.`
    );
  }
  if ((index.unique === 1) !== unique || getIndexColumns(database, indexName).join('\0') !== columns.join('\0')) {
    throw new Error(
      `Migration 000005 integrity check failed: index ${indexName} has an incorrect uniqueness or column order.`
    );
  }
}

function validateUniqueColumns(database: DatabaseSync, tableName: string, columns: string[]): void {
  const indexes = database
    .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
    .all() as Array<{ name: string; unique: number }>;
  const found = indexes.some(
    (index) => index.unique === 1 && getIndexColumns(database, index.name).join('\0') === columns.join('\0')
  );
  if (!found) {
    throw new Error(
      `Migration 000005 integrity check failed: ${tableName} is missing a unique constraint on (${columns.join(', ')}).`
    );
  }
}

function validateForeignKey(
  database: DatabaseSync,
  tableName: string,
  sourceColumn: string,
  referencedTable: string,
  referencedColumn: string,
  onDelete: string
): void {
  const foreignKeys = database
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)
    .all() as unknown as ForeignKeyInfo[];
  const found = foreignKeys.some(
    (foreignKey) =>
      foreignKey.from === sourceColumn &&
      foreignKey.table === referencedTable &&
      foreignKey.to === referencedColumn &&
      foreignKey.on_delete.toUpperCase() === onDelete
  );
  if (!found) {
    throw new Error(
      `Migration 000005 integrity check failed: ${tableName}.${sourceColumn} must reference ${referencedTable}.${referencedColumn} ON DELETE ${onDelete}.`
    );
  }
}

function validateCheckConstraint(database: DatabaseSync, tableName: string, pattern: RegExp, description: string): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string | null } | undefined;
  if (!row?.sql || !pattern.test(row.sql)) {
    throw new Error(`Migration 000005 integrity check failed: ${tableName} is missing ${description}.`);
  }
}

function assertNoRows(database: DatabaseSync, sql: string, message: string): void {
  const count = countRowsMatching(database, sql);
  if (count > 0) {
    throw new Error(`Migration 000005 integrity check failed: ${count} ${message}.`);
  }
}

export function validatePostsMigrationCompleteness(database: DatabaseSync): void {
  if (!migrationVersionExists(database, POSTS_MIGRATION_VERSION)) {
    return;
  }

  let stage = 'structure';
  let started = performance.now();
  let completed = false;
  const nextStage = (next: string) => {
    log.diagnostic('Startup database validation stage', { stage, durationMs: Number((performance.now() - started).toFixed(2)), status: 'ok' });
    stage = next; started = performance.now();
  };
  try {

  const hasCosGalleryMigration = migrationVersionExists(database, COS_GALLERY_MIGRATION_VERSION);
  const hasCreatorRatingsMigration = migrationVersionExists(database, CREATOR_RATINGS_MIGRATION_VERSION);

  validateRequiredColumns(database, 'folders', [
    { name: 'carousel_owner_folder_id', type: 'INTEGER', notNull: false, defaultValue: null }
  ]);
  validateRequiredColumns(database, 'scan_runs', [
    { name: 'warning_count', type: 'INTEGER', notNull: true, defaultValue: '0' },
    { name: 'warning_text', type: 'TEXT', notNull: false, defaultValue: null }
  ]);
  const requiredPostColumns: RequiredColumn[] = [
    { name: 'id', type: 'INTEGER', notNull: true, primaryKeyPosition: 1 },
    { name: 'folder_id', type: 'INTEGER', notNull: true },
    { name: 'place_id', type: 'INTEGER', notNull: false },
    { name: 'source_path', type: 'TEXT', notNull: true },
    { name: 'post_type', type: 'TEXT', notNull: true, defaultValue: "'single'" },
    { name: 'caption', type: 'TEXT', notNull: false },
    { name: 'sort_timestamp', type: 'INTEGER', notNull: true },
    { name: 'taken_at', type: 'INTEGER', notNull: false },
    { name: 'taken_at_source', type: 'TEXT', notNull: false },
    { name: 'is_deleted', type: 'INTEGER', notNull: true, defaultValue: '0' },
    { name: 'deleted_at', type: 'TEXT', notNull: false },
    { name: 'is_trashed', type: 'INTEGER', notNull: true, defaultValue: '0' },
    { name: 'trashed_at', type: 'TEXT', notNull: false },
    { name: 'created_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP' },
    { name: 'updated_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP' }
  ];
  if (hasCosGalleryMigration) {
    requiredPostColumns.splice(5, 0, {
      name: 'content_rating',
      type: 'TEXT',
      notNull: true,
      defaultValue: "'R15'"
    });
  }
  if (hasCreatorRatingsMigration) {
    validateRequiredColumns(database, 'creator_rating_sources', [
      { name: 'folder_id', type: 'INTEGER', notNull: true, primaryKeyPosition: 1 },
      { name: 'source', type: 'TEXT', notNull: true, primaryKeyPosition: 2 },
      { name: 'source_creator_id', type: 'TEXT', notNull: true, primaryKeyPosition: 3 },
      { name: 'source_display_name', type: 'TEXT', notNull: true },
      { name: 'rating', type: 'TEXT', notNull: true },
      { name: 'is_manual', type: 'INTEGER', notNull: true, defaultValue: '0' },
      { name: 'observed_at', type: 'INTEGER', notNull: false },
      { name: 'metadata_json', type: 'TEXT', notNull: false },
      { name: 'created_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP' }
    ]);
  }
  validateRequiredColumns(database, 'posts', requiredPostColumns);
  validateRequiredColumns(database, 'post_items', [
    { name: 'post_id', type: 'INTEGER', notNull: true, primaryKeyPosition: 1 },
    { name: 'image_id', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
    { name: 'position', type: 'INTEGER', notNull: true, primaryKeyPosition: 2 }
  ]);
  validateRequiredColumns(database, 'likes', [
    { name: 'post_id', type: 'INTEGER', notNull: true, primaryKeyPosition: 1 },
    { name: 'created_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP' }
  ]);
  validateRequiredColumns(database, 'collection_items', [
    { name: 'collection_id', type: 'INTEGER', notNull: true, primaryKeyPosition: 1 },
    { name: 'post_id', type: 'INTEGER', notNull: true, primaryKeyPosition: 2 },
    { name: 'created_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP' }
  ]);

  const requiredIndexes: Array<readonly [string, string, readonly string[], boolean]> = [
    ['posts', 'idx_posts_folder_visible_sort', ['folder_id', 'is_deleted', 'is_trashed', 'sort_timestamp', 'id'], false],
    ['posts', 'idx_posts_visible_sort', ['is_deleted', 'is_trashed', 'sort_timestamp', 'id'], false],
    ['posts', 'idx_posts_type_visibility', ['post_type', 'is_deleted', 'is_trashed'], false],
    ['posts', 'idx_posts_place_visibility', ['place_id', 'is_deleted', 'is_trashed', 'sort_timestamp'], false],
    ['posts', 'idx_posts_source_path', ['source_path'], false],
    ['posts', 'idx_posts_trashed_listing', ['is_trashed', 'is_deleted', 'trashed_at', 'id'], false],
    ['post_items', 'idx_post_items_image_id', ['image_id'], true],
    ['post_items', 'idx_post_items_post_id', ['post_id', 'position'], false],
    ['likes', 'idx_likes_created_at', ['created_at'], false],
    ['collection_items', 'idx_collection_items_post', ['post_id'], false],
    ['collection_items', 'idx_collection_items_created', ['collection_id', 'created_at', 'post_id'], false],
    ['folders', 'idx_folders_carousel_owner', ['carousel_owner_folder_id'], false]
  ];
  if (hasCosGalleryMigration) {
    requiredIndexes.push([
      'posts',
      'idx_posts_content_rating_visible_sort',
      ['content_rating', 'is_deleted', 'is_trashed', 'sort_timestamp', 'id'],
      false
    ]);
  }
  if (hasCreatorRatingsMigration) {
    requiredIndexes.push(
      ['creator_rating_sources', 'idx_creator_rating_sources_folder', ['folder_id', 'is_manual', 'rating'], false],
      ['creator_rating_sources', 'idx_creator_rating_sources_source', ['source', 'source_creator_id'], false]
    );
  }
  for (const [tableName, indexName, columns, unique] of requiredIndexes) {
    validateRequiredIndex(database, tableName, indexName, [...columns], unique);
  }
  validateUniqueColumns(database, 'posts', ['source_path']);
  validateUniqueColumns(database, 'post_items', ['image_id']);

  validateForeignKey(database, 'folders', 'carousel_owner_folder_id', 'folders', 'id', 'SET NULL');
  validateForeignKey(database, 'posts', 'folder_id', 'folders', 'id', 'CASCADE');
  validateForeignKey(database, 'posts', 'place_id', 'places', 'id', 'SET NULL');
  validateForeignKey(database, 'post_items', 'post_id', 'posts', 'id', 'CASCADE');
  validateForeignKey(database, 'post_items', 'image_id', 'images', 'id', 'CASCADE');
  if (hasCreatorRatingsMigration) {
    validateForeignKey(database, 'creator_rating_sources', 'folder_id', 'folders', 'id', 'CASCADE');
  }
  validateForeignKey(database, 'likes', 'post_id', 'posts', 'id', 'CASCADE');
  validateForeignKey(database, 'collection_items', 'collection_id', 'collections', 'id', 'CASCADE');
  validateForeignKey(database, 'collection_items', 'post_id', 'posts', 'id', 'CASCADE');

  validateCheckConstraint(
    database,
    'posts',
    /CHECK\s*\(\s*post_type\s+IN\s*\(\s*'single'\s*,\s*'carousel'\s*\)\s*\)/i,
    'the post_type single/carousel check constraint'
  );
  validateCheckConstraint(
    database,
    'post_items',
    hasCosGalleryMigration
      ? /CHECK\s*\(\s*position\s*>=\s*1\s*\)/i
      : /CHECK\s*\(\s*position\s*>=\s*1\s+AND\s+position\s*<=\s*20\s*\)/i,
    hasCosGalleryMigration
      ? 'the positive position check constraint'
      : 'the bounded position check constraint'
  );
  if (hasCosGalleryMigration) {
    validateCheckConstraint(
      database,
      'posts',
      /CHECK\s*\(\s*content_rating\s+IN\s*\(\s*'R15'\s*,\s*'R18'\s*\)\s*\)/i,
      'the content_rating R15/R18 check constraint'
    );
  }

  nextStage('relationships');
  assertNoRows(
    database,
    'SELECT COUNT(*) AS count FROM posts WHERE posts.is_deleted = 0 AND NOT EXISTS (SELECT 1 FROM post_items WHERE post_items.post_id = posts.id AND post_items.position = 1)',
    'post(s) lack a representative position 1 item'
  );
  assertNoRows(
    database,
    `SELECT COUNT(*) AS count FROM (
       SELECT posts.id
       FROM posts
       JOIN post_items ON post_items.post_id = posts.id
       GROUP BY posts.id
       HAVING MIN(post_items.position) <> 1 OR MAX(post_items.position) <> COUNT(*)
     )`,
    'post(s) have non-contiguous item positions'
  );
  assertNoRows(
    database,
    `SELECT COUNT(*) AS count FROM (
       SELECT posts.id
       FROM posts
       JOIN post_items ON post_items.post_id = posts.id
       GROUP BY posts.id, posts.post_type
       HAVING (posts.post_type = 'single' AND COUNT(*) <> 1)
          OR (posts.post_type = 'carousel' AND COUNT(*) < 2)
     )`,
    'post(s) have an item count inconsistent with post_type'
  );
  assertNoRows(
    database,
    `SELECT COUNT(*) AS count
     FROM images
     JOIN folders ON folders.id = images.folder_id
     WHERE images.is_deleted = 0
       AND folders.role = 'normal'
       AND LOWER(images.filename) NOT IN ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'cover.avif', 'cover.gif')
       AND NOT EXISTS (SELECT 1 FROM post_items WHERE post_items.image_id = images.id)`,
    'active normal media item(s) lack post membership'
  );

  nextStage('foreign_keys');
  const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyErrors.length > 0) {
    throw new Error(
      `Migration 000005 integrity check failed: foreign_key_check found ${foreignKeyErrors.length} violation(s).`
    );
  }
  nextStage('integrity');
  const integrityRows = database.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
  const integrityMessages = integrityRows.flatMap((row) => Object.values(row).map(String));
  if (integrityMessages.length !== 1 || integrityMessages[0].toLowerCase() !== 'ok') {
    throw new Error(
      `Migration 000005 integrity check failed: integrity_check returned ${integrityMessages.join('; ') || 'no result'}.`
    );
  }
  completed = true;
  } finally {
    log.diagnostic('Startup database validation stage', { stage, durationMs: Number((performance.now() - started).toFixed(2)), status: completed ? 'ok' : 'failed' });
  }
}

export function runStartupMigrations(options: StartupMigrationOptions = {}): StartupMigrationResult {
  const databasePath = options.databasePath ?? storageService.getDatabasePath();
  if (databasePath === ':memory:') {
    log.info('Skipping Dbmate migrations because the configured database directory is unavailable');
    return {
      baselineInserted: false,
      databasePath,
      usedInMemoryDatabase: true
    };
  }

  let validationRuns = 0;
  const validate = (database: DatabaseSync) => {
    if (migrationVersionExists(database, POSTS_MIGRATION_VERSION)) validationRuns++;
    validatePostsMigrationCompleteness(database);
  };
  const baselineResult = baselineExistingDatabaseIfNeeded(databasePath, options);
  const before = repairKnownIncompleteMigrationMarkers(databasePath, options, validate);
  const migrationStarted = performance.now();
  try { runDbmateUp(databasePath, options); }
  catch (error) {
    log.diagnostic('Startup migration phase', { status: 'failed', durationMs: Number((performance.now() - migrationStarted).toFixed(2)), validationRuns });
    throw error;
  }

  const database = new DatabaseSync(databasePath);
  try {
    const applied = appliedMigrationVersions(database).filter(version => !before.includes(version));
    log.diagnostic('Startup migration phase', { status: 'ok', migrationsApplied: applied, migrationExecuted: applied.length > 0, durationMs: Number((performance.now() - migrationStarted).toFixed(2)) });
    validate(database);
    completeManagedCreatorMigration(database, appConfig.galleryRoot);
  } finally {
    log.diagnostic('Startup database validation summary', { validationRuns });
    database.close();
  }

  return {
    baselineInserted: baselineResult.baselineInserted,
    databasePath,
    usedInMemoryDatabase: false
  };
}
