import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useAppStore } from '../stores/app';
import type { FeedItem, FolderSummary } from '../types/api';
import ReelPlayerCard from './ReelPlayerCard.vue';
import { fetchReelPlayback } from '../api/gallery';
import type { ReelPlayback } from '../types/api';

vi.mock('vidstack/bundle', () => ({}));
vi.mock('../api/gallery', () => ({ fetchReelPlayback: vi.fn() }));
enableAutoUnmount(afterEach);

let nextPlayFailures = 0;
let nextPlayError: Error = new DOMException('Autoplay blocked', 'NotAllowedError');
let autoReady = true;

class FakeMediaPlayerElement extends HTMLElement {
  muted = true;
  paused = true;
  playCallCount = 0;
  pauseCallCount = 0;
  private selectedSource: unknown = null;
  ready = false;
  get src() { return this.selectedSource; }
  set src(value: unknown) {
    this.selectedSource = value;
    this.ready = false;
    if (value && autoReady) queueMicrotask(() => {
      if (this.selectedSource !== value) return;
      this.ready = true;
      this.dispatchEvent(new Event('can-play'));
    });
  }
  get state() { return { source: this.src || { src: '' }, canPlay: this.ready }; }

  async play() {
    this.playCallCount += 1;
    if (!this.ready) throw new Error('[vidstack] media is not ready - wait for can-play');

    if (nextPlayFailures > 0) {
      nextPlayFailures -= 1;
      this.paused = true;
      throw nextPlayError;
    }

    this.paused = false;
  }

  async pause() {
    this.pauseCallCount += 1;
    this.paused = true;
  }
}

class FakeMediaProviderElement extends HTMLElement {}
class FakeMediaPosterElement extends HTMLElement {}
class FakeMediaTimeSliderElement extends HTMLElement {}

if (!customElements.get('media-player')) {
  customElements.define('media-player', FakeMediaPlayerElement);
}

if (!customElements.get('media-provider')) {
  customElements.define('media-provider', FakeMediaProviderElement);
}

if (!customElements.get('media-poster')) {
  customElements.define('media-poster', FakeMediaPosterElement);
}

if (!customElements.get('media-time-slider')) {
  customElements.define('media-time-slider', FakeMediaTimeSliderElement);
}

function createFeedItem(id: number): FeedItem {
  return {
    id,
    folderId: 77,
    folderSlug: 'animal-planet',
    folderName: 'Animal Planet',
    folderPath: 'animal-planet',
    folderBreadcrumb: null,
    filename: `reel-${id}.mp4`,
    width: 1080,
    height: 1920,
    mediaType: 'video',
    durationMs: 21_000,
    thumbnailUrl: `/thumbs/${id}.webp`,
    previewUrl: `/previews/${id}.mp4`,
    sortTimestamp: 1_777_000_000_000 + id,
    takenAt: 1_777_000_000_000 + id
  };
}

function createFolder(): FolderSummary {
  return {
    id: 77,
    slug: 'animal-planet',
    name: 'Animal Planet',
    description: 'Wildlife clips',
    folderPath: 'animal-planet',
    breadcrumb: null,
    imageCount: 0,
    videoCount: 3,
    latestImageMtimeMs: null,
    avatarImageId: null,
    avatarUrl: null
  };
}

function getPlayerElement(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('media-player').element as unknown as FakeMediaPlayerElement;
}

const globalStubs = {
  Avatar: {
    template: '<div data-test="avatar" />'
  },
  RouterLink: {
    props: ['to'],
    template: '<a data-test="folder-link"><slot /></a>'
  }
};

describe('ReelPlayerCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchReelPlayback).mockReset().mockImplementation(async id => ({
      previewUrl: `/previews/${id}.mp4`, previewReady: true,
      originalUrl: null, originalMimeType: null
    }));
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    setActivePinia(createPinia());
    nextPlayFailures = 0;
    autoReady = true;
    nextPlayError = new DOMException('Autoplay blocked', 'NotAllowedError');
    const appStore = useAppStore();
    appStore.$patch({
      videoMuted: true
    });
    window.localStorage.clear();
  });

  it('shows the overlay only for the active reel', async () => {
    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(1),
        folder: createFolder(),
        active: true
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();
    expect(wrapper.get('.reel-player-card__overlay').classes()).toContain('reel-player-card__overlay--visible');

    await wrapper.setProps({
      active: false
    });
    await flushPromises();

    expect(wrapper.get('.reel-player-card__overlay').classes()).not.toContain('reel-player-card__overlay--visible');
  });

  it('renders mobile action content inside the overlay controls', async () => {
    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(8),
        folder: createFolder(),
        active: true
      },
      slots: {
        'mobile-action-rail': '<div data-test="mobile-action-rail">actions</div>'
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    expect(wrapper.find('.reel-player-card__mobile-actions [data-test="mobile-action-rail"]').exists()).toBe(true);
  });

  it('shows a short folder path plus filename in the overlay copy', async () => {
    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: {
          ...createFeedItem(9),
          folderPath: 'OnePlus5T/Videos',
          filename: 'filename.mp4'
        },
        folder: createFolder(),
        active: true
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    expect(wrapper.get('.reel-player-card__folder-description').text()).toBe('Videos/filename.mp4');
  });

  it('toggles playback when the active reel surface is clicked', async () => {
    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(2),
        folder: createFolder(),
        active: true
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    const player = getPlayerElement(wrapper);
    expect(wrapper.get('media-player').attributes('load')).toBe('eager');
    expect(player.playCallCount).toBeGreaterThanOrEqual(1);
    expect(player.paused).toBe(false);
    expect(wrapper.find('.reel-player-card__pause-indicator').exists()).toBe(false);

    await wrapper.get('.reel-player-card__surface').trigger('click');
    await flushPromises();

    expect(player.pauseCallCount).toBe(1);
    expect(player.paused).toBe(true);
    expect(wrapper.find('.reel-player-card__pause-indicator').exists()).toBe(true);

    await wrapper.get('.reel-player-card__surface').trigger('click');
    await flushPromises();

    expect(player.playCallCount).toBeGreaterThanOrEqual(2);
    expect(player.paused).toBe(false);
    expect(wrapper.find('.reel-player-card__pause-indicator').exists()).toBe(false);
  });

  it('keeps seek-bar interaction from toggling reel playback', async () => {
    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(12),
        folder: createFolder(),
        active: true
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    const player = getPlayerElement(wrapper);
    expect(player.pauseCallCount).toBe(0);

    await wrapper.get('.reel-player-card__seekbar-track').trigger('click');
    await flushPromises();

    expect(player.pauseCallCount).toBe(0);
    expect(player.paused).toBe(false);
    expect(wrapper.find('.reel-player-card__pause-indicator').exists()).toBe(false);
  });

  it('persists the mute preference for the current reel and later reels', async () => {
    const appStore = useAppStore();
    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(3),
        folder: createFolder(),
        active: true
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    await wrapper.get('.reel-player-card__sound-button').trigger('click');
    await flushPromises();

    const firstPlayer = getPlayerElement(wrapper);
    expect(appStore.videoMuted).toBe(false);
    expect(firstPlayer.muted).toBe(false);
    expect(wrapper.get('.reel-player-card__sound-button').attributes('aria-label')).toBe('Mute sound');

    wrapper.unmount();

    const nextWrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(4),
        folder: createFolder(),
        active: true
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    const secondPlayer = getPlayerElement(nextWrapper);
    expect(appStore.videoMuted).toBe(false);
    expect(secondPlayer.muted).toBe(false);
    expect(nextWrapper.get('.reel-player-card__sound-button').attributes('aria-label')).toBe('Mute sound');
  });

  it('requests a gesture for autoplay rejection without retrying or switching URLs', async () => {
    nextPlayFailures = 1;

    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(7),
        folder: createFolder(),
        active: true
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    const player = getPlayerElement(wrapper);
    expect((player.src as { src?: string } | null)?.src).toBe('/previews/7.mp4');
    expect(player.playCallCount).toBe(1);
    expect(wrapper.text()).toContain('浏览器阻止了自动播放');
    player.dispatchEvent(new Event('can-play'));
    await flushPromises();
    expect(player.playCallCount).toBe(1);
    await wrapper.get('.reel-player-card__status button').trigger('click');
    await flushPromises();
    expect(player.paused).toBe(false);
    expect(player.playCallCount).toBe(2);
  });

  it('falls back to visible loading when the reel is inactive', async () => {
    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(6),
        folder: createFolder(),
        active: false
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    expect(wrapper.get('media-player').attributes('load')).toBe('visible');
    expect(getPlayerElement(wrapper).src).toBe('');
    expect(fetchReelPlayback).not.toHaveBeenCalled();
  });

  function mountActive() {
    return mount(ReelPlayerCard, {
      props: { item: createFeedItem(7), folder: createFolder(), active: true },
      global: { stubs: globalStubs }
    });
  }

  const coldCompatible: ReelPlayback = {
    previewUrl: '/previews/7.mp4?v=current', previewReady: false,
    originalUrl: '/api/originals/777', originalMimeType: 'video/mp4'
  };

  it('starts a compatible cold original directly using the resolved image ID', async () => {
    vi.mocked(fetchReelPlayback).mockResolvedValue(coldCompatible);
    const wrapper = mountActive();
    await flushPromises();
    expect(getPlayerElement(wrapper).src).toEqual({ src: '/api/originals/777', type: 'video/mp4' });
    expect(fetchReelPlayback).toHaveBeenCalledTimes(1);
    expect(fetchReelPlayback).toHaveBeenCalledWith(7, expect.any(AbortSignal));
    await wrapper.setProps({ active: false });
    await flushPromises();
    expect(getPlayerElement(wrapper).src).toBe('');
    expect(getPlayerElement(wrapper).paused).toBe(true);
    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(fetchReelPlayback).toHaveBeenCalledTimes(2);
  });

  it('keeps current previews first even if an original is eligible', async () => {
    vi.mocked(fetchReelPlayback).mockResolvedValue({ ...coldCompatible, previewReady: true });
    const wrapper = mountActive();
    await flushPromises();
    expect(getPlayerElement(wrapper).src).toEqual({ src: coldCompatible.previewUrl, type: 'video/mp4' });
  });

  it('waits for the current provider can-play instead of treating preparation as failure', async () => {
    autoReady = false;
    const wrapper = mountActive();
    await flushPromises();
    const player = getPlayerElement(wrapper);
    expect(player.playCallCount).toBe(0);
    expect(wrapper.text()).toContain('正在准备播放');
    player.ready = true;
    player.dispatchEvent(new Event('can-play'));
    await flushPromises();
    expect(player.playCallCount).toBe(1);
    expect(player.paused).toBe(false);
    expect(wrapper.text()).not.toContain('视频暂时无法播放');
  });

  it('uses a preview with a preparing message when the browser cannot play the original', async () => {
    vi.mocked(fetchReelPlayback).mockResolvedValue(coldCompatible);
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    nextPlayFailures = 1;
    nextPlayError = new DOMException('Provider not ready', 'AbortError');
    const wrapper = mountActive();
    await flushPromises();
    expect(getPlayerElement(wrapper).src).toEqual({ src: coldCompatible.previewUrl, type: 'video/mp4' });
    expect(wrapper.text()).toContain('正在准备播放');
    getPlayerElement(wrapper).dispatchEvent(new Event('can-play'));
    await flushPromises();
    expect(getPlayerElement(wrapper).paused).toBe(false);
  });

  it('falls back only once for a real media failure, never ping-pongs sources', async () => {
    vi.mocked(fetchReelPlayback).mockResolvedValue(coldCompatible);
    const wrapper = mountActive();
    await flushPromises();
    const player = getPlayerElement(wrapper);
    player.dispatchEvent(new CustomEvent('error', { detail: { code: 3, message: 'Decode failed' } }));
    // A second old-provider event before Vue applies the replacement src is stale.
    player.dispatchEvent(new CustomEvent('error', { detail: { code: 3, message: 'Old provider' } }));
    await flushPromises();
    expect(player.src).toEqual({ src: coldCompatible.previewUrl, type: 'video/mp4' });
    player.dispatchEvent(new CustomEvent('error', { detail: { code: 2, message: 'Network failed' } }));
    await flushPromises();
    expect(player.src).toEqual({ src: coldCompatible.previewUrl, type: 'video/mp4' });
    expect(wrapper.text()).toContain('视频暂时无法播放');
  });

  it('ignores late resolution from a card that has left the viewport', async () => {
    let complete!: (value: ReelPlayback) => void;
    vi.mocked(fetchReelPlayback).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const wrapper = mountActive();
    await wrapper.setProps({ active: false });
    complete(coldCompatible);
    await flushPromises();
    expect(getPlayerElement(wrapper).src).toBe('');
    expect(getPlayerElement(wrapper).playCallCount).toBe(0);
    expect(vi.mocked(fetchReelPlayback).mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it('does not bypass a failed playback lookup by loading an unverified media URL', async () => {
    vi.mocked(fetchReelPlayback).mockRejectedValueOnce(new Error('request failed'));
    const wrapper = mountActive();
    await flushPromises();
    expect(getPlayerElement(wrapper).src).toBe('');
    expect(wrapper.text()).toContain('视频暂时无法播放');
    await wrapper.get('.reel-player-card__status button').trigger('click');
    await flushPromises();
    expect(getPlayerElement(wrapper).src).toEqual({ src: '/previews/7.mp4', type: 'video/mp4' });
  });

  it('does not resume a user-paused clip when a readiness event fires', async () => {
    const wrapper = mountActive();
    await flushPromises();
    await wrapper.get('.reel-player-card__surface').trigger('click');
    const player = getPlayerElement(wrapper);
    const count = player.playCallCount;
    player.dispatchEvent(new Event('can-play'));
    await flushPromises();
    expect(player.playCallCount).toBe(count);
    expect(player.paused).toBe(true);
  });

  it('makes the folder overlay clickable without toggling playback', async () => {
    const wrapper = mount(ReelPlayerCard, {
      props: {
        item: createFeedItem(5),
        folder: createFolder(),
        active: true
      },
      global: {
        stubs: globalStubs
      }
    });

    await flushPromises();

    const player = getPlayerElement(wrapper);
    expect(player.pauseCallCount).toBe(0);
    expect(wrapper.find('[data-test="folder-link"]').exists()).toBe(true);

    await wrapper.get('[data-test="folder-link"]').trigger('click');
    await flushPromises();

    expect(player.pauseCallCount).toBe(0);
    expect(wrapper.find('.reel-player-card__pause-indicator').exists()).toBe(false);
  });
});
