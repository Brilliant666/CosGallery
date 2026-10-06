import type { Ref } from 'vue';
import type { MediaPlayerElement } from 'vidstack/elements';
import type { ReelItem } from '../types/api';
import { useVideoPlayback } from './useVideoPlayback';

// Reels retain active-card autoplay while gallery videos share the same
// original, lossless remux and compatibility-preview state machine.
export function useReelPlayback(
  item: () => ReelItem,
  active: () => boolean,
  player: Ref<MediaPlayerElement | null>,
  muted: () => boolean
) {
  return useVideoPlayback(item, active, player, muted);
}
