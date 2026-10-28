import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createManifest, installRelease, probeRuntime, verifyManifest } from './release-tools.mjs'

const executable = fileURLToPath(new URL('./release-tools.mjs', import.meta.url))
const commit = 'a'.repeat(40), tree = 'b'.repeat(40), declaredSourceSha = 'c'.repeat(40)
const info = { product: 'CosGallery', version: '1.2.3', commit, tree, dirty: false, builtAt: 'synthetic', node: 'synthetic' }

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cosgallery-release-fixture-'))
  t.after(() => {
    assert.match(path.relative(tmpdir(), root), /^cosgallery-release-fixture-[^\\/]+$/)
    rmSync(root, { recursive: true, force: true })
  })
  const serverDist = path.join(root, 'source', 'server dist')
  const clientDist = path.join(root, 'source', '客户端')
  const allowParent = path.join(root, 'installation area')
  mkdirSync(serverDist, { recursive: true }); mkdirSync(clientDist, { recursive: true }); mkdirSync(allowParent)
  for (const dir of [serverDist, clientDist]) writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify(info))
  mkdirSync(path.join(clientDist, 'assets'))
  writeFileSync(path.join(serverDist, 'index.js'), 'synthetic server')
  writeFileSync(path.join(clientDist, 'assets', 'app.js'), 'synthetic client')
  const args = { serverDist, clientDist, declaredSourceSha }
  return { root, allowParent, ...args, manifest: createManifest(args) }
}

test('manifest separates source, paired build and explicit runtime identities', t => {
  const f = fixture(t)
  const result = verifyManifest({ ...f, runtimeInfo: info })
  assert.equal(result.ok, true)
  assert.equal(result.declaredSourceSha, declaredSourceSha)
  assert.equal(result.installedBuild.commit, commit)
  assert.equal(result.declaredSourceMatchesBuild, false)
  assert.equal(result.runtimeMatchesInstalled, true)
  assert.equal(verifyManifest({ ...f }).runtime, null)
  assert.equal(verifyManifest({ ...f, runtimeInfo: { ...info, commit: 'd'.repeat(40) } }).ok, false)
})

test('detects changed, missing and extra files and rejects mismatched build identities', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.serverDist, 'index.js'), 'changed')
  rmSync(path.join(f.clientDist, 'assets', 'app.js'))
  writeFileSync(path.join(f.clientDist, 'extra.js'), 'extra')
  const result = verifyManifest(f)
  assert.equal(result.ok, false)
  assert.deepEqual(result.differences.map(item => item.issue).sort(), ['changed', 'extra', 'missing'])
  writeFileSync(path.join(f.clientDist, 'build-info.json'), JSON.stringify({ ...info, commit: 'd'.repeat(40) }))
  assert.throws(() => verifyManifest(f), /identities differ/)
})

test('rejects malicious manifest paths, collisions and invalid identities', t => {
  const f = fixture(t)
  for (const value of ['../outside', '/outside', 'assets\\outside', 'assets/CON.txt', 'assets/trailing.']) {
    const bad = structuredClone(f.manifest); bad.artifacts.client[0].path = value
    assert.throws(() => verifyManifest({ ...f, manifest: bad }), /Invalid manifest path/)
  }
  const duplicate = structuredClone(f.manifest)
  duplicate.artifacts.server.push({ ...duplicate.artifacts.server[0] })
  assert.throws(() => verifyManifest({ ...f, manifest: duplicate }), /Duplicate manifest path/)
  const collision = structuredClone(f.manifest)
  collision.artifacts.client.push({ ...collision.artifacts.client[0], path: 'ASSETS/other.js' })
  assert.throws(() => verifyManifest({ ...f, manifest: collision }), /Case-colliding/)
  assert.throws(() => createManifest({ ...f, declaredSourceSha: 'not-a-sha' }), /declared source SHA/)
  assert.throws(() => createManifest({ ...f, serverDist: path.relative(process.cwd(), f.serverDist) }), /absolute path/)
})

test('preflight is read only; explicit install copies to a new child and verifies contents', t => {
  const f = fixture(t), destination = path.join(f.allowParent, 'new installation')
  const options = { ...f, destination }
  assert.equal(installRelease(options).mode, 'preflight')
  assert.throws(() => readFileSync(path.join(destination, 'server', 'index.js')), { code: 'ENOENT' })
  const installed = installRelease({ ...options, apply: true })
  assert.equal(installed.mode, 'installed')
  assert.equal(installed.verification.ok, true)
  assert.equal(readFileSync(path.join(destination, 'client', 'assets', 'app.js'), 'utf8'), 'synthetic client')
  assert.throws(() => installRelease({ ...options, apply: true }), /new, non-overlapping/)
  assert.throws(() => installRelease({ ...options, destination: path.join(f.root, 'outside') }), /new, non-overlapping/)
  assert.throws(() => installRelease({ ...options, destination: f.allowParent + path.sep + '..' + path.sep + 'escape' }), /without traversal/)
  assert.throws(() => installRelease({ ...options, allowParent: f.serverDist, destination: path.join(f.serverDist, 'nested') }), /non-overlapping/)
})

test('rejects links in artifacts and destination parent', t => {
  const f = fixture(t)
  const link = path.join(f.root, 'junction')
  try { symlinkSync(f.allowParent, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM' || error.code === 'ENOTSUP') return t.skip(`link creation unavailable: ${error.code}`); throw error }
  assert.throws(() => installRelease({ ...f, allowParent: link, destination: path.join(link, 'target') }), /links or junctions/)
  const inside = path.join(f.serverDist, 'linked')
  symlinkSync(f.clientDist, inside, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => createManifest(f), /link/)
})

test('CLI requires explicit arguments and reports mismatch with nonzero status', t => {
  const f = fixture(t), file = path.join(f.root, 'manifest.json')
  writeFileSync(file, JSON.stringify(f.manifest))
  const invoke = args => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(invoke(['install']).status, 0)
  const generated = invoke(['manifest', '--server-dist', f.serverDist, '--client-dist', f.clientDist, '--declared-source-sha', declaredSourceSha])
  assert.equal(generated.status, 0, generated.stderr)
  assert.equal(JSON.parse(generated.stdout).declaredSourceSha, declaredSourceSha)
  const args = ['verify', '--manifest', file, '--server-dist', f.serverDist, '--client-dist', f.clientDist]
  assert.equal(invoke(args).status, 0)
  const destination = path.join(f.allowParent, 'cli target')
  const install = ['install', '--manifest', file, '--server-dist', f.serverDist, '--client-dist', f.clientDist, '--allow-parent', f.allowParent, '--destination', destination]
  assert.equal(JSON.parse(invoke(install).stdout).mode, 'preflight')
  assert.equal(JSON.parse(invoke([...install, '--apply']).stdout).mode, 'installed')
  writeFileSync(path.join(f.clientDist, 'extra'), 'synthetic')
  const result = invoke(args)
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).ok, false)
  const refused = path.join(f.allowParent, 'refused')
  assert.notEqual(invoke([...install.slice(0, -1), refused, '--apply']).status, 0)
  assert.throws(() => readFileSync(path.join(refused, 'server', 'index.js')), { code: 'ENOENT' })
})

test('dirty or incomplete build identity refuses CLI install before creating destination', t => {
  const f = fixture(t), file = path.join(f.root, 'manifest.json')
  writeFileSync(file, JSON.stringify(f.manifest))
  for (const [label, badInfo] of [['dirty', { ...info, dirty: true }], ['incomplete', { ...info, commit: undefined }]]) {
    const destination = path.join(f.allowParent, label)
    writeFileSync(path.join(f.serverDist, 'build-info.json'), JSON.stringify(badInfo))
    const result = spawnSync(process.execPath, [executable, 'install', '--manifest', file, '--server-dist', f.serverDist, '--client-dist', f.clientDist, '--allow-parent', f.allowParent, '--destination', destination, '--apply'], { encoding: 'utf8', windowsHide: true })
    assert.notEqual(result.status, 0)
    assert.throws(() => readFileSync(destination), { code: 'ENOENT' })
  }
})

test('unhealthy or mismatched runtime returns nonzero and requests only public endpoints', async t => {
  const f = fixture(t), file = path.join(f.root, 'manifest.json'), requests = []
  writeFileSync(file, JSON.stringify(f.manifest))
  let health, client
  const server = createServer((req, res) => {
    requests.push([req.method, req.url])
    res.end(JSON.stringify(req.url === '/api/health' ? health : client))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  assert.notEqual(port, 4141)
  const normal = { ok: true, storage: { available: true, usingInMemoryDatabase: false }, build: info }
  const another = { ...info, commit: 'd'.repeat(40) }
  const cases = [
    { health: { ...normal, ok: false }, client: info },
    { health: { ...normal, storage: { ...normal.storage, available: false } }, client: info },
    { health: { ...normal, storage: { ...normal.storage, usingInMemoryDatabase: true } }, client: info },
    { health: normal, client: another },
    { health: { ...normal, build: another }, client: another },
  ]
  for (const scenario of cases) {
    health = scenario.health; client = scenario.client; requests.length = 0
    const cli = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [executable, 'runtime', '--base-url', `http://127.0.0.1:${port}`, '--manifest', file], { windowsHide: true })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.on('error', reject)
      child.on('close', code => resolve({ code, output }))
    })
    assert.equal(cli.code, 1)
    assert.equal(JSON.parse(cli.output).ok, false)
    assert.deepEqual(requests.sort(), [['GET', '/api/health'], ['GET', '/build-info.json']])
  }
})

test('runtime makes only bounded GETs to explicitly selected loopback fixture', async t => {
  const f = fixture(t), requests = []
  let mode = 'normal'
  const server = createServer((req, res) => {
    requests.push([req.method, req.url])
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://example.invalid/' }); res.end(); return }
    if (mode === 'oversized') { res.end('x'.repeat(65537)); return }
    if (mode === 'hang') return
    if (req.url === '/api/health') res.end(JSON.stringify({ ok: true, storage: { available: true, usingInMemoryDatabase: false }, build: info }))
    else if (req.url === '/build-info.json') res.end(JSON.stringify(info))
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  assert.notEqual(port, 4141)
  const baseUrl = `http://127.0.0.1:${port}`
  const result = await probeRuntime({ baseUrl, manifest: f.manifest })
  assert.equal(result.ok, true)
  assert.equal(result.matchesManifest, true)
  assert.deepEqual(requests.sort(), [['GET', '/api/health'], ['GET', '/build-info.json']])
  for (const invalid of [`http://user@127.0.0.1:${port}`, `http://127.0.0.1:${port}/private`, `http://127.0.0.1:${port}/..`, `http://127.0.0.1:${port}/%2e%2e`, `http://127.0.0.1:${port}/?`, `http://127.0.0.2:${port}`, 'http://example.com:80', 'http://localhost', 'http://localhost:0', 'http://localhost:65536', `https://127.0.0.1:${port}`]) {
    await assert.rejects(probeRuntime({ baseUrl: invalid }), /Base URL/)
  }
  assert.equal(requests.length, 2)
  const cli = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, 'runtime', '--base-url', baseUrl], { windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
  assert.equal(cli.code, 0)
  assert.equal(JSON.parse(cli.output).paired, true)
  mode = 'redirect'
  await assert.rejects(probeRuntime({ baseUrl }), /unexpected HTTP status 302/)
  mode = 'oversized'
  await assert.rejects(probeRuntime({ baseUrl }), /exceeds 64 KiB/)
  mode = 'hang'
  await assert.rejects(probeRuntime({ baseUrl }), /abort/i)
})
