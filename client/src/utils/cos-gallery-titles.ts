import type { FeedItem } from '../types/api';

interface WorkLabelSource {
  postType?: FeedItem['postType'];
  folderName: string;
  carouselTitle?: string | null;
  sourcePath?: string;
}

const WORK_NUMBER_PATTERN = /(?:^|[\s\-–—])(?:NO\.?\s*)?\d{1,4}(?=\s|[^\d]|$)/i;
const TRAILING_ARCHIVE_METADATA_PATTERN = /(?:\s*\[[^\]]*\])+\s*$/;

function workTitleFromSourcePath(sourcePath: string | undefined): string | null {
  if (!sourcePath) {
    return null;
  }

  const segments = sourcePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.at(-1)?.trim() || null;
}

export function formatCosGalleryWorkLabel(item: WorkLabelSource): string | null {
  if (item.postType !== 'carousel') {
    return null;
  }

  const rawTitle = item.carouselTitle?.trim() || workTitleFromSourcePath(item.sourcePath);
  if (!rawTitle) {
    return null;
  }

  const workNumber = WORK_NUMBER_PATTERN.exec(rawTitle);
  if (!workNumber || workNumber.index === undefined) {
    return null;
  }

  const titleStart = workNumber.index + workNumber[0].length;
  const workTitle = rawTitle
    .slice(titleStart)
    .replace(/^[\s\-–—:：]+/, '')
    .replace(TRAILING_ARCHIVE_METADATA_PATTERN, '')
    .trim()
    .replace(/([\p{Script=Han}])\d+\.\d+$/u, '$1')
    .trim();

  return workTitle ? `${item.folderName} ${workTitle}` : item.folderName;
}
