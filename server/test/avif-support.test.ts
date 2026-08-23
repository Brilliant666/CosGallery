import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');
const { execFileMock, execFileAsyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileAsyncMock: vi.fn()
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(execFileMock, {
    [PROMISIFY_CUSTOM]: execFileAsyncMock
  })
}));

type AppConfigModule = typeof import('../src/config/env.js');
type DerivativeServiceModule = typeof import('../src/services/derivative-service.js');

describe.sequential('AVIF derivative strategy', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let generateDerivatives: DerivativeServiceModule['generateDerivatives'];
  let generateThumbnailDerivative: DerivativeServiceModule['generateThumbnailDerivative'];
  let generatePreviewDerivative: DerivativeServiceModule['generatePreviewDerivative'];
  let readMediaMetadata: DerivativeServiceModule['readMediaMetadata'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-avif-derivatives-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));

    vi.resetModules();

    ({ appConfig } = await import('../src/config/env.js'));
    ({ generateDerivatives, generatePreviewDerivative, generateThumbnailDerivative, readMediaMetadata } = await import('../src/services/derivative-service.js'));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    execFileMock.mockReset();
    execFileAsyncMock.mockReset();
    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);
  });

  it('keeps static AVIF images on the Sharp image path so alpha survives in derivatives', async () => {
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === 'ffprobe') {
        throw new Error('ffprobe should not be called for static AVIF');
      }

      return {
        stdout: '',
        stderr: ''
      };
    });

    const sourcePath = path.join(appConfig.galleryRoot, 'albums', 'transparent.avif');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await sharp({
      create: {
        width: 24,
        height: 12,
        channels: 4,
        background: { r: 255, g: 88, b: 88, alpha: 0.5 }
      }
    })
      .avif({ effort: 4 })
      .toFile(sourcePath);

    const result = await generateDerivatives(sourcePath, 'albums/transparent.avif', true);

    expect(result.mediaType).toBe('image');
    expect(result.isAnimated).toBe(false);
    expect(result.generatedPreview).toBe(true);
    expect(result.generatedThumbnail).toBe(true);

    const ffmpegCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffmpeg');
    expect(ffmpegCalls).toHaveLength(0);

    const previewMetadata = await sharp(path.join(appConfig.previewsDir, result.previewPath)).metadata();
    const thumbnailMetadata = await sharp(path.join(appConfig.thumbnailsDir, result.thumbnailPath)).metadata();

    expect(previewMetadata.hasAlpha).toBe(true);
    expect(thumbnailMetadata.hasAlpha).toBe(true);
    expect(execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffprobe')).toHaveLength(0);
  });

  it('reads static AVIF metadata without requiring ffprobe', async () => {
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === 'ffprobe') {
        throw new Error('ffprobe should not be called for static AVIF metadata');
      }

      return {
        stdout: '',
        stderr: ''
      };
    });

    const sourcePath = path.join(appConfig.galleryRoot, 'albums', 'metadata-only.avif');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await sharp({
      create: {
        width: 20,
        height: 10,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 0.8 }
      }
    })
      .avif({ effort: 4 })
      .toFile(sourcePath);

    const metadata = await readMediaMetadata(sourcePath, 'image');

    expect(metadata.mediaType).toBe('image');
    expect(metadata.isAnimated).toBe(false);
    expect(metadata.width).toBe(20);
    expect(metadata.height).toBe(10);
    expect(execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffprobe')).toHaveLength(0);
  });

  it('routes animated AVIF image sequences through ffmpeg while keeping image semantics', async () => {
    execFileAsyncMock.mockImplementation(createExecFileAsyncMock(animatedAvifProbePayload()));

    const sourcePath = path.join(appConfig.galleryRoot, 'albums', 'animated.avif');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from('animated-avif'));

    const result = await generateDerivatives(sourcePath, 'albums/animated.avif', true);

    expect(result.mediaType).toBe('image');
    expect(result.isAnimated).toBe(true);
    expect(result.durationMs).toBeNull();
    expect(result.takenAt).toBeNull();
    expect(result.generatedPreview).toBe(true);
    expect(result.generatedThumbnail).toBe(true);
    expect(result.previewPath).toBe('albums/animated.webp');
    expect(result.thumbnailPath).toBe('albums/animated.webp');

    const ffprobeCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffprobe');
    const ffmpegCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffmpeg');
    expect(ffprobeCalls).toHaveLength(1);
    expect(ffmpegCalls).toHaveLength(2);
    expect(ffmpegCalls[0]?.[1]).toContain('0:v:1');
    expect(ffmpegCalls[0]?.[1].some((arg: string) => arg.includes('thumbnail'))).toBe(true);
    expect(ffmpegCalls[1]?.[1]).toContain('0:v:1');
    expect(ffmpegCalls[1]?.[1].some((arg: string) => arg.includes("scale='min(1500,iw)':-2:flags=lanczos"))).toBe(true);
    expect(ffmpegCalls[1]?.[1]).toContain('-loop');
  });

  it('uses the animated AVIF ffmpeg thumbnail path during thumbnail-only rebuilds', async () => {
    execFileAsyncMock.mockImplementation(createExecFileAsyncMock(animatedAvifProbePayload()));

    const sourcePath = path.join(appConfig.galleryRoot, 'albums', 'animated-thumb.avif');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from('animated-avif-thumb'));

    const result = await generateThumbnailDerivative(sourcePath, 'albums/animated-thumb.avif', true);

    expect(result.generatedThumbnail).toBe(true);
    expect(result.thumbnailPath).toBe('albums/animated-thumb.webp');

    const ffprobeCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffprobe');
    const ffmpegCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffmpeg');
    expect(ffprobeCalls).toHaveLength(1);
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0]?.[1]).toContain('0:v:1');
    expect(ffmpegCalls[0]?.[1].some((arg: string) => arg.includes('thumbnail'))).toBe(true);
  });

  it('uses the animated AVIF ffmpeg preview path during preview-only generation', async () => {
    execFileAsyncMock.mockImplementation(createExecFileAsyncMock(animatedAvifProbePayload()));

    const sourcePath = path.join(appConfig.galleryRoot, 'albums', 'animated-preview.avif');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from('animated-avif-preview'));

    const result = await generatePreviewDerivative(sourcePath, 'albums/animated-preview.avif', true);

    expect(result.generatedPreview).toBe(true);
    expect(result.previewPath).toBe('albums/animated-preview.webp');

    const ffprobeCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffprobe');
    const ffmpegCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffmpeg');
    expect(ffprobeCalls).toHaveLength(1);
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0]?.[1]).toContain('0:v:1');
    expect(ffmpegCalls[0]?.[1].some((arg: string) => arg.includes("scale='min(1500,iw)':-2:flags=lanczos"))).toBe(true);
  });
});

function createExecFileAsyncMock(payload: unknown) {
  return async (command: string) => {
    if (command === 'ffprobe') {
      return {
        stdout: JSON.stringify(payload),
        stderr: ''
      };
    }

    return {
      stdout: '',
      stderr: ''
    };
  };
}

function animatedAvifProbePayload() {
  return {
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      tags: {
        major_brand: 'avis',
        compatible_brands: 'avismsf1miafMA1B',
        creation_time: '2020-09-13T22:30:30.000000Z'
      }
    },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'av1',
        width: 800,
        height: 450,
        pix_fmt: 'yuv420p',
        nb_frames: '1',
        tags: {
          title: 'Image'
        }
      },
      {
        codec_type: 'video',
        codec_name: 'av1',
        width: 800,
        height: 450,
        pix_fmt: 'yuv420p',
        duration: '10.844167',
        nb_frames: '325',
        tags: {
          handler_name: 'GPAC avifs'
        }
      }
    ]
  };
}
