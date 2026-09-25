export const THUMBNAIL_QUALITY = 82;
export const PREVIEW_QUALITY = 86;
export const WEBP_EFFORT = 4;
export const VIDEO_PREVIEW_MAX_LONG_EDGE = 1280;
export const VIDEO_PREVIEW_MAX_SHORT_EDGE = 720;
export const VIDEO_PREVIEW_QUALITY = 24;
export const VIDEO_AUDIO_BITRATE = '128k';
// Increment when algorithm behavior changes beyond the explicit parameters.
export const DERIVATIVE_RECIPE_VERSION = 1;

export const IMAGE_DERIVATIVE_EXTENSION = '.webp';
export const VIDEO_PREVIEW_EXTENSION = '.mp4';

// Matches the generator-owned .<stem>.<randomUUID>.tmp.<codec> name only;
// a legitimate filename containing "tmp" remains a published media file.
export function isDerivativeTemporaryFile(name: string): boolean {
  return /^\..+\.[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.tmp\.(?:webp|mp4)$/i.test(name);
}

export function isPublishedDerivativeFile(name: string, kind: 'thumbnail' | 'preview'): boolean {
  const lower = name.toLowerCase();
  return !isDerivativeTemporaryFile(name) && (lower.endsWith(IMAGE_DERIVATIVE_EXTENSION)
    || (kind === 'preview' && lower.endsWith(VIDEO_PREVIEW_EXTENSION)));
}
