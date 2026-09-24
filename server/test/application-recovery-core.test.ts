import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationRecoveryService, type ApplicationRecoveryConfig, readRecoveryPoints } from '../src/services/application-recovery-core.js';
import { generateRecoveryPoint, validateRecoveryRoot, applyRecoveryRetention } from '../src/services/application-recovery-worker.js';
import { LocalIngestPasswordStore } from '../src/services/local-ingest-password-store.js';
import { schemaSql } from '../src/db/schema.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(): ApplicationRecoveryConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'application-recovery-test-')); roots.push(root);
  const sourceDbPath = path.join(root, 'data', 'gallery.sqlite');
  fs.mkdirSync(path.dirname(sourceDbPath));
  const db = new DatabaseSync(sourceDbPath);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version TEXT PRIMARY KEY);
    INSERT INTO schema_migrations VALUES ('000003');
    CREATE TABLE creators(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE aliases(id INTEGER PRIMARY KEY,creator_id INTEGER REFERENCES creators(id),name TEXT);
    CREATE TABLE works(id INTEGER PRIMARY KEY,creator_id INTEGER REFERENCES creators(id),name TEXT);
    CREATE TABLE local_works(id INTEGER PRIMARY KEY,work_id INTEGER REFERENCES works(id),path TEXT);
    CREATE TABLE source_links(id INTEGER PRIMARY KEY,work_id INTEGER REFERENCES works(id),source TEXT);
    CREATE TABLE sort_decisions(id INTEGER PRIMARY KEY,work_id INTEGER REFERENCES works(id),time TEXT);
    CREATE TABLE fulfillments(id INTEGER PRIMARY KEY,work_id INTEGER REFERENCES works(id),state TEXT);
    CREATE TABLE plans(id INTEGER PRIMARY KEY,work_id INTEGER REFERENCES works(id),status TEXT);
    INSERT INTO creators VALUES(1,'synthetic creator'); INSERT INTO aliases VALUES(1,1,'alias');
    INSERT INTO works VALUES(1,1,'work'); INSERT INTO local_works VALUES(1,1,'before-move');
    INSERT INTO source_links VALUES(1,1,'source'); INSERT INTO sort_decisions VALUES(1,1,'2000-01-01');
    INSERT INTO fulfillments VALUES(1,1,'satisfied'); INSERT INTO plans VALUES(1,1,'failed');`);
  db.close();
  fs.writeFileSync(path.join(root, '.env'), 'PASSWORD=synthetic-secret');
  fs.mkdirSync(path.join(root, '.run')); fs.writeFileSync(path.join(root, '.run', '隔离配置.xml'), '<configuration/>');
  fs.mkdirSync(path.join(root, 'private')); fs.writeFileSync(path.join(root, 'private', 'local-ingest-archive-password.key'), 'synthetic-key');
  return { backupRoot: path.join(root, 'data_backup'), sourceDbPath, instanceId: 'synthetic', codeVersion: 'test-head', configFiles: [{ path: path.join(root, '.env'), label: '.env' }, { path: path.join(root, '.run'), label: '.run' }], privateRoot: path.join(root, 'private'), requiredPrivateFiles: ['local-ingest-archive-password.key'], forbiddenRoots: [path.join(root, 'gallery'), path.join(root, 'cache'), path.join(root, 'waiting')] };
}
describe('application recovery engine', () => {
  it('restores actual project schema identities, source satisfaction, sort decisions and plan history without rewinding later files', async () => {
    const config = fixture(); fs.unlinkSync(config.sourceDbPath);
    const db = new DatabaseSync(config.sourceDbPath);
    db.exec('PRAGMA foreign_keys=ON; BEGIN'); db.exec(schemaSql);
    db.exec(`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES('000027');
      INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id) VALUES(1,'Synthetic','synthetic','fixture','one');
      INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(1,'Alias','alias','manual');
      INSERT INTO folders(id,slug,name,folder_path) VALUES(1,'synthetic','Synthetic','synthetic');
      INSERT INTO posts(id,folder_id,source_path,sort_timestamp) VALUES(1,1,'Synthetic/Work',1);
      INSERT INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
      VALUES(1,1,'a.jpg','.jpg','Synthetic/Work/a.jpg','synthetic/a.jpg',1,1,1,'image/jpeg','synthetic-fingerprint',1,'now',1,'thumbnail','preview');
      INSERT INTO post_items(post_id,image_id,position) VALUES(1,1,1);
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,gallery_folder_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at) VALUES(1,1,1,'synthetic','Synthetic','synthetic/Synthetic','Synthetic','matched','now');
      INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'Work');
      INSERT INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,identity_policy,relative_path,absolute_path,folder_name,image_count,total_bytes,match_status,scanned_at) VALUES(1,1,1,1,'manual','Work','synthetic/Work','Work',1,1,'matched','now');
      INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at) VALUES(1,1,'synthetic','one','Synthetic collection','now');
      INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order,source_title,first_seen_at,last_seen_at) VALUES(1,1,1,'synthetic','001',1,'Synthetic title','now','now');
      INSERT INTO archive_catalog_download_tasks(id,source_work_id,provider,target_root,target_relative_directory,target_filename,status,attempt_count) VALUES(1,1,'synthetic','synthetic','Synthetic','001.7z','staged',3);
      INSERT INTO archive_catalog_work_decisions(id,decision_key,kind,work_id,local_work_id,source_work_id,reason,payload_json) VALUES(1,'accepted','accept_version',1,1,1,'Synthetic accepted version','{}');
      INSERT INTO archive_catalog_source_bindings(collection_id,source_work_id,work_id,decision_id) VALUES(1,'001',1,1);
      INSERT INTO archive_catalog_local_fulfillments(decision_id,source_work_id,local_work_id,work_id,task_id,source_snapshot_json,local_snapshot_json,reason) VALUES(1,1,1,1,1,'{}','{}','Synthetic satisfaction');
      INSERT INTO archive_catalog_work_sort_confirmations(decision_key,work_id,primary_local_work_id,primary_post_id,original_timestamp,adopted_timestamp,evidence_json,confirmation_source) VALUES('sort',1,1,1,1,2,'{}','synthetic-order-estimate');
      INSERT INTO archive_local_admission_plans(plan_id,content_hash,payload_json) VALUES('plan','synthetic-hash','{}');
      INSERT INTO archive_local_admission_items(plan_id,item_key,state,manifest_json,work_id,local_work_id,last_error) VALUES('plan','completed','completed','[]',1,1,NULL),('plan','old-failed','failed','[]',NULL,NULL,'historical failure'); COMMIT;`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
    const snapshot = (connection: DatabaseSync) => Object.fromEntries(tables.map(name => [name, connection.prepare(`SELECT * FROM "${name}"`).all()]));
    const before = snapshot(db);
    const mediaBefore = path.join(path.dirname(config.backupRoot), 'before.jpg'); fs.writeFileSync(mediaBefore, 'synthetic-media-not-backed-up');
    const point = await generateRecoveryPoint(config, 'manual');
    const mediaAfter = path.join(path.dirname(config.backupRoot), 'moved.jpg'); fs.renameSync(mediaBefore, mediaAfter);
    db.exec("INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,reason,payload_json) VALUES('after-backup','manual_note',1,'new decision','{}')"); db.close();
    const restoredPath = path.join(path.dirname(config.backupRoot), 'actual-restored.sqlite'); fs.copyFileSync(path.join(config.backupRoot, point.id, 'gallery.sqlite'), restoredPath);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    expect(snapshot(restored)).toEqual(before);
    expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(restored.prepare("SELECT state FROM archive_local_admission_items WHERE item_key='old-failed'").get()?.state).toBe('failed');
    expect(restored.prepare("SELECT 1 FROM archive_catalog_work_decisions WHERE decision_key='after-backup'").get()).toBeUndefined();
    expect(fs.existsSync(mediaBefore)).toBe(false); expect(fs.existsSync(mediaAfter)).toBe(true);
    expect(point.files.every(file => !file.name.endsWith('.jpg'))).toBe(true); restored.close();
  });
  it('backs up complete old schema plus real configuration/key, and restores facts without migration or task replay', async () => {
    const config = fixture(); const before = fs.readFileSync(config.sourceDbPath);
    const point = await generateRecoveryPoint(config, 'manual');
    expect(fs.readFileSync(config.sourceDbPath)).toEqual(before);
    expect(point.schemaVersions).toEqual(['000003']); expect(point.validation.tables).toBe(9);
    expect(point.configuration.complete).toBe(true);
    expect(point.files.map(file => file.name)).toContain('config/.run/隔离配置.xml');
    expect(JSON.stringify(point)).not.toMatch(/synthetic-secret|synthetic-key|before-move/);
    const live = new DatabaseSync(config.sourceDbPath); live.exec("UPDATE local_works SET path='after-move'; INSERT INTO sort_decisions VALUES(2,1,'2020-01-01');"); live.close();
    const restoredPath = path.join(path.dirname(config.backupRoot), 'restored.sqlite');
    fs.copyFileSync(path.join(config.backupRoot, point.id, 'gallery.sqlite'), restoredPath);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    for (const table of ['creators','aliases','works','local_works','source_links','sort_decisions','fulfillments','plans']) expect(restored.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(1);
    expect(restored.prepare('SELECT path FROM local_works').get()?.path).toBe('before-move');
    expect(restored.prepare('SELECT status FROM plans').get()?.status).toBe('failed'); restored.close();
    expect(readRecoveryPoints(config.backupRoot)).toHaveLength(1);
    expect(new ApplicationRecoveryService(config).getStatus().latestSuccess?.id).toBe(point.id);
  });
  it('runs the same engine asynchronously and synchronously in separate child processes', async () => {
    const service = new ApplicationRecoveryService(fixture());
    const pending = service.create('manual');
    expect(new ApplicationRecoveryService(service.config).getStatus().active).not.toBeNull();
    expect(new ApplicationRecoveryService(service.config).create('manual')).toBe(pending);
    const asyncPoint = await pending; const syncPoint = service.createSync('pre-migration');
    expect(syncPoint.id).not.toBe(asyncPoint.id); expect(service.getStatus().points).toHaveLength(2);
    expect(service.getStatus().active).toBeNull();
  }, 15000);
  it('bounds a real database-busy worker and reports failure without publishing an incomplete point', async () => {
    const config = fixture(); config.timeoutMs = 2500;
    const db = new DatabaseSync(config.sourceDbPath); db.exec('BEGIN EXCLUSIVE');
    const service = new ApplicationRecoveryService(config);
    try {
      const result = service.create('manual');
      await expect(result).rejects.toMatchObject({ code: 'RECOVERY_TIMEOUT' });
      expect(service.getStatus().points).toEqual([]);
      expect(service.getStatus().lastFailure?.code).toBe('RECOVERY_TIMEOUT');
    } finally { db.exec('ROLLBACK'); db.close(); }
  }, 10000);
  it('rejects overlapping targets and symlink redirects', () => {
    const config = fixture();
    for (const backupRoot of [path.dirname(config.sourceDbPath), config.sourceDbPath, path.join(config.forbiddenRoots[0]!, 'backup')]) expect(() => validateRecoveryRoot({ ...config, backupRoot })).toThrow();
    const link = path.join(path.dirname(config.backupRoot), 'backup-link');
    fs.mkdirSync(config.forbiddenRoots[0]!); fs.symlinkSync(config.forbiddenRoots[0]!, link, 'junction');
    expect(() => validateRecoveryRoot({ ...config, backupRoot: path.join(link, 'nested') })).toThrow();
  });
  it('does not overwrite concurrent workers, partial output or foreign/manual backups', async () => {
    const config = fixture(); const point = await generateRecoveryPoint(config, 'manual');
    fs.mkdirSync(path.join(config.backupRoot, '.partial-interrupted')); fs.writeFileSync(path.join(config.backupRoot, '.partial-interrupted', 'gallery.sqlite'), 'unfinished');
    fs.mkdirSync(path.join(config.backupRoot, '.recovery-lock')); fs.writeFileSync(path.join(config.backupRoot, '.recovery-lock', 'owner.json'), JSON.stringify({ pid: process.pid, id: 'other', reason: 'manual', startedAt: new Date().toISOString() }));
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_BUSY' });
    expect(new ApplicationRecoveryService(config).getStatus().active?.id).toBe('other');
    expect(readRecoveryPoints(config.backupRoot).map(row => row.id)).toEqual([point.id]);
  });
  it('arbitrates actual concurrent generators and keeps only complete publications', async () => {
    const config = fixture();
    const results = await Promise.allSettled([generateRecoveryPoint(config, 'manual'), generateRecoveryPoint(config, 'pre-rebuild')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(readRecoveryPoints(config.backupRoot)).toHaveLength(1);
  });
  it('identifies interrupted work after restart and recovers only its abandoned lock', async () => {
    const config = fixture(); fs.mkdirSync(config.backupRoot);
    const lock = path.join(config.backupRoot, '.recovery-lock'); fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, id: 'interrupted', reason: 'manual', startedAt: new Date().toISOString() }));
    fs.mkdirSync(path.join(config.backupRoot, '.partial-interrupted'));
    const service = new ApplicationRecoveryService(config);
    expect(service.getStatus().lastFailure?.code).toBe('RECOVERY_INTERRUPTED');
    expect(service.getStatus().active).toBeNull();
    await generateRecoveryPoint(config, 'manual');
    expect(readRecoveryPoints(config.backupRoot)).toHaveLength(1);
    expect(fs.existsSync(path.join(config.backupRoot, '.partial-interrupted'))).toBe(true);
  });
  it('does not steal a replacement live lock when two processes race to recover an interrupted lock', async () => {
    const config = fixture(); fs.mkdirSync(config.backupRoot);
    const lock = path.join(config.backupRoot, '.recovery-lock'); fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, id: 'dead' }));
    const realMkdir = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
      if (String(target) === path.join(lock, '.reaper')) {
        fs.renameSync(lock, path.join(config.backupRoot, '.interrupted-other'));
        realMkdir(lock);
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, id: 'replacement' }));
      }
      return realMkdir(target, options as never) as never;
    });
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_BUSY' });
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).id).toBe('replacement');
  });
  it('validates encrypted snapshot configuration with the included key independently of caller hints', async () => {
    const config = fixture();
    fs.unlinkSync(path.join(config.privateRoot!, 'local-ingest-archive-password.key'));
    const raw = new LocalIngestPasswordStore(config.privateRoot!).encrypt('test-password-not-metadata');
    const db = new DatabaseSync(config.sourceDbPath); db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO app_settings VALUES(?,?)').run('local_ingest.archive_password', raw); db.close();
    const point = await generateRecoveryPoint(config, 'manual');
    expect(new LocalIngestPasswordStore(path.join(config.backupRoot, point.id, 'private')).decrypt(raw)).toBe('test-password-not-metadata');
    fs.writeFileSync(path.join(config.privateRoot!, 'local-ingest-archive-password.key'), Buffer.alloc(32, 7));
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_KEY_MISMATCH' });
    config.requiredPrivateFiles = []; fs.unlinkSync(path.join(config.privateRoot!, 'local-ingest-archive-password.key'));
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_KEY_MISMATCH' });
    expect(JSON.stringify(point)).not.toContain('test-password-not-metadata');
  });
  it('records optional configuration gaps but fails for missing required encryption keys', async () => {
    const config = fixture(); fs.rmSync(config.configFiles[1]!.path, { recursive: true });
    const point = await generateRecoveryPoint(config, 'manual'); expect(point.configuration.gaps).toContain('config/.run: missing');
    fs.unlinkSync(path.join(config.privateRoot!, 'local-ingest-archive-password.key'));
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED_FILE_MISSING' });
    expect(readRecoveryPoints(config.backupRoot)).toHaveLength(1);
  });
  it('detects changed or newly introduced keys during collection rather than publishing a mismatched set', async () => {
    const config = fixture(); const realCopy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
      realCopy(source, destination, flags);
      if (String(source).endsWith('.env')) fs.writeFileSync(path.join(config.privateRoot!, 'another.key'), 'new-key');
    });
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_CONFIG_CHANGED' });
    expect(readRecoveryPoints(config.backupRoot)).toEqual([]);
  });
  it('detects a changed required key and rejects malformed or symlink metadata on restart', async () => {
    const config = fixture(); const realCopy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
      realCopy(source, destination, flags);
      if (String(source).endsWith('.env')) fs.writeFileSync(path.join(config.privateRoot!, 'local-ingest-archive-password.key'), 'changed-key');
    });
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_CONFIG_CHANGED' });
    fs.mkdirSync(path.join(config.backupRoot, 'point-malformed')); fs.writeFileSync(path.join(config.backupRoot, 'point-malformed', 'metadata.json'), '{');
    expect(new ApplicationRecoveryService(config).getStatus().points).toEqual([]);
  });
  it('ignores valid JSON with incomplete or invalid success metadata after restart', async () => {
    const config = fixture(); const point = await generateRecoveryPoint(config, 'manual');
    const invalid = [
      { codeVersion: undefined }, { codeVersion: 123 }, { bytes: undefined }, { bytes: -1 }, { bytes: Infinity },
      { reason: 'unknown' }, { reason: ['manual'] }, { startedAt: 'invalid' }, { completedAt: '2026-02-30T00:00:00.000Z' },
      { timings: undefined }, { timings: { ...point.timings, totalMs: undefined } }, { timings: { ...point.timings, validationMs: -1 } },
      { schemaVersions: [27] }, { configuration: { complete: 'yes', gaps: [] } }, { configuration: { complete: false, gaps: [null] } },
      { validation: { ...point.validation, foreignKeys: 1 } }, { validation: { ...point.validation, tables: 1.5 } },
      { files: [] }, { files: [{ name: 'gallery.sqlite', bytes: -1, sha256: point.files[0]!.sha256 }] }
    ];
    for (const [index, change] of invalid.entries()) {
      const id = `point-incomplete-${index}`; const directory = path.join(config.backupRoot, id); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'gallery.sqlite'), 'synthetic');
      fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ ...point, ...change, id }));
    }
    const status = new ApplicationRecoveryService(config).getStatus();
    expect(status.points).toEqual([point]); expect(status.latestSuccess?.id).toBe(point.id);
  });
  it('fails FK validation without publishing or migrating the old database', async () => {
    const config = fixture(); const db = new DatabaseSync(config.sourceDbPath); db.exec('PRAGMA foreign_keys=OFF; INSERT INTO aliases VALUES(2,999,\'broken\')'); db.close();
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED' });
    const status = new ApplicationRecoveryService(config).getStatus(); expect(status.points).toEqual([]); expect(status.lastFailure?.code).toBe('RECOVERY_VALIDATION_FAILED'); expect(status.active).toBeNull();
  });
  it('retains the last good point on insufficient disk space', async () => {
    const config = fixture(); const point = await generateRecoveryPoint(config, 'manual');
    const old = fs.statfsSync(config.backupRoot);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ ...old, bavail: 0 } as never);
    await expect(generateRecoveryPoint(config, 'manual')).rejects.toMatchObject({ code: 'RECOVERY_NO_SPACE' });
    expect(readRecoveryPoints(config.backupRoot).map(row => row.id)).toEqual([point.id]);
  });
  it('deduplicates daily work across service instances and preserves manual/pre-operation points', async () => {
    const config = fixture(); config.automatic = { enabled: true };
    const first = await generateRecoveryPoint(config, 'daily');
    expect((await generateRecoveryPoint(config, 'daily')).id).toBe(first.id);
    const manual = await generateRecoveryPoint(config, 'manual');
    const pre = await generateRecoveryPoint(config, 'pre-rebuild');
    for (let i = 1; i <= 45; i++) {
      const id = `point-retention-${i}`; const dir = path.join(config.backupRoot, id); fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'gallery.sqlite'), 'retention-fixture');
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ ...first, id, completedAt: new Date(Date.now() - i * 86400000).toISOString() }));
    }
    fs.mkdirSync(path.join(config.backupRoot, 'legacy-manual-backup'));
    applyRecoveryRetention(config.backupRoot, config.instanceId);
    const points = readRecoveryPoints(config.backupRoot); expect(points.filter(p => p.reason === 'daily').length).toBeLessThanOrEqual(11);
    expect(points.map(p => p.id)).toEqual(expect.arrayContaining([first.id, manual.id, pre.id]));
    expect(fs.existsSync(path.join(config.backupRoot, 'legacy-manual-backup'))).toBe(true);
  });
});
