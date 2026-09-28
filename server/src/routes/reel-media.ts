import fs from 'node:fs/promises';
import path from 'node:path';
import type express from 'express';
import { appConfig } from '../config/env.js';
import { derivativeSourceVersion, hasCurrentDerivative, SourceIndexOutdatedError, writeVersionedDerivative } from '../utils/derivative-version.js';
import { applyDerivativeErrorHeaders, applyProtectedMediaHeaders } from '../utils/media-response.js';
import { resolveOriginalPath } from '../utils/media-paths.js';
import { getReelOriginalVersion, getReelRemuxLocation, getReelSourceSnapshot, ReelPlaybackError, resolveReelPlayback } from '../services/reel-playback-service.js';
import { writeReelRemux } from '../services/reel-video-format.js';
import { withDerivativeOutputRead } from '../services/derivative-output-lock.js';
import { mediaGenerationLimit } from '../services/media-generation-queue.js';
import { maintenanceOperationLock } from '../services/maintenance-operation-lock.js';
import { scannerService } from '../services/scanner-service.js';
import { sendUnexpectedError } from '../middleware/http-errors.js';

const remuxes = new Map<string, Promise<void>>();
const stale = () => new ReelPlaybackError(409, 'DERIVATIVE_VERSION_CHANGED', 'Media version changed; refresh the gallery.');
function terminated(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && ['ECONNABORTED', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(String(error.code));
}

function sendFile(response: express.Response, source: string, mime: string, remux = false): Promise<void> {
  applyProtectedMediaHeaders(response);
  response.setHeader('Content-Type', mime);
  // Only server-resolved and version-checked paths reach here. The remux cache
  // is intentionally hidden from generic static/preview routing.
  // A configured root may itself live under .mocks/.codex. Apply the dotfile
  // policy to media paths inside that root, not its deployment ancestors.
  const root = remux ? appConfig.previewsDir : appConfig.galleryRoot;
  const relative = path.relative(root, source);
  return new Promise((resolve, reject) => response.sendFile(relative, { root, dotfiles: remux ? 'allow' : 'ignore' }, error => {
    if (!error || response.headersSent || terminated(error)) resolve();
    else reject(error);
  }));
}

export async function serveReelMedia(request: express.Request, response: express.Response, postId: number, kind: 'original' | 'remux'): Promise<void> {
  try {
    const { initial, recheck } = getReelSourceSnapshot(postId);
    const remux = getReelRemuxLocation(initial);
    const expected = kind === 'original' ? getReelOriginalVersion(initial) : remux.version;
    if (request.query.v !== expected) throw stale();
    const source = resolveOriginalPath(initial.relative_path);
    const validate = recheck;
    const serveRemux = () => withDerivativeOutputRead(remux.output, async () => {
      if (!await hasCurrentDerivative(remux.output, remux.version)) return false;
      validate();
      await sendFile(response, remux.output, 'video/mp4', true);
      return true;
    });
    // Authoritative post identity/visibility and recipe version gate even warm
    // cache reads; the generic /previews route cannot serve these private paths.
    if (kind === 'remux' && await serveRemux()) return;
    const playback = await resolveReelPlayback(postId, kind === 'remux');
    validate();
    if (kind === 'original') {
      if (!playback.originalUrl || !playback.originalMimeType) throw new ReelPlaybackError(404, 'REEL_ORIGINAL_UNAVAILABLE', 'Original media is unavailable.');
      await sendFile(response, source, playback.originalMimeType);
      return;
    }
    if (!playback.remuxUrl) throw new ReelPlaybackError(404, 'REEL_REMUX_UNAVAILABLE', 'Lossless playback media is unavailable.');
    if (scannerService.isLibraryRebuildRequired()) throw new ReelPlaybackError(409, 'LIBRARY_REBUILD_REQUIRED', 'Library rebuild required before generating media.');
    let pending = remuxes.get(remux.output);
    if (!pending) {
      const work = mediaGenerationLimit(() => maintenanceOperationLock.runGeneration(async () => {
        validate();
        const stat = await fs.stat(source);
        validate();
        if (derivativeSourceVersion(stat.size, stat.mtimeMs) !== derivativeSourceVersion(initial.file_size, initial.mtime_ms)) throw new SourceIndexOutdatedError();
        await writeVersionedDerivative(source, remux.output, 'preview', remux.mediaType, false, temporary => writeReelRemux(source, temporary), { expectedVersion: remux.version, validate });
      }));
      pending = work.finally(() => { if (remuxes.get(remux.output) === pending) remuxes.delete(remux.output); });
      remuxes.set(remux.output, pending);
    }
    await pending;
    if (!await serveRemux()) throw stale();
  } catch (error) {
    if (response.headersSent || response.destroyed || response.writableEnded || request.aborted || terminated(error)) return;
    applyDerivativeErrorHeaders(response);
    if (error instanceof ReelPlaybackError) response.status(error.status).json({ code: error.code, message: error.message });
    else if (error instanceof SourceIndexOutdatedError) response.status(409).json({ code: error.code, message: error.message });
    else if (error && typeof error === 'object' && 'status' in error && error.status === 416) response.status(416).json({ code: 'INVALID_RANGE', message: 'Requested media range is not satisfiable.' });
    else if (error && typeof error === 'object' && (('status' in error && error.status === 404) || ('code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))))) response.status(404).json({ code: 'REEL_NOT_FOUND', message: 'Reel media not found.' });
    else sendUnexpectedError(response, error);
  }
}
