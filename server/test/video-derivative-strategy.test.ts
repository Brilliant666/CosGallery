import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

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

describe.sequential('video derivative strategy', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let generateDerivatives: DerivativeServiceModule['generateDerivatives'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-video-derivatives-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));

    vi.resetModules();

    ({ appConfig } = await import('../src/config/env.js'));
    ({ generateDerivatives } = await import('../src/services/derivative-service.js'));
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

  it('keeps preview transcoding for large high-resolution browser-safe MP4 originals while preserving original playback eligibility', async () => {
    execFileAsyncMock.mockImplementation(createExecFileAsyncMock({
      format: {
        duration: '4.0',
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2'
      },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 2160, height: 3840, pix_fmt: 'yuv420p' },
        { codec_type: 'audio', codec_name: 'aac' }
      ]
    }));

    const sourcePath = path.join(appConfig.galleryRoot, 'clips', 'reel-1.mp4');
    const stalePreviewPath = path.join(appConfig.previewsDir, 'clips', 'reel-1.mp4');

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(path.dirname(stalePreviewPath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.alloc(32 * 1024 * 1024));

    const result = await generateDerivatives(sourcePath, 'clips/reel-1.mp4');

    expect(result.playbackStrategy).toBe('original');
    expect(result.generatedPreview).toBe(true);

    const ffmpegCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffmpeg');
    expect(ffmpegCalls).toHaveLength(2);
    expect(ffmpegCalls[0]?.[1]).toContain('libwebp');
    expect(ffmpegCalls[1]?.[1]).toContain('libx264');
    expect(ffmpegCalls[1]?.[1]).toContain(expectedVideoScaleFilter());
  });

  it('keeps preview transcoding for incompatible MP4 files', async () => {
    execFileAsyncMock.mockImplementation(createExecFileAsyncMock({
      format: {
        duration: '4.0',
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2'
      },
      streams: [
        { codec_type: 'video', codec_name: 'hevc', width: 1080, height: 1920, pix_fmt: 'yuv420p' },
        { codec_type: 'audio', codec_name: 'aac' }
      ]
    }));

    const sourcePath = path.join(appConfig.galleryRoot, 'clips', 'reel-2.mp4');

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.alloc(1024 * 1024));

    const result = await generateDerivatives(sourcePath, 'clips/reel-2.mp4', true);

    expect(result.playbackStrategy).toBe('preview');
    expect(result.generatedPreview).toBe(true);

    const ffmpegCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffmpeg');
    expect(ffmpegCalls).toHaveLength(2);
    expect(ffmpegCalls[0]?.[1]).toContain('libwebp');
    expect(ffmpegCalls[1]?.[1]).toContain('libx264');
    expect(ffmpegCalls[1]?.[1]).toContain(expectedVideoScaleFilter());
  });

  it('normalizes rotated source dimensions to display dimensions before returning metadata', async () => {
    execFileAsyncMock.mockImplementation(createExecFileAsyncMock({
      format: {
        duration: '4.0',
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2'
      },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          pix_fmt: 'yuv420p',
          side_data_list: [
            {
              rotation: -90
            }
          ]
        },
        { codec_type: 'audio', codec_name: 'aac' }
      ]
    }));

    const sourcePath = path.join(appConfig.galleryRoot, 'clips', 'reel-rotated.mp4');

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.alloc(1024 * 1024));

    const result = await generateDerivatives(sourcePath, 'clips/reel-rotated.mp4', true);

    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
  });
});

function expectedVideoScaleFilter(): string {
  return "scale='trunc(if(gt(iw,ih),min(1280,iw),min(720,iw))/2)*2':'trunc(if(gt(iw,ih),min(1280,iw)*ih/iw,min(720,iw)*ih/iw)/2)*2':flags=lanczos";
}

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
