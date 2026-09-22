import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectReviewFiles, matchReviewInventory, normalizeReviewPath, parseReviewArchiveInventory
} from '../src/services/local-ingest-review-inventory.js';

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-inventory-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const listing = (members: string) => `7-Zip\n\nListing archive: sample.7z\n\n--\nPath = C:\\private\\sample.7z\nType = 7z\nPhysical Size = 1234\n\n----------\n${members}`;
const entry = (name: string, size = '9', crc = 'CBF43926', extra = '') =>
  `Path = ${name}\nSize = ${size}\nCRC = ${crc}\nAttributes = A\n${extra}\n`;
const file = (relativePath: string, size = 9, checksum = 'CBF43926') => ({ relativePath, size, crc32: checksum });

describe('strict review archive inventory', () => {
  it('ignores the archive header, skips safe directories, normalizes paths and CRC', () => {
    const parsed = parseReviewArchiveInventory(listing(
      'Path = album\nSize = 0\nFolder = +\nAttributes = D\n\n'
      + entry('album\\e\u0301.jpg', '9', 'cbf43926') + 'Path = empty.txt\nSize = 0\nAttributes = A\n'
    ));
    expect(parsed).toEqual([file('album/e\u0301.jpg'), file('empty.txt', 0, '00000000')]);
    expect(normalizeReviewPath('原目录\\image.jpg')).toBe('原目录/image.jpg');
  });

  it('requires the member separator and unambiguous fields', () => {
    expect(() => parseReviewArchiveInventory('Path = a.jpg\nSize = 9\nCRC = CBF43926')).toThrow('separator');
    expect(() => parseReviewArchiveInventory(listing(entry('a.jpg', '9', 'CBF43926', 'Size = 9')))).toThrow('Duplicate field');
    expect(() => parseReviewArchiveInventory(listing('Path = a.jpg\nnot a field\n'))).toThrow('Malformed');
    expect(parseReviewArchiveInventory(listing(''))).toEqual([]);
  });

  it.each(['../x', '/x', '\\x', 'C:\\x', 'a/../x', 'a//x', './x', 'a/./x', 'a/', 'a\0x', 'a\nx', 'x:stream', 'a. ', 'CON.txt', 'x?'])
    ('rejects unsafe path %j before inspecting its kind', unsafe => {
      expect(() => normalizeReviewPath(unsafe)).toThrow();
      expect(() => parseReviewArchiveInventory(listing(`Path = ${unsafe}\nFolder = +\n\n`))).toThrow();
    });

  it.each(['-1', '1.5', 'Infinity', '9007199254740992', '', '+1', '1e2'])('rejects invalid size %j', size => {
    expect(() => parseReviewArchiveInventory(listing(entry('a.jpg', size)))).toThrow('size');
  });

  it.each(['', '123', 'GGGGGGGG', '123456789', ' 12345678'])('requires full CRC for nonempty members %j', crc => {
    expect(() => parseReviewArchiveInventory(listing(entry('a.jpg', '9', crc)))).toThrow('CRC32');
  });

  it.each([
    'Symbolic Link = elsewhere', 'Symbolic Link = -', 'Hard Link = elsewhere', 'Hard Link = -', 'Reparse = +', 'Mode = lrwxrwxrwx',
    'Mode = prw-r--r--', 'Mode = srw-r--r--', 'Mode = brw-r--r--', 'Mode = 0120777', 'Type = fifo'
  ])('rejects link or nonregular metadata %s', extra => {
    expect(() => parseReviewArchiveInventory(listing(entry('a.jpg', '9', 'CBF43926', extra)))).toThrow();
  });

  it('recognizes POSIX ordinary files/directories and rejects contradictory markers', () => {
    expect(parseReviewArchiveInventory(listing('Path = a\nAttributes = D_ drwxr-xr-x\n\n'
      + entry('a/b.jpg', '9', 'CBF43926', 'Mode = 0100644')))).toEqual([file('a/b.jpg')]);
    expect(() => parseReviewArchiveInventory(listing('Path = a\nFolder = -\nAttributes = D\n\n'))).toThrow('Conflicting');
    expect(() => parseReviewArchiveInventory(listing('Path = a\nAttributes = A_ lrwxrwxrwx\n\n'))).toThrow();
  });

  it('rejects normalized and case-only collisions, including directory/file conflicts', () => {
    for (const members of [entry('A.jpg') + entry('a.JPG'), entry('é.jpg') + entry('e\u0301.jpg'),
      entry('album') + entry('Album/a.jpg'), 'Path = ALBUM\nFolder = +\n\n' + entry('album')]) {
      expect(() => parseReviewArchiveInventory(listing(members))).toThrow();
    }
  });
});

describe('read-only extracted tree inventory', () => {
  it('reads nested ordinary files once into SHA256 and CRC32 without writing', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'a.jpg'), '123456789');
    await fs.writeFile(path.join(root, 'empty.txt'), '');
    const before = await fs.stat(path.join(root, 'sub', 'a.jpg'));
    const result = await inspectReviewFiles(root);
    expect(result).toEqual([
      { ...file('empty.txt', 0, '00000000'), sha256: createHash('sha256').update('').digest('hex') },
      { ...file('sub/a.jpg'), sha256: createHash('sha256').update('123456789').digest('hex') }
    ]);
    expect((await fs.stat(path.join(root, 'sub', 'a.jpg'))).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(path.join(root, 'sub', 'a.jpg'), 'utf8')).toBe('123456789');
  });

  it('streams multiple chunks with CRC continuity', async () => {
    const root = await fixture();
    const payload = Buffer.alloc(200_000, 91);
    payload[100_000] = 17;
    await fs.writeFile(path.join(root, 'large.bin'), payload);
    const [actual] = await inspectReviewFiles(root);
    expect(actual).toEqual({ relativePath: 'large.bin', size: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'), crc32: crc32(payload).toString(16).padStart(8, '0').toUpperCase() });
  });

  it('rejects root and nested directory symlinks without following them', async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.writeFile(path.join(outside, 'outside.txt'), 'must not be read');
    const link = path.join(root, 'linked');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inspectReviewFiles(link)).rejects.toThrow('ordinary directory');
    await expect(inspectReviewFiles(root)).rejects.toThrow('links');
  });

  it('rejects hard-linked files and a file used as the tree root', async () => {
    const root = await fixture();
    const target = path.join(root, 'original');
    await fs.writeFile(target, 'x');
    await fs.link(target, path.join(root, 'linked'));
    await expect(inspectReviewFiles(root)).rejects.toThrow('hard-linked');
    await expect(inspectReviewFiles(target)).rejects.toThrow('ordinary directory');
  });

  it('detects a same-size file replacement while opening instead of accepting its new content', async () => {
    const root = await fixture();
    const target = path.join(root, 'a.jpg');
    await fs.writeFile(target, 'old');
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.rename(target, path.join(root, 'old.saved'));
      await fs.writeFile(target, 'new');
      return originalOpen(...args);
    });
    await expect(inspectReviewFiles(root)).rejects.toThrow('changed before reading');
  });

  it('detects directory changes, even if its initial file was read correctly', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, 'a.jpg'), '123456789');
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.writeFile(path.join(root, 'unseen.jpg'), 'other');
      return originalOpen(...args);
    });
    await expect(inspectReviewFiles(root)).rejects.toThrow('tree changed');
  });

  it('compares file metadata again after streaming and rejects a changed size', async () => {
    const root = await fixture();
    const target = path.join(root, 'a.jpg');
    await fs.writeFile(target, '123456789');
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      vi.spyOn(handle, 'stat').mockImplementation(async (options?: { bigint?: boolean }) => {
        if (++calls === 2) await fs.appendFile(target, '!');
        return originalStat(options as { bigint: true });
      });
      return handle;
    });
    await expect(inspectReviewFiles(root)).rejects.toThrow('changed while reading');
  });
});

describe('exact review delta matching', () => {
  const archive = [file('Album/a.jpg'), file('Album/empty.jpg', 0, '00000000')];
  it('accepts unchanged inventories and only the exact approved absent member', () => {
    expect(() => matchReviewInventory(archive, [...archive], [])).not.toThrow();
    expect(() => matchReviewInventory(archive, [file('album\\a.JPG', 9, 'cbf43926')], [{ relativePath: 'Album/empty.jpg', size: 0 }])).not.toThrow();
  });

  it('rejects extra, unapproved missing, changed-size and same-size changed-content entries', () => {
    expect(() => matchReviewInventory(archive, [...archive, file('extra.jpg')], [])).toThrow('extra');
    expect(() => matchReviewInventory(archive, [archive[0]], [])).toThrow('missing');
    expect(() => matchReviewInventory(archive, [file('Album/a.jpg', 8), archive[1]], [])).toThrow('size and CRC32');
    expect(() => matchReviewInventory(archive, [file('Album/a.jpg', 9, 'ABCDEF12'), archive[1]], [])).toThrow('size and CRC32');
  });

  it('does not allow removing an unknown member, a wrong size, or a file still present', () => {
    expect(() => matchReviewInventory(archive, [], [{ relativePath: 'other.jpg', size: 0 }])).toThrow('does not match');
    expect(() => matchReviewInventory(archive, [archive[0]], [{ relativePath: archive[1].relativePath, size: 1 }])).toThrow('does not match');
    expect(() => matchReviewInventory(archive, archive, [{ relativePath: archive[1].relativePath, size: 0 }])).toThrow('still present');
  });

  it('rejects duplicated, unsafe, or invalid caller-provided evidence instead of trusting typed inputs', () => {
    expect(() => matchReviewInventory([...archive, file('ALBUM/A.JPG')], archive, [])).toThrow('Duplicate');
    expect(() => matchReviewInventory(archive, [...archive, file('ALBUM/A.JPG')], [])).toThrow('Duplicate');
    expect(() => matchReviewInventory(archive, [archive[0]], [
      { relativePath: archive[1].relativePath, size: 0 }, { relativePath: 'ALBUM/EMPTY.JPG', size: 0 }
    ])).toThrow('Duplicate');
    expect(() => matchReviewInventory([file('../a')], [], [])).toThrow('Unsafe');
    expect(() => matchReviewInventory([file('a', Number.NaN)], [], [])).toThrow('size');
    expect(() => matchReviewInventory([file('a', 0, '')], [], [])).toThrow('CRC32');
  });
});
