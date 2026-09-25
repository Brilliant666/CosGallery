import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const helper = fileURLToPath(new URL('./run-workspace-script.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cosgallery-workspace-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, '中文目录 with spaces')
  mkdirSync(workspace)
  // The explicit caller is a harmless package-manager stand-in. It records the
  // exact Node, cwd and argv without looking up executables on the system PATH.
  const caller = join(root, 'caller.cjs')
  writeFileSync(caller, `console.log(JSON.stringify({execPath:process.execPath,cwd:process.cwd(),args:process.argv.slice(2),path:process.env.PATH??process.env.Path}));process.exit(Number(process.env.FIXTURE_EXIT_CODE??0))`)
  return { root, workspace, caller }
}

test('uses the current Node and explicit caller in a Unicode workspace and preserves arguments', t => {
  const { workspace, caller } = fixture(t)
  const args = ['--', '--flag', 'two words', '中文值', 'literal&value', 'quote"value']
  const result = spawnSync(process.execPath, [helper, workspace, 'probe', ...args], {
    encoding: 'utf8', env: { ...process.env, npm_execpath: caller }, windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  const recorded = JSON.parse(result.stdout)
  assert.equal(recorded.execPath, process.execPath)
  assert.equal(recorded.cwd, workspace)
  assert.deepEqual(recorded.args, ['run', 'probe', ...args.slice(1)])
  assert.equal(recorded.path.split(delimiter)[0], dirname(process.execPath))
})

test('forwards a child failure exit code', t => {
  const { workspace, caller } = fixture(t)
  const result = spawnSync(process.execPath, [helper, workspace, 'probe'], {
    encoding: 'utf8', env: { ...process.env, npm_execpath: caller, FIXTURE_EXIT_CODE: '7' }, windowsHide: true,
  })
  assert.equal(result.status, 7)
})

test('requires an explicit package-manager context rather than guessing a system executable', t => {
  const { workspace } = fixture(t)
  const env = { ...process.env }
  delete env.npm_execpath
  const result = spawnSync(process.execPath, [helper, workspace, 'probe'], { encoding: 'utf8', env, windowsHide: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /through pnpm run/)
})

test('reports usage before starting a child when workspace or script is missing', () => {
  const result = spawnSync(process.execPath, [helper], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage:/)
})
