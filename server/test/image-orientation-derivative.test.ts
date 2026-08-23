import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type AppConfigModule = typeof import('../src/config/env.js');
type DerivativeServiceModule = typeof import('../src/services/derivative-service.js');

describe.sequential('image orientation metadata', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let generateDerivatives: DerivativeServiceModule['generateDerivatives'];
  let readMediaMetadata: DerivativeServiceModule['readMediaMetadata'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-image-orientation-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));

    vi.resetModules();

    ({ appConfig } = await import('../src/config/env.js'));
    ({ generateDerivatives, readMediaMetadata } = await import('../src/services/derivative-service.js'));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);
  });

  it('stores portrait display dimensions for EXIF-rotated JPEGs and keeps previews larger than thumbnails', async () => {
    const relativePath = 'phones/rotated-note9.jpg';
    const sourcePath = path.join(appConfig.galleryRoot, relativePath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 196, g: 212, b: 242 }
      }
    })
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6 })
      .toFile(sourcePath);

    const metadata = await readMediaMetadata(sourcePath, 'image');
    expect(metadata.width).toBe(800);
    expect(metadata.height).toBe(1200);
    expect(metadata.displayOrientation).toBe(6);

    const result = await generateDerivatives(sourcePath, relativePath, true);
    expect(result.width).toBe(800);
    expect(result.height).toBe(1200);

    const previewMetadata = await sharp(path.join(appConfig.previewsDir, result.previewPath)).metadata();
    const thumbnailMetadata = await sharp(path.join(appConfig.thumbnailsDir, result.thumbnailPath)).metadata();

    expect(previewMetadata.width).toBe(800);
    expect(previewMetadata.height).toBe(1200);
    expect(thumbnailMetadata.width).toBe(640);
    expect(thumbnailMetadata.height).toBe(960);
  });
});
