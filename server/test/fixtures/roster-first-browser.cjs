// Opt-in cross-repository browser E2E. Dependencies are supplied explicitly;
// no browser installation, production fallback, or credentials are inherited.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = fs.realpathSync.native(path.resolve(process.argv[2] || ''));
assert(root.startsWith(path.join(fs.realpathSync.native(os.tmpdir()), 'cosgallery-roster-e2e-')));
const url = process.argv[3];
assert(/^http:\/\/127\.0\.0\.1:4[4-8][0-9]{2}$/.test(url));
const phase = process.argv[4] || 'select';
const stateFile = path.join(root, 'browser-state.json');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2));
const db = new DatabaseSync(path.join(root, 'db/gallery.sqlite'), { readOnly: true });
db.exec('PRAGMA query_only=ON');
const ids = json(path.join(root, 'fixture-ids.json'));
const firstId = ids.first.id;
const downloadScope = `source_work_id IN (SELECT s.id FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id WHERE w.creator_id=${firstId})`;
const query = sql => db.prepare(sql).all();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function otherSnapshot() {
  const result = {};
  for (const [table, clause] of [
    ['archive_catalog_creators', `id<>${firstId}`],
    ['archive_catalog_local_creator_folders', `creator_id<>${firstId}`],
    ['archive_catalog_local_works', `local_creator_folder_id IN (SELECT id FROM archive_catalog_local_creator_folders WHERE creator_id<>${firstId})`],
    ['archive_catalog_works', `creator_id<>${firstId}`],
    ['archive_catalog_source_works', `work_id IN (SELECT id FROM archive_catalog_works WHERE creator_id<>${firstId})`],
    ['archive_catalog_metadata_tasks', `creator_id<>${firstId}`],
    ['archive_catalog_download_tasks', `NOT (${downloadScope})`]
  ]) result[table] = hash(query(`SELECT * FROM ${table} WHERE ${clause} ORDER BY id`));
  return result;
}
async function api(route, body, method = 'POST') {
  const response = await fetch(url + '/api' + route, body === undefined ? {} : {
    method, headers: { 'content-type': 'application/json', 'x-foldergram-intent': '1' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  assert(response.ok, JSON.stringify({ route, status: response.status, data }));
  return data;
}
async function select() {
  const { chromium } = require(process.env.ROSTER_E2E_PLAYWRIGHT);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.goto(url + '/archive-catalog', { waitUntil: 'networkidle' });
    await page.locator('[data-test=open-first-collection]').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: `选择 #${firstId} ${ids.first.name}`, exact: true }).check();
    await page.screenshot({ path: path.join(root, 'selection.png'), fullPage: true });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(query(`SELECT * FROM archive_catalog_metadata_tasks WHERE creator_id=${firstId}`).length, 0);
    // Keep one unrelated pending task to prove the plugin does not consume all.
    await api('/admin/archive-catalog/metadata-tasks/plan-selected', { creatorIds: [ids.outsider.id] });
    write('other-before.json', otherSnapshot());
    await page.locator('[data-test=open-first-collection]').first().click();
    await dialog.getByRole('checkbox', { name: `选择 #${firstId} ${ids.first.name}`, exact: true }).check();
    await dialog.locator('[data-test=submit-first-collection]').click();
    await dialog.locator('[data-test=stage1-handoff]').waitFor();
    const scope = JSON.parse(await dialog.locator('[data-test=stage1-handoff]').inputValue());
    assert.deepEqual(scope.creatorIds, [firstId]);
    assert.equal(scope.taskIds.length, 1);
    const tokenResponse = await api('/admin/archive-catalog/bridge-token', {});
    write('browser-state.json', { scope, token: tokenResponse.token });
    assert.equal(fs.existsSync(path.join(root, 'gallery', ids.first.name)), false);
    await page.screenshot({ path: path.join(root, 'handoff.png'), fullPage: true });
    console.log(JSON.stringify({ phase, scope, cancelledCreates: 0, emptyCreatorDirectory: false }));
  } finally { await browser.close(); }
}
async function plugin() {
  const { chromium } = require(process.env.ROSTER_E2E_PLAYWRIGHT);
  const { createFixtureRunner } = require(process.env.ROSTER_E2E_PLUGIN_FIXTURE);
  const state = json(stateFile);
  let lostReceipt = false;
  const receiptBodies = [];
  const bridgeFetch = async (requestUrl, options = {}) => {
    assert.equal(new URL(requestUrl).origin, url);
    const body = options.body ? JSON.parse(options.body) : null;
    const response = await fetch(requestUrl, options);
    if (options.method === 'PATCH' && body?.status === 'completed') {
      receiptBodies.push(body);
      if (!lostReceipt && phase !== 'staging') {
        assert(response.ok, await response.text());
        lostReceipt = true;
        throw new Error('Synthetic lost response after server committed receipt');
      }
    }
    return response;
  };
  const runner = await createFixtureRunner({ chromium, bridgeUrl: url, token: state.token,
    fetch: bridgeFetch, inboxRoot: path.join(root, 'inbox'), creatorName: ids.first.name,
    works: [{ filename: '001.7z', title: '晴空', images: 1 }, { filename: '002.7z', title: '星夜', images: 1 }] });
  try {
    if (phase === 'staging') {
      await runner.harness.seed(json(path.join(root, 'fixture-extension-state.json')));
    } else {
      await assert.rejects(runner.stage1(state.scope.taskIds), /回传|回写|已完成百度转存/);
      assert.equal(lostReceipt, true);
      assert.equal(runner.evidence.saveClicks, 1);
      await runner.harness.dispatch({ type: 'cam:bridge-sync' });
      const resume = await runner.harness.dispatch({ type: 'cam:resume' });
      assert(resume.ok, resume.error);
      await runner.waitFor(value => value.metadataQueue.status === 'completed');
      assert.equal(runner.evidence.saveClicks, 1);
      assert.equal(receiptBodies.length, 2);
      assert.deepEqual(receiptBodies[0], receiptBodies[1]);
    }
    assert.equal(query(`SELECT * FROM archive_catalog_metadata_tasks WHERE creator_id=${firstId} AND status='completed'`).length, 1);
    assert.equal(query(`SELECT * FROM archive_catalog_download_tasks WHERE ${downloadScope}`).length, 2);
    assert.deepEqual(otherSnapshot(), json(path.join(root, 'other-before.json')));
    write('plugin-stage1.json', runner.evidence);
    if (phase === 'source') {
      write('fixture-extension-state.json', runner.harness.state);
      console.log(JSON.stringify({ phase, evidence: runner.evidence }));
      return;
    }
    const seedTaskId = query(`SELECT id FROM archive_catalog_download_tasks WHERE ${downloadScope} ORDER BY id`)[0].id;
    await runner.stage2({ seedTaskId, singleBatch: true });
    assert.equal(query(`SELECT * FROM archive_catalog_download_tasks WHERE ${downloadScope} AND status='staged'`).length, 2);
    assert.deepEqual(otherSnapshot(), json(path.join(root, 'other-before.json')));
    write('plugin-evidence.json', runner.evidence);
    assert.deepEqual(runner.evidence.errors, []);
    assert.deepEqual(runner.evidence.externalRequests, []);
    console.log(JSON.stringify({ phase, evidence: runner.evidence }));
  } finally { await runner.close(); }
}
async function ingest() {
  const sharp = require('sharp');
  const workName = `${ids.first.name} NO.001 晴空 [1P-1MB]`;
  const pack = path.join(root, 'archive-fixture');
  const payload = path.join(pack, 'inner', workName);
  const outer = path.join(pack, 'outer');
  fs.mkdirSync(payload, { recursive: true }); fs.mkdirSync(outer, { recursive: true });
  await sharp({ create: { width: 20, height: 30, channels: 3, background: '#bc8f8f' } }).jpeg().toFile(path.join(payload, '01.jpg'));
  fs.writeFileSync(path.join(payload, 'fixture-ad.txt'), 'synthetic advertisement');
  const archiveRoot = path.join(root, 'inbox', ids.first.name);
  fs.mkdirSync(archiveRoot, { recursive: true });
  const sevenZip = process.env.ROSTER_E2E_7ZIP;
  assert(sevenZip && fs.existsSync(sevenZip));
  function packArchive(cwd, destination) {
    const result = spawnSync(sevenZip, ['a', '-t7z', '-pfixture-password-not-a-real-secret', '-mhe=on', destination, '.'], { cwd, windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  packArchive(path.join(pack, 'inner'), path.join(outer, 'payload.7zz'));
  packArchive(outer, path.join(archiveRoot, '001.7z'));
  const scan = await api('/admin/local-ingest/scan', {});
  const jobs = query(`SELECT * FROM local_ingest_jobs WHERE creator_id=${firstId}`);
  assert.equal(jobs.length, 1);
  const jobId = jobs[0].id;
  const run = await api(`/admin/local-ingest/jobs/${jobId}/run`, {});
  const job = db.prepare('SELECT * FROM local_ingest_jobs WHERE id=?').get(jobId);
  assert.equal(job.status, 'ingested', JSON.stringify(run));
  assert.equal(job.phase, 'done'); assert.equal(job.validation_status, 'passed');
  assert.equal(job.cleanup_status, 'recycled'); assert.equal(job.attempt_count, 1);
  assert.deepEqual(otherSnapshot(), json(path.join(root, 'other-before.json')));
  const local = query(`SELECT l.* FROM archive_catalog_local_works l JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id WHERE f.creator_id=${firstId} AND l.is_active=1`);
  assert.equal(local.length, 1); assert(local[0].work_id); assert.equal(local[0].match_status, 'matched');
  const taskStates = query(`SELECT target_filename,status FROM archive_catalog_download_tasks WHERE ${downloadScope} ORDER BY id`);
  assert.deepEqual(taskStates.map(x => x.status), ['ingested', 'staged']);
  assert(!fs.existsSync(path.join(archiveRoot, '001.7z')));
  assert.equal(fs.readdirSync(path.join(root, 'simulated-recycle')).length, 2);
  const before = JSON.stringify(job);
  await api('/admin/local-ingest/scan', {});
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM local_ingest_jobs WHERE id=?').get(jobId)), before);
  const repeated = await api('/admin/archive-catalog/metadata-tasks/plan-selected', { creatorIds: [firstId] });
  assert.equal(repeated.items[0].result, 'source_ready');
  const gallery = await api(`/cos-gallery/creators/${firstId}`);
  write('ingest-evidence.json', { scan, job, local, taskStates, gallery });
  write('restart-before.json', { jobs: query('SELECT * FROM local_ingest_jobs ORDER BY id'), tasks: query('SELECT * FROM archive_catalog_download_tasks ORDER BY id'), sources: query('SELECT * FROM archive_catalog_source_works ORDER BY id'), bridges: query('SELECT * FROM archive_catalog_local_creator_folders ORDER BY id'), scans: query('SELECT * FROM scan_runs ORDER BY id') });
  console.log(JSON.stringify({ phase, jobId, status: job.status, taskStates, gallery, otherCreatorsUnchanged: true }));
}
async function restart() {
  await api('/health');
  const after = { jobs: query('SELECT * FROM local_ingest_jobs ORDER BY id'), tasks: query('SELECT * FROM archive_catalog_download_tasks ORDER BY id'), sources: query('SELECT * FROM archive_catalog_source_works ORDER BY id'), bridges: query('SELECT * FROM archive_catalog_local_creator_folders ORDER BY id'), scans: query('SELECT * FROM scan_runs ORDER BY id') };
  assert.deepEqual(JSON.parse(JSON.stringify(after)), json(path.join(root, 'restart-before.json')));
  const { chromium } = require(process.env.ROSTER_E2E_PLAYWRIGHT);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${url}/library/${firstId}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(root, 'gallery.png'), fullPage: true });
    const workLink = page.locator(`a[href^="/library/${firstId}/works/"]`).first();
    await workLink.click();
    await page.waitForURL(`**/library/${firstId}/works/*`);
    await page.locator('.work-media-card').first().waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('.work-media-card__image');
      return image && image.complete && image.naturalWidth > 0;
    });
    assert.equal(await page.locator('.work-media-card').count(), 1);
    await page.screenshot({ path: path.join(root, 'work.png'), fullPage: true });
    assert.deepEqual(otherSnapshot(), json(path.join(root, 'other-before.json')));
    console.log(JSON.stringify({ phase, persisted: true, noStartupQueueOrScan: true, workRoute: page.url() }));
  } finally { await browser.close(); }
}
({ select, plugin, source: plugin, staging: plugin, ingest, restart }[phase] ?? (() => { throw Error('Unknown phase'); }))().finally(() => db.close()).catch(error => { console.error(error); process.exitCode = 1; });
