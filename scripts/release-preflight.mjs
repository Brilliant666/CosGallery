import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { absoluteSafe, readJson, verifyManifest } from './release-tools.mjs'

export const deploymentStages = ['read-check', 'stop', 'confirm-exit', 'install', 'start', 'health']
export const requiredChecks = ['Verify (Node 22)', 'Verify (Node 24)', 'Windows command and release contracts (Node 24)', 'Synthetic Chromium interaction smoke (Node 24)']
const scopes = ['ci', 'review', 'compatibility', 'regression', 'dependencies', 'recovery']
const gitSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item
})
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const text = value => typeof value === 'string' && value.trim().length > 0
const demand = (condition, message) => { if (!condition) throw new Error(message) }
const sha = value => demand(typeof value === 'string' && gitSha.test(value), 'Expected a full lowercase Git SHA')

function directory(value, label) {
  const resolved = absoluteSafe(value, label)
  demand(lstatSync(resolved).isDirectory(), `${label} must be a directory`)
  return resolved
}

function regularFile(value, label) {
  const resolved = absoluteSafe(value, label)
  demand(lstatSync(resolved).isFile(), `${label} must be a regular file`)
  return resolved
}

function sourceSnapshot(root, revision) {
  sha(revision)
  const canonicalRoot = realpathSync.native(root)
  // Read Git objects, not a possibly modified checkout; no fetch, hooks or checkout.
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-c', `safe.directory=${canonicalRoot.replaceAll('\\', '/')}`, '-C', canonicalRoot, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trimEnd()
  // Git may expand a Windows TEMP 8.3 alias or normalize drive spelling.
  // absoluteSafe already rejected links/junctions in the supplied root.
  demand(path.relative(realpathSync.native(git('rev-parse', '--show-toplevel')), canonicalRoot) === '', 'sourceRoot must be the repository root')
  demand(git('rev-parse', `${revision}^{commit}`) === revision, 'Revision must identify a commit')
  const tree = git('rev-parse', `${revision}^{tree}`)
  const entries = git('ls-tree', '-rz', '--full-tree', revision).split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line)
    demand(match, 'Invalid Git tree entry')
    return { mode: match[1], type: match[2], object: match[3], path: match[4] }
  })
  for (const required of ['pnpm-lock.yaml', 'package.json', 'server/package.json', 'client/package.json']) demand(entries.some(entry => entry.path === required && entry.type === 'blob'), `Missing tracked build input: ${required}`)
  // Conservative: all tracked inputs except documentation/governance prose. No
  // custom caller exclusions that could silently weaken artifact equivalence.
  const inputs = entries.filter(entry => !entry.path.startsWith('docs/') && !/^[^/]+\.md$/i.test(entry.path) && !['LICENSE', 'LICENSE.md'].includes(entry.path))
  demand(inputs.every(entry => entry.type === 'blob' && entry.mode !== '120000'), 'Build inputs cannot contain links or submodules')
  const dependencyInputs = entries.filter(entry => !/\.md$/i.test(entry.path) && !['LICENSE', 'LICENSE.md'].includes(entry.path))
  demand(dependencyInputs.every(entry => entry.type === 'blob' && entry.mode !== '120000'), 'Dependency inputs cannot contain links or submodules')
  return { sha: revision, tree, buildInputs: digest(inputs), dependencyInputs: digest(dependencyInputs), lockfile: digest(entries.filter(entry => entry.path === 'pnpm-lock.yaml')), migrations: digest(entries.filter(entry => entry.path.startsWith('server/db/migrations/'))) }
}

function command(value, label, check, hashFile) {
  const argv = check(`${label}.argv`, () => {
    demand(value && Array.isArray(value.argv) && value.argv.length > 0 && value.argv.every(text), 'argv must be a nonempty string array')
    return value.argv
  })
  const executable = argv && check(`${label}.executable`, () => hashFile(argv[0], 'executable'))
  const cwd = check(`${label}.cwd`, () => directory(value?.cwd, 'command cwd'))
  check(`${label}.expected`, () => demand(text(value?.expected), 'Expected result is required'))
  check(`${label}.inputs`, () => demand(Array.isArray(value?.inputs), 'inputs must explicitly list command scripts/configuration (empty for inline/native commands)'))
  const inputs = Array.isArray(value?.inputs) ? value.inputs.map((file, index) => check(`${label}.inputs.${index}`, () => hashFile(file, 'command input'))) : []
  // Common direct script/config arguments cannot be silently omitted. Shell
  // indirection and transitive imports still require the reviewer's inventory.
  if (argv && cwd) for (const arg of argv.slice(1)) {
    const possible = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg
    if (/\.(?:ps1|mjs|cjs|js|py|cmd|bat|json|ya?ml)$/i.test(possible)) check(`${label}.inputs`, () => demand(inputs.some(item => item?.path === path.resolve(cwd, possible)), 'Script/config argument must be listed in inputs'))
  }
  // Declarative only. No shell interpretation or command execution here.
  return { argv, executable, cwd, expected: value?.expected, inputs }
}

function acceptance(value, check) {
  check('acceptance.auth', () => demand(value && ['enabled', 'disabled'].includes(value.auth), 'acceptance.auth must explicitly be enabled or disabled'))
  check('acceptance.checks', () => demand(Array.isArray(value?.checks) && value.checks.length >= 2, 'acceptance.checks must include health and build identity'))
  const paths = new Set()
  for (const [index, item] of (Array.isArray(value?.checks) ? value.checks : []).entries()) {
    check(`acceptance.checks.${index}.path`, () => {
      demand(item && item.method === 'GET' && typeof item.path === 'string' && /^\/[a-zA-Z0-9/_-]+(?:\.[a-zA-Z0-9]+)?$/.test(item.path), 'Acceptance requires explicit GET paths without credentials/query/fragment')
      demand(!paths.has(item.path), 'Duplicate acceptance path')
      paths.add(item.path)
    })
    check(`acceptance.checks.${index}.access`, () => demand(['public', 'admin'].includes(item?.access), 'Acceptance access must be public or admin'))
    check(`acceptance.checks.${index}.expectedStatus`, () => demand(item?.expectedStatus === (item?.access === 'admin' && value?.auth === 'enabled' ? 401 : 200), 'Acceptance status must match anonymous access and configured authentication'))
  }
  for (const endpoint of ['/api/health', '/build-info.json']) check(`acceptance.${endpoint}`, () => demand(Array.isArray(value?.checks) && value.checks.some(item => item?.path === endpoint && item.access === 'public' && item.expectedStatus === 200), `${endpoint} must be a public 200 check`))
}

function record(file, label) {
  regularFile(file, label)
  demand(path.extname(file).toLowerCase() === '.json' && lstatSync(file).size <= 1024 * 1024, `${label} must be a JSON receipt no larger than 1 MiB`)
  const value = readJson(file, label)
  demand(value && typeof value === 'object' && !Array.isArray(value), `${label} must contain a JSON object`)
  // Hash receipts, not database/media/dependency trees. Their truth is reviewed,
  // not inferred from file existence. Keep raw private contents out of output.
  return { path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
}

export function prepareDeployment({ profile, evidenceFile, requireEvidence = true }) {
  const issues = []
  const check = (field, fn) => { try { return fn() } catch (error) { issues.push({ field, message: error.message }); return undefined } }
  const fileCache = new Map()
  const hashFile = (file, label) => {
    const resolved = regularFile(file, label)
    if (!fileCache.has(resolved)) fileCache.set(resolved, { path: resolved, sha256: createHash('sha256').update(readFileSync(resolved)).digest('hex') })
    return fileCache.get(resolved)
  }
  const p = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {}
  check('schema', () => demand(p.schema === 'cosgallery-deployment-profile/v1', 'Unsupported deployment profile'))
  const root = check('sourceRoot', () => directory(p.sourceRoot, 'sourceRoot'))
  const snapshots = new Map()
  const snapshot = revision => {
    sha(revision)
    if (!root) return undefined
    if (!snapshots.has(revision)) snapshots.set(revision, sourceSnapshot(root, revision))
    return snapshots.get(revision)
  }
  const candidate = check('candidateSha', () => snapshot(p.candidateSha))
  const baseline = check('baselineSha', () => snapshot(p.baselineSha))
  const manifest = check('manifest', () => {
    const value = readJson(p.manifest, 'manifest')
    demand(value && typeof value === 'object' && !Array.isArray(value), 'Manifest must be an object')
    return value
  })
  check('serverDist', () => directory(p.serverDist, 'serverDist'))
  check('clientDist', () => directory(p.clientDist, 'clientDist'))
  if (manifest) check('artifacts', () => {
    const result = verifyManifest({ manifest, serverDist: p.serverDist, clientDist: p.clientDist })
    demand(result.ok, `Artifact verification failed: ${result.differences.map(item => `${item.side}/${item.path}:${item.issue}`).join(', ')}`)
    demand(manifest.declaredSourceSha === p.candidateSha, 'Manifest declared source must match the exact candidate')
  })
  const buildSource = manifest && root ? check('buildSource', () => snapshot(manifest.build?.commit)) : undefined
  if (candidate && buildSource) check('buildEquivalence', () => {
    demand(buildSource.tree === manifest.build.tree, 'Build tree does not match its Git commit')
    demand(candidate.buildInputs === buildSource.buildInputs, 'Candidate build inputs differ from artifact source; prepare a compatible paired build')
    demand(candidate.dependencyInputs === buildSource.dependencyInputs, 'Candidate dependency inputs differ from artifact source; prepare a compatible paired build')
  })
  check('runtime', () => {
    demand(p.runtime && /^\d+\.\d+\.\d+$/.test(p.runtime.node) && /^\d+\.\d+\.\d+$/.test(p.runtime.pnpm) && text(p.runtime.platform) && text(p.runtime.arch), 'Explicit node, pnpm, platform and arch are required')
  })
  const records = {}
  for (const kind of ['dependencies', 'recovery']) records[kind] = check(`records.${kind}`, () => record(p.records?.[kind], `${kind} record`))
  check('regression', () => {
    demand(Array.isArray(p.regression) && p.regression.length > 0, 'At least one scoped local regression command is required')
  })
  const regressionCommands = Array.isArray(p.regression) ? p.regression.map((entry, index) => command(entry, `regression.${index}`, check, hashFile)) : []
  check('steps', () => demand(Array.isArray(p.steps) && p.steps.length === deploymentStages.length, 'All six separate deployment steps are required'))
  const stepCommands = deploymentStages.map((stage, index) => {
    const entry = p.steps?.[index]
    check(`steps.${stage}`, () => demand(entry?.stage === stage, `Expected separate ${stage} step at position ${index + 1}`))
    return command(entry, `steps.${stage}`, check, hashFile)
  })
  acceptance(p.acceptance, check)
  let evidence
  if (requireEvidence || evidenceFile) evidence = check('evidence', () => readJson(evidenceFile, 'evidence'))
  const inputsValid = issues.length === 0 || issues.every(issue => issue.field === 'evidence')
  const keys = {}, evidenceStatus = {}, evidenceTemplate = { schema: 'cosgallery-deployment-evidence/v1', receipts: {} }
  let context, planDigest = null
  if (inputsValid) {
    context = { candidate, baseline, build: manifest.build, artifactDigest: digest({ build: manifest.build, artifacts: manifest.artifacts }), runtime: p.runtime, records }
    const pair = { candidate, baseline, build: manifest.build }
    const regression = { buildInputs: candidate.buildInputs, dependencyInputs: candidate.dependencyInputs, artifacts: context.artifactDigest, runtime: p.runtime, dependencies: records.dependencies, commands: regressionCommands }
    const bindings = {
      ci: { candidate, checks: requiredChecks },
      review: { candidate, baseline, steps: stepCommands, acceptance: p.acceptance },
      compatibility: { ...pair, runtime: p.runtime },
      regression,
      dependencies: { dependencyInputs: candidate.dependencyInputs, buildInputs: candidate.buildInputs, lockfile: candidate.lockfile, runtime: p.runtime, record: records.dependencies },
      recovery: { baseline, targetInputs: candidate.buildInputs, dependencyInputs: candidate.dependencyInputs, runtime: p.runtime, record: records.recovery },
    }
    planDigest = digest({ profile: p, context, commands: { steps: stepCommands, regression: regressionCommands } })
    for (const scope of scopes) {
      keys[scope] = digest({ schema: 'cosgallery-deployment-binding/v1', scope, inputs: bindings[scope] })
      evidenceTemplate.receipts[scope] = { key: keys[scope], status: 'pending', checkedAt: null, checkedBy: '', reference: '', coverage: [] }
    }
    evidenceTemplate.receipts.ci.head = p.candidateSha
    evidenceTemplate.receipts.ci.checks = requiredChecks.map(name => ({ name, conclusion: 'pending' }))
    evidenceTemplate.receipts.compatibility.persistence = 'unreviewed'
    evidenceTemplate.receipts.compatibility.rationale = ''
    evidenceTemplate.receipts.recovery.coverage = ['code', 'dependencies', 'configuration', 'data-policy']
    if (requireEvidence) {
      check('evidence.schema', () => demand(evidence?.schema === evidenceTemplate.schema, 'Unsupported or missing deployment evidence'))
      for (const scope of scopes) {
        const before = issues.length
        check(`evidence.${scope}`, () => {
          const receipt = evidence?.receipts?.[scope]
          demand(receipt?.key === keys[scope], 'Missing or stale evidence binding; review only this affected scope')
          demand(receipt.status === 'passed' && text(receipt.checkedBy) && text(receipt.reference) && Array.isArray(receipt.coverage) && receipt.coverage.length > 0 && receipt.coverage.every(text), 'Passed evidence needs reviewer, concrete reference and coverage')
          demand(typeof receipt.checkedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.checkedAt) && new Date(receipt.checkedAt).toISOString() === receipt.checkedAt, 'Evidence needs a valid UTC checkedAt')
          if (scope === 'ci') {
            demand(receipt.head === candidate.sha, 'CI must cover the exact candidate SHA, even for equal trees')
            demand(Array.isArray(receipt.checks) && receipt.checks.length === requiredChecks.length && requiredChecks.every(name => receipt.checks.filter(item => item.name === name && item.conclusion === 'success').length === 1), 'All existing Verify checks must have succeeded')
          }
          if (scope === 'compatibility') {
            demand(['none', 'compatible', 'migration'].includes(receipt.persistence) && text(receipt.rationale), 'Compatibility needs persistence impact and rationale')
            demand(candidate.migrations === baseline.migrations || receipt.persistence === 'migration', 'Changed migrations require explicit migration impact review')
          }
          if (scope === 'recovery') demand(['code', 'dependencies', 'configuration', 'data-policy'].every(item => receipt.coverage.includes(item)), 'Recovery evidence must cover code, dependencies, configuration and current data policy')
        })
        evidenceStatus[scope] = issues.length === before ? 'reusable' : 'missing-or-stale'
      }
    }
  }
  const offlineReady = requireEvidence && issues.length === 0
  return { schema: 'cosgallery-deployment-preflight/v1', ok: issues.length === 0, offlineReady, planDigest, context, keys, evidenceStatus, issues, evidenceTemplate: inputsValid ? evidenceTemplate : null, requiresFreshChecks: ['current authorization', 'current process identity and business idle state', 'current protected files and recovery applicability'], limitations: ['Offline caller-supplied evidence; no remote CI or review authentication', 'No commands, HTTP, service control, deployment or database access performed'] }
}
