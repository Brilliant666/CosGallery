import { createMemoryHistory, createRouter } from 'vue-router';
import type { ImageDetail, PostMediaItem } from '../src/types/api';

export function mediaItem(position: number, mediaType: 'image' | 'video' = position % 2 === 0 ? 'video' : 'image'): PostMediaItem {
  const imageId = 700 + position;
  const filename = `${String(position).padStart(3, '0')}.${mediaType === 'video' ? 'mp4' : 'jpg'}`;
  return {
    imageId, position, filename, mediaType,
    width: position % 3 === 0 ? 1920 : 800,
    height: position % 3 === 0 ? 1080 : 1200,
    durationMs: mediaType === 'video' ? 62_000 : null,
    isAnimated: false,
    thumbnailUrl: `/thumbnails/${imageId}.webp`,
    previewUrl: `/previews/${imageId}.${mediaType === 'video' ? 'mp4' : 'webp'}`,
    originalUrl: `/api/originals/${imageId}`,
    relativePath: `Creator/Work/${filename}`,
    mimeType: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
    fileSize: position * 1_048_576,
    playbackStrategy: 'preview', exif: null
  };
}

export function workDetail(items: PostMediaItem[] = Array.from({ length: 5 }, (_, i) => mediaItem(i + 1))): ImageDetail {
  const cover = items[0] ?? mediaItem(1);
  return {
    ...cover, id: 123, folderId: 7, folderSlug: 'creator', folderName: 'Creator', folderPath: 'Creator',
    folderBreadcrumb: null, folderAvatarImageId: null, sourcePath: 'Creator/Work', caption: 'Creator NO.033 Work',
    carouselTitle: 'Work', postType: items.length > 1 ? 'carousel' : 'single', itemCount: items.length,
    mediaItems: items, sortTimestamp: 1_777_000_000_000, takenAt: null,
    relativePath: cover.relativePath!, mimeType: cover.mimeType!, fileSize: cover.fileSize!, originalUrl: cover.originalUrl!,
    playbackStrategy: 'preview', exif: null, previousImageId: 122, nextImageId: 124
  };
}

// Row-major preview fixtures; media type must not partition the position sequence.
export function mixedOrientationItems(count = 5): PostMediaItem[] {
  const dimensions = [
    [4000, 6000, 'image'], [6000, 4000, 'image'], [4000, 4000, 'image'],
    [1920, 1080, 'video'], [4000, 6000, 'image'], [8000, 1000, 'image'],
    [1000, 8000, 'image'], [1080, 1920, 'video'],
    [5600, 8402, 'image'], [4000, 5000, 'image'], [1080, 1920, 'image']
  ] as const;
  return Array.from({ length: count }, (_, index) => {
    const [width, height, mediaType] = dimensions[index % dimensions.length]!;
    return { ...mediaItem(index + 1, mediaType), width, height };
  });
}

export function galleryTestRouter() {
  const blank = { template: '<div />' };
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: blank },
      { path: '/library', name: 'library', component: blank },
      { path: '/creators/:creatorId', name: 'canonical-creator', component: blank },
      { path: '/creators/:creatorId/works/:postId', name: 'canonical-work-gallery', component: blank },
      { path: '/f/:slug', name: 'folder', component: blank },
      { path: '/f/:slug/works/:postId', name: 'work-gallery', component: blank },
      { path: '/post/:id', name: 'image', component: blank },
      { path: '/share/:slug/posts/:id', name: 'shared-post', component: blank }
    ]
  });
}
