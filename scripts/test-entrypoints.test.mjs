import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repository = fileURLToPath(new URL('../', import.meta.url))
const rootPackage = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
const serverPackage = JSON.parse(readFileSync(join(repository, 'server/package.json'), 'utf8'))

test('server test entry selects files, discovers the default suite and rejects unmatched files', { timeout: 60_000 }, t => {
  const packageManager = process.env.npm_execpath
  assert(packageManager && existsSync(packageManager), 'Run through pnpm test:workspace-runner')
  const root = mkdtempSync(join(tmpdir(), 'cosgallery-test-entry-'))
  t.after(() => {
    assert(relative(tmpdir(), root).startsWith('cosgallery-test-entry-'))
    rmSync(root, { recursive: true, force: true })
  })
  const workspace = join(root, '中文目录 with spaces')
  mkdirSync(join(workspace, 'scripts'), { recursive: true })
  mkdirSync(join(workspace, 'server/test'), { recursive: true })
  copyFileSync(join(repository, 'scripts/run-workspace-script.mjs'), join(workspace, 'scripts/run-workspace-script.mjs'))
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ private: true, scripts: { 'test:server': rootPackage.scripts['test:server'] } }))
  writeFileSync(join(workspace, 'server/package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: serverPackage.scripts.test } }))
  // Exercise the actual root/child scripts and installed Vitest against harmless
  // tests. Never discover or execute the repository's application test suite here.
  writeFileSync(join(workspace, 'server/vitest.config.ts'), `export default ${JSON.stringify({
    resolve: { alias: { vitest: join(repository, 'server/node_modules/vitest/dist/index.js') } },
    test: { include: ['test/**/*.test.ts'], fileParallelism: false, maxWorkers: 1, minWorkers: 1 },
  })}`)
  for (const name of ['selected', 'unrelated']) {
    writeFileSync(join(workspace, 'server/test', `${name}.test.ts`), `import { test, expect } from 'vitest'; test('${name}', () => expect(1).toBe(1));`)
  }
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const env = {
    ...process.env, NODE_ENV: 'test',
    [pathKey]: [dirname(process.execPath), join(repository, 'server/node_modules/.bin'), process.env[pathKey] ?? ''].join(delimiter),
  }
  const run = (label, filters) => {
    const report = join(root, `${label}.json`)
    const result = spawnSync(process.execPath, [packageManager, 'run', 'test:server', '--', ...filters, '--reporter=json', `--outputFile=${report}`], {
      cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    })
    assert.ifError(result.error)
    return { result, report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : undefined }
  }
  const selected = run('selected', ['test/selected.test.ts'])
  assert.equal(selected.result.status, 0, selected.result.stdout + selected.result.stderr)
  assert.equal(selected.report.numTotalTests, 1)
  assert.deepEqual(selected.report.testResults.flatMap(file => file.assertionResults.map(assertion => assertion.title)), ['selected'])

  const all = run('all', [])
  assert.equal(all.result.status, 0, all.result.stdout + all.result.stderr)
  assert.equal(all.report.numTotalTests, 2)
  assert.deepEqual(all.report.testResults.flatMap(file => file.assertionResults.map(assertion => assertion.title)).sort(), ['selected', 'unrelated'])

  const unmatched = run('unmatched', ['test/does-not-exist.test.ts'])
  assert.equal(unmatched.result.status, 1, unmatched.result.stdout + unmatched.result.stderr)
  assert.equal(unmatched.report.numTotalTests, 0)
  assert.deepEqual(unmatched.report.testResults, [])
})
