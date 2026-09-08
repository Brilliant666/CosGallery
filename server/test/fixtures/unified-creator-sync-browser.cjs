// Opt-in cross-repository E2E. Start unified-creator-sync-runtime.mjs first.
// All pages/cloud/archive payloads/history are synthetic; bridge calls use the actual isolated app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = fs.realpathSync.native(path.resolve(process.argv[2] || ''));
assert(path.dirname(root) === fs.realpathSync.native(os.tmpdir()) && path.basename(root).startsWith('cosgallery-unified-e2e-'));
const url = process.argv[3];
assert(/^http:\/\/127\.0\.0\.1:4[4-8][0-9]{2}$/.test(url));
const phase = process.argv[4] || 'cycle';
const db = new DatabaseSync(path.join(root, 'db/gallery.sqlite'), { readOnly: true });
db.exec('PRAGMA query_only=ON');
const ids = JSON.parse(fs.readFileSync(path.join(root, 'fixture-ids.json'), 'utf8'));
const firstId = ids.first.id;
const query = sql => db.prepare(sql).all();
const normalized = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const downloadScope = `source_work_id IN (SELECT s.id FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id WHERE w.creator_id=${firstId})`;
const tasks = () => query(`SELECT * FROM archive_catalog_download_tasks WHERE ${downloadScope} ORDER BY id`);
const jobs = () => query(`SELECT * FROM local_ingest_jobs WHERE creator_id=${firstId} ORDER BY id`);
const locals = () => query(`SELECT l.* FROM archive_catalog_local_works l JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id WHERE f.creator_id=${firstId} AND l.is_active=1 ORDER BY l.id`);
function protectedRows() {
  const result = {};
  for (const [table, clause] of [
    ['archive_catalog_creators', `id<>${firstId}`],
    ['archive_catalog_local_creator_folders', `creator_id<>${firstId}`],
    ['archive_catalog_local_works', `local_creator_folder_id IN (SELECT id FROM archive_catalog_local_creator_folders WHERE creator_id<>${firstId})`],
    ['archive_catalog_works', `creator_id<>${firstId}`],
    ['archive_catalog_source_works', `work_id IN (SELECT id FROM archive_catalog_works WHERE creator_id<>${firstId})`],
    ['archive_catalog_metadata_tasks', `creator_id<>${firstId}`],
    ['archive_catalog_download_tasks', `NOT (${downloadScope})`],
    ['local_ingest_jobs', `creator_id<>${firstId}`]
  ]) result[table] = hash(query(`SELECT * FROM ${table} WHERE ${clause} ORDER BY id`));
  return result;
}
function businessSnapshot() {
  return Object.fromEntries(['local_ingest_jobs', 'archive_catalog_download_tasks', 'archive_catalog_source_works',
    'archive_catalog_local_works', 'archive_catalog_local_creator_folders', 'posts', 'post_items', 'scan_runs']
    .map(table => [table, query(`SELECT * FROM ${table} ORDER BY 1`)]));
}
async function api(route, body, method = 'POST') {
  const response = await fetch(url + '/api' + route, body === undefined ? {} : {
    method, headers: { 'content-type': 'application/json', 'x-foldergram-intent': '1' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  assert(response.ok, JSON.stringify({ route, status: response.status, data }));
  return data;
}
async function downloadAndIngest(selectedWorks) {
  const sharp = require('sharp');
  const sevenZip = process.env.ROSTER_E2E_7ZIP;
  assert(sevenZip && path.isAbsolute(sevenZip) && fs.existsSync(sevenZip));
  for (const work of selectedWorks) {
    assert(/^\d{3}\.7z$/.test(work.filename));
    const number = work.filename.replace('.7z', '');
    const pack = path.join(root, 'archive-fixture', number);
    const name = `${ids.first.name} NO.${number} ${work.title} [${work.images}P-1MB]`;
    const payload = path.join(pack, 'inner', name);
    const outer = path.join(pack, 'outer');
    fs.mkdirSync(payload, { recursive: true }); fs.mkdirSync(outer, { recursive: true });
    for (let index = 0; index < work.images; index++) {
      await sharp({ create: { width: 20, height: 30, channels: 3, background: '#bc8f8f' } }).jpeg()
        .toFile(path.join(payload, `${index + 1}.jpg`));
    }
    const archiveRoot = path.join(root, 'inbox', ids.first.name);
    fs.mkdirSync(archiveRoot, { recursive: true });
    for (const [cwd, destination] of [[path.join(pack, 'inner'), path.join(outer, 'payload.7zz')], [outer, path.join(archiveRoot, work.filename)]]) {
      assert(!fs.existsSync(destination), 'Fixture must not overwrite an existing archive');
      const result = spawnSync(sevenZip, ['a', '-t7z', '-pfixture-password-not-a-real-secret', '-mhe=on', destination, '.'], { cwd, windowsHide: true, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  }
  await api('/admin/local-ingest/scan', {});
  for (const work of selectedWorks) {
    const matches = jobs().filter(job => job.source_archive_name === work.filename);
    assert.equal(matches.length, 1);
    const job = matches[0];
    assert.equal(job.attempt_count, 0, 'Already run jobs must never be executed again');
    await api(`/admin/local-ingest/jobs/${job.id}/run`, {});
    const after = jobs().find(value => value.id === job.id);
    assert.deepEqual([after.status, after.phase, after.validation_status, after.cleanup_status, after.attempt_count], ['ingested', 'done', 'passed', 'recycled', 1], JSON.stringify(after));
    assert(!fs.existsSync(path.join(root, 'inbox', ids.first.name, work.filename)));
    assert(fs.existsSync(after.target_path));
  }
  assert(locals().every(local => local.work_id && local.match_status === 'matched'));
}
async function cycle() {
  await api('/health');
  assert.equal(query('SELECT COUNT(*) n FROM local_ingest_jobs')[0].n, 588);
  const protectedBefore = protectedRows();
  const works = [{ filename: '001.7z', title: '晴空', images: 1 }, { filename: '002.7z', title: '星夜', images: 1 }, { filename: '003.7z', title: '秋色', images: 1 }];
  const { chromium } = require(process.env.ROSTER_E2E_PLAYWRIGHT);
  const { createFixtureRunner } = require(process.env.ROSTER_E2E_PLUGIN_FIXTURE);
  const token = (await api('/admin/archive-catalog/bridge-token', {})).token;
  const runner = await createFixtureRunner({ chromium, bridgeUrl: url, token,
    fetch: (requestUrl, options) => { assert.equal(new URL(requestUrl).origin, url); return fetch(requestUrl, options); },
    inboxRoot: path.join(root, 'inbox'), creatorName: ids.first.name, works });
  const summaries = [];
  try {
    async function check(requestId) {
      const beforeScans = query('SELECT * FROM scan_runs ORDER BY id');
      const plan = await api('/admin/archive-catalog/metadata-tasks/plan-selected', { creatorIds: [firstId], requestId });
      assert.equal(plan.taskIds.length, 1);
      const rounds = plan.items.filter(item => item.task?.checkRoundId).map(item => ({ taskId: item.task.id, checkRoundId: item.task.checkRoundId }));
      assert.equal(rounds.length, 1);
      const replay = await api('/admin/archive-catalog/metadata-tasks/plan-selected', { creatorIds: [firstId], requestId });
      assert.equal(replay.replayed, true);
      assert.equal(replay.items[0].task.checkRoundId, rounds[0].checkRoundId);
      await runner.stage1(plan.taskIds, rounds);
      assert.equal(query(`SELECT status FROM archive_catalog_metadata_tasks WHERE creator_id=${firstId}`)[0].status, 'completed');
      assert.deepEqual(query('SELECT * FROM scan_runs ORDER BY id'), beforeScans, 'A source check must not scan the gallery');
      assert.deepEqual(protectedRows(), protectedBefore);
      const metadata = query(`SELECT * FROM archive_catalog_metadata_tasks WHERE creator_id=${firstId}`);
      const unchanged = await api('/admin/archive-catalog/metadata-tasks/plan-selected', { creatorIds: [firstId], requestId });
      assert.equal(unchanged.replayed, true); assert.deepEqual(unchanged.taskIds, []);
      assert.deepEqual(query(`SELECT * FROM archive_catalog_metadata_tasks WHERE creator_id=${firstId}`), metadata);
      return plan;
    }
    assert(!fs.existsSync(path.join(root, 'gallery', ids.first.name)));
    const initial = await check('fixture-initial-three');
    assert.deepEqual(runner.evidence.sourceSaves.map(names => [...names].sort()), [['001.7z', '002.7z', '003.7z']]);
    assert.equal(tasks().length, 3); assert(tasks().every(task => task.status === 'pending'));
    assert(!fs.existsSync(path.join(root, 'gallery', ids.first.name)), 'Planning must not create a creator directory');
    await runner.stage2({ seedTaskId: tasks()[0].id, singleBatch: true });
    assert(tasks().every(task => task.status === 'staged'));
    await downloadAndIngest(works);
    assert.equal(locals().length, 3); assert(tasks().every(task => task.status === 'ingested'));
    const firstJobs = jobs(); const firstTasks = tasks();
    const firstLocalIdentities = locals().map(({ id, work_id, local_path, match_status }) => ({ id, work_id, local_path, match_status }));
    const copiedBefore = runner.evidence.copied.length;
    summaries.push({ phase: 'first-three', localWorks: 3, jobs: firstJobs.map(job => job.id), round: initial.items[0].task.checkRoundId });

    // Simulate a cloud archive removed after its work was ingested locally.
    // A refresh must not replenish that historical package just to rebuild a full cloud mirror.
    runner.cloud.sourceFiles.delete('001.7z');
    works.push({ filename: '004.7z', title: '冬日', images: 1 });
    const incremental = await check('fixture-add-fourth');
    assert.deepEqual(runner.evidence.sourceSaves.map(names => [...names].sort()), [['001.7z', '002.7z', '003.7z'], ['004.7z']]);
    assert.equal(runner.cloud.sourceFiles.has('001.7z'),false,'Already ingested historical cloud package must not be resaved');
    assert.notEqual(incremental.items[0].task.checkRoundId, initial.items[0].task.checkRoundId);
    assert.deepEqual(jobs(), firstJobs);
    assert.deepEqual(tasks().slice(0, 3), firstTasks, 'Already ingested Stage2 tasks must not be rewritten or downgraded');
    const pending = tasks().filter(task => task.status === 'pending');
    assert.equal(tasks().length, 4); assert.deepEqual(pending.map(task => task.target_filename), ['004.7z']);
    await runner.stage2({ seedTaskId: pending[0].id, singleBatch: true });
    assert.deepEqual(runner.evidence.copied.slice(copiedBefore), [['004.7z']]);
    await downloadAndIngest([works[3]]);
    assert.equal(locals().length, 4); assert.equal(jobs().length, 4);
    assert.deepEqual(jobs().slice(0, 3), firstJobs);
    assert.deepEqual(locals().slice(0, 3).map(({ id, work_id, local_path, match_status }) => ({ id, work_id, local_path, match_status })), firstLocalIdentities);
    assert(tasks().every(task => task.status === 'ingested'));
    summaries.push({ phase: 'incremental-fourth', newTaskFilename: '004.7z', localWorks: 4, round: incremental.items[0].task.checkRoundId });

    const beforeNoChangeJobs = jobs(); const beforeNoChangeTasks = tasks();
    const beforeNoChangeCopied = normalized(runner.evidence.copied);
    const beforeNoChangeSourceSaves = normalized(runner.evidence.sourceSaves);
    const beforeNoChangeCollectionReads = runner.evidence.collectionReads;
    const beforeNoChangeSourceReads = runner.evidence.sourceReads;
    await check('fixture-unchanged-four');
    assert.deepEqual(tasks(), beforeNoChangeTasks); assert.deepEqual(jobs(), beforeNoChangeJobs);
    assert.deepEqual(runner.evidence.copied, beforeNoChangeCopied);
    assert.deepEqual(runner.evidence.sourceSaves, beforeNoChangeSourceSaves);
    assert(runner.evidence.collectionReads > beforeNoChangeCollectionReads, 'Unchanged check must really reread Costuan');
    assert(runner.evidence.sourceReads > beforeNoChangeSourceReads, 'Unchanged check must really re-enumerate own cloud files');
    assert.equal(locals().length, 4);
    await api('/admin/local-ingest/scan', {});
    assert.deepEqual(jobs(), beforeNoChangeJobs, 'Discovery after cleanup must not recreate or rerun any Job');
    assert.deepEqual(protectedRows(), protectedBefore);
    assert.equal(query('SELECT COUNT(*) n FROM local_ingest_jobs')[0].n, 592);
    assert.equal(fs.readdirSync(path.join(root, 'simulated-recycle')).length, 8);
    assert.deepEqual(runner.evidence.errors, []); assert.deepEqual(runner.evidence.externalRequests, []);
    assert.equal(query('PRAGMA quick_check')[0].quick_check, 'ok'); assert.deepEqual(query('PRAGMA foreign_key_check'), []);
    write('unified-restart-before.json', businessSnapshot());
    write('unified-protected-before.json', protectedBefore);
    const evidence = { syntheticOnly: true, summaries, noChange: { missingTasks: 0, duplicateJobs: 0 },
      protectedBefore, protectedAfter: protectedRows(), syntheticHistoricalJobsUnchanged: 588,
      plugin: runner.evidence, stage3Jobs: jobs(), simulatedRecycleEntries: 8, realRecycleBinCalls: 0 };
    write('unified-evidence.json', evidence);
    console.log(JSON.stringify(evidence));
  } finally { await runner.close(); }
}
async function restart() {
  await api('/health');
  assert.deepEqual(normalized(businessSnapshot()), read('unified-restart-before.json'));
  assert.deepEqual(protectedRows(), read('unified-protected-before.json'));
  assert.equal(locals().length, 4); assert.equal(jobs().length, 4);
  const result = { syntheticOnly: true, restart: 'pass', unchangedHistoricalJobs: 588, unchangedAllJobs: 592, newStartupScans: 0 };
  write('unified-restart-evidence.json', result); console.log(JSON.stringify(result));
}
({ cycle, restart }[phase] ?? (() => { throw Error('Unknown phase'); }))().finally(() => db.close()).catch(error => { console.error(error); process.exitCode = 1; });
