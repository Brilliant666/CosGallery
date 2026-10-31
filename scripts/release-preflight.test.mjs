import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createManifest } from './release-tools.mjs'
import { deploymentStages, prepareDeployment, requiredChecks } from './release-preflight.mjs'

const cli = fileURLToPath(new URL('./release-tools.mjs', import.meta.url))
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cosgallery-preflight-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.match(path.basename(root), /^cosgallery-preflight-[^\\/]+$/)
    rmSync(root, { recursive: true, force: true })
  })
  const sourceRoot = path.join(root, '合成 source')
  mkdirSync(sourceRoot)
  const git = (...args) => {
    const result = spawnSync('git', ['-c', `safe.directory=${sourceRoot.replaceAll('\\', '/')}`, '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-C', sourceRoot, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '--quiet')
  for (const file of ['package.json', 'server/package.json', 'client/package.json', 'pnpm-lock.yaml', 'server/db/migrations/000001.sql', 'client/src/app.ts']) {
    mkdirSync(path.dirname(path.join(sourceRoot, file)), { recursive: true })
    writeFileSync(path.join(sourceRoot, file), 'synthetic')
  }
  const commit = () => { git('add', '--all'); git('commit', '--quiet', '-m', 'Synthetic fixture'); return git('rev-parse', 'HEAD') }
  const candidateSha = commit()
  const build = { product: 'CosGallery', version: '1.2.3', commit: candidateSha, tree: git('rev-parse', 'HEAD^{tree}'), dirty: false }
  const serverDist = path.join(root, 'server dist'), clientDist = path.join(root, 'client dist')
  for (const dir of [serverDist, clientDist]) { mkdirSync(dir); writeJson(path.join(dir, 'build-info.json'), build); writeFileSync(path.join(dir, 'app.js'), 'synthetic artifact') }
  const manifest = path.join(root, 'manifest.json')
  writeJson(manifest, createManifest({ serverDist, clientDist, declaredSourceSha: candidateSha }))
  const records = { dependencies: path.join(root, 'dependencies.json'), recovery: path.join(root, 'recovery.json') }
  for (const file of Object.values(records)) writeJson(file, { synthetic: true, note: 'No production state' })
  const command = { argv: [process.execPath, '--version'], inputs: [], cwd: sourceRoot, expected: 'Synthetic successful exit; this is never executed by prepare' }
  const profile = { schema: 'cosgallery-deployment-profile/v1', sourceRoot, candidateSha, baselineSha: candidateSha, manifest, serverDist, clientDist, records, runtime: { node: '24.21.0', pnpm: '10.28.0', platform: 'win32', arch: 'x64' }, regression: [structuredClone(command)], steps: deploymentStages.map(stage => ({ ...command, stage })), acceptance: { auth: 'enabled', checks: [{ method: 'GET', path: '/api/health', access: 'public', expectedStatus: 200 }, { method: 'GET', path: '/build-info.json', access: 'public', expectedStatus: 200 }, { method: 'GET', path: '/api/admin/status', access: 'admin', expectedStatus: 401 }] } }
  const evidenceFile = path.join(root, 'evidence.json'), profileFile = path.join(root, 'profile.json')
  function evidence() {
    const plan = prepareDeployment({ profile, requireEvidence: false })
    assert.equal(plan.ok, true, JSON.stringify(plan.issues))
    const value = structuredClone(plan.evidenceTemplate)
    for (const [scope, receipt] of Object.entries(value.receipts)) Object.assign(receipt, { status: 'passed', checkedAt: '2026-10-31T01:00:00.000Z', checkedBy: 'synthetic reviewer', reference: `fixture://${scope}/result`, coverage: scope === 'recovery' ? receipt.coverage : ['synthetic scoped checks'] })
    value.receipts.ci.checks = requiredChecks.map(name => ({ name, conclusion: 'success' }))
    Object.assign(value.receipts.compatibility, { persistence: 'none', rationale: 'Synthetic unchanged persistence' })
    writeJson(evidenceFile, value)
    return value
  }
  const prepare = () => prepareDeployment({ profile, evidenceFile })
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true })
  return { root, profile, git, commit, evidence, evidenceFile, profileFile, prepare, invoke }
}

test('offline preparation reuses six bound receipts and accounts for anonymous admin 401', t => {
  const f = fixture(t)
  f.evidence()
  const first = f.prepare(), second = f.prepare()
  assert.equal(first.offlineReady, true)
  assert.equal(first.planDigest, second.planDigest)
  assert.deepEqual(Object.values(first.evidenceStatus), Array(6).fill('reusable'))
  assert.equal(first.requiresFreshChecks.length, 3)
  assert.equal(first.context.candidate.sha, f.profile.candidateSha)
})

test('one call reports independent missing inputs and returns no usable plan', t => {
  const f = fixture(t)
  delete f.profile.records
  delete f.profile.regression
  f.profile.steps = []
  f.profile.acceptance.checks[0].expectedStatus = 401
  const result = f.prepare()
  assert.equal(result.ok, false)
  assert.equal(result.offlineReady, false)
  for (const field of ['records.dependencies', 'records.recovery', 'regression', 'steps', 'acceptance.checks.0.expectedStatus', 'evidence']) assert.ok(result.issues.some(issue => issue.field === field), field)
  assert.equal(result.planDigest, null)
})

test('modified dependencies receipt invalidates only dependent evidence; runtime and recovery changes bind independently', t => {
  const f = fixture(t)
  f.evidence()
  writeJson(f.profile.records.dependencies, { changed: true })
  let result = f.prepare()
  assert.equal(result.evidenceStatus.dependencies, 'missing-or-stale')
  assert.equal(result.evidenceStatus.regression, 'missing-or-stale')
  assert.equal(result.evidenceStatus.review, 'reusable')
  assert.equal(result.evidenceStatus.ci, 'reusable')
  assert.equal(result.evidenceStatus.recovery, 'reusable')
  f.evidence()
  writeJson(f.profile.records.recovery, { changed: true })
  result = f.prepare()
  assert.equal(result.evidenceStatus.recovery, 'missing-or-stale')
  assert.equal(result.evidenceStatus.regression, 'reusable')
  f.evidence()
  f.profile.runtime.node = '24.22.0'
  result = f.prepare()
  for (const scope of ['regression', 'dependencies', 'recovery', 'compatibility']) assert.equal(result.evidenceStatus[scope], 'missing-or-stale')
  assert.equal(result.evidenceStatus.ci, 'reusable')
})

test('doc-only candidate permits old clean artifacts but cannot reuse old Head CI or review', t => {
  const f = fixture(t)
  f.evidence()
  writeFileSync(path.join(f.profile.sourceRoot, 'README.md'), 'new documentation')
  f.profile.candidateSha = f.commit()
  const manifest = JSON.parse(readFileSync(f.profile.manifest, 'utf8'))
  manifest.declaredSourceSha = f.profile.candidateSha
  writeJson(f.profile.manifest, manifest)
  const result = f.prepare()
  assert.equal(result.evidenceStatus.ci, 'missing-or-stale')
  assert.equal(result.evidenceStatus.review, 'missing-or-stale')
  assert.equal(result.evidenceStatus.regression, 'reusable')
  assert.equal(result.evidenceStatus.dependencies, 'reusable')
  assert.equal(result.evidenceStatus.recovery, 'reusable')
  const evidence = f.evidence()
  evidence.receipts.ci.head = f.profile.baselineSha
  writeJson(f.evidenceFile, evidence)
  assert.match(f.prepare().issues.find(issue => issue.field === 'evidence.ci').message, /exact candidate/)
})

test('baseline changes invalidate review, compatibility and recovery without claiming a fresh runtime observation', t => {
  const f = fixture(t)
  f.evidence()
  writeFileSync(path.join(f.profile.sourceRoot, 'README.md'), 'baseline docs')
  f.profile.baselineSha = f.commit()
  const result = f.prepare()
  for (const scope of ['review', 'compatibility', 'recovery']) assert.equal(result.evidenceStatus[scope], 'missing-or-stale')
  assert.equal(result.evidenceStatus.ci, 'reusable')
  assert.equal(result.evidenceStatus.regression, 'reusable')
})

test('lockfile or migration changes cannot reuse old artifacts even with unchanged version text', t => {
  const f = fixture(t)
  for (const file of ['pnpm-lock.yaml', 'server/db/migrations/000001.sql']) {
    writeFileSync(path.join(f.profile.sourceRoot, file), `changed ${file}`)
    f.profile.candidateSha = f.commit()
    const manifest = JSON.parse(readFileSync(f.profile.manifest, 'utf8'))
    manifest.declaredSourceSha = f.profile.candidateSha
    writeJson(f.profile.manifest, manifest)
    const result = prepareDeployment({ profile: f.profile, requireEvidence: false })
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(issue => issue.field === 'buildEquivalence'))
  }
})

test('tampered, dirty and extra artifacts fail before evidence reuse', t => {
  const f = fixture(t)
  f.evidence()
  writeFileSync(path.join(f.profile.serverDist, 'app.js'), 'tampered')
  writeFileSync(path.join(f.profile.clientDist, 'extra'), 'extra')
  let result = f.prepare()
  assert.equal(result.offlineReady, false)
  assert.ok(result.issues.some(issue => issue.field === 'artifacts' && /changed.*extra/.test(issue.message)))
  const buildFile = path.join(f.profile.serverDist, 'build-info.json')
  const build = JSON.parse(readFileSync(buildFile, 'utf8')); build.dirty = true; writeJson(buildFile, build)
  result = f.prepare()
  assert.ok(result.issues.some(issue => issue.field === 'artifacts' && /clean/.test(issue.message)))
})

test('passed flag alone, wrong CI checks and missing recovery scope cannot authorize readiness', t => {
  const f = fixture(t)
  const evidence = f.evidence()
  evidence.receipts.review.reference = ''
  evidence.receipts.ci.checks.pop()
  evidence.receipts.recovery.coverage = ['code']
  writeJson(f.evidenceFile, evidence)
  const result = f.prepare()
  assert.deepEqual(result.issues.map(issue => issue.field).sort(), ['evidence.ci', 'evidence.recovery', 'evidence.review'])
})

test('CLI accepts BOM, produces JSON aggregated failure and never executes profile commands', t => {
  const f = fixture(t)
  f.profile.regression[0].argv = [process.execPath, '-e', 'throw new Error("MUST NOT EXECUTE")']
  f.evidence()
  writeFileSync(f.profileFile, '\uFEFF' + JSON.stringify(f.profile))
  let result = f.invoke(['plan', '--profile', f.profileFile])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).offlineReady, false)
  result = f.invoke(['prepare', '--profile', f.profileFile, '--evidence', f.evidenceFile])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).offlineReady, true)
  f.profile.records.dependencies = path.join(f.root, '..', 'outside')
  delete f.profile.regression
  writeJson(f.profileFile, f.profile)
  result = f.invoke(['prepare', '--profile', f.profileFile, '--evidence', f.evidenceFile])
  assert.equal(result.status, 1, result.stderr)
  assert.ok(JSON.parse(result.stdout).issues.length >= 2)
  assert.equal(f.invoke(['plan', '--profile', f.profileFile, '--apply']).status, 1)
})

test('timing CLI refuses a different plan or a non-ready plan', t => {
  const f = fixture(t)
  f.evidence()
  const planFile = path.join(f.root, 'prepared.json'), logFile = path.join(f.root, 'timing.json')
  const plan = f.prepare()
  writeJson(planFile, plan)
  writeJson(logFile, { schema: 'cosgallery-deployment-timing/v1', planDigest: 'a'.repeat(64), runId: 'synthetic', stages: [] })
  let result = f.invoke(['timing', '--plan', planFile, '--log', logFile])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /match a successful/)
  writeJson(logFile, { schema: 'cosgallery-deployment-timing/v1', planDigest: plan.planDigest, runId: 'synthetic', stages: [] })
  result = f.invoke(['timing', '--plan', planFile, '--log', logFile])
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).status, 'incomplete')
})

test('null manifest and incomplete commands stay inside aggregated diagnostics', t => {
  const f = fixture(t)
  writeJson(f.profile.manifest, null)
  f.profile.steps[0] = { stage: 'read-check' }
  const result = f.prepare()
  for (const field of ['manifest', 'steps.read-check.argv', 'steps.read-check.cwd', 'steps.read-check.expected', 'steps.read-check.inputs']) assert.ok(result.issues.some(issue => issue.field === field), field)
  assert.equal(result.offlineReady, false)
  assert.equal(result.planDigest, null)
})

test('edited deployment scripts, commands and authentication invalidate plan review', t => {
  const f = fixture(t), script = path.join(f.root, 'synthetic-step.mjs')
  writeFileSync(script, 'throw new Error("NEVER EXECUTE")')
  Object.assign(f.profile.steps[0], { argv: [process.execPath, script], inputs: [script] })
  f.evidence()
  const previousDigest = f.prepare().planDigest
  writeFileSync(script, 'throw new Error("CHANGED, NEVER EXECUTE")')
  let result = f.prepare()
  assert.notEqual(result.planDigest, previousDigest)
  assert.equal(result.evidenceStatus.review, 'missing-or-stale')
  assert.equal(result.evidenceStatus.ci, 'reusable')
  f.evidence()
  f.profile.acceptance.auth = 'disabled'
  f.profile.acceptance.checks[2].expectedStatus = 200
  result = f.prepare()
  assert.equal(result.evidenceStatus.review, 'missing-or-stale')
  f.profile.steps[0].inputs = []
  assert.ok(f.prepare().issues.some(issue => /must be listed in inputs/.test(issue.message)))
})

test('regression scripts bind bytes; dependency inputs include package config even with unchanged lockfile', t => {
  const f = fixture(t), script = path.join(f.root, 'synthetic-regression.mjs')
  writeFileSync(script, 'synthetic')
  Object.assign(f.profile.regression[0], { argv: [process.execPath, script], inputs: [script] })
  f.evidence()
  writeFileSync(script, 'changed synthetic')
  assert.equal(f.prepare().evidenceStatus.regression, 'missing-or-stale')
  f.evidence()
  const before = f.prepare()
  writeFileSync(path.join(f.profile.sourceRoot, 'package.json'), '{"scripts":{"postinstall":"changed"}}')
  f.profile.candidateSha = f.commit()
  const tree = f.git('rev-parse', 'HEAD^{tree}')
  for (const dir of [f.profile.serverDist, f.profile.clientDist]) writeJson(path.join(dir, 'build-info.json'), { product: 'CosGallery', version: '1.2.3', commit: f.profile.candidateSha, tree, dirty: false })
  writeJson(f.profile.manifest, createManifest({ ...f.profile, declaredSourceSha: f.profile.candidateSha }))
  const after = f.prepare()
  assert.equal(after.context.candidate.lockfile, before.context.candidate.lockfile)
  assert.equal(after.evidenceStatus.dependencies, 'missing-or-stale')
})

test('changed migrations need an explicit impact review even with fresh paired artifacts', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.profile.sourceRoot, 'server/db/migrations/000002.sql'), 'synthetic migration')
  f.profile.candidateSha = f.commit()
  const tree = f.git('rev-parse', 'HEAD^{tree}')
  for (const dir of [f.profile.serverDist, f.profile.clientDist]) writeJson(path.join(dir, 'build-info.json'), { product: 'CosGallery', version: '1.2.3', commit: f.profile.candidateSha, tree, dirty: false })
  writeJson(f.profile.manifest, createManifest({ ...f.profile, declaredSourceSha: f.profile.candidateSha }))
  const evidence = f.evidence()
  assert.match(f.prepare().issues.find(issue => issue.field === 'evidence.compatibility').message, /migration impact/)
  evidence.receipts.compatibility.persistence = 'migration'
  writeJson(f.evidenceFile, evidence)
  assert.equal(f.prepare().offlineReady, true)
})

test('docs workspace install inputs invalidate dependencies despite unchanged application inputs and lockfile', t => {
  const f = fixture(t)
  f.evidence()
  const before = f.prepare()
  mkdirSync(path.join(f.profile.sourceRoot, 'docs'))
  writeFileSync(path.join(f.profile.sourceRoot, 'docs/package.json'), '{"scripts":{"postinstall":"changed"}}')
  f.profile.candidateSha = f.commit()
  const tree = f.git('rev-parse', 'HEAD^{tree}')
  const manifest = JSON.parse(readFileSync(f.profile.manifest, 'utf8'))
  manifest.declaredSourceSha = f.profile.candidateSha
  writeJson(f.profile.manifest, manifest)
  assert.ok(f.prepare().issues.some(issue => issue.field === 'buildEquivalence' && /dependency inputs/.test(issue.message)))
  for (const dir of [f.profile.serverDist, f.profile.clientDist]) writeJson(path.join(dir, 'build-info.json'), { product: 'CosGallery', version: '1.2.3', commit: f.profile.candidateSha, tree, dirty: false })
  writeJson(f.profile.manifest, createManifest({ ...f.profile, declaredSourceSha: f.profile.candidateSha }))
  const after = f.prepare()
  assert.equal(after.context.candidate.lockfile, before.context.candidate.lockfile)
  assert.equal(after.context.candidate.buildInputs, before.context.candidate.buildInputs)
  assert.notEqual(after.context.candidate.dependencyInputs, before.context.candidate.dependencyInputs)
  assert.equal(after.evidenceStatus.dependencies, 'missing-or-stale')
})

test('repository root comparison accepts Windows path aliases but still rejects a repository subdirectory', t => {
  const f = fixture(t)
  // Git normalizes drive spelling; TEMP may also use a Windows 8.3 alias.
  // The root check must compare existing directories, not their spelling.
  if (process.platform === 'win32') f.profile.sourceRoot = f.profile.sourceRoot.replace(/^[A-Z]:/, drive => drive.toLowerCase())
  const accepted = prepareDeployment({ profile: f.profile, requireEvidence: false })
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues))
  if (process.platform === 'win32') {
    // Only ask cmd to expand the short name of our generated fixture. This
    // performs no file operation; the fixture cleanup still uses its own root.
    assert.doesNotMatch(f.profile.sourceRoot, /[%!"\r\n]/)
    const shortName = spawnSync('cmd.exe', ['/d', '/u', '/c', `for %I in ("${f.profile.sourceRoot}") do @echo "%~sI"`], { encoding: 'utf16le', windowsHide: true, windowsVerbatimArguments: true })
    assert.equal(shortName.status, 0, shortName.stderr)
    const alias = shortName.stdout.trim().replace(/^"(.*)"$/, '$1')
    assert.ok(path.isAbsolute(alias))
    if (alias.toLowerCase() !== f.profile.sourceRoot.toLowerCase()) {
      f.profile.sourceRoot = alias
      const shortAccepted = prepareDeployment({ profile: f.profile, requireEvidence: false })
      assert.equal(shortAccepted.ok, true, JSON.stringify(shortAccepted.issues))
      t.diagnostic('Windows 8.3 repository alias exercised')
    } else t.diagnostic('No distinct 8.3 alias on this volume; drive-case check exercised')
  }
  f.profile.sourceRoot = path.join(f.profile.sourceRoot, 'server')
  const rejected = prepareDeployment({ profile: f.profile, requireEvidence: false })
  assert.equal(rejected.ok, false)
  assert.ok(rejected.issues.some(issue => issue.field === 'candidateSha' && /repository root/.test(issue.message)))
})
