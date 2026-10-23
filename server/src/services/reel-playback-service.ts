import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../config/env.js';
import { postRepository } from '../db/repositories.js';
import { derivativeSourceVersion, hasCurrentDerivative, imageDerivativeVersion, SourceIndexOutdatedError } from '../utils/derivative-version.js';
import { resolveOriginalPath } from '../utils/media-paths.js';
import { safeJoin } from '../utils/path-utils.js';
import { scannerService } from './scanner-service.js';
import { getMimeTypeFromExtension, SUPPORTED_VIDEO_EXTENSIONS } from '../utils/image-utils.js';
import { inspectReelVideo } from './reel-video-format.js';
import { getReelOriginalVersion, getReelRemuxLocation } from '../utils/reel-source-version.js';
export { getReelOriginalVersion, getReelRemuxLocation } from '../utils/reel-source-version.js';

export class ReelPlaybackError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface ReelPlayback {
  previewUrl: string;
  previewReady: boolean;
  originalUrl: string | null;
  originalMimeType: string | null;
  remuxUrl: string | null;
  remuxMimeType: string | null;
  remuxReady: boolean;
}

export type VideoPlaybackIdentity = 'post' | 'media' | 'gallery-media';

const notFound = () => new ReelPlaybackError(404, 'REEL_NOT_FOUND', 'Reel media not found.');

export function getReelSourceSnapshot(id: number, identity: VideoPlaybackIdentity = 'post') {
  const lookup = () => identity === 'gallery-media'
    ? postRepository.getGalleryPlaybackMedia(id)
    : identity === 'media' ? postRepository.getReelPlaybackMedia(id) : postRepository.getReelPlaybackImage(id);
  const initial = lookup();
  if (!initial) throw notFound();
  const version = imageDerivativeVersion(initial, 'preview');
  const recheck = () => {
    const current = lookup();
    if (!current) throw notFound();
    const before=initial as typeof initial & {post_id?:number;media_position?:number};
    const after=current as typeof current & {post_id?:number;media_position?:number};
    if(before.post_id!==after.post_id || before.media_position!==after.media_position) throw new SourceIndexOutdatedError();
    if (current.id !== initial.id || current.relative_path !== initial.relative_path ||
        current.preview_path !== initial.preview_path || current.playback_strategy !== initial.playback_strategy ||
        current.mime_type !== initial.mime_type || current.checksum_or_fingerprint !== initial.checksum_or_fingerprint ||
        imageDerivativeVersion(current, 'preview') !== version) {
      throw new SourceIndexOutdatedError();
    }
  };
  return { initial, version, recheck };
}

// Resolve one active post only. Browser capability is not inferred from an old
// indexed strategy: every supported original gets an attempt without ffprobe.
// Only an explicit fallback lookup probes remux eligibility after that attempt.
export async function resolveReelPlayback(id: number, inspectFallback = false, identity: VideoPlaybackIdentity = 'post'): Promise<ReelPlayback> {
  const { initial, version, recheck } = getReelSourceSnapshot(id,identity);
  const base = identity === 'gallery-media' ? `/api/gallery/media/${id}`
    : identity === 'media' ? `/api/reels/media/${id}` : `/api/reels/${id}`;
  let output: string;
  try { output = safeJoin(appConfig.previewsDir, initial.preview_path); } catch { throw notFound(); }
  // Readiness is advisory metadata, so never wait for a transcode's output lease.
  // The preview route validates again and holds its read lease while serving bytes.
  const previewReady = await hasCurrentDerivative(output, version);
  recheck();
  const result: ReelPlayback = {
    previewUrl: identity !== 'post' ? `${base}/preview?v=${version}` : `/previews/${initial.preview_path.split('/').map(encodeURIComponent).join('/')}?v=${version}`,
    previewReady,
    originalUrl: null,
    originalMimeType: null,
    remuxUrl: null,
    remuxMimeType: null,
    remuxReady: false
  };
  const remux = getReelRemuxLocation(initial);
  result.remuxReady = await hasCurrentDerivative(remux.output, remux.version);
  recheck();
  if (result.remuxReady) {
    result.remuxUrl = `${base}/remux?v=${remux.version}`;
    result.remuxMimeType = 'video/mp4';
  }
  // A cache hit does not displace a compatible original. Preview-only media can
  // still use a reliable cache without requiring the source disk to be online.
  if (scannerService.isLibraryRebuildRequired()) {
    if (previewReady || result.remuxReady) return result;
    throw new ReelPlaybackError(409, 'LIBRARY_REBUILD_REQUIRED', 'Library rebuild required before resolving original media.');
  }
  let source: string;
  try { source = resolveOriginalPath(initial.relative_path); } catch { throw notFound(); }
  let stat;
  try { stat = await fs.stat(source); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      recheck();
      // Missing source is not a reason to discard an already valid preview.
      if (previewReady || result.remuxReady) return result;
      throw notFound();
    }
    throw error;
  }
  recheck();
  if (!stat.isFile()) throw notFound();
  if (derivativeSourceVersion(stat.size, stat.mtimeMs) !== derivativeSourceVersion(initial.file_size, initial.mtime_ms)) {
    throw new SourceIndexOutdatedError();
  }
  const extension = path.extname(initial.relative_path).toLowerCase();
  if (SUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
    result.originalUrl = `${base}/original?v=${getReelOriginalVersion(initial)}`;
    result.originalMimeType = getMimeTypeFromExtension(extension);
  }
  if (inspectFallback && !result.remuxReady) {
    let format;
    try {
      format = await inspectReelVideo(source, derivativeSourceVersion(initial.file_size, initial.mtime_ms));
    } catch (error) {
      recheck();
      if (!(error instanceof SourceIndexOutdatedError) && previewReady) return result;
      throw error;
    }
    recheck();
    if (format.mode === 'remux' || (format.mode === 'original' && format.mimeType === 'video/mp4')) {
      result.remuxUrl = `${base}/remux?v=${remux.version}`;
      result.remuxMimeType = 'video/mp4';
    }
  }
  return result;
}

export function resolveReelMediaPlayback(mediaId:number,inspectFallback=false):Promise<ReelPlayback> {
  return resolveReelPlayback(mediaId,inspectFallback,'media');
}

export function resolveGalleryMediaPlayback(mediaId: number, inspectFallback = false): Promise<ReelPlayback> {
  return resolveReelPlayback(mediaId, inspectFallback, 'gallery-media');
}
