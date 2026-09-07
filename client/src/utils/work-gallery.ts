import type { ImageDetail, PostMediaItem } from '../types/api';

export function parsePositiveId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function orderedMediaItems(items: readonly PostMediaItem[] | undefined): PostMediaItem[] {
  return [...(items ?? [])].sort((left, right) => left.position - right.position);
}

export function resolveMediaSelection(items: readonly PostMediaItem[], query: unknown) {
  if (query === undefined) return { index: 0, invalid: false };
  const imageId = parsePositiveId(query);
  const index = imageId === null ? -1 : items.findIndex((item) => item.imageId === imageId);
  return { index: Math.max(index, 0), invalid: index < 0 };
}

export function workGalleryRoute(slug: string, postId: number) {
  return { name: 'work-gallery', params: { slug, postId: String(postId) } };
}

export function canonicalCreatorRoute(creatorId: number, returnTo?: string) {
  return {
    name: 'canonical-creator',
    params: { creatorId: String(creatorId) },
    ...(returnTo ? { query: { returnTo } } : {})
  };
}

export function canonicalWorkGalleryRoute(creatorId: number, postId: number, returnTo?: string) {
  return {
    name: 'canonical-work-gallery',
    params: { creatorId: String(creatorId), postId: String(postId) },
    ...(returnTo ? { query: { returnTo } } : {})
  };
}

export function workMediaRoute(postId: number, imageId: number, creatorId?: number, returnTo?: string) {
  return {
    name: 'image',
    params: { id: String(postId) },
    query: {
      media: String(imageId),
      context: 'work',
      ...(creatorId ? { creator: String(creatorId) } : {}),
      ...(returnTo ? { returnTo } : {})
    }
  };
}

export function workTitle(work: ImageDetail): string {
  return work.caption?.trim() || work.carouselTitle?.trim() ||
    work.sourcePath?.replaceAll('\\', '/').split('/').at(-1) || work.filename;
}
