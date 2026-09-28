import fs from 'node:fs/promises';
import { appConfig } from '../config/env.js';
import { postRepository } from '../db/repositories.js';
import { derivativeSourceVersion, hasCurrentDerivative, imageDerivativeVersion, SourceIndexOutdatedError } from '../utils/derivative-version.js';
import { resolveOriginalPath } from '../utils/media-paths.js';
import { safeJoin } from '../utils/path-utils.js';
import { scannerService } from './scanner-service.js';

export class ReelPlaybackError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface ReelPlayback {
  previewUrl: string;
  previewReady: boolean;
  originalUrl: string | null;
  originalMimeType: string | null;
}

const notFound = () => new ReelPlaybackError(404, 'REEL_NOT_FOUND', 'Reel media not found.');

// Resolve one post only. This endpoint never probes, generates, or scans media.
export async function resolveReelPlayback(postId: number): Promise<ReelPlayback> {
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
    originalMimeType: null
  };
  // A cache hit does not displace a compatible original. Preview-only media can
  // still use a reliable cache without requiring the source disk to be online.
  if (previewReady && initial.playback_strategy !== 'original') return result;
  if (scannerService.isLibraryRebuildRequired()) {
    if (previewReady) return result;
    throw new ReelPlaybackError(409, 'LIBRARY_REBUILD_REQUIRED', 'Library rebuild required before resolving original media.');
  }
  let source: string;
  try { source = resolveOriginalPath(initial.relative_path); } catch { throw notFound(); }
  let stat;
  try { stat = await fs.stat(source); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      recheck();
      // Missing source is not a reason to discard an already valid preview.
      if (previewReady) return result;
      throw notFound();
    }
    throw error;
  }
  recheck();
  if (!stat.isFile()) throw notFound();
  if (derivativeSourceVersion(stat.size, stat.mtimeMs) !== derivativeSourceVersion(initial.file_size, initial.mtime_ms)) {
    throw new SourceIndexOutdatedError();
  }
  if (initial.playback_strategy === 'original') {
    result.originalUrl = `/api/originals/${initial.id}`;
    result.originalMimeType = initial.mime_type;
  }
  return result;
}
