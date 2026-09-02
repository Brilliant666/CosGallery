import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type LocalIngestRoots = {
  libraryRoot: string;
  inboxRoot: string;
  processingRoot: string;
};

export class LocalIngestPathError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LocalIngestPathError';
  }
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

export function normalizeAbsoluteLocalIngestPath(value: string, label = 'path'): string {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new LocalIngestPathError('ROOT_NOT_ABSOLUTE', `${label} must be an absolute path`);
  }
  return path.normalize(path.resolve(trimmed));
}

function canonicalizeFromNearestExistingSync(value: string): string {
  const resolved = normalizeAbsoluteLocalIngestPath(value);
  let current = resolved;
  const missingSegments: string[] = [];
  while (!fsSync.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  const real = fsSync.realpathSync.native(current);
  return path.normalize(path.resolve(real, ...missingSegments));
}

export function canonicalizeLocalIngestPathSync(value: string): string {
  return canonicalizeFromNearestExistingSync(value);
}

export async function canonicalizeLocalIngestPath(value: string): Promise<string> {
  const resolved = normalizeAbsoluteLocalIngestPath(value);
  let current = resolved;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.normalize(path.resolve(real, ...missingSegments));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isSameOrNestedPath(root: string, candidate: string): boolean {
  const comparedRoot = comparisonPath(root);
  const comparedCandidate = comparisonPath(candidate);
  const relative = path.relative(comparedRoot, comparedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertLocalIngestRootPolicySync(
  roots: LocalIngestRoots,
  expectedGalleryRoot: string
): LocalIngestRoots {
  const normalized: LocalIngestRoots = {
    libraryRoot: normalizeAbsoluteLocalIngestPath(roots.libraryRoot, 'libraryRoot'),
    inboxRoot: normalizeAbsoluteLocalIngestPath(roots.inboxRoot, 'inboxRoot'),
    processingRoot: normalizeAbsoluteLocalIngestPath(roots.processingRoot, 'processingRoot')
  };
  const canonical: LocalIngestRoots = {
    libraryRoot: canonicalizeLocalIngestPathSync(normalized.libraryRoot),
    inboxRoot: canonicalizeLocalIngestPathSync(normalized.inboxRoot),
    processingRoot: canonicalizeLocalIngestPathSync(normalized.processingRoot)
  };
  const expected = canonicalizeLocalIngestPathSync(
    normalizeAbsoluteLocalIngestPath(expectedGalleryRoot, 'GALLERY_ROOT')
  );
  if (comparisonPath(canonical.libraryRoot) !== comparisonPath(expected)) {
    throw new LocalIngestPathError(
      'LIBRARY_ROOT_MISMATCH',
      'V1 libraryRoot must match the GALLERY_ROOT startup configuration'
    );
  }
  const entries = Object.entries(canonical) as Array<[keyof LocalIngestRoots, string]>;
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftName, leftPath] = entries[leftIndex];
      const [rightName, rightPath] = entries[rightIndex];
      if (isSameOrNestedPath(leftPath, rightPath) || isSameOrNestedPath(rightPath, leftPath)) {
        throw new LocalIngestPathError(
          'ROOTS_OVERLAP',
          `${leftName} and ${rightName} must be separate, non-overlapping directories`
        );
      }
    }
  }
  return normalized;
}

export async function assertPathInsideLocalIngestRoot(
  root: string,
  candidate: string,
  options: { allowRoot?: boolean; directChild?: boolean; code?: string; label?: string } = {}
): Promise<{ root: string; candidate: string; relative: string }> {
  const canonicalRoot = await canonicalizeLocalIngestPath(root);
  const canonicalCandidate = await canonicalizeLocalIngestPath(candidate);
  const relative = path.relative(comparisonPath(canonicalRoot), comparisonPath(canonicalCandidate));
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  const allowedRoot = options.allowRoot === true || relative !== '';
  const direct = !options.directChild || (relative !== '' && !relative.includes(path.sep));
  if (!inside || !allowedRoot || !direct) {
    throw new LocalIngestPathError(
      options.code ?? 'PATH_OUTSIDE_ALLOWED_ROOT',
      `${options.label ?? 'Path'} is outside its allowed root`
    );
  }
  return { root: canonicalRoot, candidate: canonicalCandidate, relative };
}

export async function assertLocalIngestRootPolicy(
  roots: LocalIngestRoots,
  expectedGalleryRoot: string
): Promise<LocalIngestRoots> {
  const normalized = assertLocalIngestRootPolicySync(roots, expectedGalleryRoot);
  const canonical: LocalIngestRoots = {
    libraryRoot: await canonicalizeLocalIngestPath(normalized.libraryRoot),
    inboxRoot: await canonicalizeLocalIngestPath(normalized.inboxRoot),
    processingRoot: await canonicalizeLocalIngestPath(normalized.processingRoot)
  };
  const expected = await canonicalizeLocalIngestPath(expectedGalleryRoot);
  if (comparisonPath(canonical.libraryRoot) !== comparisonPath(expected)) {
    throw new LocalIngestPathError(
      'LIBRARY_ROOT_MISMATCH',
      'V1 libraryRoot must match the GALLERY_ROOT startup configuration'
    );
  }
  const entries = Object.entries(canonical) as Array<[keyof LocalIngestRoots, string]>;
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftName, leftPath] = entries[leftIndex];
      const [rightName, rightPath] = entries[rightIndex];
      if (isSameOrNestedPath(leftPath, rightPath) || isSameOrNestedPath(rightPath, leftPath)) {
        throw new LocalIngestPathError(
          'ROOTS_OVERLAP',
          `${leftName} and ${rightName} must be separate, non-overlapping directories`
        );
      }
    }
  }
  return normalized;
}
