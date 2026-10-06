import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGalleryVideoPlayback } from '../api/gallery';
import type { ReelPlayback } from '../types/api';
import VideoMediaPlayer from './VideoMediaPlayer.vue';
import { ReelOriginalLoader } from '../utils/reel-original-loader';

vi.mock('../api/gallery', () => ({ fetchGalleryVideoPlayback: vi.fn() }));
enableAutoUnmount(afterEach);

let autoReady = true;
let playResult: (() => Promise<void>) | undefined;
class NativePlayer extends HTMLElement {
  muted = true;
  paused = true;
  ready = false;
  duration = 0;
  currentTime = 0;
  sources: unknown[] = [];
  playCalls = 0;
  pauseCalls = 0;
  private selected: unknown;
  get src() { return this.selected; }
  set src(value: unknown) {
    this.selected = value;
    this.sources.push(value);
    this.ready = false;
    this.duration = 0;
    if (value && autoReady) queueMicrotask(() => {
      if (this.selected !== value) return;
      this.ready = true;
      this.dispatchEvent(new CustomEvent('can-play'));
    });
  }
  get state() { return { source: this.selected || { src: '' }, canPlay: this.ready }; }
  async play() {
    this.playCalls += 1;
    if (playResult) await playResult();
    this.paused = false;
  }
  async pause() { this.pauseCalls += 1; this.paused = true; }
}
customElements.define('media-player', NativePlayer);
customElements.define('media-provider', class extends HTMLElement {});

const original: ReelPlayback = {
  originalUrl: '/api/gallery/media/42/original?v=one', originalMimeType: 'video/quicktime',
  previewUrl: '/previews/42.mp4?v=one', previewReady: false
};
const remux = { ...original, remuxUrl: '/api/gallery/media/42/remux?v=one', remuxMimeType: 'video/mp4', remuxReady: false };
function mountNative(props = {}) {
  return mount(VideoMediaPlayer, { props: { src: original.previewUrl, mediaId: 42, autoplay: true, ...props } });
}
function playerOf(wrapper: ReturnType<typeof mountNative>) { return wrapper.get('media-player').element as NativePlayer; }
function fail(player: NativePlayer, detail: unknown) { player.dispatchEvent(new CustomEvent('error', { detail })); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}

beforeEach(() => {
  autoReady = true;
  playResult = undefined;
  vi.mocked(fetchGalleryVideoPlayback).mockReset().mockResolvedValue(original);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { headers: { 'content-type': 'video/quicktime' } })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('VideoMediaPlayer scoped original playback', () => {
  it('selects the scoped MOV original without ever assigning or probing a cold preview', async () => {
    const plan = deferred<ReelPlayback>();
    vi.mocked(fetchGalleryVideoPlayback).mockReturnValueOnce(plan.promise);
    const wrapper = mountNative();
    const player = playerOf(wrapper);
    expect(player.src).toBe('');
    expect(wrapper.text()).toContain('正在选择播放源');
    plan.resolve(original);
    await flushPromises();
    expect(player.src).toEqual({ src: original.originalUrl, type: 'video/quicktime' });
    expect(player.sources).not.toContainEqual({ src: original.previewUrl, type: 'video/mp4' });
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchGalleryVideoPlayback).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    expect((wrapper.get('media-provider').element as any).loaders[0]).toBeInstanceOf(ReelOriginalLoader);
    expect((player as any).autoPlay).toBe(false);
    expect(wrapper.find('media-play-button').exists()).toBe(false);
  });

  it('retains the shared preview path without a media ID', async () => {
    const wrapper = mountNative({ mediaId: undefined });
    await flushPromises();
    expect(fetchGalleryVideoPlayback).not.toHaveBeenCalled();
    expect(playerOf(wrapper).src).toEqual({ src: original.previewUrl, type: 'video/mp4' });
    expect(wrapper.find('media-play-button').exists()).toBe(true);
    expect((wrapper.get('media-provider').element as any).loaders).toEqual([]);
  });

  it('does not offer the legacy HD switch for native playback', async () => {
    const wrapper = mountNative({ originalUrl: '/legacy/original', playbackStrategy: 'original', width: 4000, height: 3000 });
    await flushPromises();
    expect(wrapper.vm.hasHdOption).toBe(false);
    await wrapper.vm.toggleHd();
    expect(wrapper.emitted('toggle-hd')).toBeUndefined();
  });

  it('uses supplied duration immediately and receives duration before the first time-update', async () => {
    const wrapper = mountNative({ durationMs: 65000, autoplay: false });
    expect(wrapper.text()).toContain('0:00 / 1:05');
    await flushPromises();
    const player = playerOf(wrapper);
    expect(player.playCalls).toBe(0);
    expect(wrapper.text()).not.toContain('正在准备播放');
    player.dispatchEvent(new CustomEvent('can-play', { detail: { duration: 92 } }));
    await flushPromises();
    expect(wrapper.text()).toContain('0:00 / 1:32');
    player.dispatchEvent(new CustomEvent('duration-change', { detail: 104 }));
    await flushPromises();
    expect(wrapper.text()).toContain('0:00 / 1:44');
    player.duration = 108;
    player.dispatchEvent(new Event('loaded-metadata'));
    await flushPromises();
    expect(wrapper.text()).toContain('0:00 / 1:48');
    expect(wrapper.emitted('loaded-metadata')?.[0]).toEqual([{ naturalWidth: 0, naturalHeight: 0, duration: 108 }]);
  });

  it('remembers a manual play request while waiting for can-play', async () => {
    autoReady = false;
    const wrapper = mountNative({ autoplay: false });
    await flushPromises();
    const player = playerOf(wrapper);
    await wrapper.get('button.video-media-player__control').trigger('click');
    expect(player.playCalls).toBe(0);
    player.ready = true;
    player.dispatchEvent(new Event('can-play'));
    await flushPromises();
    expect(player.playCalls).toBe(1);
    expect(player.paused).toBe(false);
  });

  it('keeps autoplay rejection blocked and uses the same state machine from the footer and surface', async () => {
    playResult = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    const wrapper = mountNative();
    await flushPromises();
    const player = playerOf(wrapper);
    expect(wrapper.text()).toContain('浏览器阻止了自动播放');
    expect(player.playCalls).toBe(1);
    player.dispatchEvent(new Event('can-play'));
    await flushPromises();
    expect(player.playCalls).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchGalleryVideoPlayback).toHaveBeenCalledTimes(1);
    playResult = undefined;
    await wrapper.get('button.video-media-player__control').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(player.paused).toBe(false);
    await wrapper.get('.video-media-player').trigger('click');
    expect(player.paused).toBe(true);
    player.dispatchEvent(new Event('can-play'));
    await flushPromises();
    expect(player.playCalls).toBe(2);
  });

  it('requires healthy original HTTP before lossless remux and explicitly offers preview after an ambiguous remux failure', async () => {
    vi.mocked(fetchGalleryVideoPlayback).mockResolvedValue(remux);
    const wrapper = mountNative();
    await flushPromises();
    const player = playerOf(wrapper);
    autoReady = false;
    fail(player, { code: 4 });
    fail(player, { code: 4 });
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(original.originalUrl, expect.objectContaining({ method: 'HEAD' }));
    expect(player.src).toEqual({ src: remux.remuxUrl, type: 'video/mp4' });
    expect(wrapper.text()).toContain('无损换封装');
    fail(player, { code: 4 });
    await flushPromises();
    expect(player.src).toEqual({ src: remux.remuxUrl, type: 'video/mp4' });
    const previewButton = wrapper.findAll('.video-media-player__status button').find(button => button.text().includes('兼容预览'))!;
    await previewButton.trigger('click');
    await flushPromises();
    expect(player.src).toEqual({ src: original.previewUrl, type: 'video/mp4' });
    expect(wrapper.text()).toContain('首次可能需要转换');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a failed lookup without using the unverified preview', async () => {
    vi.mocked(fetchGalleryVideoPlayback).mockRejectedValueOnce(new Error('network'));
    const wrapper = mountNative();
    await flushPromises();
    expect(playerOf(wrapper).src).toBe('');
    expect(fetch).not.toHaveBeenCalled();
    await wrapper.get('.video-media-player__status button').trigger('click');
    await flushPromises();
    expect(playerOf(wrapper).src).toEqual({ src: original.originalUrl, type: 'video/quicktime' });
  });

  it('shows buffering without changing sources and respects an external pause after readiness', async () => {
    const wrapper = mountNative({ title: 'Clip title' });
    await flushPromises();
    const player = playerOf(wrapper);
    expect(wrapper.get('.video-media-player').attributes('aria-label')).toContain('Clip title');
    for (const event of ['waiting', 'stalled']) {
      player.dispatchEvent(new Event(event));
      await flushPromises();
      expect(wrapper.text()).toContain('正在缓冲');
      expect(player.src).toEqual({ src: original.originalUrl, type: 'video/quicktime' });
      player.dispatchEvent(new Event('playing'));
      await flushPromises();
      expect(wrapper.text()).not.toContain('正在缓冲');
    }
    player.paused = true;
    player.dispatchEvent(new Event('pause'));
    await flushPromises();
    expect(wrapper.find('.video-media-player__pause-indicator').exists()).toBe(true);
    const calls = player.playCalls;
    player.dispatchEvent(new Event('can-play'));
    player.dispatchEvent(new Event('stalled'));
    await flushPromises();
    expect(player.playCalls).toBe(calls);
    expect(player.paused).toBe(true);
    expect(wrapper.text()).not.toContain('正在缓冲');
    expect(fetchGalleryVideoPlayback).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores late resolution and stale timing after changing media identity', async () => {
    const first = deferred<ReelPlayback>();
    const second = deferred<ReelPlayback>();
    vi.mocked(fetchGalleryVideoPlayback).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = mountNative({ durationMs: 65000 });
    await wrapper.setProps({ mediaId: 43, src: '/previews/43.mp4', durationMs: 120000 });
    first.resolve(original);
    await flushPromises();
    const player = playerOf(wrapper);
    expect(player.src).toBe('');
    expect(vi.mocked(fetchGalleryVideoPlayback).mock.calls[0]?.[1]?.aborted).toBe(true);
    player.dispatchEvent(new CustomEvent('duration-change', { detail: 999 }));
    await flushPromises();
    expect(wrapper.text()).toContain('0:00 / 2:00');
    second.resolve({ ...original, originalUrl: '/api/gallery/media/43/original', previewUrl: '/previews/43.mp4' });
    await flushPromises();
    expect(player.src).toEqual({ src: '/api/gallery/media/43/original', type: 'video/quicktime' });
  });

  it('ignores old play rejection after switching identity', async () => {
    const pending = deferred<void>();
    playResult = () => pending.promise;
    const wrapper = mountNative();
    await flushPromises();
    playResult = undefined;
    vi.mocked(fetchGalleryVideoPlayback).mockResolvedValue({ ...original, originalUrl: '/api/gallery/media/43/original' });
    await wrapper.setProps({ mediaId: 43 });
    await flushPromises();
    pending.reject(new DOMException('old blocked', 'NotAllowedError'));
    await flushPromises();
    expect(playerOf(wrapper).paused).toBe(false);
    expect(wrapper.text()).not.toContain('浏览器阻止');
  });

  it('does not apply late fallback after changing identity', async () => {
    const fallback = deferred<ReelPlayback>();
    vi.mocked(fetchGalleryVideoPlayback).mockResolvedValueOnce(original).mockReturnValueOnce(fallback.promise);
    const wrapper = mountNative();
    await flushPromises();
    fail(playerOf(wrapper), { code: 3 });
    await flushPromises();
    vi.mocked(fetchGalleryVideoPlayback).mockResolvedValue({ ...original, originalUrl: '/api/gallery/media/43/original' });
    await wrapper.setProps({ mediaId: 43 });
    await flushPromises();
    fallback.resolve(remux);
    await flushPromises();
    expect(playerOf(wrapper).src).toEqual({ src: '/api/gallery/media/43/original', type: 'video/quicktime' });
  });

  it('aborts unresolved selection on unmount without starting playback', async () => {
    const pending = deferred<ReelPlayback>();
    vi.mocked(fetchGalleryVideoPlayback).mockReturnValueOnce(pending.promise);
    const wrapper = mountNative();
    const player = playerOf(wrapper);
    wrapper.unmount();
    pending.resolve(original);
    await flushPromises();
    expect(vi.mocked(fetchGalleryVideoPlayback).mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(player.playCalls).toBe(0);
    expect(player.paused).toBe(true);
  });
});
