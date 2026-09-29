import { createHash } from 'node:crypto';
import type { ImageRecord } from '../types/models.js';
import { appConfig } from '../config/env.js';
import {
  derivativeVersion,
  derivativeSourceVersion,
} from './derivative-version.js';
import { safeJoin } from './path-utils.js';

export type ReelVersionRecord = Pick<
  ImageRecord,
  'id' | 'relative_path' | 'checksum_or_fingerprint' | 'file_size' | 'mtime_ms'
>;
function reelSourceIdentity(image: ReelVersionRecord): string {
  // IDs can be reused after an index reset. Bind caches to both the configured
  // source library and the specific indexed source, without exposing paths.
  return createHash('sha256')
    .update(
      JSON.stringify([
        appConfig.galleryRoot,
        image.id,
        image.relative_path,
        image.checksum_or_fingerprint,
      ]),
    )
    .digest('hex')
    .slice(0, 24);
}
export function getReelOriginalVersion(image: ReelVersionRecord): string {
  return createHash('sha256')
    .update(
      `${reelSourceIdentity(image)}|${derivativeSourceVersion(image.file_size, image.mtime_ms)}|reel-original-v1`,
    )
    .digest('hex')
    .slice(0, 24);
}
export function getReelRemuxLocation(image: ReelVersionRecord) {
  const mediaType = `video-remux:${reelSourceIdentity(image)}`;
  const version = derivativeVersion(
    derivativeSourceVersion(image.file_size, image.mtime_ms),
    'preview',
    mediaType,
  );
  return {
    version,
    mediaType,
    output: safeJoin(
      appConfig.previewsDir,
      `.reel-remux/${image.id}/${version}.mp4`,
    ),
  };
}
