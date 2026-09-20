import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

export type ReviewArchiveFile = { relativePath: string; size: number; crc32: string };
export type ReviewInspectedFile = ReviewArchiveFile & { sha256: string };
export type ReviewRemovedFile = { relativePath: string; size: number };

/** Normalize separators, preserving the real Unicode filename; compare keys separately. */
export function normalizeReviewPath(value: string): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f:<>"|?*]/u.test(value)) {
    throw new Error('Unsafe review relative path');
  }
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error('Unsafe review relative path');
  }
  return normalized;
}

function pathKey(value: string): string {
  return normalizeReviewPath(value).toLowerCase().normalize('NFC');
}

function checkedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid review file size');
  return value;
}

function checkedCrc(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}$/iu.test(value)) throw new Error('Invalid review file CRC32');
  return value.toUpperCase();
}

/** A file may not also be an ancestor of another entry (including case variants). */
function assertTreePaths(entries: Map<string, 'file' | 'directory'>): void {
  for (const key of entries.keys()) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (entries.get(parts.slice(0, i).join('/')) === 'file') {
        throw new Error('Review inventory has conflicting file and directory paths');
      }
    }
  }
}

function archiveEntryKind(fields: Map<string, string>): 'file' | 'directory' {
  for (const key of fields.keys()) {
    // A link target of "-" is still a link, not a negative boolean marker.
    if (/(?:symbolic|hard)\s*link|reparse/iu.test(key)) {
      throw new Error('Archive review does not support links or reparse points');
    }
  }
  const folder = fields.get('Folder');
  if (folder !== undefined && folder !== '+' && folder !== '-') throw new Error('Invalid archive folder marker');
  const attributes = fields.get('Attributes') ?? '';
  const mode = fields.get('Mode') ?? '';
  if (/reparse|\blink\b/iu.test(attributes) || /(?:^|\s)[A-Z_]*L[A-Z_]*(?:\s|$)/u.test(attributes)) {
    throw new Error('Archive review does not support links or reparse points');
  }
  const typeHints: Array<'file' | 'directory'> = [];
  if (folder !== undefined) typeHints.push(folder === '+' ? 'directory' : 'file');
  if (/(?:^|\s)[A-Z_]*D[A-Z_]*(?:\s|$)/u.test(attributes)) typeHints.push('directory');
  for (const field of [attributes, mode]) {
    const permission = field.match(/(?:^|\s)([-dlbcps?][rwxStTs-]{9})(?:\s|$)/u)?.[1];
    if (permission) {
      if (permission[0] !== '-' && permission[0] !== 'd') throw new Error('Archive review requires ordinary files and directories');
      typeHints.push(permission[0] === 'd' ? 'directory' : 'file');
    }
  }
  if (mode && !/[-dlbcps?][rwxStTs-]{9}/u.test(mode)) {
    if (!/^0?[0-7]{5,6}$/u.test(mode)) throw new Error('Unsupported archive file mode');
    const type = Number.parseInt(mode, 8) & 0o170000;
    if (type !== 0o100000 && type !== 0o040000) throw new Error('Archive review requires ordinary files and directories');
    typeHints.push(type === 0o040000 ? 'directory' : 'file');
  }
  const explicitType = fields.get('Type');
  if (explicitType) {
    if (!/^(?:file|regular file|directory)$/iu.test(explicitType)) throw new Error('Unsupported archive entry type');
    typeHints.push(explicitType.toLowerCase() === 'directory' ? 'directory' : 'file');
  }
  if (typeHints.includes('file') && typeHints.includes('directory')) throw new Error('Conflicting archive entry type');
  return typeHints[0] ?? 'file';
}

/** Parse only the member section of `7z l -slt`, never the archive header. */
export function parseReviewArchiveInventory(stdout: string): ReviewArchiveFile[] {
  const lines = stdout.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const separator = lines.findIndex(line => line === '----------');
  if (separator < 0) throw new Error('Archive review listing is missing its member separator');
  const result: ReviewArchiveFile[] = [];
  const paths = new Map<string, 'file' | 'directory'>();
  let fields = new Map<string, string>();
  const flush = () => {
    if (!fields.size) return;
    const relativePath = normalizeReviewPath(fields.get('Path') ?? '');
    const key = pathKey(relativePath);
    if (paths.has(key)) throw new Error('Duplicate normalized path in archive review inventory');
    const kind = archiveEntryKind(fields);
    paths.set(key, kind);
    if (kind === 'file') {
      const rawSize = fields.get('Size');
      if (rawSize === undefined || !/^\d+$/u.test(rawSize)) throw new Error('Invalid archive review file size');
      const size = checkedSize(Number(rawSize));
      const rawCrc = fields.get('CRC');
      const crc = size === 0 && !rawCrc ? '00000000' : checkedCrc(rawCrc ?? '');
      result.push({ relativePath, size, crc32: crc });
    }
    fields = new Map();
  };
  for (const line of lines.slice(separator + 1)) {
    if (!line) { flush(); continue; }
    const delimiter = line.indexOf(' = ');
    if (delimiter <= 0) throw new Error('Malformed archive review listing member');
    const key = line.slice(0, delimiter);
    if (fields.has(key)) throw new Error('Duplicate field in archive review listing');
    fields.set(key, line.slice(delimiter + 3));
  }
  flush();
  assertTreePaths(paths);
  return result.sort((a, b) => pathKey(a.relativePath).localeCompare(pathKey(b.relativePath), 'en'));
}

function sameStats(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
    && before.nlink === after.nlink;
}

/** Read just the specified extracted tree, without following links or writing anything. */
export async function inspectReviewFiles(root: string): Promise<ReviewInspectedFile[]> {
  const absoluteRoot = path.resolve(root);
  const rootStat = await fs.lstat(absoluteRoot, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Review root must be an ordinary directory');
  const result: ReviewInspectedFile[] = [];
  const paths = new Map<string, 'file' | 'directory'>();
  const inspected: Array<{ absolute: string; stat: BigIntStats }> = [{ absolute: absoluteRoot, stat: rootStat }];
  const directories: Array<{ absolute: string; names: string[] }> = [];
  const walk = async (directory: string, parent: string) => {
    const names = (await fs.readdir(directory)).sort();
    directories.push({ absolute: directory, names });
    for (const name of names) {
      const relativePath = normalizeReviewPath(parent ? `${parent}/${name}` : name);
      const key = pathKey(relativePath);
      if (paths.has(key)) throw new Error('Duplicate normalized path in extracted review inventory');
      const absolute = path.join(directory, name);
      const before = await fs.lstat(absolute, { bigint: true });
      if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
        throw new Error('Review inventory does not support links or non-ordinary entries');
      }
      inspected.push({ absolute, stat: before });
      if (before.isDirectory()) {
        paths.set(key, 'directory');
        await walk(absolute, relativePath);
        continue;
      }
      if (before.nlink !== 1n) throw new Error('Review inventory does not support hard-linked files');
      paths.set(key, 'file');
      const size = checkedSize(Number(before.size));
      const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!sameStats(before, await handle.stat({ bigint: true }))) throw new Error('Review file changed before reading');
        const hash = createHash('sha256');
        let checksum = 0;
        let bytesRead = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          const data = chunk as Buffer;
          hash.update(data);
          checksum = crc32(data, checksum);
          bytesRead += data.length;
        }
        if (bytesRead !== size || !sameStats(before, await handle.stat({ bigint: true }))
          || !sameStats(before, await fs.lstat(absolute, { bigint: true }))) {
          throw new Error('Review file changed while reading');
        }
        result.push({ relativePath, size, sha256: hash.digest('hex'), crc32: checksum.toString(16).padStart(8, '0').toUpperCase() });
      } finally {
        await handle.close();
      }
    }
  };
  await walk(absoluteRoot, '');
  // Recheck after the whole traversal, including empty directories and earlier files.
  for (const entry of inspected) {
    if (!sameStats(entry.stat, await fs.lstat(entry.absolute, { bigint: true }))) {
      throw new Error('Review tree changed while inspecting');
    }
  }
  // Directory timestamps can be coalesced (notably on Windows). Verify actual
  // membership too, so a new file cannot escape the captured manifest.
  for (const directory of directories) {
    const current = (await fs.readdir(directory.absolute)).sort();
    if (current.length !== directory.names.length || current.some((name, index) => name !== directory.names[index])) {
      throw new Error('Review tree changed while inspecting');
    }
  }
  assertTreePaths(paths);
  return result.sort((a, b) => pathKey(a.relativePath).localeCompare(pathKey(b.relativePath), 'en'));
}

/** Approvals account for exact missing members; they never waive other evidence. */
export function matchReviewInventory(
  archive: ReviewArchiveFile[], actual: ReviewArchiveFile[], removed: ReviewRemovedFile[]
): void {
  const index = <T extends ReviewRemovedFile>(entries: T[], label: string): Map<string, T> => {
    const map = new Map<string, T>();
    const paths = new Map<string, 'file' | 'directory'>();
    for (const entry of entries) {
      const key = pathKey(entry.relativePath);
      checkedSize(entry.size);
      if ('crc32' in entry) checkedCrc(entry.crc32 as string);
      if (map.has(key)) throw new Error(`Duplicate normalized path in ${label} review inventory`);
      map.set(key, entry);
      paths.set(key, 'file');
    }
    assertTreePaths(paths);
    return map;
  };
  const original = index(archive, 'archive');
  const current = index(actual, 'actual');
  const approved = index(removed, 'removed');
  for (const [key, entry] of approved) {
    const expected = original.get(key);
    if (!expected || expected.size !== entry.size) throw new Error('Approved removal does not match archive path and size');
    if (current.has(key)) throw new Error('Approved removed file is still present');
  }
  for (const [key, entry] of current) {
    const expected = original.get(key);
    if (!expected) throw new Error('Unapproved extra file in extracted review inventory');
    if (expected.size !== entry.size || checkedCrc(expected.crc32) !== checkedCrc(entry.crc32)) {
      throw new Error('Extracted review file does not match archive size and CRC32');
    }
  }
  for (const key of original.keys()) {
    if (!current.has(key) && !approved.has(key)) throw new Error('Unapproved missing file in extracted review inventory');
  }
}
