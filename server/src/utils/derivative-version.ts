import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { appConfig } from '../config/env.js';
import { PREVIEW_MAX_WIDTH, THUMBNAIL_SIZE } from './image-utils.js';
import { withDerivativeOutputWrite } from '../services/derivative-output-lock.js';
import { THUMBNAIL_QUALITY, PREVIEW_QUALITY, WEBP_EFFORT, VIDEO_PREVIEW_MAX_LONG_EDGE, VIDEO_PREVIEW_MAX_SHORT_EDGE, VIDEO_PREVIEW_QUALITY, VIDEO_AUDIO_BITRATE, DERIVATIVE_RECIPE_VERSION } from './derivative-spec.js';

export type DerivativeKind = 'thumbnail' | 'preview';

export class SourceIndexOutdatedError extends Error {
  readonly code = 'SOURCE_INDEX_OUTDATED';
  constructor() { super('Source changed; index update required before generating derivatives.'); }
}

export interface DerivativeGenerationExpectation {
  expectedVersion: string;
  // Synchronous: no event-loop yield between the authoritative check and rename.
  validate: () => void;
}

// Bump the recipe when orientation/animation/encoder behavior changes. Display
// titles, source links and sort decisions deliberately do not participate.
export function derivativeVersion(sourceVersion: string, kind: DerivativeKind, mediaType = 'image'): string {
  const recipe = kind === 'thumbnail'
    ? `thumb-v${DERIVATIVE_RECIPE_VERSION}:${THUMBNAIL_SIZE}:${THUMBNAIL_QUALITY}:${WEBP_EFFORT}`
    : mediaType === 'video'
      ? `video-v${DERIVATIVE_RECIPE_VERSION}:${VIDEO_PREVIEW_MAX_LONG_EDGE}:${VIDEO_PREVIEW_MAX_SHORT_EDGE}:${appConfig.ffmpegVideoEncoder}:${VIDEO_PREVIEW_QUALITY}:aac${VIDEO_AUDIO_BITRATE}`
      : `preview-v${DERIVATIVE_RECIPE_VERSION}:${PREVIEW_MAX_WIDTH}:${PREVIEW_QUALITY}:${WEBP_EFFORT}:animated`;
  return createHash('sha256').update(`${sourceVersion}|${mediaType}|${recipe}`).digest('hex').slice(0, 24);
}

export function derivativeSourceVersion(size: number, mtimeMs: number): string {
  return `${size}:${Math.round(mtimeMs)}`;
}

export function imageDerivativeVersion(image: { file_size: number; mtime_ms: number; media_type: string }, kind: DerivativeKind): string {
  return derivativeVersion(derivativeSourceVersion(image.file_size, image.mtime_ms), kind, image.media_type);
}

const stampPath = (output: string) => `${output}.version.json`;

export async function hasCurrentDerivative(output: string, version: string): Promise<boolean> {
  try {
    const [stat, raw] = await Promise.all([fs.stat(output), fs.readFile(stampPath(output), 'utf8')]);
    const stamp = JSON.parse(raw) as { version: string; size: number; mtimeMs: number };
    return stat.isFile() && stamp.version === version && stamp.size === stat.size && stamp.mtimeMs === stat.mtimeMs;
  } catch { return false; }
}

export async function stampDerivative(output: string, version: string): Promise<void> {
  const stat = await fs.stat(output);
  const target = stampPath(output);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version, size: stat.size, mtimeMs: stat.mtimeMs }));
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function writeVersionedDerivative(
  source: string, output: string, kind: DerivativeKind, mediaType: string,
  force: boolean, write: (temporaryOutput: string) => Promise<void>, expectation?: DerivativeGenerationExpectation
): Promise<boolean> {
  return withDerivativeOutputWrite(output, async () => {
    expectation?.validate();
    const before = await fs.stat(source);
    const sourceVersion = derivativeSourceVersion(before.size, before.mtimeMs);
    const version = derivativeVersion(sourceVersion, kind, mediaType);
    if (expectation && version !== expectation.expectedVersion) throw new SourceIndexOutdatedError();
    if (!force && await hasCurrentDerivative(output, version)) return false;
    // Unstamped legacy files have no reliable provenance. Upgrade only the
    // requested output; never delete/scan/prewarm the existing cache tree.
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = path.join(path.dirname(output), `.${path.basename(output, path.extname(output))}.${randomUUID()}.tmp${path.extname(output)}`);
    try {
      await write(temporary);
      const after = await fs.stat(source);
      if (derivativeSourceVersion(after.size, after.mtimeMs) !== sourceVersion) {
        throw new SourceIndexOutdatedError();
      }
      expectation?.validate();
      // A bounded local rename avoids an async DB-change gap after validation.
      // No media bytes are synchronously loaded or encoded here.
      renameSync(temporary, output);
      await stampDerivative(output, version);
      return true;
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  });
}
