import fs from 'node:fs';
import path from 'node:path';
import { recycleBinAdapter, type RecycleBinAdapter } from './recycle-bin-adapter.js';

export type AdmissionParentCleanupResult = {
  status: 'recycled' | 'not_applicable' | 'not_empty' | 'failed';
  parentPath: string;
  message?: string;
  /** A failed restore never overwrites a newly created original directory. */
  retainedPath?: string;
};

const reserved = (name: string) => /^\.local-(?:admission|review)-/i.test(name);
const normalized = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (left: string, right: string) => normalized(left) === normalized(right);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function statOrMissing(target: string) {
  try { return fs.lstatSync(target); } catch (error) { if (missing(error)) return undefined; throw error; }
}
function assertRealDirectory(target: string) {
  const stat = fs.lstatSync(target);
  let current = target;
  // Inspect ancestors instead of comparing spelling with realpath: Windows
  // short names such as BRILLI~1 are not junctions and are valid temp paths.
  while (true) {
    const entry = current === target ? stat : fs.lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Cleanup requires an ordinary directory, without symbolic links or junctions');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return stat;
}

/** Explicit batch finalization only. Never call this from a waiting-area/list read. */
export async function recycleEmptyAdmissionParent(options: {
  waitingRoot: string;
  parentPath: string;
  assertIdle: () => void | Promise<void>;
  recycler?: Pick<RecycleBinAdapter, 'recycle'>;
}): Promise<AdmissionParentCleanupResult> {
  const parentPath = path.resolve(options.parentPath);
  let holdingRoot: string | undefined;
  let heldPath: string | undefined;
  const result = (status: AdmissionParentCleanupResult['status'], message?: string): AdmissionParentCleanupResult => ({ status, parentPath, ...(message ? { message } : {}) });
  // Restore only when the original name is still absent. Windows rename does
  // not replace an existing directory; a concurrent writer retains its path.
  function restore(): string | undefined {
    if (!heldPath) return undefined;
    try {
      if (!statOrMissing(heldPath)) return undefined;
      if (statOrMissing(parentPath)) return heldPath;
      fs.renameSync(heldPath, parentPath); heldPath = undefined; return undefined;
    }
    catch { return heldPath; }
  }
  try {
    if (!path.isAbsolute(options.waitingRoot) || !path.isAbsolute(options.parentPath)) throw new Error('Cleanup paths must be absolute');
    const waitingRoot = path.resolve(options.waitingRoot);
    if (!samePath(path.dirname(parentPath), waitingRoot) || reserved(path.basename(parentPath)) || samePath(parentPath, waitingRoot)) {
      throw new Error('Cleanup target must be a non-reserved direct child of the waiting root');
    }
    assertRealDirectory(waitingRoot);
    if (!statOrMissing(parentPath)) return result('not_applicable');
    await options.assertIdle();
    assertRealDirectory(waitingRoot);
    const original = assertRealDirectory(parentPath);
    if (fs.readdirSync(parentPath).length) return result('not_empty');
    // Reserve an unpredictable container exclusively, rather than overwriting
    // an existing quarantine or another creator's folder.
    holdingRoot = fs.mkdtempSync(path.join(waitingRoot, '.local-admission-empty-'));
    heldPath = path.join(holdingRoot, path.basename(parentPath));
    fs.renameSync(parentPath, heldPath);
    await options.assertIdle();
    const held = assertRealDirectory(heldPath);
    if (held.dev !== original.dev || held.ino !== original.ino) throw new Error('Cleanup directory identity changed');
    if (fs.readdirSync(heldPath).length) {
      const retainedPath = restore();
      return { ...result('not_empty', 'New content was detected; nothing was recycled'), ...(retainedPath ? { retainedPath } : {}) };
    }
    const recycled = await (options.recycler ?? recycleBinAdapter).recycle(heldPath);
    if (!recycled.recycled || statOrMissing(heldPath)) throw new Error('Recycle operation did not remove the empty directory');
    heldPath = undefined;
    return result('recycled');
  } catch (error) {
    const retainedPath = restore();
    return { ...result('failed', error instanceof Error ? error.message : String(error)), ...(retainedPath ? { retainedPath } : {}) };
  } finally {
    // Remove only our own empty wrapper, never recursively remove content.
    if (holdingRoot) { try { fs.rmdirSync(holdingRoot); } catch { /* retained content is reported above */ } }
  }
}
