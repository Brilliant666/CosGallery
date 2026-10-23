import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

import { appConfig } from '../config/env.js';
import { imageRepository } from '../db/repositories.js';
import { databaseManager } from '../db/database.js';
import type { ImageRecord } from '../types/models.js';
import { log } from '../services/log-service.js';
import { generatePreviewDerivative, generateThumbnailDerivative } from '../services/derivative-service.js';
import { scannerService } from '../services/scanner-service.js';
import { maintenanceOperationLock } from '../services/maintenance-operation-lock.js';
import { withDerivativeOutputRead } from '../services/derivative-output-lock.js';
import { hasCurrentDerivative, imageDerivativeVersion, derivativeSourceVersion, SourceIndexOutdatedError, type DerivativeKind } from '../utils/derivative-version.js';
import { resolveOriginalPath } from '../utils/media-paths.js';
import { applyDerivativeErrorHeaders, applyNoStoreMediaHeaders, applyProtectedMediaHeaders } from '../utils/media-response.js';
import { normalizePath, safeJoin } from '../utils/path-utils.js';
import { sendUnexpectedError } from '../middleware/http-errors.js';
import { mediaGenerationLimit } from '../services/media-generation-queue.js';

// Singleflight is per actual output, independent of the URL used to request it.
const inflightGenerations = new Map<string, Promise<void>>();
type SendDerivativeResult = 'sent' | 'aborted';
class DerivativeRecordNotFoundError extends Error {}
class DerivativeVersionChangedError extends Error {}
class DerivativeScopeError extends Error {
  constructor(readonly cause: unknown) { super('Derivative scope changed.'); }
}

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
  // Legacy Post trash retains its preview contract. Whole-Work removals have an
  // administrative recycle-bin entry and must also close ordinary cached URLs.
  if (!record || record.is_deleted || (expectedId !== undefined && record.id !== expectedId)) return null;
  const removed = databaseManager.connection.prepare(`SELECT 1 FROM post_items pi
    JOIN posts p ON p.id=pi.post_id WHERE pi.image_id=? AND (
      EXISTS (SELECT 1 FROM archive_catalog_local_works l JOIN work_removals r ON r.work_id=l.work_id WHERE l.post_id=p.id)
      OR EXISTS (SELECT 1 FROM work_removal_paths held JOIN work_removals r ON r.work_id=held.work_id
        WHERE held.relative_path=p.source_path)) LIMIT 1`).get(record.id);
  if (removed) return null;
  return record;
}

function sendError(response: express.Response, status: number, message: string, code?: string): void {
  applyDerivativeErrorHeaders(response);
  response.status(status).json({ message, ...(code ? { code } : {}) });
}

function queueLazyGeneration(output: string, requestedPath: string, kind: DerivativeKind, expectedId: number, expectedVersion: string, validateScope?:()=>void): Promise<void> {
  const pending = inflightGenerations.get(output);
  if (pending) return pending;
  const work = mediaGenerationLimit(() => maintenanceOperationLock.runGeneration(async () => {
    const record = findCurrentImageRecord(requestedPath, kind, expectedId);
    if (!record) throw new DerivativeRecordNotFoundError();
    const validate = () => {
      validateScope?.();
      const current = findCurrentImageRecord(requestedPath, kind, expectedId);
      if (!current) throw new DerivativeRecordNotFoundError();
      if (imageDerivativeVersion(current, kind) !== expectedVersion || current.relative_path !== record.relative_path) throw new DerivativeVersionChangedError();
    };
    validate();
    if (await hasCurrentDerivative(output, imageDerivativeVersion(record, kind))) return;
    const source = resolveOriginalPath(record.relative_path);
    // Before AVIF inspection / codec work; the writer checks again after taking
    // the output lease and before publication. Hot reliable A never stats B.
    const sourceStat = await fs.stat(source);
    validate();
    if (derivativeSourceVersion(sourceStat.size, sourceStat.mtimeMs) !== derivativeSourceVersion(record.file_size, record.mtime_ms)) throw new SourceIndexOutdatedError();
    log.info('Lazy derivative generate', { kind, file: requestedPath, source: record.relative_path });
    const expectation = { expectedVersion, validate };
    if (kind === 'thumbnail') {
      await generateThumbnailDerivative(source, record.relative_path, false, { thumbnailPath: record.thumbnail_path }, expectation);
    } else {
      await generatePreviewDerivative(source, record.relative_path, false, { previewPath: record.preview_path }, expectation);
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

function sendDerivativeFile(response: express.Response, output: string, root: string, options?: { noStore?: boolean }): Promise<SendDerivativeResult> {
  // Historical unversioned links remain usable, but cannot cache mutable pixels
  // forever. Share routes keep their stronger no-store option.
  if (options?.noStore || !response.req?.query?.v) applyNoStoreMediaHeaders(response);
  else applyProtectedMediaHeaders(response);
  return new Promise((resolve, reject) => {
    // The configured cache root itself may be under .mocks or .codex; apply
    // dotfile policy within that root, just as scoped original delivery does.
    response.sendFile(path.relative(root, output), { root, dotfiles: 'ignore' }, error => {
      if (error) {
        if (response.headersSent || isConnectionTerminationError(error)) resolve('aborted');
        else reject(error);
      } else resolve('sent');
    });
  });
}

async function serveKnownDerivative(
  request: express.Request, response: express.Response, requestedPath: string,
  kind: DerivativeKind, expectedId?: number, options?: { noStore?: boolean; validate?:()=>void }
): Promise<void> {
  const root = kind === 'thumbnail' ? appConfig.thumbnailsDir : appConfig.previewsDir;
  const output = resolveDerivativePath(root, requestedPath);
  if (!output) { sendError(response, 400, 'Invalid derivative path.'); return; }
  const initial = findCurrentImageRecord(requestedPath, kind, expectedId);
  if (!initial) { sendError(response, 404, 'Derivative not found.'); return; }
  const validateScope=()=>{try{options?.validate?.();}catch(error){throw new DerivativeScopeError(error);}};
  const version = imageDerivativeVersion(initial, kind);
  if (request.query?.v !== undefined && request.query.v !== version) {
    sendError(response, 409, 'Media version changed; refresh the gallery.', 'DERIVATIVE_VERSION_CHANGED'); return;
  }

  const tryServeCurrent = () => withDerivativeOutputRead(output, async () => {
    if (!await hasCurrentDerivative(output, version)) return false;
    validateScope();
    // Recheck after asynchronous cache I/O. Hold this output's read lease until
    // sendFile finishes, so a newer generator cannot replace its bytes mid-send.
    const current = findCurrentImageRecord(requestedPath, kind, initial.id);
    if (!current) throw new DerivativeRecordNotFoundError();
    if (imageDerivativeVersion(current, kind) !== version) throw new DerivativeVersionChangedError();
    await sendDerivativeFile(response, output, root, options);
    return true;
  });

  try {
    validateScope();
    if (await tryServeCurrent()) return;
    if (scannerService.isLibraryRebuildRequired()) {
      sendError(response, 409, 'Library rebuild required before generating derivatives.'); return;
    }
    await queueLazyGeneration(output, requestedPath, kind, initial.id, version,validateScope);
    const current = findCurrentImageRecord(requestedPath, kind, initial.id);
    if (!current) throw new DerivativeRecordNotFoundError();
    if (!await tryServeCurrent()) throw new DerivativeVersionChangedError();
  } catch (error) {
    if (response.headersSent || response.destroyed || response.writableEnded || request.aborted || isConnectionTerminationError(error)) return;
    if (error instanceof DerivativeScopeError) throw error.cause;
    if (error instanceof DerivativeRecordNotFoundError) sendError(response, 404, 'Derivative not found.');
    else if (error instanceof Error && 'status' in error && error.status === 416) sendError(response, 416, 'Requested media range is not satisfiable.');
    else if (error instanceof SourceIndexOutdatedError) sendError(response, 409, error.message, error.code);
    else if (error instanceof DerivativeVersionChangedError) sendError(response, 409, 'Media changed during generation; refresh the gallery.', 'DERIVATIVE_VERSION_CHANGED');
    else { applyDerivativeErrorHeaders(response); sendUnexpectedError(response, error); }
  }
}

export async function serveDerivativeForImage(
  response: express.Response, imageRecord: ImageRecord, kind: DerivativeKind, options?: { noStore?: boolean; validate?:()=>void }
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
