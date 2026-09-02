import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const RECYCLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$target = [Environment]::GetEnvironmentVariable('FOLDERGRAM_RECYCLE_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Recycle target is missing' }
if ([System.IO.File]::Exists($target)) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
    $target,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  )
} elseif ([System.IO.Directory]::Exists($target)) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $target,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  )
} else {
  throw 'Recycle target does not exist'
}
`;

function exists(targetPath: string): Promise<boolean> {
  return fs.access(targetPath).then(() => true, () => false);
}

function runPowerShellRecycle(targetPath: string): Promise<void> {
  const encoded = Buffer.from(RECYCLE_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env: { ...process.env, FOLDERGRAM_RECYCLE_TARGET: targetPath },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Recycle operation exited with code ${code ?? 'unknown'}`));
    });
  });
}

export type RecycleBinResult = {
  targetPath: string;
  recycled: boolean;
};

export class RecycleBinAdapter {
  async recycle(targetPath: string): Promise<RecycleBinResult> {
    const absolutePath = path.resolve(targetPath);
    if (!(await exists(absolutePath))) {
      throw new Error('Recycle target does not exist');
    }
    if (process.platform !== 'win32') {
      throw new Error('Windows Recycle Bin is unavailable on this platform');
    }
    await runPowerShellRecycle(absolutePath);
    if (await exists(absolutePath)) {
      throw new Error('Recycle operation returned without removing the original path');
    }
    return { targetPath: absolutePath, recycled: true };
  }

  async smokeTest(processingRoot: string): Promise<RecycleBinResult> {
    await fs.mkdir(processingRoot, { recursive: true });
    const sentinel = path.join(processingRoot, `recycle-bin-smoke-test-${randomUUID()}.txt`);
    await fs.writeFile(sentinel, 'Foldergram recycle-bin smoke test\n', { flag: 'wx' });
    return this.recycle(sentinel);
  }
}

export const recycleBinAdapter = new RecycleBinAdapter();
