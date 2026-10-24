// Prepare a bounded set of actual cached derivatives for paired local benchmarks.
// Production originals/caches are read-only. All writes are under the isolated evidence root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const [evidenceArg, productionArg, url, ordinaryArg, multiArg, largeArg] = process.argv.slice(2);
const evidence = fs.realpathSync(evidenceArg), production = fs.realpathSync(productionArg);
assert(evidence.split(path.sep).includes('data') && path.basename(evidence).startsWith('gallery-perf'));
const [ordinaryId,multiId,largeId] = [ordinaryArg,multiArg,largeArg].map(Number);
assert([ordinaryId,multiId,largeId].every(n=>Number.isSafeInteger(n)&&n>0));
assert(/^http:\/\/127\.0\.0\.1:4[4-8]\d{2}$/.test(url));
const isolated = path.join(evidence, 'before');
assert(fs.existsSync(path.join(isolated, '.isolated-gallery-perf')));
Object.assign(process.env, { NODE_ENV: 'production', DATA_ROOT: isolated, DB_DIR: path.join(isolated,'db'),
  GALLERY_ROOT: path.join(isolated,'gallery'), THUMBNAILS_DIR: path.join(isolated,'thumbnails'),
  PREVIEWS_DIR: path.join(isolated,'previews'), DERIVATIVE_MODE: 'lazy', LOCAL_INGEST_STARTUP_SCAN: 'false' });
assert(process.env.GALLERY_BENCH_FFMPEG && path.isAbsolute(process.env.GALLERY_BENCH_FFMPEG));
process.env.FFMPEG_PATH = process.env.GALLERY_BENCH_FFMPEG;
const builtRoot = path.resolve(evidence, '../gallery-perf-before-source');
assert(!fs.existsSync(path.join(builtRoot, '.env')));
const derivative = await import(pathToFileURL(path.join(builtRoot,'server/dist/services/derivative-service.js')).href);
const db = new DatabaseSync(path.join(evidence, 'snapshot.sqlite'), { readOnly: true });
const api = async route => { const r = await fetch(url + '/api' + route); assert(r.ok, route); return r.json(); };
const write = (name, data) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2));
const pathname = value => new URL(value, url).pathname;
const selected = new Map();
const add = (p, kind) => {
  if (!p) return;
  const relative = decodeURIComponent(pathname(p).replace(/^\/(thumbnails|previews)\//, ''));
  assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
  if (selected.has(`${kind}:${relative}`)) return;
  const col = kind === 'thumbnail' ? 'thumbnail_path' : 'preview_path';
  const row = db.prepare(`SELECT * FROM images WHERE ${col}=?`).get(relative);
  assert(row, `No indexed media for ${relative}`);
  selected.set(`${kind}:${relative}`, { row, relative, kind });
};
const library = await api('/cos-gallery/creators?page=1&limit=50');
for (const c of library.items) { add(c.avatarUrl, 'thumbnail'); add(c.coverUrl, 'thumbnail'); }
const samples = { library: { targetPaths: library.items.filter(c => c.coverUrl).slice(0, 4).map(c => pathname(c.coverUrl)) } };
samples.clockTime = fs.existsSync(path.join(evidence, 'samples.json'))
  ? JSON.parse(fs.readFileSync(path.join(evidence, 'samples.json'), 'utf8')).clockTime ?? new Date().toISOString()
  : new Date().toISOString();
samples.library.returnCreatorId = library.items[0].id;
// The sidebar only shows recent creators. Prepare the avatar union for the
// synthetic visit states exercised by this navigation test.
const { selectRecentCreators } = await import(pathToFileURL(path.join(builtRoot, 'client/src/utils/sidebar-folders.ts')).href);
const folders = (await api('/folders')).items;
const visitedIds = new Set([ordinaryId, multiId, largeId, samples.library.returnCreatorId]);
const visitStates = [[], ...folders.filter(f => visitedIds.has(f.canonicalCreatorId)).map(f => [`creator:${f.canonicalCreatorId}`])];
for (const recent of visitStates) {
  for (const folder of selectRecentCreators(folders, recent)) add(folder.avatarUrl, 'thumbnail');
}
const returnPage = await api(`/cos-gallery/creators/${samples.library.returnCreatorId}/works?page=1&limit=24`);
add(returnPage.creator.avatarUrl, 'thumbnail');
add(returnPage.creator.coverUrl, 'thumbnail');
for(const item of returnPage.items) add(item.thumbnailUrl,'thumbnail');
for (const [label, creatorId] of [['ordinary', ordinaryId], ['multi', multiId]]) {
  const page = await api(`/cos-gallery/creators/${creatorId}/works?page=1&limit=24`);
  const page2 = await api(`/cos-gallery/creators/${creatorId}/works?page=2&limit=24`);
  assert(page.items.length === 24);
  if (label === 'multi') assert(page.creator.localFolders.length > 1);
  if (label === 'ordinary') assert(page.creator.localFolders.length === 1);
  for (const item of [...page.items, ...page2.items]) add(item.thumbnailUrl, 'thumbnail');
  add(page.creator.avatarUrl, 'thumbnail');
  add(page.creator.coverUrl, 'thumbnail');
  const work = await api(`/cos-gallery/creators/${creatorId}/works/${page.items[0].id}`);
  for (const item of work.mediaItems.slice(0, 80)) add(item.thumbnailUrl, 'thumbnail');
  const firstImage = work.mediaItems.find(m => m.mediaType === 'image');
  for (const item of work.mediaItems.filter(m => m.mediaType === 'image').slice(0, 4)) add(item.previewUrl, 'preview');
  samples[label] = { creatorId, postId: work.id, mediaId: firstImage.imageId, pagination: label === 'multi',
    targetPaths: page.items.slice(0, 4).map(i => pathname(i.thumbnailUrl)),
    workTargetPaths: work.mediaItems.slice(0, 4).map(i => pathname(i.thumbnailUrl)) };
  write(`${label}-before-page.json`, page);
}
const largePage = await api(`/cos-gallery/creators/${largeId}/works?page=1&limit=24`);
const largeCard = [...largePage.items].sort((a,b) => b.itemCount-a.itemCount)[0];
const large = await api(`/cos-gallery/creators/${largeId}/works/${largeCard.id}`);
assert(large.mediaItems.length >= 500);
for (const item of large.mediaItems.slice(0, 80)) add(item.thumbnailUrl, 'thumbnail');
for (const item of large.mediaItems.filter(m => m.mediaType === 'image').slice(0, 4)) add(item.previewUrl, 'preview');
const deep = large.mediaItems.filter(m => m.mediaType === 'image')[1];
samples.large = { creatorId: largeId, postId: large.id, mediaId: deep.imageId,
  targetPaths: large.mediaItems.slice(0, 4).map(i => pathname(i.thumbnailUrl)), previewPath: pathname(deep.previewUrl) };
samples.sql = {
  old: db.prepare("SELECT id,thumbnail_path,preview_path FROM images WHERE media_type='image' ORDER BY id LIMIT 1").get(),
  recent: db.prepare("SELECT id,thumbnail_path,preview_path FROM images WHERE media_type='image' AND is_deleted=0 AND is_trashed=0 ORDER BY id DESC LIMIT 1").get()
};
for (const row of Object.values(samples.sql)) { add('/thumbnails/' + row.thumbnail_path, 'thumbnail'); add('/previews/' + row.preview_path, 'preview'); }
write('samples.json', samples);
const manifest = [];
for (const { row, relative, kind } of selected.values()) {
  const dir = kind === 'thumbnail' ? 'thumbnails' : 'previews';
  const src = path.join(production, 'data', dir, relative);
  const dest = path.join(evidence, 'before', dir, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let origin = 'existing-production-cache';
  if (!fs.existsSync(dest)) {
    if (fs.existsSync(src)) fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    else {
      // Pre-generate ONLY the fixed sample's derivatives, outside measured runs.
      // Use the actual production generator; its output roots are isolated.
      assert(fs.existsSync(row.absolute_path));
      if(kind === 'thumbnail') await derivative.generateThumbnailDerivative(row.absolute_path, row.relative_path, false, { thumbnailPath: relative });
      else await derivative.generatePreviewDerivative(row.absolute_path, row.relative_path, false, { previewPath: relative });
      origin = 'sample-prepared-in-isolation';
    }
  } else origin = 'existing-isolated-cache';
  const after = path.join(evidence, 'after', dir, relative);
  fs.mkdirSync(path.dirname(after), { recursive: true });
  if (!fs.existsSync(after)) fs.copyFileSync(dest, after, fs.constants.COPYFILE_EXCL);
  const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.equal(hash(dest), hash(after));
  manifest.push({ kind, relative, imageId: row.id, bytes: fs.statSync(dest).size, sha256: hash(dest), origin });
}
write('cache-manifest.json', manifest);
console.log(JSON.stringify({ derivatives: manifest.length, sources: Object.fromEntries([...new Set(manifest.map(m => m.origin))].map(origin => [origin, manifest.filter(m => m.origin === origin).length])), samples }));
db.close();
