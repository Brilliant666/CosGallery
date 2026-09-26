import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrustedSevenZip, trustedSevenZip } from '../src/utils/trusted-seven-zip.js';
import { defaultLocalIngestSettings, LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosgallery-trusted-tool-'));
  roots.push(root);
  const executable = path.join(root, process.platform === 'win32' ? 'approved.exe' : 'approved');
  fs.writeFileSync(executable, Buffer.from(process.platform === 'win32' ? [0x4d, 0x5a, 0, 1] : [0x7f, 0x45, 0x4c, 0x46, 1]));
  fs.chmodSync(executable, 0o700);
  const runner = vi.fn(async () => ({ code: 0, signal: null, stdout: '7-Zip synthetic', stderr: '' }));
  return { root, executable, runner };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('startup-owned 7-Zip boundary', () => {
  it('only invokes the exact configured pinned native binary, with arguments kept separate', async () => {
    const f = fixture(), tool = new TrustedSevenZip(f.executable, f.runner);
    const args = ['i', 'a path with spaces'];
    await tool.run(f.executable, args, 1000);
    expect(f.runner).toHaveBeenCalledExactlyOnceWith(f.executable, args, 1000);
    await expect(tool.run(path.join(f.root, '7z.exe'), [], 1000)).rejects.toMatchObject({ code: 'SEVEN_ZIP_STARTUP_OWNED' });
    expect(f.runner).toHaveBeenCalledTimes(1);
  });
  it.each(['7z', '', '\\\\server\\share\\7z.exe', 'https://example.invalid/7z.exe'])('rejects nonlocal or unconfigured input %s before spawn', async input => {
    const f = fixture(), tool = new TrustedSevenZip(input, f.runner);
    await expect(tool.run(tool.executable, ['i'], 1000)).rejects.toMatchObject({ code: 'SEVEN_ZIP_NOT_CONFIGURED' });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('rejects scripts renamed to an exe and changed binary contents without trusting basename', async () => {
    const f = fixture();
    fs.writeFileSync(f.executable, '#!/bin/sh\necho unsafe');
    await expect(new TrustedSevenZip(f.executable, f.runner).run(f.executable, ['i'], 1000)).rejects.toMatchObject({ code: 'SEVEN_ZIP_NOT_CONFIGURED' });
    const g = fixture(), tool = new TrustedSevenZip(g.executable, g.runner);
    fs.appendFileSync(g.executable, 'replacement');
    await expect(tool.run(g.executable, ['i'], 1000)).rejects.toMatchObject({ code: 'SEVEN_ZIP_CHANGED' });
    expect(g.runner).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('ignores legacy DB executable selection and refuses HTTP-style replacement before persistence or validation', async () => {
    const f = fixture(), gallery = path.join(f.root, 'gallery');fs.mkdirSync(gallery);
    const values = new Map<string, string>([['local_ingest.settings', JSON.stringify({ ...defaultLocalIngestSettings(gallery), sevenZipPath: f.executable })]]);
    const repository = { get: (key: string) => values.get(key) ?? null, setMany: vi.fn() };
    const service = new LocalIngestSettingsService(gallery, repository);
    expect(service.get().sevenZipPath).toBe(trustedSevenZip.executable);
    expect(() => service.save({ ...service.get(), sevenZipPath: f.executable })).toThrow('启动配置');
    await expect(service.validate({ ...service.get(), sevenZipPath: f.executable })).rejects.toMatchObject({ code: 'SEVEN_ZIP_STARTUP_OWNED' });
    expect(repository.setMany).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
  });
});
