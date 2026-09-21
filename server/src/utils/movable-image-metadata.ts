import fs from 'node:fs/promises';
import sharp, { type Metadata } from 'sharp';

/**
 * The Windows libvips file cache can keep WebP inputs locked after metadata().
 * Admission validates files that must subsequently move: use a Buffer on Windows
 * without changing global Sharp caches, pixel limits, or the single validation.
 * Callers retain their existing bounded / sequential execution.
 */
export async function readMovableImageMetadata(filename: string): Promise<Metadata> {
  const input = process.platform === 'win32' ? await fs.readFile(filename) : filename;
  return sharp(input, { failOn: 'error' }).metadata();
}
