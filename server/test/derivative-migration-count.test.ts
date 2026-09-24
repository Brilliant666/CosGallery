import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';

const oldCount = `SELECT COUNT(*) AS count FROM images WHERE asset_key IS NULL OR TRIM(asset_key)=''
 OR LOWER(thumbnail_path)!=LOWER(SUBSTR(TRIM(asset_key),1,2)||'/'||LOWER(TRIM(asset_key))||'.webp')
 OR LOWER(preview_path)!=LOWER(SUBSTR(TRIM(asset_key),1,2)||'/'||LOWER(TRIM(asset_key))||CASE WHEN media_type='video' THEN '.mp4' ELSE '.webp' END)`;

describe('legacy derivative compatibility count', () => {
  let db: DatabaseSync;
  let repository: typeof import('../src/db/repositories.js')['imageRepository'];
  const globals = globalThis as unknown as Record<symbol, DatabaseSync | null>;
  const key = Symbol.for('foldergram.database.connection');
  beforeEach(async () => {
    db = new DatabaseSync(':memory:'); db.exec(schemaSql); globals[key] = db;
    ({ imageRepository: repository } = await import('../src/db/repositories.js'));
    db.exec("INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'fixture','Fixture','/fixture')");
  });
  afterEach(() => { globals[key] = null; db.close(); });
  it('matches the previous expression for case, whitespace, missing keys, video and invisible rows', () => {
    const inputs: Array<[string | null, string, string, string]> = [
      [null, 'old/thumb.webp', 'old/preview.webp', 'image'], ['', '', '', 'image'], [' ', ' / .webp', ' / .webp', 'image'],
      ['abc', 'ab/abc.webp', 'ab/abc.webp', 'image'], ['VIDEO', 'VI/VIDEO.webp', 'VI/VIDEO.mp4', 'video'],
      [' Spaced ', 'sp/spaced.webp', 'SP/SPACED.WEBP', 'image'], ['upper', 'UP/UPPER.WEBP', 'UP/UPPER.MP4', 'video'],
      ['mismatch', 'mi/mismatch.webp', 'wrong.mp4', 'video'], ['x', 'x/x.webp', 'x/x.webp', 'image']
    ];
    const insert = db.prepare(`INSERT INTO images(folder_id,asset_key,filename,extension,relative_path,absolute_path,file_size,width,height,media_type,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path,is_deleted,is_trashed)
      VALUES(1,?,'file.jpg','.jpg',?,? ,1,1,1,?,'fixture','fixture',1,'fixture',1,?,?,?,?)`);
    inputs.forEach(([asset, thumb, preview, media], index) => {
      insert.run(asset, `fixture-${index}`, `/fixture/${index}`, media, thumb, preview, index % 2, (index + 1) % 2);
      expect(repository.countPendingDerivativeMigrationRows()).toBe(db.prepare(oldCount).get()!.count);
    });
    const prepare = vi.spyOn(db, 'prepare');
    const original = repository.countPendingDerivativeMigrationRows();
    expect(repository.countPendingDerivativeMigrationRows()).toBe(original);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('TRIM(asset_key)'))).toBe(false);
    prepare.mockRestore();
    db.exec("UPDATE images SET preview_path='invalid' WHERE asset_key='abc'");
    expect(repository.countPendingDerivativeMigrationRows()).toBe(original + 1);
    expect(repository.countPendingDerivativeMigrationRows()).toBe(db.prepare(oldCount).get()!.count);
  });
});
