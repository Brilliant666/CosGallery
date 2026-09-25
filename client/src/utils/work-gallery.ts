import type { ImageDetail, PostMediaItem } from '../types/api';
import type { LocationQuery } from 'vue-router';
import { useFoldersStore } from '../stores/folders';

export function folderReadingRoute(slug: string, creatorId?: number | null) {
  const canonicalId = creatorId ?? useFoldersStore().items.find(folder => folder.slug === slug)?.canonicalCreatorId;
  return canonicalId ? canonicalCreatorRoute(canonicalId) : { name: 'folder', params: { slug } };
}

// Carry only browser state, never a nested arbitrary return URL.
export function libraryReadingQuery(path?: string): Record<string, string> {
  if (!path || !/^\/(?:library|creators)(?:\/|\?|$)/u.test(path) || path.includes('\\')) return {};
  const url = new URL(path, 'http://library.invalid');
  const query: Record<string, string> = {};
  for (const key of ['q', 'rating', 'preference', 'libraryPage', 'loaded']) {
    const value = url.searchParams.get(key);
    if (value) query[key] = value;
  }
  if (url.pathname === '/library' && url.searchParams.get('page')) query.libraryPage = url.searchParams.get('page')!;
  // Read one old library return target for bookmarks created before unified routes.
  const legacy = url.searchParams.get('returnTo');
  if (legacy && /^\/library(?:\?|$)/u.test(legacy) && !legacy.includes('\\')) {
    const old = new URL(legacy, 'http://library.invalid');
    for (const key of ['q', 'rating', 'preference']) if (!query[key] && old.searchParams.get(key)) query[key] = old.searchParams.get(key)!;
    if (!query.libraryPage && old.searchParams.get('page')) query.libraryPage = old.searchParams.get('page')!;
  }
  return query;
}

export function libraryReturnRoute(query: LocationQuery) {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === 'string') encoded.set(key, value);
  const state = libraryReadingQuery(`/library/reader?${encoded}`);
  return { name: 'library', query: { q: state.q, rating: state.rating, ...(state.preference ? { preference: state.preference } : {}), page: state.libraryPage } };
}

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
    ...(returnTo ? { query: libraryReadingQuery(returnTo) } : {})
  };
}

export function canonicalWorkGalleryRoute(creatorId: number, postId: number, returnTo?: string) {
  return {
    name: 'canonical-work-gallery',
    params: { creatorId: String(creatorId), postId: String(postId) },
    ...(returnTo ? { query: libraryReadingQuery(returnTo) } : {})
  };
}

export function workMediaRoute(postId: number, imageId: number, creatorId?: number, returnTo?: string) {
  if (creatorId) return {
    ...canonicalWorkGalleryRoute(creatorId, postId, returnTo),
    query: { ...libraryReadingQuery(returnTo), media: String(imageId) }
  };
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
