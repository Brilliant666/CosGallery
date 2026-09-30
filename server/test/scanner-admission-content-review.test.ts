import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe.sequential('work-scoped scanner content review boundary', () => {
  let root: string;
  let gallery: string;
  let scanner: typeof import('../src/services/scanner-service.js')['scannerService'];
  let manager: typeof import('../src/db/database.js')['databaseManager'];
  let derivatives: typeof import('../src/services/derivative-service.js');
  let repositories: typeof import('../src/db/repositories.js');
  let config: typeof import('../src/config/env.js')['appConfig'];
  const creator = 'Synthetic Scanner Creator';
  const work = 'Synthetic Album';

  beforeEach(async () => {
    vi.resetModules();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-scanner-content-review-'));
    gallery = path.join(root, 'gallery');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COS_GALLERY_MODE', '1');
    vi.stubEnv('DERIVATIVE_MODE', 'lazy');
    vi.stubEnv('SCAN_MEDIA_ERROR_MODE', 'skip');
    vi.stubEnv('SCAN_DISCOVERY_CONCURRENCY', '1');
    vi.stubEnv('DATA_ROOT', path.join(root, 'data'));
    vi.stubEnv('GALLERY_ROOT', gallery);
    vi.stubEnv('DB_DIR', path.join(root, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(root, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(root, 'previews'));
    vi.stubEnv('APP_ENV_FILE', path.join(root, 'absent.env'));
    vi.stubEnv('APP_RUN_CONFIG_FILE', path.join(root, 'absent.run.xml'));
    ({ databaseManager: manager } = await import('../src/db/database.js'));
    derivatives = await import('../src/services/derivative-service.js');
    repositories = await import('../src/db/repositories.js');
    ({ appConfig: config } = await import('../src/config/env.js'));
    ({ scannerService: scanner } = await import('../src/services/scanner-service.js'));
    await fs.mkdir(path.join(gallery, creator, work), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    manager?.close();
    vi.unstubAllEnvs();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('cosgallery-scanner-content-review-')) {
      throw new Error('Refusing cleanup outside the isolated scanner fixture');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });

  const filename = (name: string, album = work) => path.join(gallery, creator, album, name);
  const scan = () => scanner.scanCosCreators([creator], 'isolated-content-review', { workFolderName: work });
  async function good(name = 'good.jpg', album = work) {
    await fs.mkdir(path.dirname(filename(name, album)), { recursive: true });
    await sharp({ create: { width: 12, height: 16, channels: 3, background: '#2468aa' } }).jpeg().toFile(filename(name, album));
  }
  async function corrupt(name = 'bad.jpg') { await fs.writeFile(filename(name), 'synthetic corrupt image bytes'); }
  const issue = { kind: 'review', code: 'MEDIA_CONTENT_REVIEW_REQUIRED', message: '图集含有无法解码或超出处理限制的文件，请核对文件处置' };

  it('diagnoses a real corrupt image and preserves the raw missing-index error', async () => {
    await good(); await corrupt();
    const result = await scan();
    expect(result?.status).toBe('failed');
    expect(result?.admissionIssue).toMatchObject(issue);
    expect(result?.error_text).toContain('LEGACY_POST_SPLIT_UNMAPPED_ITEM');
    expect(result?.error_text).toContain('unsupported image format');
    expect(await fs.readFile(filename('bad.jpg'), 'utf8')).toBe('synthetic corrupt image bytes');
    expect(manager.connection.prepare('SELECT COUNT(*) n FROM posts').get()?.n).toBe(0);
  });

  it('marks an entirely undecodable album for review without requiring a mapped image', async () => {
    await corrupt();
    const result = await scan();
    expect(result?.status).toBe('completed_with_errors');
    expect(result?.admissionIssue).toMatchObject(issue);
  });

  it('diagnoses a real JPEG pixel-limit error in fail mode', async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).jpeg().toBuffer();
    let patched = false;
    for (let offset = 2; offset < bytes.length - 9;) {
      const marker = bytes[offset + 1], size = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        bytes.writeUInt16BE(32768, offset + 5); bytes.writeUInt16BE(32768, offset + 7); patched = true; break;
      }
      offset += size + 2;
    }
    expect(patched).toBe(true);
    await fs.writeFile(filename('pixel-limit.jpeg'), bytes); config.scanMediaErrorMode = 'fail';
    const result = await scan();
    expect(result?.status).toBe('failed');
    expect(result?.admissionIssue).toMatchObject(issue);
    expect(result?.error_text).toContain('Input image exceeds pixel limit');
    expect(await fs.readFile(filename('pixel-limit.jpeg'))).toEqual(bytes);
  });

  it('keeps an operational cause out of the review branch even with decoder-looking text', async () => {
    await corrupt();
    const cause = Object.assign(new Error('disk failed'), { code: 'EIO' });
    vi.spyOn(derivatives, 'readMediaMetadata').mockRejectedValueOnce(new Error('Input file has corrupt header: wrapped fault', { cause }));
    const result = await scan();
    expect(result?.status).toBe('completed_with_errors');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('does not classify a mixture of content and operational errors as review', async () => {
    await good(); await corrupt('bad.jpg'); await corrupt('system.jpg');
    const read = derivatives.readMediaMetadata;
    vi.spyOn(derivatives, 'readMediaMetadata').mockImplementation(async (source, ...options) => {
      if (path.basename(source) === 'system.jpg') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return read(source, ...options);
    });
    const result = await scan();
    expect(result?.status).toBe('failed');
    expect(result?.error_text).toContain('unsupported image format');
    expect(result?.error_text).toContain('permission denied');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('does not classify a file that changed during diagnosis as review', async () => {
    await corrupt();
    vi.spyOn(derivatives, 'readMediaMetadata').mockImplementationOnce(async source => {
      await fs.writeFile(source, 'changed source with a different size');
      throw new Error('Input file contains unsupported image format');
    });
    const result = await scan();
    expect(result?.error_text).toContain('Media changed during metadata diagnosis');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('rejects a source changed after the discovery snapshot before decoding begins', async () => {
    await corrupt();
    const stat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (source, options) => {
      const result = await stat(source, options);
      if (String(source) === filename('bad.jpg')) await fs.writeFile(filename('bad.jpg'), 'changed after discovery with a different size');
      return result;
    });
    const read = vi.spyOn(derivatives, 'readMediaMetadata');
    const result = await scan();
    expect(result?.error_text).toContain('Media source identity changed during discovery');
    expect(result?.admissionIssue).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects hard-linked sources as an operational identity uncertainty', async () => {
    await corrupt(); await fs.link(filename('bad.jpg'), filename('alias.jpg'));
    const result = await scan();
    expect(result?.error_text).toContain('not a regular single-link file');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('accepts stable full-precision identities above the numeric Stats inode range', async () => {
    await good();
    const highInode = 11821949028016703n;
    expect(BigInt(Number(highInode))).not.toBe(highInode);
    const lstat = fs.lstat, stat = fs.stat;
    vi.spyOn(fs, 'lstat').mockImplementation(async (source, options) => {
      const result = await lstat(source, options);
      if (String(source) === filename('good.jpg')) Object.assign(result, { ino: highInode });
      return result;
    });
    vi.spyOn(fs, 'stat').mockImplementation(async (source, options) => {
      const result = await stat(source, options);
      if (String(source) === filename('good.jpg')) Object.assign(result, { ino: Number(highInode), mtimeMs: Math.ceil(result.mtimeMs) });
      return result;
    });
    const result = await scan();
    expect(result?.status).toBe('completed');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('rejects an exact inode change even when its rounded numeric value is identical', async () => {
    await corrupt();
    const highInode = 11821949028016703n;
    expect(Number(highInode)).toBe(Number(highInode + 1n));
    const lstat = fs.lstat, stat = fs.stat;
    let observations = 0;
    vi.spyOn(fs, 'lstat').mockImplementation(async (source, options) => {
      const result = await lstat(source, options);
      if (String(source) === filename('bad.jpg')) Object.assign(result, { ino: ++observations >= 4 ? highInode + 1n : highInode });
      return result;
    });
    vi.spyOn(fs, 'stat').mockImplementation(async (source, options) => {
      const result = await stat(source, options);
      if (String(source) === filename('bad.jpg')) Object.assign(result, { ino: Number(highInode) });
      return result;
    });
    const result = await scan();
    expect(result?.error_text).toContain('Media changed during metadata diagnosis');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('bounds the combined fatal diagnostic and sample text without making unknown failures reviewable', async () => {
    await corrupt(); config.scanMediaErrorMode = 'fail';
    vi.spyOn(derivatives, 'readMediaMetadata').mockRejectedValueOnce(new Error('unknown failure '.repeat(1000)));
    const result = await scan();
    expect(result?.status).toBe('failed');
    expect(result?.error_text?.length).toBeLessThanOrEqual(8000);
    expect(result?.error_text).toContain('unknown failure');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('does not classify a database error with decoder-looking text as review', async () => {
    await good();
    vi.spyOn(repositories.imageRepository, 'upsert').mockImplementationOnce(() => {
      throw new Error('Input file contains unsupported image format');
    });
    expect((await scan())?.admissionIssue).toBeUndefined();
  });

  it('keeps filesystem discovery errors outside the review branch', async () => {
    await good();
    const stat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (source, options) => {
      if (String(source) === filename('good.jpg')) throw Object.assign(new Error('filesystem input/output error'), { code: 'EIO' });
      return stat(source, options);
    });
    const result = await scan();
    expect(result?.error_text).toContain('filesystem input/output error');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('keeps derivative output errors outside the metadata-only review boundary', async () => {
    await good(); config.derivativeMode = 'eager';
    vi.spyOn(derivatives, 'generateDerivatives').mockRejectedValueOnce(Object.assign(new Error('output is not permitted'), { code: 'EPERM' }));
    const result = await scan();
    expect(result?.status).toBe('completed_with_errors');
    expect(result?.error_text).toContain('output is not permitted');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('keeps unscoped creator scans compatible without admission review metadata', async () => {
    await corrupt();
    const result = await scanner.scanCosCreators([creator], 'isolated-unscoped');
    expect(result?.status).toBe('completed_with_errors');
    expect(result?.admissionIssue).toBeUndefined();
  });

  it('returns each queued run and its own review issue instead of the latest scan row', async () => {
    await corrupt(); await good('good.jpg', 'Other Synthetic Album');
    const latest = vi.spyOn(repositories.scanRunRepository, 'latest').mockImplementation(() => {
      throw new Error('A scoped scan must return its own run');
    });
    const [failed, completed] = await Promise.all([
      scan(),
      scanner.scanCosCreators([creator], 'isolated-other-album', { workFolderName: 'Other Synthetic Album' })
    ]);
    expect(failed?.id).not.toBe(completed?.id);
    expect(failed?.status).toBe('completed_with_errors');
    expect(failed?.admissionIssue).toMatchObject(issue);
    expect(completed?.status).toBe('completed');
    expect(completed?.admissionIssue).toBeUndefined();
    expect(manager.connection.prepare('SELECT status FROM scan_runs WHERE id=?').get(failed!.id)?.status).toBe(failed?.status);
    expect(latest).not.toHaveBeenCalled();
  });
});
