// Time the actual two-index migration SQL against a disposable snapshot copy.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
const evidence = fs.realpathSync(process.argv[2]);
assert(fs.existsSync(path.join(evidence,'before/.isolated-gallery-perf')));
const target = path.join(evidence,'index-size.sqlite');
assert(!fs.existsSync(target), 'Do not overwrite an existing measurement');
fs.copyFileSync(path.join(evidence,'snapshot.sqlite'),target,fs.constants.COPYFILE_EXCL);
const db=new DatabaseSync(target);
const sql=fs.readFileSync('server/db/migrations/000020_add_image_derivative_path_indexes.sql','utf8').split('-- migrate:down')[0];
const sizeBefore=fs.statSync(target).size;
const statsBefore=db.prepare('SELECT count(*) n,min(id) first,max(id) last,sum(file_size) bytes FROM images').get();
const t=performance.now(); db.exec('BEGIN'); db.exec(sql); db.exec('COMMIT'); const createMs=performance.now()-t;
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const sizeAfter=fs.statSync(target).size;
assert.deepEqual(db.prepare('SELECT count(*) n,min(id) first,max(id) last,sum(file_size) bytes FROM images').get(),statsBefore);
const repeatStart=performance.now(); db.exec(sql); const repeatMs=performance.now()-repeatStart;
const result={rows:statsBefore.n,createMs,repeatMs,sizeBefore,sizeAfter,deltaBytes:sizeAfter-sizeBefore,
  quickCheck:db.prepare('PRAGMA quick_check').all(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all(),
  indexes:db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('idx_images_thumbnail_path','idx_images_preview_path')").all()};
db.close();fs.writeFileSync(path.join(evidence,'index-size.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
