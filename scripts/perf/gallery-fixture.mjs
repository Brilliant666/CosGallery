// Local-only evidence preparation. Output MUST stay in an ignored data directory.
// prepare <production-repo> <evidence-root>; inspect <evidence-root>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
const [mode, sourceArg, evidenceArg] = process.argv.slice(2);
const evidence = path.resolve(mode === 'prepare' ? evidenceArg : sourceArg);
assert(evidence.split(path.sep).includes('data') && path.basename(evidence).startsWith('gallery-perf'));
const write = (name, data) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2));
if (mode === 'prepare') {
  const source = fs.realpathSync(sourceArg);
  fs.mkdirSync(evidence, { recursive: true });
  const original = path.join(source, 'data/db/gallery.sqlite');
  const snapshot = path.join(evidence, 'snapshot.sqlite');
  assert(!fs.existsSync(snapshot), 'Reuse the existing snapshot, do not overwrite evidence');
  const production = new DatabaseSync(original, { readOnly: true });
  production.exec('PRAGMA query_only=ON');
  await backup(production, snapshot);
  production.close();
  const snapshotDb = new DatabaseSync(snapshot, { readOnly: true });
  write('snapshot-summary.json', {
    at: new Date().toISOString(), node: process.version,
    images: snapshotDb.prepare('SELECT count(*) n FROM images').get().n,
    posts: snapshotDb.prepare('SELECT count(*) n FROM posts').get().n,
    migration: snapshotDb.prepare('SELECT max(version) version FROM schema_migrations').get().version,
    indexes: snapshotDb.prepare('PRAGMA index_list(images)').all(),
    quickCheck: snapshotDb.prepare('PRAGMA quick_check').all(),
    foreignKeys: snapshotDb.prepare('PRAGMA foreign_key_check').all(),
    size: fs.statSync(snapshot).size
  });
  snapshotDb.close();
  for (const label of ['before', 'after']) {
    const root = path.join(evidence, label);
    for (const dir of ['db', 'gallery', 'thumbnails', 'previews']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, '.isolated-gallery-perf'), 'isolated fixture only');
    fs.copyFileSync(snapshot, path.join(root, 'db/gallery.sqlite'), fs.constants.COPYFILE_EXCL);
    const copy = new DatabaseSync(path.join(root, 'db/gallery.sqlite'));
    // Path bookkeeping ONLY in the isolated copy; both fixtures receive identical edits.
    copy.prepare("UPDATE app_settings SET value=? WHERE key='scanner.last_successful_gallery_root'")
      .run(path.join(root, 'gallery').replaceAll('\\', '/'));
    copy.close();
  }
  console.log(fs.readFileSync(path.join(evidence, 'snapshot-summary.json'), 'utf8'));
} else if (mode === 'inspect') {
  const db = new DatabaseSync(path.join(evidence, 'snapshot.sqlite'), { readOnly: true });
  console.log(JSON.stringify({
    multiDirectory: db.prepare('SELECT creator_id,count(*) n FROM archive_catalog_local_creator_folders WHERE is_active=1 GROUP BY creator_id HAVING n>1').all(),
    sample: db.prepare('SELECT id,relative_path,thumbnail_path,preview_path,media_type FROM images ORDER BY id DESC LIMIT 1').get()
  }));
  db.close();
} else throw new Error('Unknown mode');
