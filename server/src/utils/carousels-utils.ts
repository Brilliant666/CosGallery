import { normalizePath, splitPathSegments } from './path-utils.js';

export const RESERVED_CAROUSELS_FOLDER_NAME = 'carousels';

export function isCarouselsFolderName(value: string): boolean {
  return value.trim().toLocaleLowerCase() === RESERVED_CAROUSELS_FOLDER_NAME;
}

export function parseTreatCarouselsAsFoldersSetting(value: string | null): boolean {
  return value === '1';
}

export function serializeTreatCarouselsAsFoldersSetting(value: boolean): string {
  return value ? '1' : '0';
}

export function getReservedCarouselsFolderPath(ownerFolderPath: string): string {
  return `${normalizePath(ownerFolderPath)}/${RESERVED_CAROUSELS_FOLDER_NAME}`;
}

export function findReservedCarouselsOwnerPath(relativePath: string): string | null {
  const segments = splitPathSegments(relativePath);

  for (let index = 1; index < segments.length; index += 1) {
    if (isCarouselsFolderName(segments[index] ?? '')) {
      return segments.slice(0, index).join('/');
    }
  }

  return null;
}

export function isWithinReservedCarouselsSubtree(relativePath: string): boolean {
  return findReservedCarouselsOwnerPath(relativePath) !== null;
}
