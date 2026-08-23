import type { FeedItem, FolderSummary, ImageDetail, NestedFolderTitleFormat } from '../types/api';

type FolderTitleSource =
  | Pick<FolderSummary, 'name' | 'parentFolderName' | 'breadcrumb' | 'folderPath'>
  | Pick<FeedItem, 'folderName' | 'folderParentName' | 'folderBreadcrumb' | 'folderPath'>
  | Pick<ImageDetail, 'folderName' | 'folderParentName' | 'folderBreadcrumb' | 'folderPath'>;

function getImmediateParentName(breadcrumb: string | null | undefined, folderPath: string): string | null {
  if (typeof breadcrumb === 'string' && breadcrumb.trim().length > 0) {
    const segments = breadcrumb
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);

    const parentFromBreadcrumb = segments.at(-1);
    if (parentFromBreadcrumb) {
      return parentFromBreadcrumb;
    }
  }

  const segments = folderPath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.length > 1 ? (segments.at(-2) ?? null) : null;
}

export function formatFolderTitle(source: FolderTitleSource, titleFormat: NestedFolderTitleFormat): string {
  const isFolderSummary = 'name' in source;
  const name = isFolderSummary ? source.name : source.folderName;
  const parentFolderName = isFolderSummary ? source.parentFolderName : source.folderParentName;
  const breadcrumb = isFolderSummary ? source.breadcrumb : source.folderBreadcrumb;

  if (titleFormat !== 'parent-plus-folder') {
    return name;
  }

  const parentName =
    typeof parentFolderName === 'string' && parentFolderName.trim().length > 0
      ? parentFolderName.trim()
      : getImmediateParentName(breadcrumb, source.folderPath);
  if (!parentName) {
    return name;
  }

  return `${parentName} - ${name}`;
}
