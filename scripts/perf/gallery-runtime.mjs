// Opt-in isolated benchmark host. Never starts watchers, ingestion or deletion recovery.
// Usage: node scripts/perf/gallery-runtime.mjs <built-source-root> <isolated-data-root> <port>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const codeRoot = fs.realpathSync(process.argv[2]);
const dataRoot = fs.realpathSync(process.argv[3]);
const port = Number(process.argv[4]);
assert(port >= 4400 && port < 4900 && port !== 4141);
assert(fs.existsSync(path.join(dataRoot, '.isolated-gallery-perf')));
assert(!fs.existsSync(path.join(codeRoot, '.env')), 'Use a clean isolated worktree/build without production .env');
const within = (p, root) => { const rel = path.relative(root, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const paths = {
  DATA_ROOT: dataRoot, DB_DIR: path.join(dataRoot, 'db'), GALLERY_ROOT: path.join(dataRoot, 'gallery'),
  THUMBNAILS_DIR: path.join(dataRoot, 'thumbnails'), PREVIEWS_DIR: path.join(dataRoot, 'previews')
};
Object.assign(process.env, paths, { NODE_ENV: 'production', SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port),
  COS_GALLERY_MODE: 'true', DERIVATIVE_MODE: 'lazy', IMAGE_DETAIL_SOURCE: 'preview',
  SCAN_DERIVATIVE_CONCURRENCY: '4', LOCAL_INGEST_STARTUP_SCAN: 'false' });
// Do not inherit source paths or development/test switches from the invoking shell.
delete process.env.VITEST;
delete process.env.DATABASE_URL;
for (const [key, value] of Object.entries(paths)) {
  assert(key === 'DATA_ROOT' || within(value, dataRoot));
  fs.mkdirSync(value, { recursive: true });
}
const load = rel => import(pathToFileURL(path.join(codeRoot, 'server/dist', rel)).href);
const { appConfig } = await load('config/env.js');
assert.equal(appConfig.databasePath, path.join(paths.DB_DIR, 'gallery.sqlite'));
for (const [key, property] of [['DATA_ROOT', 'dataRoot'], ['DB_DIR', 'dbDir'], ['GALLERY_ROOT', 'galleryRoot'],
  ['THUMBNAILS_DIR', 'thumbnailsDir'], ['PREVIEWS_DIR', 'previewsDir']]) assert.equal(appConfig[property], paths[key]);
console.log(JSON.stringify({ event: 'isolated-paths-verified', codeRoot, paths, node: process.version, port }));
const { createApp } = await load('app.js');
const { databaseManager } = await load('db/database.js');
// Match the regular createApp HTTP stack and production static assets, without bootstrap side effects.
const app = createApp();
const db = databaseManager.connection;
const migration = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
console.log(JSON.stringify({ event: 'ready', migration, scans: 'not invoked; benchmark host only' }));
const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405); response.end('Read-only benchmark'); return;
  }
  app(request, response);
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'listening', pid: process.pid, port })));
// Parent owns only this benchmark child; close via stdin rather than process-name termination.
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { if (data.trim() === 'stop') server.close(() => { databaseManager.close(); process.exit(0); }); });
