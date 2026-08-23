import { createHash } from 'node:crypto';

import { normalizePath } from './path-utils.js';

export type IndexedFileStatus = 'unchanged' | 'new' | 'updated';

export interface FullScanOptions {
  repairUnchangedDerivatives: boolean;
  forceNewFileDerivatives: boolean;
  allowDerivativeMigration: boolean;
}

export interface FolderScanFileFingerprint {
  relativePath: string;
  fileSize: number;
  mtimeMs: number;
}

export interface FolderScanSignature {
  signature: string;
  fileCount: number;
  maxMtimeMs: number;
  totalSize: number;
}

export interface FolderShortcutDecisionInput {
  currentSignature: string;
  galleryRootChanged: boolean;
  hasStoredGalleryRoot: boolean;
  hasMatchingIndexedFiles: boolean;
  repairUnchangedDerivatives: boolean;
  storedSignature: string | null;
}

export interface UnchangedImageRefreshDecisionInput {
  absolutePathChanged: boolean;
  galleryRootChanged: boolean;
  hasStoredGalleryRoot: boolean;
  isDeleted: boolean;
}

const defaultFullScanOptions: FullScanOptions = {
  repairUnchangedDerivatives: true,
  forceNewFileDerivatives: true,
  allowDerivativeMigration: true
};

export function resolveFullScanOptions(options: Partial<FullScanOptions> = {}): FullScanOptions {
  return {
    ...defaultFullScanOptions,
    ...options
  };
}

export function shouldQueueDerivativeJobForStatus(status: IndexedFileStatus, options: FullScanOptions): boolean {
  return status !== 'unchanged' || options.repairUnchangedDerivatives;
}

export function createFolderScanSignature(files: FolderScanFileFingerprint[]): FolderScanSignature {
  const normalizedFiles = files
    .map((file) => ({
      relativePath: normalizePath(file.relativePath),
      fileSize: file.fileSize,
      mtimeMs: Math.round(file.mtimeMs)
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hash = createHash('sha1');
  let totalSize = 0;
  let maxMtimeMs = 0;

  for (const file of normalizedFiles) {
    totalSize += file.fileSize;
    maxMtimeMs = Math.max(maxMtimeMs, file.mtimeMs);
    hash.update(`${file.relativePath}:${file.fileSize}:${file.mtimeMs}\n`);
  }

  return {
    signature: hash.digest('hex'),
    fileCount: normalizedFiles.length,
    maxMtimeMs,
    totalSize
  };
}

export function shouldSkipFolderBySignature(input: FolderShortcutDecisionInput): boolean {
  if (input.repairUnchangedDerivatives) {
    return false;
  }

  if (!input.hasStoredGalleryRoot || input.galleryRootChanged) {
    return false;
  }

  if (!input.hasMatchingIndexedFiles) {
    return false;
  }

  return input.storedSignature !== null && input.storedSignature === input.currentSignature;
}

export function shouldRefreshUnchangedImage(input: UnchangedImageRefreshDecisionInput): boolean {
  if (input.isDeleted) {
    return true;
  }

  if (!input.hasStoredGalleryRoot) {
    return true;
  }

  return input.galleryRootChanged || input.absolutePathChanged;
}

const primaryCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
  usage: 'sort'
});

const secondaryCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'variant',
  usage: 'sort'
});

export function compareNaturalFilename(a: string, b: string): number {
  const primary = primaryCollator.compare(a, b);
  if (primary !== 0) return primary;

  const secondary = secondaryCollator.compare(a, b);
  if (secondary !== 0) return secondary;

  const normA = a.normalize('NFKD');
  const normB = b.normalize('NFKD');
  if (normA !== normB) {
    return normA < normB ? -1 : 1;
  }

  return a < b ? -1 : a > b ? 1 : 0;
}
