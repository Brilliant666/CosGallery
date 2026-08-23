export function formatMediaDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || durationMs <= 0) {
    return '';
  }

  return formatClockSeconds(Math.max(1, Math.round(durationMs / 1000)));
}

export function formatRemainingMediaDuration(
  durationMs: number | null | undefined,
  currentTimeMs: number | null | undefined
): string {
  if (durationMs === null || durationMs === undefined || durationMs <= 0) {
    return '0:00';
  }

  const safeCurrentTimeMs = currentTimeMs ?? 0;
  const remainingMs = Math.max(0, durationMs - Math.max(0, safeCurrentTimeMs));

  if (remainingMs === 0) {
    return '0:00';
  }

  return `-${formatClockSeconds(Math.ceil(remainingMs / 1000))}`;
}

/**
 * Formats playback position as "current / total", e.g. "0:42 / 0:58".
 * Used in the in-player time label.
 */
export function formatVideoTimestamp(
  durationMs: number | null | undefined,
  currentTimeMs: number | null | undefined
): string {
  const safeDurationMs = (durationMs != null && durationMs > 0) ? durationMs : 0;
  const safeCurrentMs = Math.max(0, Math.min(currentTimeMs ?? 0, safeDurationMs));

  const current = formatClockSeconds(Math.floor(safeCurrentMs / 1000));
  const total = safeDurationMs > 0 ? formatClockSeconds(Math.round(safeDurationMs / 1000)) : '0:00';

  return `${current} / ${total}`;
}

function formatClockSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export const VIDEO_PREVIEW_MAX_LONG_EDGE = 1280;
export const VIDEO_PREVIEW_MAX_SHORT_EDGE = 720;
const INSTAGRAM_MIN_ASPECT_RATIO = 4 / 5;
const INSTAGRAM_MAX_ASPECT_RATIO = 1.91;

export function videoPreviewWouldDownscale(width: number | null | undefined, height: number | null | undefined): boolean {
  if (!width || !height || width <= 0 || height <= 0) {
    return false;
  }

  return width > height ? width > VIDEO_PREVIEW_MAX_LONG_EDGE : width > VIDEO_PREVIEW_MAX_SHORT_EDGE;
}

export function clampFeedAspectRatio(width: number | null | undefined, height: number | null | undefined): number {
  if (!width || !height || width <= 0 || height <= 0) {
    return 1;
  }

  const ratio = width / height;
  return Math.min(INSTAGRAM_MAX_ASPECT_RATIO, Math.max(INSTAGRAM_MIN_ASPECT_RATIO, ratio));
}
