import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { MediaPlayerElement } from 'vidstack/elements';
import type { PlayerSrc } from 'vidstack';
import { fetchReelPlayback } from '../api/gallery';
import type { FeedItem, ReelPlayback } from '../types/api';

type PlaybackState = 'idle' | 'resolving' | 'preparing' | 'playing' | 'paused' | 'blocked' | 'error';

// Only the active card resolves/loads media. No cold-preview request is issued
// merely to discover whether it exists, and no background transcode is started.
export function useReelPlayback(
  item: () => FeedItem,
  active: () => boolean,
  player: Ref<MediaPlayerElement | null>,
  muted: () => boolean
) {
  const state = ref<PlaybackState>('idle');
  const source = ref('');
  const sourceMime = ref<'video/mp4' | 'video/webm'>('video/mp4');
  const plan = ref<ReelPlayback | null>(null);
  const videoSource = computed<PlayerSrc>(() => active() && source.value
    ? { src: source.value, type: sourceMime.value } : '');
  const statusText = computed(() => ({
    idle: '', resolving: '正在选择播放源…', preparing: source.value === plan.value?.remuxUrl
      ? '正在准备播放（无损换封装，不降低清晰度）…'
      : source.value === plan.value?.previewUrl && !plan.value?.previewReady
        ? '正在准备播放（兼容预览，首次可能需要转换）…' : '正在准备播放…',
    playing: '', paused: '', blocked: '浏览器阻止了自动播放，请点击播放。',
    error: '视频暂时无法播放，请重试。'
  })[state.value]);
  let controller: AbortController | null = null;
  let epoch = 0;
  let pendingPlay: number | null = null;
  const attemptedSources = new Set<string>();
  let userPaused = false;
  let removeListeners: (() => void) | undefined;

  function canPlayOriginal(candidate: ReelPlayback) {
    return Boolean(candidate.originalUrl && candidate.originalMimeType
      && ['video/mp4', 'video/webm'].includes(candidate.originalMimeType.split(';')[0]!.trim())
      && document.createElement('video').canPlayType(candidate.originalMimeType));
  }

  function canPlayRemux(candidate: ReelPlayback) {
    return Boolean(candidate.remuxUrl && candidate.remuxMimeType
      && document.createElement('video').canPlayType(candidate.remuxMimeType));
  }

  const canUsePreview = computed(() => state.value === 'error' && Boolean(plan.value)
    && source.value !== plan.value?.previewUrl);

  function selectSource(url: string, mime = 'video/mp4') {
    epoch += 1;
    pendingPlay = null;
    attemptedSources.add(url);
    sourceMime.value = mime.split(';')[0]!.trim() === 'video/webm' ? 'video/webm' : 'video/mp4';
    source.value = url;
    state.value = 'preparing';
  }

  async function resolve() {
    controller?.abort();
    const token = ++epoch;
    pendingPlay = null;
    source.value = '';
    plan.value = null;
    attemptedSources.clear();
    userPaused = false;
    if (!active()) { state.value = 'idle'; return; }
    state.value = 'resolving';
    controller = new AbortController();
    try {
      const candidate = await fetchReelPlayback(item().id, controller.signal);
      if (token !== epoch || !active()) return;
      plan.value = candidate;
      if (canPlayOriginal(candidate)) {
        selectSource(candidate.originalUrl!, candidate.originalMimeType!);
      } else if (canPlayRemux(candidate)) {
        selectSource(candidate.remuxUrl!, candidate.remuxMimeType!);
      } else {
        selectSource(candidate.previewUrl);
      }
    } catch (error) {
      if (token !== epoch || !active()) return;
      if (!(error instanceof Error && error.name === 'AbortError')) state.value = 'error';
    }
  }

  function failed(error: unknown) {
    if (!active()) return;
    const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    // Cancellation is normal when changing src/cards. Autoplay policy is not a
    // broken preview and must not switch URLs or retry in a timer loop.
    if (name === 'AbortError' || code === 1) return;
    if (userPaused) return;
    if (name === 'NotAllowedError') { state.value = 'blocked'; return; }
    // Only a decoding failure after media was established as usable justifies
    // automatic conversion. Code 4 / NotSupportedError can also mean an initial
    // HTTP or network failure, so those ambiguous errors must offer retry instead.
    // Even a reported warm cache can expire: network errors must never switch src.
    if (code === 3 && plan.value) {
      const candidate = plan.value;
      if (source.value === candidate.originalUrl && canPlayRemux(candidate)
          && !attemptedSources.has(candidate.remuxUrl!)) {
        selectSource(candidate.remuxUrl!, candidate.remuxMimeType!);
        return;
      }
      if (source.value !== candidate.previewUrl && !attemptedSources.has(candidate.previewUrl)) {
        selectSource(candidate.previewUrl);
        return;
      }
    }
    state.value = 'error';
  }

  // Ambiguous HTTP/network failures never trigger conversion automatically.
  // The user can explicitly opt into a compatible preview after retrying.
  function usePreview() {
    if (!active() || !canUsePreview.value || !plan.value) return;
    userPaused = false;
    selectSource(plan.value.previewUrl);
  }

  function matchesSource(target: MediaPlayerElement) {
    const actual = target.state.source.src;
    return active() && Boolean(source.value) && typeof actual === 'string'
      && new URL(actual, window.location.href).href === new URL(source.value, window.location.href).href;
  }

  async function play(gesture = false) {
    const target = player.value;
    if (!target || !active() || !source.value || pendingPlay === epoch) return;
    // Vidstack rejects play() with a generic Error before can-play. Readiness is
    // not a resource failure, and an old provider must not start a new source.
    if (!matchesSource(target) || !target.state.canPlay) return;
    if (!gesture && (userPaused || state.value === 'blocked' || state.value === 'error')) return;
    if (gesture) { userPaused = false; state.value = 'preparing'; }
    const token = epoch;
    pendingPlay = token;
    target.muted = muted();
    try {
      await target.play();
      if (token === epoch && active() && !userPaused) state.value = 'playing';
    } catch (error) {
      if (token === epoch) failed(error);
    } finally {
      if (pendingPlay === token) pendingPlay = null;
    }
  }

  async function toggle() {
    if (!active()) return;
    if (state.value === 'error') { await resolve(); return; }
    if (!source.value || !player.value) return;
    if (player.value.paused || state.value === 'blocked' || userPaused) {
      await play(true);
    } else {
      userPaused = true;
      state.value = 'paused';
      void player.value.pause().catch(() => undefined);
    }
  }

  watch(player, target => {
    removeListeners?.();
    if (!target) return;
    const ready = () => { void play(); };
    const playing = () => {
      if (!matchesSource(target)) return;
      if (active() && !userPaused) state.value = 'playing';
      else void target.pause().catch(() => undefined);
    };
    const error = (event: Event) => {
      if (matchesSource(target)) failed((event as CustomEvent).detail);
    };
    target.addEventListener('can-play', ready);
    target.addEventListener('playing', playing);
    target.addEventListener('error', error);
    removeListeners = () => {
      target.removeEventListener('can-play', ready);
      target.removeEventListener('playing', playing);
      target.removeEventListener('error', error);
    };
  }, { flush: 'post' });

  watch([active, () => item().id, () => item().previewUrl], () => {
    if (player.value && source.value) void player.value.pause().catch(() => undefined);
    void resolve();
  }, { immediate: true });
  watch(source, async () => { await nextTick(); void play(); }, { flush: 'post' });
  watch(muted, value => { if (player.value) player.value.muted = value; });
  onBeforeUnmount(() => {
    epoch += 1;
    controller?.abort();
    removeListeners?.();
    void player.value?.pause().catch(() => undefined);
  });
  return { videoSource, state, statusText, toggle, play, canUsePreview, usePreview };
}
