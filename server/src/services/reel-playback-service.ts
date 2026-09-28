import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ImageRecord } from '../types/models.js';
import { appConfig } from '../config/env.js';
import { postRepository } from '../db/repositories.js';
import { derivativeVersion, derivativeSourceVersion, hasCurrentDerivative, imageDerivativeVersion, SourceIndexOutdatedError } from '../utils/derivative-version.js';
import { resolveOriginalPath } from '../utils/media-paths.js';
import { safeJoin } from '../utils/path-utils.js';
import { scannerService } from './scanner-service.js';
import { inspectReelVideo } from './reel-video-format.js';

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

const notFound = () => new ReelPlaybackError(404, 'REEL_NOT_FOUND', 'Reel media not found.');

export function getReelSourceSnapshot(postId: number) {
  const initial = postRepository.getReelPlaybackImage(postId);
  if (!initial) throw notFound();
  const version = imageDerivativeVersion(initial, 'preview');
  const recheck = () => {
    const current = postRepository.getReelPlaybackImage(postId);
    if (!current) throw notFound();
    if (current.id !== initial.id || current.relative_path !== initial.relative_path ||
        current.preview_path !== initial.preview_path || current.playback_strategy !== initial.playback_strategy ||
        current.mime_type !== initial.mime_type || current.checksum_or_fingerprint !== initial.checksum_or_fingerprint ||
        imageDerivativeVersion(current, 'preview') !== version) {
      throw new SourceIndexOutdatedError();
    }
  };
  return { initial, version, recheck };
}

type ReelVersionRecord = Pick<ImageRecord, 'id' | 'relative_path' | 'checksum_or_fingerprint' | 'file_size' | 'mtime_ms'>;
function reelSourceIdentity(image: ReelVersionRecord): string {
  // IDs can be reused after an index reset. Bind caches to both the configured
  // source library and the specific indexed source, without exposing paths.
  return createHash('sha256').update(JSON.stringify([appConfig.galleryRoot, image.id, image.relative_path, image.checksum_or_fingerprint])).digest('hex').slice(0, 24);
}
export function getReelOriginalVersion(image: ReelVersionRecord): string {
  return createHash('sha256').update(`${reelSourceIdentity(image)}|${derivativeSourceVersion(image.file_size, image.mtime_ms)}|reel-original-v1`).digest('hex').slice(0, 24);
}
export function getReelRemuxLocation(image: ReelVersionRecord) {
  const mediaType = `video-remux:${reelSourceIdentity(image)}`;
  const version = derivativeVersion(derivativeSourceVersion(image.file_size, image.mtime_ms), 'preview', mediaType);
  return { version, mediaType, output: safeJoin(appConfig.previewsDir, `.reel-remux/${image.id}/${version}.mp4`) };
}

// Resolve one active post only. Legacy preview rows are inspected on demand;
// no indexing/database update, media generation or whole-feed probing occurs.
export async function resolveReelPlayback(postId: number): Promise<ReelPlayback> {
  const { initial, version, recheck } = getReelSourceSnapshot(postId);
  let output: string;
  try { output = safeJoin(appConfig.previewsDir, initial.preview_path); } catch { throw notFound(); }
  // Readiness is advisory metadata, so never wait for a transcode's output lease.
  // The preview route validates again and holds its read lease while serving bytes.
  const previewReady = await hasCurrentDerivative(output, version);
  recheck();
  const result: ReelPlayback = {
    previewUrl: `/previews/${initial.preview_path.split('/').map(encodeURIComponent).join('/')}?v=${version}`,
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
    result.remuxUrl = `/api/reels/${postId}/remux?v=${remux.version}`;
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
  // Existing indexed compatible MP4s retain their zero-probe fast path. Every
  // other container, including old preview-only rows, uses versioned inspection.
  let format;
  try {
    format = initial.playback_strategy === 'original' && path.extname(initial.relative_path).toLowerCase() === '.mp4' && initial.mime_type === 'video/mp4'
      ? { mode: 'original' as const, mimeType: 'video/mp4' }
      : await inspectReelVideo(source, derivativeSourceVersion(initial.file_size, initial.mtime_ms));
  } catch (error) {
    recheck();
    if (!(error instanceof SourceIndexOutdatedError) && (previewReady || result.remuxReady)) return result;
    throw error;
  }
  recheck();
  if (format.mode === 'original') {
    result.originalUrl = `/api/reels/${postId}/original?v=${getReelOriginalVersion(initial)}`;
    result.originalMimeType = format.mimeType;
  } else if (format.mode === 'remux') {
    result.remuxUrl = `/api/reels/${postId}/remux?v=${remux.version}`;
    result.remuxMimeType = 'video/mp4';
  }
  return result;
}
