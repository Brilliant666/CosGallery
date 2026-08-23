import { normalizePath, splitPathSegments } from './path-utils.js';

export const RESERVED_STORIES_FOLDER_NAME = 'stories';

export function isStoriesFolderName(value: string): boolean {
  return value.trim().toLocaleLowerCase() === RESERVED_STORIES_FOLDER_NAME;
}

export function parseTreatStoriesAsFoldersSetting(value: string | null): boolean {
  return value === '1';
}

export function serializeTreatStoriesAsFoldersSetting(value: boolean): string {
  return value ? '1' : '0';
}

export function getReservedStoriesFolderPath(ownerFolderPath: string): string {
  return `${normalizePath(ownerFolderPath)}/${RESERVED_STORIES_FOLDER_NAME}`;
}

export function findReservedStoriesOwnerPath(relativePath: string): string | null {
  const segments = splitPathSegments(relativePath);

  for (let index = 1; index < segments.length; index += 1) {
    if (isStoriesFolderName(segments[index] ?? '')) {
      return segments.slice(0, index).join('/');
    }
  }

  return null;
}

export function isWithinReservedStoriesSubtree(relativePath: string): boolean {
  return findReservedStoriesOwnerPath(relativePath) !== null;
}
