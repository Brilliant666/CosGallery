import { describe, expect, it, vi } from 'vitest';
import { VideoProviderLoader, type MediaContext } from 'vidstack';
import { ReelOriginalLoader } from './reel-original-loader';

// Exercise the actual browser provider; Node's package export is an SSR stub.
vi.mock('vidstack', () => import('../../node_modules/vidstack/dev/vidstack.js'));

describe('scoped native reel loader', () => {
  it('only opts same-origin scoped originals into native attempts', () => {
    const loader = new ReelOriginalLoader();
    expect(loader.canPlay({ src: '/api/reels/7/original?v=abc', type: 'video/quicktime' })).toBe(true);
    expect(loader.canPlay({ src: '/api/reels/media/70/original?v=abc', type: 'video/quicktime' })).toBe(true);
    expect(loader.canPlay({ src: 'https://example.invalid/api/reels/media/70/original', type: 'video/quicktime' })).toBe(false);
    expect(loader.canPlay({ src: '/api/reels/media/70/remux', type: 'video/mp4' })).toBe(false);
    expect(loader.canPlay({ src: 'https://example.invalid/api/reels/7/original', type: 'video/quicktime' })).toBe(false);
    expect(loader.canPlay({ src: '/api/reels/7/remux', type: 'video/mp4' })).toBe(false);
    expect(loader.canPlay({ src: '/api/reels/7/original', type: 'text/html' })).toBe(false);
  });

  it('uses native video.src rather than MIME-filtered source while preserving identity', async () => {
    const loader = new ReelOriginalLoader();
    const video = document.createElement('video');
    vi.spyOn(video, 'load').mockImplementation(() => {});
    loader.target = video;
    const context = { $state: { clipStartTime: () => 0, clipEndTime: () => 0 } } as unknown as MediaContext;
    const provider = await loader.load(context);
    const source = { src: '/api/reels/media/70/original?v=abc', type: 'video/quicktime' };
    await provider.loadSource(source, 'metadata');
    expect(video.getAttribute('src')).toBe(source.src);
    expect(video.querySelector('source')).toBeNull();
    expect(provider.currentSrc).toEqual(source);
    expect(video.load).toHaveBeenCalledOnce();
    expect(loader).toBeInstanceOf(VideoProviderLoader);
  });
});
