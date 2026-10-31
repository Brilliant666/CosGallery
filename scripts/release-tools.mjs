import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareDeployment } from './release-preflight.mjs'
import { summarizeTiming } from './release-timing.mjs'

const identityKeys = ['product', 'version', 'commit', 'tree', 'dirty']
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function absoluteSafe(value, label, { missingLeaf = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`${label} must be an absolute path without traversal`)
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) throw new Error(`${label} cannot be a filesystem root`)
  const root = path.parse(resolved).root
  let current = root
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i])
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} cannot contain links or junctions`)
    } catch (error) {
      if (error.code === 'ENOENT' && missingLeaf && i === parts.length - 1) continue
      throw error
    }
  }
  return resolved
}

function directory(value, label) {
  const result = absoluteSafe(value, label)
  if (!lstatSync(result).isDirectory()) throw new Error(`${label} must be a directory`)
  return result
}

function disjoint(a, b) {
  const inside = (parent, child) => {
    const relative = path.relative(parent, child)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  }
  return !inside(a, b) && !inside(b, a)
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) throw new Error('Invalid manifest path')
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Invalid manifest path')
  return parts
}

function sha(value, label) {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error(`${label} must be a lowercase Git SHA`)
  return value
}

function identity(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.product !== 'CosGallery' || typeof value.version !== 'string' || !value.version || value.dirty !== false) throw new Error(`${label} must describe a clean CosGallery build`)
  sha(value.commit, `${label} commit`)
  sha(value.tree, `${label} tree`)
  return Object.fromEntries(identityKeys.map(key => [key, value[key]]))
}

function sameIdentity(a, b) { return identityKeys.every(key => a[key] === b[key]) }

function files(root) {
  const entries = []
  function visit(folder, prefix = '') {
    for (const name of readdirSync(folder).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name
      safeRelative(rel)
      const item = path.join(folder, name)
      const stat = lstatSync(item)
      if (stat.isSymbolicLink()) throw new Error(`Artifact contains a link: ${rel}`)
      if (stat.isDirectory()) visit(item, rel)
      else if (stat.isFile()) {
        const data = readFileSync(item)
        entries.push({ path: rel, size: data.length, sha256: createHash('sha256').update(data).digest('hex') })
      } else throw new Error(`Unsupported artifact entry: ${rel}`)
    }
  }
  visit(root)
  return entries
}

function buildIdentity(root, label) {
  const file = path.join(root, 'build-info.json')
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error(`${label} build-info.json must be a regular file`)
  return identity(JSON.parse(readFileSync(file, 'utf8')), label)
}

function roots(serverDist, clientDist) {
  const server = directory(serverDist, 'server dist')
  const client = directory(clientDist, 'client dist')
  if (!disjoint(server, client)) throw new Error('Artifact directories must not overlap')
  return { server, client }
}

export function createManifest({ serverDist, clientDist, declaredSourceSha }) {
  const dirs = roots(serverDist, clientDist)
  const server = buildIdentity(dirs.server, 'server')
  const client = buildIdentity(dirs.client, 'client')
  if (!sameIdentity(server, client)) throw new Error('Server and client build identities differ')
  const manifest = { schema: 'cosgallery-release-manifest/v1', declaredSourceSha: sha(declaredSourceSha, 'declared source SHA'), build: server, artifacts: { server: files(dirs.server), client: files(dirs.client) } }
  validateManifest(manifest)
  return manifest
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== 'cosgallery-release-manifest/v1') throw new Error('Unsupported manifest')
  sha(manifest.declaredSourceSha, 'declared source SHA')
  identity(manifest.build, 'manifest build')
  for (const side of ['server', 'client']) {
    const list = manifest.artifacts?.[side]
    if (!Array.isArray(list) || !list.length) throw new Error(`Missing ${side} artifact list`)
    const seen = new Set()
    const spelling = new Map()
    for (const item of list) {
      const parts = safeRelative(item?.path)
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/')
        const key = prefix.toLowerCase()
        if (spelling.has(key) && spelling.get(key) !== prefix) throw new Error('Case-colliding manifest path')
        spelling.set(key, prefix)
      }
      const key = item.path.toLowerCase()
      if (seen.has(key)) throw new Error('Duplicate manifest path')
      seen.add(key)
      if (!Number.isSafeInteger(item.size) || item.size < 0 || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('Invalid manifest file metadata')
    }
    if (!seen.has('build-info.json')) throw new Error(`Missing ${side} build identity`)
  }
}

export function verifyManifest({ manifest, serverDist, clientDist, runtimeInfo }) {
  validateManifest(manifest)
  const actual = createManifest({ serverDist, clientDist, declaredSourceSha: manifest.declaredSourceSha })
  const differences = []
  for (const side of ['server', 'client']) {
    const expected = new Map(manifest.artifacts[side].map(entry => [entry.path, entry]))
    const found = new Map(actual.artifacts[side].map(entry => [entry.path, entry]))
    for (const [name, entry] of expected) {
      const other = found.get(name)
      if (!other) differences.push({ side, path: name, issue: 'missing' })
      else if (entry.size !== other.size || entry.sha256 !== other.sha256) differences.push({ side, path: name, issue: 'changed' })
    }
    for (const name of found.keys()) if (!expected.has(name)) differences.push({ side, path: name, issue: 'extra' })
  }
  const buildMatches = sameIdentity(manifest.build, actual.build)
  const runtime = runtimeInfo === undefined ? null : identity(runtimeInfo, 'runtime')
  const runtimeMatches = runtime === null ? null : sameIdentity(runtime, actual.build)
  return { ok: buildMatches && differences.length === 0 && runtimeMatches !== false, declaredSourceSha: manifest.declaredSourceSha, expectedBuild: manifest.build, installedBuild: actual.build, declaredSourceMatchesBuild: manifest.declaredSourceSha === actual.build.commit, runtime, runtimeMatchesInstalled: runtimeMatches, differences }
}

export function installRelease(options) {
  const { manifest, serverDist, clientDist, destination, allowParent, apply = false } = options
  const dirs = roots(serverDist, clientDist)
  const parent = directory(allowParent, 'allowed parent')
  const target = absoluteSafe(destination, 'destination', { missingLeaf: true })
  if (path.dirname(target) !== parent || existsSync(target) || !disjoint(target, dirs.server) || !disjoint(target, dirs.client)) throw new Error('Destination must be a new, non-overlapping direct child of the allowed parent')
  const preflight = verifyManifest({ manifest, serverDist: dirs.server, clientDist: dirs.client })
  if (!preflight.ok) throw new Error('Artifact verification failed; installation refused')
  if (!apply) return { mode: 'preflight', destination: target, verification: preflight }
  // No overwrite and no rollback: on failure the partial new target is retained.
  mkdirSync(target)
  for (const side of ['server', 'client']) {
    const destRoot = path.join(target, side)
    mkdirSync(destRoot)
    for (const entry of manifest.artifacts[side]) {
      const parts = safeRelative(entry.path)
      let folder = destRoot
      for (const component of parts.slice(0, -1)) {
        folder = path.join(folder, component)
        if (!existsSync(folder)) mkdirSync(folder)
        if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()) throw new Error('Unsafe destination directory')
      }
      copyFileSync(path.join(dirs[side], ...parts), path.join(folder, parts.at(-1)), constants.COPYFILE_EXCL)
    }
  }
  const installed = verifyManifest({ manifest, serverDist: path.join(target, 'server'), clientDist: path.join(target, 'client') })
  if (!installed.ok) throw new Error('Copied artifact verification failed; partial target retained')
  return { mode: 'installed', destination: target, verification: installed }
}

export function readJson(file, label) {
  const resolved = absoluteSafe(file, label)
  if (!lstatSync(resolved).isFile()) throw new Error(`${label} must be a regular file`)
  return JSON.parse(readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''))
}

function loopbackBase(value) {
  const match = typeof value === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/i.exec(value)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('Base URL must be plain HTTP on loopback with an explicit port and no path or credentials')
  let url
  try { url = new URL(value) } catch { throw new Error('A valid loopback base URL is required') }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return url
}

function getJson(base, endpoint) {
  return new Promise((resolve, reject) => {
    const request = http.get(new URL(endpoint, base), { signal: AbortSignal.timeout(5000) }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`${endpoint}: unexpected HTTP status ${response.statusCode}`)); return }
      let length = 0
      const chunks = []
      response.on('data', chunk => {
        length += chunk.length
        if (length > 65536) { response.destroy(new Error(`${endpoint}: response exceeds 64 KiB`)); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error(`${endpoint}: invalid JSON`)) }
      })
    })
    request.on('error', reject)
  })
}

export async function probeRuntime({ baseUrl, manifest }) {
  const base = loopbackBase(baseUrl)
  if (manifest !== undefined) validateManifest(manifest)
  const [health, client] = await Promise.all([getJson(base, '/api/health'), getJson(base, '/build-info.json')])
  if (typeof health?.ok !== 'boolean' || typeof health?.storage?.available !== 'boolean' || typeof health?.storage?.usingInMemoryDatabase !== 'boolean') throw new Error('Invalid health response')
  const serverBuild = identity(health.build, 'runtime server')
  const clientBuild = identity(client, 'runtime client')
  const paired = sameIdentity(serverBuild, clientBuild)
  const matchesManifest = manifest === undefined ? null : sameIdentity(serverBuild, manifest.build) && sameIdentity(clientBuild, manifest.build)
  return { ok: health.ok && health.storage.available && !health.storage.usingInMemoryDatabase && paired && matchesManifest !== false, health: { ok: health.ok, storageAvailable: health.storage.available, usingInMemoryDatabase: health.storage.usingInMemoryDatabase }, serverBuild, clientBuild, paired, matchesManifest }
}

async function main(args) {
  const command = args.shift()
  const allowed = { manifest: ['server-dist', 'client-dist', 'declared-source-sha'], verify: ['manifest', 'server-dist', 'client-dist', 'runtime-info'], install: ['manifest', 'server-dist', 'client-dist', 'destination', 'allow-parent', 'apply'], runtime: ['base-url', 'manifest'], plan: ['profile'], prepare: ['profile', 'evidence'], timing: ['plan', 'log'] }[command]
  if (!allowed) throw new Error('Usage: release-tools.mjs manifest|verify|install|runtime|plan|prepare|timing --option value [--apply]')
  const options = {}
  while (args.length) {
    const key = args.shift()
    if (!key.startsWith('--') || !allowed.includes(key.slice(2)) || Object.hasOwn(options, key.slice(2))) throw new Error(`Unknown or duplicate option: ${key}`)
    const name = key.slice(2)
    if (name === 'apply') options[name] = true
    else {
      const value = args.shift()
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
      options[name] = value
    }
  }
  const base = { serverDist: options['server-dist'], clientDist: options['client-dist'] }
  let result
  if (command === 'plan' || command === 'prepare') {
    result = prepareDeployment({ profile: readJson(options.profile, 'profile'), evidenceFile: options.evidence, requireEvidence: command === 'prepare' })
  }
  else if (command === 'timing') {
    const plan = readJson(options.plan, 'prepared plan')
    const log = readJson(options.log, 'timing log')
    if (plan.schema !== 'cosgallery-deployment-preflight/v1' || plan.offlineReady !== true || log.planDigest !== plan.planDigest) throw new Error('Timing log must match a successful prepared plan')
    result = summarizeTiming(log)
  }
  else if (command === 'manifest') result = createManifest({ ...base, declaredSourceSha: options['declared-source-sha'] })
  else if (command === 'runtime') result = await probeRuntime({ baseUrl: options['base-url'], manifest: options.manifest ? readJson(options.manifest, 'manifest') : undefined })
  else {
    const manifest = readJson(options.manifest, 'manifest')
    if (command === 'verify') result = verifyManifest({ ...base, manifest, runtimeInfo: options['runtime-info'] ? readJson(options['runtime-info'], 'runtime info') : undefined })
    else result = installRelease({ ...base, manifest, destination: options.destination, allowParent: options['allow-parent'], apply: options.apply })
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.ok === false) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
