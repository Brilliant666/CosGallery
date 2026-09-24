import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('persistent derivative source and recipe provenance', () => {
  let root: string;
  let source: string;
  let output: string;
  let versions: typeof import('../src/utils/derivative-version.js');
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.resetModules();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'derivative-version-'));
    source = path.join(root, 'source.png');
    output = path.join(root, 'result.webp');
    await fs.writeFile(source, 'fixture source');
    versions = await import('../src/utils/derivative-version.js');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  const write = async (output: string) => { await fs.writeFile(output, 'derivative fixture'); };
  async function version() {
    const stat = await fs.stat(source);
    return versions.derivativeVersion(versions.derivativeSourceVersion(stat.size, stat.mtimeMs), 'thumbnail');
  }
  it('upgrades only requested unknown legacy output, then reuses the persistent stamp after module reload', async () => {
    await fs.writeFile(output, 'legacy pixels with unknown source');
    const generate = vi.fn(write);
    expect(await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, generate)).toBe(true);
    const before = await fs.stat(output);
    expect(await versions.hasCurrentDerivative(output, await version())).toBe(true);
    vi.resetModules();
    versions = await import('../src/utils/derivative-version.js');
    expect(await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, generate)).toBe(false);
    expect(generate).toHaveBeenCalledOnce();
    expect((await fs.stat(output)).mtimeMs).toBe(before.mtimeMs);
  });
  it('source and recipe changes invalidate only corresponding output', async () => {
    await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, write);
    const before = await version();
    await fs.writeFile(source, 'a changed source with a different size');
    expect(await version()).not.toBe(before);
    expect(await versions.hasCurrentDerivative(output, await version())).toBe(false);
    await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, write);
    const stat = await fs.stat(source);
    const previewVersion = versions.derivativeVersion(versions.derivativeSourceVersion(stat.size, stat.mtimeMs), 'preview');
    expect(await versions.hasCurrentDerivative(output, previewVersion)).toBe(false);
  });
  it('failed generation preserves prior complete output and provenance; retries work', async () => {
    await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, write);
    await expect(versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', true, async temporary => {
      await fs.writeFile(temporary, 'partial'); throw new Error('decode failed');
    })).rejects.toThrow('decode failed');
    expect(await fs.readFile(output, 'utf8')).toBe('derivative fixture');
    expect(await versions.hasCurrentDerivative(output, await version())).toBe(true);
    expect((await fs.readdir(root)).some(name => name.includes('.tmp'))).toBe(false);
    expect(await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', true, write)).toBe(true);
  });
  it('refuses publication when the source changes during generation', async () => {
    await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, write);
    const oldVersion = await version();
    const oldStamp = await fs.readFile(`${output}.version.json`, 'utf8');
    await expect(versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', true, async temporary => {
      await write(temporary); await fs.writeFile(source, 'changed');
    })).rejects.toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
    expect(await fs.readFile(output, 'utf8')).toBe('derivative fixture');
    expect(await fs.readFile(`${output}.version.json`, 'utf8')).toBe(oldStamp);
    expect(await versions.hasCurrentDerivative(output, oldVersion)).toBe(true);
  });

  it('rejects a stale expected index before encoding, retaining old output and stamp', async () => {
    await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, write);
    const expectedVersion = await version();
    const oldStamp = await fs.readFile(`${output}.version.json`, 'utf8');
    await fs.writeFile(source, 'replacement with different source metadata');
    const encode = vi.fn(write);
    await expect(versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', true, encode,
      { expectedVersion, validate: () => undefined })).rejects.toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
    expect(encode).not.toHaveBeenCalled();
    expect(await fs.readFile(output, 'utf8')).toBe('derivative fixture');
    expect(await fs.readFile(`${output}.version.json`, 'utf8')).toBe(oldStamp);
  });

  it('checks current identity/version immediately before publication and preserves the old pair on failure', async () => {
    await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, write);
    const expectedVersion = await version();
    const oldStamp = await fs.readFile(`${output}.version.json`, 'utf8');
    let current = true;
    await expect(versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', true, async temporary => {
      await fs.writeFile(temporary, 'new complete output'); current = false;
    }, { expectedVersion, validate: () => { if (!current) throw new Error('indexed identity changed'); } })).rejects.toThrow('indexed identity changed');
    expect(await fs.readFile(output, 'utf8')).toBe('derivative fixture');
    expect(await fs.readFile(`${output}.version.json`, 'utf8')).toBe(oldStamp);
    expect((await fs.readdir(root)).some(name => name.includes('.tmp'))).toBe(false);
  });

  it('does not replace a file while a response holds its output lease and releases failed readers', async () => {
    const { withDerivativeOutputRead } = await import('../src/services/derivative-output-lock.js');
    await versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', false, write);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const reader = withDerivativeOutputRead(output, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; }); throw new Error('response aborted');
    });
    const readerFailure = expect(reader).rejects.toThrow('response aborted');
    await started;
    const replacement = vi.fn(async (temporary: string) => { await fs.writeFile(temporary, 'new result'); });
    const writing = versions.writeVersionedDerivative(source, output, 'thumbnail', 'image', true, replacement);
    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();
    expect(await fs.readFile(output, 'utf8')).toBe('derivative fixture');
    release();
    await Promise.all([readerFailure, writing]);
    expect(await fs.readFile(output, 'utf8')).toBe('new result');
  });
});
