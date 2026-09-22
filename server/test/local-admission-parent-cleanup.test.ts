import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recycleEmptyAdmissionParent } from '../src/services/local-admission-parent-cleanup.js';

describe('explicit empty admission parent cleanup', () => {
  let root: string, waitingRoot: string, parentPath: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-parent-cleanup-'));
    waitingRoot = path.join(root, 'waiting'); parentPath = path.join(waitingRoot, 'Synthetic Creator');
    fs.mkdirSync(parentPath, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function setup(assertIdle: () => void | Promise<void> = () => {}) {
    const recycle = vi.fn(async (targetPath: string) => {
      fs.renameSync(targetPath, path.join(root, 'synthetic-recycle'));
      return { targetPath, recycled: true };
    });
    return { options: { waitingRoot, parentPath, assertIdle, recycler: { recycle } }, recycle };
  }
  function held() {
    const wrapper = fs.readdirSync(waitingRoot).find(name => name.startsWith('.local-admission-empty-'))!;
    return path.join(waitingRoot, wrapper, path.basename(parentPath));
  }
  it('recycles only the explicit empty parent and a repeat is a no-op', async () => {
    fs.mkdirSync(path.join(waitingRoot, 'Another Creator'));
    const { options, recycle } = setup();
    expect((await recycleEmptyAdmissionParent(options)).status).toBe('recycled');
    expect((await recycleEmptyAdmissionParent(options)).status).toBe('not_applicable');
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(waitingRoot)).toEqual(['Another Creator']);
    expect(fs.statSync(path.join(root, 'synthetic-recycle')).isDirectory()).toBe(true);
  });
  it.each(['photo.jpg', '.local-admission-attachments'])('preserves non-empty parents including %s', async name => {
    if (name.startsWith('.')) fs.mkdirSync(path.join(parentPath, name)); else fs.writeFileSync(path.join(parentPath, name), 'media');
    const { options, recycle } = setup();
    expect((await recycleEmptyAdmissionParent(options)).status).toBe('not_empty');
    expect(recycle).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(parentPath, name))).toBe(true);
  });
  it('rejects roots, nested, external, relative and reserved targets', async () => {
    const { options, recycle } = setup();
    for (const target of [waitingRoot, path.join(parentPath, 'nested'), root, 'relative', path.join(waitingRoot, '.local-review-held')]) {
      expect((await recycleEmptyAdmissionParent({ ...options, parentPath: target })).status).toBe('failed');
    }
    expect(recycle).not.toHaveBeenCalled(); expect(fs.existsSync(parentPath)).toBe(true);
  });
  it('rejects symbolic-link or junction parents and roots without following them', async () => {
    const real = path.join(root, 'real'); fs.mkdirSync(real);
    fs.rmdirSync(parentPath); fs.symlinkSync(real, parentPath, process.platform === 'win32' ? 'junction' : 'dir');
    const { options, recycle } = setup();
    expect((await recycleEmptyAdmissionParent(options)).status).toBe('failed');
    const linkedRoot = path.join(root, 'linked'); fs.symlinkSync(waitingRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await recycleEmptyAdmissionParent({ ...options, waitingRoot: linkedRoot, parentPath: path.join(linkedRoot, 'Other') })).status).toBe('failed');
    expect(recycle).not.toHaveBeenCalled(); expect(fs.existsSync(real)).toBe(true);
  });
  it('refuses an active task without moving anything', async () => {
    const { options, recycle } = setup(() => { throw Error('Synthetic active claim'); });
    expect(await recycleEmptyAdmissionParent(options)).toMatchObject({ status: 'failed', message: 'Synthetic active claim' });
    expect(recycle).not.toHaveBeenCalled(); expect(fs.readdirSync(waitingRoot)).toEqual(['Synthetic Creator']);
  });
  it('restores after activity begins during the final guard', async () => {
    let calls = 0;
    const { options, recycle } = setup(() => { if (++calls === 2) throw Error('Synthetic new claim'); });
    expect((await recycleEmptyAdmissionParent(options)).status).toBe('failed');
    expect(recycle).not.toHaveBeenCalled(); expect(fs.readdirSync(waitingRoot)).toEqual(['Synthetic Creator']);
  });
  it('restores concurrent new content instead of recycling it', async () => {
    let calls = 0;
    const { options, recycle } = setup(() => { if (++calls === 2) fs.writeFileSync(path.join(held(), 'new.jpg'), 'new content'); });
    expect((await recycleEmptyAdmissionParent(options)).status).toBe('not_empty');
    expect(recycle).not.toHaveBeenCalled(); expect(fs.readFileSync(path.join(parentPath, 'new.jpg'), 'utf8')).toBe('new content');
    expect(fs.readdirSync(waitingRoot)).toEqual(['Synthetic Creator']);
  });
  it('does not overwrite a recreated original name and reports the retained location', async () => {
    let calls = 0;
    const { options, recycle } = setup(() => {
      if (++calls === 2) { fs.writeFileSync(path.join(held(), 'held.jpg'), 'held'); fs.mkdirSync(parentPath); fs.writeFileSync(path.join(parentPath, 'new.jpg'), 'new'); }
    });
    const result = await recycleEmptyAdmissionParent(options);
    expect(result.status).toBe('not_empty'); expect(result.retainedPath).toBeTruthy(); expect(recycle).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(result.retainedPath!, 'held.jpg'), 'utf8')).toBe('held');
    expect(fs.readFileSync(path.join(parentPath, 'new.jpg'), 'utf8')).toBe('new');
  });
  it('restores on recycler failure without changing completed admission facts', async () => {
    const { options, recycle } = setup(); recycle.mockRejectedValueOnce(Error('Synthetic recycler failed'));
    expect(await recycleEmptyAdmissionParent(options)).toMatchObject({ status: 'failed', message: 'Synthetic recycler failed' });
    expect(fs.readdirSync(waitingRoot)).toEqual(['Synthetic Creator']);
  });
  it('rechecks for files written while awaiting the initial idle guard', async () => {
    const { options, recycle } = setup(async () => { fs.writeFileSync(path.join(parentPath, 'new.jpg'), 'new'); });
    expect((await recycleEmptyAdmissionParent(options)).status).toBe('not_empty');
    expect(recycle).not.toHaveBeenCalled(); expect(fs.readFileSync(path.join(parentPath, 'new.jpg'), 'utf8')).toBe('new');
  });
  it('rejects a file instead of a directory', async () => {
    fs.rmdirSync(parentPath); fs.writeFileSync(parentPath, 'not a folder');
    const { options, recycle } = setup();
    expect((await recycleEmptyAdmissionParent(options)).status).toBe('failed'); expect(recycle).not.toHaveBeenCalled();
  });
  it('does not report success if a recycler leaves the directory in place', async () => {
    const { options, recycle } = setup(); recycle.mockImplementationOnce(async targetPath => ({ targetPath, recycled: true }));
    expect(await recycleEmptyAdmissionParent(options)).toMatchObject({ status: 'failed', message: 'Recycle operation did not remove the empty directory' });
    expect(fs.readdirSync(waitingRoot)).toEqual(['Synthetic Creator']);
  });
});
