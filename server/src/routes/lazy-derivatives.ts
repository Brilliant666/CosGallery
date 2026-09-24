import express from 'express';
import pLimit from 'p-limit';

import { appConfig } from '../config/env.js';
import { imageRepository } from '../db/repositories.js';
import type { ImageRecord } from '../types/models.js';
import { log } from '../services/log-service.js';
import { generatePreviewDerivative, generateThumbnailDerivative } from '../services/derivative-service.js';
import { scannerService } from '../services/scanner-service.js';
import { maintenanceOperationLock } from '../services/maintenance-operation-lock.js';
import { withDerivativeOutputRead } from '../services/derivative-output-lock.js';
import { hasCurrentDerivative, imageDerivativeVersion, type DerivativeKind } from '../utils/derivative-version.js';
import { resolveOriginalPath } from '../utils/media-paths.js';
import { applyDerivativeErrorHeaders, applyNoStoreMediaHeaders, applyProtectedMediaHeaders } from '../utils/media-response.js';
import { normalizePath, safeJoin } from '../utils/path-utils.js';

// Singleflight is per actual output, independent of the URL used to request it.
const inflightGenerations = new Map<string, Promise<void>>();
const generationLimit = pLimit(appConfig.scanDerivativeConcurrency);
type SendDerivativeResult = 'sent' | 'aborted';
class DerivativeRecordNotFoundError extends Error {}
class DerivativeVersionChangedError extends Error {}

function getRequestedPath(request: express.Request): string | null {
  const rawPath = request.params.path;
  const relativePath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath ?? '';
  const normalized = normalizePath(relativePath).replace(/^\/+/, '');
  return normalized.length > 0 ? normalized : null;
}

function resolveDerivativePath(rootDir: string, requestedPath: string): string | null {
  try { return safeJoin(rootDir, requestedPath); } catch { return null; }
}

function findCurrentImageRecord(requestedPath: string, kind: DerivativeKind, expectedId?: number): ImageRecord | null {
  const record = kind === 'thumbnail'
    ? imageRepository.getByThumbnailPath(requestedPath)
    : imageRepository.getByPreviewPath(requestedPath);
  // Trashed media retain their existing recycle-bin preview contract. Deleted or
  // unindexed/retained originals cannot enter ordinary generation.
  if (!record || record.is_deleted || (expectedId !== undefined && record.id !== expectedId)) return null;
  return record;
}

function sendError(response: express.Response, status: number, message: string): void {
  applyDerivativeErrorHeaders(response);
  response.status(status).json({ message });
}

function queueLazyGeneration(output: string, requestedPath: string, kind: DerivativeKind, expectedId: number): Promise<void> {
  const pending = inflightGenerations.get(output);
  if (pending) return pending;
  const work = generationLimit(() => maintenanceOperationLock.runGeneration(async () => {
    const record = findCurrentImageRecord(requestedPath, kind, expectedId);
    if (!record) throw new DerivativeRecordNotFoundError();
    if (await hasCurrentDerivative(output, imageDerivativeVersion(record, kind))) return;
    log.info('Lazy derivative generate', { kind, file: requestedPath, source: record.relative_path });
    const source = resolveOriginalPath(record.relative_path);
    if (kind === 'thumbnail') {
      await generateThumbnailDerivative(source, record.relative_path, false, { thumbnailPath: record.thumbnail_path });
    } else {
      await generatePreviewDerivative(source, record.relative_path, false, { previewPath: record.preview_path });
    }
  }));
  let tracked: Promise<void>;
  tracked = work.finally(() => {
    if (inflightGenerations.get(output) === tracked) inflightGenerations.delete(output);
  });
  inflightGenerations.set(output, tracked);
  return tracked;
}

function isConnectionTerminationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : null;
  return code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

function sendDerivativeFile(response: express.Response, output: string, options?: { noStore?: boolean }): Promise<SendDerivativeResult> {
  // Historical unversioned links remain usable, but cannot cache mutable pixels
  // forever. Share routes keep their stronger no-store option.
  if (options?.noStore || !response.req?.query?.v) applyNoStoreMediaHeaders(response);
  else applyProtectedMediaHeaders(response);
  return new Promise((resolve, reject) => {
    response.sendFile(output, error => {
      if (error) {
        if (response.headersSent || isConnectionTerminationError(error)) resolve('aborted');
        else reject(error);
      } else resolve('sent');
    });
  });
}

async function serveKnownDerivative(
  request: express.Request, response: express.Response, requestedPath: string,
  kind: DerivativeKind, expectedId?: number, options?: { noStore?: boolean }
): Promise<void> {
  const root = kind === 'thumbnail' ? appConfig.thumbnailsDir : appConfig.previewsDir;
  const output = resolveDerivativePath(root, requestedPath);
  if (!output) { sendError(response, 400, 'Invalid derivative path.'); return; }
  const initial = findCurrentImageRecord(requestedPath, kind, expectedId);
  if (!initial) { sendError(response, 404, 'Derivative not found.'); return; }
  const version = imageDerivativeVersion(initial, kind);
  if (request.query?.v !== undefined && request.query.v !== version) {
    sendError(response, 409, 'Media version changed; refresh the gallery.'); return;
  }

  const tryServeCurrent = () => withDerivativeOutputRead(output, async () => {
    if (!await hasCurrentDerivative(output, version)) return false;
    // Recheck after asynchronous cache I/O. Hold this output's read lease until
    // sendFile finishes, so a newer generator cannot replace its bytes mid-send.
    const current = findCurrentImageRecord(requestedPath, kind, initial.id);
    if (!current) throw new DerivativeRecordNotFoundError();
    if (imageDerivativeVersion(current, kind) !== version) throw new DerivativeVersionChangedError();
    await sendDerivativeFile(response, output, options);
    return true;
  });

  try {
    if (await tryServeCurrent()) return;
    if (scannerService.isLibraryRebuildRequired()) {
      sendError(response, 409, 'Library rebuild required before generating derivatives.'); return;
    }
    await queueLazyGeneration(output, requestedPath, kind, initial.id);
    const current = findCurrentImageRecord(requestedPath, kind, initial.id);
    if (!current) throw new DerivativeRecordNotFoundError();
    if (!await tryServeCurrent()) throw new DerivativeVersionChangedError();
  } catch (error) {
    if (response.headersSent) return;
    if (error instanceof DerivativeRecordNotFoundError) sendError(response, 404, 'Derivative not found.');
    else if (error instanceof DerivativeVersionChangedError) sendError(response, 409, 'Media changed during generation; refresh the gallery.');
    else sendError(response, 500, error instanceof Error ? error.message : 'Failed to generate derivative.');
  }
}

export async function serveDerivativeForImage(
  response: express.Response, imageRecord: ImageRecord, kind: DerivativeKind, options?: { noStore?: boolean }
): Promise<void> {
  const requestedPath = kind === 'thumbnail' ? imageRecord.thumbnail_path : imageRecord.preview_path;
  await serveKnownDerivative(response.req, response, requestedPath, kind, imageRecord.id, options);
}

const lazyThumbnailsRouter = express.Router();
const lazyPreviewsRouter = express.Router();
for (const [router, kind] of [[lazyThumbnailsRouter, 'thumbnail'], [lazyPreviewsRouter, 'preview']] as const) {
  router.get('/*path', async (request, response) => {
    const requestedPath = getRequestedPath(request);
    if (!requestedPath) { sendError(response, 400, 'Invalid derivative path.'); return; }
    await serveKnownDerivative(request, response, requestedPath, kind);
  });
}
export { lazyThumbnailsRouter, lazyPreviewsRouter };
