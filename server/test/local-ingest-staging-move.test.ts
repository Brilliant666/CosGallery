import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStagingMoveManifest, finishStagingMove, readStagingMoveManifest,
  STAGING_MOVE_MANIFEST, verifyStagingMoveState, type StagingMoveBinding
} from '../src/services/local-ingest-staging-move.js';

const roots: string[] = [];

async function fixture(firstName = 'first.jpg', firstKind: 'image' | 'advertisement' = 'image') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-move-'));
  roots.push(root);
  const processingPath = path.join(root, 'job');
  const levelTwoRoot = path.join(processingPath, 'level-2');
  const contentRoot = path.join(levelTwoRoot, 'wrapper');
  await fs.mkdir(contentRoot, { recursive: true });
  await fs.writeFile(path.join(contentRoot, firstName), 'first image');
  await fs.writeFile(path.join(contentRoot, 'second.jpg'), 'second image');
  await fs.writeFile(path.join(contentRoot, 'ad.txt'), 'ad');
  const binding: StagingMoveBinding = {
    jobId: 7, sourceWorkId: 8, archiveDownloadTaskId: 9, sourceArchiveSha256: 'SYNTHETIC-HASH',
    targetPath: path.join(root, 'gallery-target'), processingPath, levelTwoRoot
  };
  const files = [
    { relativePath: firstName, kind: firstKind, size: 11 },
    { relativePath: 'second.jpg', kind: 'image' as const, size: 12 },
    { relativePath: 'ad.txt', kind: 'advertisement' as const, size: 2 }
  ];
  const summary = {
    sourceWorkId: 8, archiveDownloadTaskId: 9, sourceArchiveSha256: binding.sourceArchiveSha256,
    plannedTargetPath: binding.targetPath, readyPath: path.join(processingPath, 'ready'),
    imageCount: firstKind === 'image' ? 2 : 1, videoCount: 0,
    totalMediaCount: firstKind === 'image' ? 2 : 1, totalBytes: firstKind === 'image' ? 23 : 12,
    warnings: ['keep original validation']
  };
  const manifest = await createStagingMoveManifest(binding, contentRoot, files, summary);
  expect(manifest).not.toBeNull();
  return { root, binding, contentRoot, manifest: manifest!, files, summary };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe.sequential('Local ingest durable staging moves', () => {
  it.each(['492.jpg', '009-01.JPG'])('keeps exact known image advertisement %s recoverable outside staged media', async name => {
    const f = await fixture(name, 'advertisement');
    await finishStagingMove(f.binding, f.manifest);
    expect(await fs.readFile(path.join(f.contentRoot, name), 'utf8')).toBe('first image');
    expect(await fs.readdir(path.join(f.binding.processingPath, 'ready'))).toEqual(['second.jpg']);
    const recovered = (await readStagingMoveManifest(f.binding))!;
    expect(recovered.summary).toEqual(f.summary);
    await finishStagingMove(f.binding, recovered);
    expect(await fs.readFile(path.join(f.contentRoot, name), 'utf8')).toBe('first image');
  });

  it('does not permit arbitrary JPG advertisements or reinterpret historical image classifications', async () => {
    await expect(fixture('normal.jpg', 'advertisement')).rejects.toMatchObject({ code: 'STAGING_MOVE_REVIEW_REQUIRED' });
    const f = await fixture('492.jpg');
    const original = JSON.stringify(f.manifest);
    await finishStagingMove(f.binding, f.manifest);
    const recovered = (await readStagingMoveManifest(f.binding))!;
    expect(JSON.stringify(recovered)).toBe(original);
    expect(recovered.summary).toMatchObject({ imageCount: 2, totalBytes: 23 });
    expect(await fs.readFile(path.join(f.binding.processingPath, 'ready', '492.jpg'), 'utf8')).toBe('first image');
    await finishStagingMove(f.binding, recovered);
  });

  it('moves without copying bytes, preserving identity and leaving advertisements behind', async () => {
    const f = await fixture();
    const copy = vi.spyOn(fs, 'copyFile');
    const before = await fs.lstat(path.join(f.contentRoot, 'first.jpg'), { bigint: true });
    await finishStagingMove(f.binding, f.manifest);
    const destination = path.join(f.binding.processingPath, 'ready', 'first.jpg');
    const after = await fs.lstat(destination, { bigint: true });
    expect(await fs.readFile(destination, 'utf8')).toBe('first image');
    expect(after.ino).toBe(before.ino);
    expect(after.dev).toBe(before.dev);
    expect(after.nlink).toBe(1n);
    expect(await fs.readdir(f.contentRoot)).toEqual(['ad.txt']);
    expect(copy).not.toHaveBeenCalled();
    expect((await readStagingMoveManifest(f.binding))!.summary).toEqual(f.summary);
  });

  it('recovers all counts after the ready-directory rename fails', async () => {
    const f = await fixture();
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic rename interruption'));
    await expect(finishStagingMove(f.binding, f.manifest)).rejects.toThrow('synthetic rename interruption');
    rename.mockRestore();
    const recovered = (await readStagingMoveManifest(f.binding))!;
    expect(recovered.summary).toMatchObject({ imageCount: 2, totalBytes: 23 });
    expect((await verifyStagingMoveState(f.binding, recovered)).pending).toHaveLength(0);
    await finishStagingMove(f.binding, recovered);
    expect(await fs.readdir(path.join(f.binding.processingPath, 'ready'))).toHaveLength(2);
  });

  it('requires review after link succeeds but unlink fails, without deleting either copy', async () => {
    const f = await fixture();
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('synthetic unlink interruption'));
    await expect(finishStagingMove(f.binding, f.manifest)).rejects.toMatchObject({ code: 'STAGING_MOVE_REVIEW_REQUIRED' });
    unlink.mockRestore();
    const retryUnlink = vi.spyOn(fs, 'unlink');
    await expect(finishStagingMove(f.binding, f.manifest)).rejects.toMatchObject({ code: 'STAGING_MOVE_REVIEW_REQUIRED' });
    expect(retryUnlink).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.contentRoot, 'first.jpg'), 'utf8')).toBe('first image');
    expect(await fs.readFile(path.join(f.binding.processingPath, 'ready-building-move', 'first.jpg'), 'utf8')).toBe('first image');
  });

  it.each(['missing', 'replacement', 'mtime', 'extra', 'duplicate'] as const)('rejects a %s inventory before any movement', async (change) => {
    const f = await fixture();
    const source = path.join(f.contentRoot, 'first.jpg');
    if (change === 'missing') await fs.unlink(source);
    if (change === 'replacement') {
      await fs.rename(source, path.join(f.root, 'old-file'));
      await fs.writeFile(source, 'replacement');
    }
    if (change === 'mtime') await fs.utimes(source, new Date(0), new Date(0));
    if (change === 'extra') await fs.writeFile(path.join(f.contentRoot, 'extra.jpg'), 'extra');
    if (change === 'duplicate') {
      await fs.mkdir(path.join(f.binding.processingPath, 'ready-building-move'));
      await fs.copyFile(source, path.join(f.binding.processingPath, 'ready-building-move', 'first.jpg'));
    }
    const link = vi.spyOn(fs, 'link');
    await expect(finishStagingMove(f.binding, f.manifest)).rejects.toMatchObject({ code: 'STAGING_MOVE_REVIEW_REQUIRED' });
    expect(link).not.toHaveBeenCalled();
    await expect(fs.access(path.join(f.contentRoot, 'second.jpg'))).resolves.toBeUndefined();
  });

  it.each(['sourceArchiveSha256', 'sourceWorkId', 'archiveDownloadTaskId', 'targetPath'] as const)('rejects a changed %s binding', async (field) => {
    const f = await fixture();
    const binding = { ...f.binding, [field]: typeof f.binding[field] === 'number' ? 999 : 'different' };
    await expect(readStagingMoveManifest(binding)).rejects.toMatchObject({ code: 'STAGING_MOVE_REVIEW_REQUIRED' });
    expect(await fs.readdir(f.contentRoot)).toHaveLength(3);
  });

  it('rejects extra files in ready rather than trusting a completed directory', async () => {
    const f = await fixture();
    await finishStagingMove(f.binding, f.manifest);
    await fs.writeFile(path.join(f.binding.processingPath, 'ready', 'extra.jpg'), 'extra');
    await expect(verifyStagingMoveState(f.binding, f.manifest)).rejects.toMatchObject({ code: 'STAGING_MOVE_REVIEW_REQUIRED' });
  });

  it('preserves an unexpected destination created immediately before link', async () => {
    const f = await fixture();
    const original = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementationOnce(async (source, destination) => {
      await fs.writeFile(destination, 'do not overwrite');
      return original(source, destination);
    });
    await expect(finishStagingMove(f.binding, f.manifest)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(f.binding.processingPath, 'ready-building-move', 'first.jpg'), 'utf8')).toBe('do not overwrite');
    expect(await fs.readFile(path.join(f.contentRoot, 'first.jpg'), 'utf8')).toBe('first image');
  });

  it('selects copy for another device before writing a manifest or moving files', async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.binding.processingPath, STAGING_MOVE_MANIFEST));
    const stats = await fs.stat(f.binding.processingPath, { bigint: true });
    vi.spyOn(fs, 'stat').mockResolvedValueOnce({ ...stats, dev: stats.dev + 1n } as never);
    expect(await createStagingMoveManifest(f.binding, f.contentRoot, f.files, f.summary)).toBeNull();
    await expect(fs.access(path.join(f.binding.processingPath, STAGING_MOVE_MANIFEST))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(f.contentRoot)).toHaveLength(3);
  });

  it('does not fall back to copying after an unsupported link operation', async () => {
    const f = await fixture();
    const copy = vi.spyOn(fs, 'copyFile');
    vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('unsupported link'), { code: 'ENOTSUP' }));
    await expect(finishStagingMove(f.binding, f.manifest)).rejects.toMatchObject({ code: 'ENOTSUP' });
    expect(copy).not.toHaveBeenCalled();
    expect(await fs.readdir(f.contentRoot)).toHaveLength(3);
  });

  it('rejects manifest traversal and linked source directories without touching outside data', async () => {
    const f = await fixture();
    const filename = path.join(f.binding.processingPath, STAGING_MOVE_MANIFEST);
    const tampered = structuredClone(f.manifest);
    tampered.files[0].relativePath = '../outside.jpg';
    await fs.writeFile(filename, JSON.stringify(tampered));
    await expect(readStagingMoveManifest(f.binding)).rejects.toMatchObject({ code: 'STAGING_MOVE_REVIEW_REQUIRED' });
    await fs.writeFile(filename, JSON.stringify(f.manifest));
    const preserved = path.join(f.root, 'preserved-content');
    await fs.rename(f.contentRoot, preserved);
    await fs.symlink(preserved, f.contentRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readStagingMoveManifest(f.binding)).rejects.toMatchObject({ code: 'STAGING_MOVE_REVIEW_REQUIRED' });
    expect(await fs.readFile(path.join(preserved, 'first.jpg'), 'utf8')).toBe('first image');
  });
});
