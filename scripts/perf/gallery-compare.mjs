// Validate paired output, cached bytes and fixed browser targets. Reports stay local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = fs.realpathSync(process.argv[2]);
assert(fs.existsSync(path.join(root, 'before/.isolated-gallery-perf')));
assert(fs.existsSync(path.join(root, 'after/.isolated-gallery-perf')));
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const before = read('before-measurements.json'), after = read('after-measurements.json');
assert.equal(before.node, after.node);
assert.equal(before.rows, after.rows);
const parity = [];
for (const name of ['ordinary', 'multi']) {
  const old = read(`before-${name}-page.json`), current = read(`after-${name}-page.json`);
  for (const key of ['page', 'limit', 'total', 'hasMore']) assert.deepEqual(current[key], old[key]);
  assert.equal(current.items.length, 24);
  assert.deepEqual(current.items.map(item => item.id), old.items.map(item => item.id));
  for (const [i, item] of current.items.entries()) {
    const { mediaItems, ...cover } = old.items[i];
    for (const key of Object.keys(cover)) assert.deepEqual(item[key], cover[key], `${name}[${i}].${key}`);
    assert.equal(item.representation, 'summary');
    assert(!Object.hasOwn(item, 'mediaItems'));
    assert.equal(item.itemCount, mediaItems.length);
    assert.equal(item.imageCount, mediaItems.filter(m => m.mediaType === 'image').length);
    assert.equal(item.videoCount, mediaItems.filter(m => m.mediaType === 'video').length);
  }
  const b = before.service.find(x => x.name === name), a = after.service.find(x => x.name === name);
  parity.push({ name, cards: 24, nestedMediaBefore: b.nestedMedia, nestedMediaAfter: a.nestedMedia,
    beforeBytes: b.rawJsonBytes, afterBytes: a.rawJsonBytes, reductionPercent: 100 * (1 - a.rawJsonBytes / b.rawJsonBytes) });
}
const cache = read('cache-manifest.json');
for (const item of cache) for (const label of ['before', 'after']) {
  const file = path.join(root, label, item.kind === 'thumbnail' ? 'thumbnails' : 'previews', item.relative);
  assert.equal(fs.statSync(file).size, item.bytes);
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), item.sha256);
}
const browser = ['before', 'after'].map(label => read(`${label}-browser.json`));
assert.deepEqual(browser[0].viewport, browser[1].viewport);
assert.equal(browser[0].browser, browser[1].browser);
assert.deepEqual(browser[0].conditions, browser[1].conditions);
for (const run of browser) assert.equal(run.failures.length, 0);
const summarize = values => {
  const sorted = values.toSorted((a,b) => a-b);
  return { median: sorted[Math.floor(sorted.length/2)], min: sorted[0], max: sorted.at(-1) };
};
const browserComparison = [];
for (const name of ['library','ordinary','multi','large','deep']) {
  const paired = browser.map(b => b.runs.filter(r => r.case === name && !r.warmup));
  assert.equal(paired[0].length, 5); assert.equal(paired[1].length, 5);
  const fixedTargets = paired[0][0].freshContext.targets.map(t => t.path);
  for (const side of paired) for (const run of side) {
    assert(!run.error);
    assert.deepEqual(run.freshContext.targets.map(t => t.path), fixedTargets);
    assert(run.freshContext.targets.every(t => t.loaded));
  }
  const value = { name };
  for (const phase of ['freshContext','sameSessionReturn']) {
    value[phase] = paired.map(side => ({ cardsMs: summarize(side.map(r => r[phase].cardsMs)), imagesMs: summarize(side.map(r => r[phase].imagesMs)),
      apiRequestCounts: side.map(r => r[phase].apiRequests.length), apiBytes: side.map(r => r[phase].apiBytes) }));
  }
  if (paired[0][0].sameSessionReturn.openedWork) value.openedWorkMs = paired.map(side => summarize(side.map(r => r.sameSessionReturn.openedWork.imagesMs)));
  browserComparison.push(value);
}
const result = { node: after.node, imageRows: after.rows, parity, verifiedCachedFiles: cache.length,
  browser: browserComparison, interactions: browser.map(b => b.interactions) };
fs.writeFileSync(path.join(root, 'comparison.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ imageRows: result.imageRows, parity, verifiedCachedFiles: cache.length,
  browserCases: browserComparison.length, failures: 0, report: path.join(root, 'comparison.json') }, null, 2));
