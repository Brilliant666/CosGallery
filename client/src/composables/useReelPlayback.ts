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
  const sourceMime = ref('video/mp4');
  const plan = ref<ReelPlayback | null>(null);
  // Our scoped native loader supports real MOV/MKV MIME types beyond the
  // built-in PlayerSrc union. Do not relabel those bytes as MP4.
  const videoSource = computed<PlayerSrc>(() => active() && source.value
    ? { src: source.value, type: sourceMime.value } as PlayerSrc : '');
  const statusText = computed(() => ({
    idle: '', resolving: '正在选择播放源…', preparing: source.value === plan.value?.remuxUrl && !plan.value?.remuxReady
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
  let fallbackPending: number | null = null;
  let removeListeners: (() => void) | undefined;

  function canPlayRemux(candidate: ReelPlayback) {
    return Boolean(candidate.remuxUrl && candidate.remuxMimeType);
  }

  const canUsePreview = computed(() => state.value === 'error' && Boolean(plan.value)
    && source.value !== plan.value?.previewUrl);

  function selectSource(url: string, mime = 'video/mp4') {
    epoch += 1;
    pendingPlay = null;
    attemptedSources.add(url);
    sourceMime.value = mime.split(';')[0]!.trim();
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
      if (candidate.originalUrl && candidate.originalMimeType) {
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

  async function chooseFallback(checkOriginalResponse = false) {
    const token = epoch;
    if (fallbackPending === token || !plan.value) return;
    fallbackPending = token;
    const previousSource = source.value;
    const current = () => token === epoch && active() && !userPaused;
    try {
      // MEDIA_ERR_SRC_NOT_SUPPORTED also covers HTTP failures. Check only the
      // original (HEAD never generates derivatives), not a remux/preview URL.
      if (checkOriginalResponse) {
        const response = await fetch(previousSource, { method: 'HEAD', signal: controller?.signal });
        if (!current()) return;
        if (!response.ok || !response.headers.get('content-type')?.startsWith('video/')) {
          state.value = 'error';
          return;
        }
      }
      if (previousSource === plan.value.originalUrl) {
        const candidate = await fetchReelPlayback(item().id, controller?.signal, true);
        if (!current()) return;
        // Never apply a fallback for a different source revision.
        if (candidate.originalUrl !== plan.value.originalUrl || candidate.previewUrl !== plan.value.previewUrl) {
          state.value = 'error';
          return;
        }
        plan.value = candidate;
        if (canPlayRemux(candidate) && !attemptedSources.has(candidate.remuxUrl!)) {
          selectSource(candidate.remuxUrl!, candidate.remuxMimeType!);
          return;
        }
      }
      if (current() && !attemptedSources.has(plan.value.previewUrl)) selectSource(plan.value.previewUrl);
      else if (current()) state.value = 'error';
    } catch {
      if (current()) state.value = 'error';
    } finally {
      if (fallbackPending === token) fallbackPending = null;
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
    if (code === 3 && plan.value) {
      void chooseFallback();
      return;
    }
    if ((code === 4 || name === 'NotSupportedError') && source.value === plan.value?.originalUrl) {
      void chooseFallback(true);
      return;
    }
    state.value = 'error';
  }

  // Explicit opt-in still prefers a verified lossless fallback over transcode.
  function usePreview() {
    if (!active() || !canUsePreview.value || !plan.value) return;
    userPaused = false;
    void chooseFallback();
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
