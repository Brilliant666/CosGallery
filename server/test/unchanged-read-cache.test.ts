import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createUnchangedReadCache } from '../src/db/unchanged-read-cache.js';

describe('SQLite generation-scoped fact reads', () => {
  it('reuses unchanged reads, isolates mutable results and sees local/independent committed writes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-generations-'));
    const file = path.join(root, 'isolated.sqlite');
    const db = new DatabaseSync(file);
    let other: DatabaseSync | undefined;
    try {
      db.exec('CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES(\'before\')');
      other = new DatabaseSync(file);
      const read = vi.fn(() => db.prepare('SELECT * FROM facts').all());
      const cached = createUnchangedReadCache<ReturnType<typeof read>>();
      expect(cached(db, read)).toEqual([{ value: 'before' }]);
      const mutable = cached(db, read); mutable[0].value = 'corrupted response';
      expect(cached(db, read)).toEqual([{ value: 'before' }]);
      expect(read).toHaveBeenCalledTimes(1);
      db.exec("UPDATE facts SET value='same connection'");
      expect(cached(db, read)).toEqual([{ value: 'same connection' }]);
      other.exec("UPDATE facts SET value='CLI connection'");
      expect(cached(db, read)).toEqual([{ value: 'CLI connection' }]);
      expect(read).toHaveBeenCalledTimes(3);
      db.exec("BEGIN; UPDATE facts SET value='uncommitted'");
      expect(cached(db, read)).toEqual([{ value: 'uncommitted' }]);
      db.exec('ROLLBACK');
      expect(cached(db, read)).toEqual([{ value: 'CLI connection' }]);
      db.exec('ALTER TABLE facts ADD COLUMN extra INTEGER DEFAULT 2');
      expect(cached(db, read)).toEqual([{ value: 'CLI connection', extra: 2 }]);
      // Neither connection identity nor a previous success leaks into a reopen.
      db.close();
      const reopened = new DatabaseSync(file);
      try { expect(cached(reopened, () => reopened.prepare('SELECT * FROM facts').all())).toEqual([{ value: 'CLI connection', extra: 2 }]); }
      finally { reopened.close(); }
    } finally { try { db.close(); } catch {} other?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('does not memoize a failure and never reuses a snapshot inside a transaction', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const cached = createUnchangedReadCache<number>();
      expect(() => cached(db, () => { throw new Error('read failed'); })).toThrow('read failed');
      expect(cached(db, () => 1)).toBe(1);
      db.exec('BEGIN');
      expect(cached(db, () => 2)).toBe(2);
      expect(cached(db, () => 3)).toBe(3);
      db.exec('COMMIT');
      expect(cached(db, () => 4)).toBe(4);
    } finally { db.close(); }
  });
});
