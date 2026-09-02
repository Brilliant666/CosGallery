import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';

export type ProcessRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export class ProcessTimeoutError extends Error {
  constructor() {
    super('Process timed out and its process tree was terminated');
    this.name = 'ProcessTimeoutError';
  }
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

export async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await runTaskkill(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== 'ESRCH') throw fallbackError;
      }
    }
  }
}

export function runProcessWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  options: SpawnOptionsWithoutStdio = {}
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      detached: process.platform === 'win32' ? false : true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let closed = false;
    let closeResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let timedOut = false;
    let terminationFinished = false;
    let settled = false;

    const finish = (): void => {
      if (settled || !closed || (timedOut && !terminationFinished)) return;
      settled = true;
      if (timedOut) {
        reject(new ProcessTimeoutError());
        return;
      }
      resolve({
        code: closeResult?.code ?? null,
        signal: closeResult?.signal ?? null,
        stdout,
        stderr
      });
    };

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      closed = true;
      closeResult = { code, signal };
      finish();
    });

    const timer = setTimeout(() => {
      if (closed || settled) return;
      timedOut = true;
      const pid = child.pid;
      if (!pid) {
        terminationFinished = true;
        child.kill('SIGKILL');
        finish();
        return;
      }
      void terminateProcessTree(pid).finally(() => {
        terminationFinished = true;
        if (!closed) child.kill('SIGKILL');
        finish();
      });
    }, timeoutMs);
  });
}
