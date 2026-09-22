import { describe, expect, it } from 'vitest';
import { runProcessWithTimeout } from '../src/utils/run-process.js';

describe('process UTF-8 output', () => {
  it('preserves stdout and stderr characters split across pipe chunks', async () => {
    const stdout = 'Path = 中文目录/写真 한글📷.webp\n';
    const stderr = '错误诊断：目录未就绪\n';
    const result = await runProcessWithTimeout(process.execPath, ['-e', `
      const fs = require('node:fs');
      const out = Buffer.from(${JSON.stringify(stdout)}, 'utf8');
      const err = Buffer.from(${JSON.stringify(stderr)}, 'utf8');
      fs.writeSync(1, out.subarray(0, 8));
      fs.writeSync(2, err.subarray(0, 1));
      setTimeout(() => {
        fs.writeSync(1, out.subarray(8));
        fs.writeSync(2, err.subarray(1));
      }, 200);
    `], 5_000);
    expect(result).toEqual({ code: 0, signal: null, stdout, stderr });
  });
});
