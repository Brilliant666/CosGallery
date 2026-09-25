import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'

const [workspaceDir, scriptName, ...scriptArgs] = process.argv.slice(2)

if (!workspaceDir || !scriptName) {
  console.error('Usage: node scripts/run-workspace-script.mjs <workspaceDir> <scriptName> [...args]')
  process.exit(1)
}

// Node --run on Windows can misdecode a non-ASCII working directory before
// locating package.json. Use the calling package manager instead, still under
// this exact Node executable. Do not resolve another Node/pnpm from system PATH.
const packageManager = process.env.npm_execpath
if (!packageManager || !existsSync(packageManager)) {
  console.error('Run this workspace helper through pnpm run <root-script>; a valid npm_execpath is required.')
  process.exit(1)
}

// Preserve the conventional separator accepted by the former node --run entry.
const forwardedArgs = scriptArgs[0] === '--' ? scriptArgs.slice(1) : scriptArgs
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
const childEnv = { ...process.env, [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ''}` }
const child = spawn(process.execPath, [packageManager, 'run', scriptName, ...forwardedArgs], {
  cwd: resolve(workspaceDir),
  env: childEnv,
  stdio: 'inherit',
  windowsHide: true,
})

const forwardSignal = signal => child.kill(signal)
const onInterrupt = () => forwardSignal('SIGINT')
const onTerminate = () => forwardSignal('SIGTERM')
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)

child.on('error', () => process.exit(1))
child.on('exit', (code, signal) => {
  process.off('SIGINT', onInterrupt)
  process.off('SIGTERM', onTerminate)
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
