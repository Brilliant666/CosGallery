import type { NestedFolderTitleFormat } from '../types/models.js';

export const DEFAULT_NESTED_FOLDER_TITLE_FORMAT: NestedFolderTitleFormat = 'folder';

export function parseNestedFolderTitleFormatSetting(value: string | null): NestedFolderTitleFormat {
  return value === 'parent-plus-folder' ? 'parent-plus-folder' : DEFAULT_NESTED_FOLDER_TITLE_FORMAT;
}

export function serializeNestedFolderTitleFormatSetting(value: NestedFolderTitleFormat): string {
  return value;
}
