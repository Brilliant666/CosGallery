import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const [workspaceDir, scriptName, ...scriptArgs] = process.argv.slice(2)

if (!workspaceDir || !scriptName) {
  console.error('Usage: node scripts/run-workspace-script.mjs <workspaceDir> <scriptName> [...args]')
  process.exit(1)
}

const child = spawn(process.execPath, ['--run', scriptName, ...scriptArgs], {
  cwd: resolve(workspaceDir),
  env: process.env,
  stdio: 'inherit',
})

child.on('error', () => process.exit(1))
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
