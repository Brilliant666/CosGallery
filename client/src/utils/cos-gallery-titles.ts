import type { FeedItem } from '../types/api';

interface WorkLabelSource {
  postType?: FeedItem['postType'];
  caption?: string | null;
}

export function formatCosGalleryWorkLabel(item: WorkLabelSource): string | null {
  if (item.postType !== 'carousel') {
    return null;
  }

  return item.caption?.trim() || null;
}
