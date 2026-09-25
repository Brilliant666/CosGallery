import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { appConfig } from '../config/env.js';
import { RequestInputError } from './request-input-error.js';
import { runProcessWithTimeout, type ProcessRunResult } from './run-process.js';

type Runner = (command: string, args: string[], timeout: number) => Promise<ProcessRunResult>;

/** Trust is granted by local startup configuration, not a basename supplied over HTTP.
 * Pin the configured regular binary for this process; replacements require restart.
 * This is not protection against a hostile OS account that can rewrite config/code.
 */
export class TrustedSevenZip {
  readonly executable: string;
  private readonly fingerprint: string | null;

  constructor(configuredPath: string, private readonly runner: Runner = (command, args, timeout) =>
    runProcessWithTimeout(command, args, timeout, { shell: false })) {
    this.executable = configuredPath ? path.normalize(configuredPath) : '';
    try { this.fingerprint = this.inspect(); } catch { this.fingerprint = null; }
  }

  private inspect(): string {
    const executable = this.executable;
    if (!path.isAbsolute(executable) || /^[\\/]{2}/.test(executable) || /[\0\r\n]/.test(executable)) {
      throw new Error('Not an absolute local executable');
    }
    const stat = fs.lstatSync(executable, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular executable');
    const real = fs.realpathSync.native(executable);
    // Windows short names may differ from realpath without being symlinks.
    // Pin the resolved target below; a changed parent junction is detected too.
    const bytes = fs.readFileSync(executable);
    if (process.platform === 'win32') {
      if (path.extname(executable).toLowerCase() !== '.exe' || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('Not a native executable');
    } else {
      fs.accessSync(executable, fs.constants.X_OK);
      // Native Linux ELF / macOS Mach-O only, never shell/script wrappers.
      const magic = bytes.subarray(0, 4).toString('hex');
      const native = process.platform === 'darwin'
        ? ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)
        : magic === '7f454c46';
      if (!native) throw new Error('Not a native executable');
    }
    return [real, stat.dev, stat.ino, stat.size, stat.mtimeNs, createHash('sha256').update(bytes).digest('hex')].join(':');
  }

  async run(requestedPath: string, args: string[], timeout: number): Promise<ProcessRunResult> {
    if (requestedPath !== this.executable) throw new RequestInputError('7-Zip路径由本机启动配置指定，网页不能修改。', 'SEVEN_ZIP_STARTUP_OWNED');
    if (!this.fingerprint) throw new RequestInputError('请在本机配置有效的7-Zip原生可执行文件并重启服务。', 'SEVEN_ZIP_NOT_CONFIGURED');
    let current: string;
    try { current = this.inspect(); } catch { throw new RequestInputError('7-Zip文件不可用或已改变，请核对本机配置后重启服务。', 'SEVEN_ZIP_CHANGED'); }
    if (current !== this.fingerprint) throw new RequestInputError('7-Zip文件已改变，请核对本机配置后重启服务。', 'SEVEN_ZIP_CHANGED');
    return this.runner(this.executable, args, timeout);
  }
}

export const trustedSevenZip = new TrustedSevenZip(appConfig.sevenZipPath);
