import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type AppConfigModule = typeof import('../src/config/env.js');
type DerivativeServiceModule = typeof import('../src/services/derivative-service.js');

describe.sequential('animated image derivatives', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let generateDerivatives: DerivativeServiceModule['generateDerivatives'];
  let readMediaMetadata: DerivativeServiceModule['readMediaMetadata'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-animated-images-'));

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

  it('keeps animated image previews animated while leaving thumbnails static', async () => {
    const relativePath = 'albums/animated-post.webp';
    const sourcePath = path.join(appConfig.galleryRoot, relativePath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await createAnimatedWebp(sourcePath);

    const metadata = await readMediaMetadata(sourcePath, 'image');
    expect(metadata.width).toBe(24);
    expect(metadata.height).toBe(12);
    expect(metadata.isAnimated).toBe(true);

    const result = await generateDerivatives(sourcePath, relativePath, true);

    expect(result.previewPath).toBe('albums/animated-post.webp');
    expect(result.thumbnailPath).toBe('albums/animated-post.webp');
    expect(result.generatedPreview).toBe(true);
    expect(result.generatedThumbnail).toBe(true);
    expect(result.isAnimated).toBe(true);

    const previewMetadata = await sharp(path.join(appConfig.previewsDir, result.previewPath), { animated: true }).metadata();
    const thumbnailMetadata = await sharp(path.join(appConfig.thumbnailsDir, result.thumbnailPath)).metadata();

    expect(previewMetadata.pages).toBe(2);
    expect(previewMetadata.pageHeight).toBe(12);
    expect(previewMetadata.width).toBe(24);
    expect(thumbnailMetadata.pages ?? 1).toBe(1);
    expect(thumbnailMetadata.width).toBe(24);
    expect(thumbnailMetadata.height).toBe(12);
  });
});

async function createAnimatedWebp(filePath: string): Promise<void> {
  const firstFrame = await sharp({
    create: {
      width: 24,
      height: 12,
      channels: 4,
      background: { r: 255, g: 88, b: 88, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
  const secondFrame = await sharp({
    create: {
      width: 24,
      height: 12,
      channels: 4,
      background: { r: 88, g: 128, b: 255, alpha: 1 }
    }
  })
    .png()
    .toBuffer();

  await sharp([firstFrame, secondFrame], { join: { animated: true } })
    .webp({ effort: 4, delay: [120, 120], loop: 0 })
    .toFile(filePath);
}
