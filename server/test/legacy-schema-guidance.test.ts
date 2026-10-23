import type { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { runStartupMigrations } from '../src/db/migration.js';
import { assertNoLegacySchema } from '../src/db/schema-compat.js';
import * as recoveryService from '../src/services/application-recovery-service.js';

const profiles = "CREATE TABLE profiles(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO profiles VALUES(1,'Synthetic creator');";
const images = "CREATE TABLE images(id INTEGER PRIMARY KEY, profile_id INTEGER, filename TEXT); INSERT INTO images VALUES(1,1,'synthetic.jpg');";

function expectPreservationGuidance(action: () => void): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).toContain('Legacy database schema detected');
  expect(message).toContain('Automatic upgrade of this schema is not supported');
  expect(message).toContain('Do not delete the SQLite database or rebuild it in place');
  expect(message).toContain('Preserve the database, configuration and required keys');
  expect(message).toContain('consistent recovery copy');
  expect(message).toContain('supported upgrade or recovery procedure');
  expect(message).not.toContain('Delete the SQLite file and restart');
}

describe('unsupported legacy schema guidance', () => {
  it.each([
    ['profiles table alone', profiles],
    ['images.profile_id alone', images],
    ['profiles and images.profile_id', profiles + images],
    ['legacy schema with a baseline marker', profiles + images
      + "CREATE TABLE schema_migrations(version TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES('000001');"]
  ])('rejects %s before startup writes, preserving the synthetic database', (_label, ddl) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-schema-guidance-'));
    const databasePath = path.join(root, 'legacy.sqlite');
    const seed = new DatabaseSync(databasePath);
    try { seed.exec(ddl); } finally { seed.close(); }
    const before = fs.readFileSync(databasePath);
    const beforeFiles = fs.readdirSync(root).sort();
    const recovery = vi.spyOn(recoveryService, 'createApplicationRecoveryService').mockImplementation(() => {
      throw new Error('Recovery must not start for an unsupported legacy schema');
    });
    const spawnSyncImpl: typeof spawnSync = vi.fn(() => {
      throw new Error('Dbmate must not start for an unsupported legacy schema');
    });
    try {
      const readOnly = new DatabaseSync(databasePath, { readOnly: true });
      try { expectPreservationGuidance(() => assertNoLegacySchema(readOnly)); }
      finally { readOnly.close(); }
      // Repeated starts must keep refusing even when a migration marker exists.
      for (let attempt = 0; attempt < 2; attempt++) {
        expectPreservationGuidance(() => runStartupMigrations({ databasePath, spawnSyncImpl }));
        expect(fs.readFileSync(databasePath)).toEqual(before);
        expect(fs.readdirSync(root).sort()).toEqual(beforeFiles);
      }
      expect(spawnSyncImpl).not.toHaveBeenCalled();
      expect(recovery).not.toHaveBeenCalled();
    } finally {
      recovery.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reject the folders/folder_id shape as a legacy profile schema', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE folders(id INTEGER PRIMARY KEY); CREATE TABLE images(id INTEGER PRIMARY KEY, folder_id INTEGER);');
      expect(() => assertNoLegacySchema(database)).not.toThrow();
    } finally { database.close(); }
  });
});
