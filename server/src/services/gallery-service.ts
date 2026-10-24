import { ManagedCreatorService } from './managed-creator-service.js';
import { CreatorGalleryLabelService } from './creator-gallery-label-service.js';
import type { GalleryLabel } from '../types/gallery-labels.js';
import { parseAccentColor, type AccentColor } from '../types/accent-color.js';
import { assertLegacyPostRemovalAllowed, assertLegacyPostRestoreAllowed } from './media-trash-service.js';
import fs from 'node:fs';
import path from 'node:path';

import {
  APP_ACCENT_COLOR_SETTING_KEY,
  APP_DEFAULT_LOCALE_SETTING_KEY,
  CAROUSELS_APPLIED_MODE_SETTING_KEY,
  CAROUSELS_MIGRATION_DECISION_SETTING_KEY,
  EXCLUDED_FOLDERS_SETTING_KEY,
  FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY,
  HOME_FEED_DEFAULT_MODE_SETTING_KEY,
  LAST_SUCCESSFUL_GALLERY_ROOT_SETTING_KEY,
  LIBRARY_REBUILD_REQUIRED_SETTING_KEY,
  NESTED_FOLDER_TITLE_FORMAT_SETTING_KEY,
  PREVIOUS_GALLERY_ROOT_SETTING_KEY,
  REELS_FEED_DEFAULT_MODE_SETTING_KEY,
  STORIES_MIGRATION_DECISION_SETTING_KEY,
  TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY,
  TREAT_STORIES_AS_FOLDERS_SETTING_KEY
} from '../constants/app-setting-keys.js';
import { derivativeVersion as buildDerivativeVersion, imageDerivativeVersion } from '../utils/derivative-version.js';
import { isPublishedDerivativeFile } from '../utils/derivative-spec.js';
import { appConfig } from '../config/env.js';
import { databaseManager } from '../db/database.js';
import { getGalleryStatistics } from '../db/gallery-statistics-repository.js';
import { createReelQueuePager, ReelQueueExpiredError } from './reel-queue.js';
import {
  appSettingsRepository,
  canonicalCreatorGalleryRepository,
  collectionConstants,
  collectionRepository,
  folderRepository,
  imageRepository,
  likeRepository,
  placeRepository,
  postRepository,
  scanRunRepository
} from '../db/repositories.js';
import { parseTreatCarouselsAsFoldersSetting, serializeTreatCarouselsAsFoldersSetting } from '../utils/carousels-utils.js';
import type {
  CanonicalWorkSummary,
  CollectionMembershipRecord,
  CollectionSummaryRecord,
  FeedImage,
  FeedPost,
  FolderImageOrder,
  NestedFolderTitleFormat,
  FolderRecord,
  FolderSummaryRecord,
  ImageDetail,
  ImageRecord,
  MediaType,
  PlaceKind,
  PlaybackStrategy,
  PostMediaItem,
  PostRecord,
  SharedFeedItem,
  SharedFolderSummary,
  SharedImageDetail,
  TrashImage
} from '../types/models.js';
import {
  getEffectiveExcludedFolderRules,
  parseExcludedFolderRulesFromSetting,
  serializeExcludedFolderRulesForSetting
} from '../utils/excluded-folder-rules.js';
import { deserializeImageExifData } from '../utils/exif-utils.js';
import { buildMonthDayKey, countFeedBursts, diversifyFeedCandidates, groupFeedBursts, listMonthDayKeysAroundDate } from '../utils/feed-utils.js';
import { shouldPreferMomentRail, type FeedRailKind } from '../utils/feed-rail-utils.js';
import { parseNestedFolderTitleFormatSetting, serializeNestedFolderTitleFormatSetting } from '../utils/folder-title-format.js';
import { countSupportedRootMediaFiles } from '../utils/gallery-root-utils.js';
import { resolveOriginalPath } from '../utils/media-paths.js';
import { getLeafPathName, getParentRelativePath, getPathBreadcrumb } from '../utils/path-utils.js';
import { buildReelQueue, shuffleReelCandidates, type ReelAffinitySignals } from '../utils/reels-utils.js';
import { parseTreatStoriesAsFoldersSetting, serializeTreatStoriesAsFoldersSetting } from '../utils/stories-utils.js';
import { scannerService } from './scanner-service.js';
import { storageService } from './storage-service.js';
import { geodataService, placeResolutionService } from './place-service.js';
import { permanentDeletionService } from './permanent-deletion-service.js';

type FeedMode = 'recent' | 'rediscover' | 'random';
type ReelsFeedMode = 'recommended' | 'recent' | 'random';
const readReelPage = createReelQueuePager();
type SupportedLocale = 'en' | 'es' | 'zh';

interface FeedCapsuleDefinition {
  id: string;
  title: string;
  subtitle: string;
  dateContext: string;
  momentDate?: MomentDateMetadata;
  minimumImageCount: number;
  count: () => number;
  // Candidate rows only; hydrate complete media after the final cover/page selection.
  list: (page: number, limit: number) => FeedPost[];
}

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

type MomentDateMetadata =
  | {
      type: 'on-this-day';
      date: CalendarDateParts;
    }
  | {
      type: 'this-week-previous-years';
      startDate: CalendarDateParts;
      endDate: CalendarDateParts;
    }
  | {
      type: 'from-last-year';
      referenceDate: CalendarDateParts;
      startDate: CalendarDateParts;
      endDate: CalendarDateParts;
    };

interface FeedRailDefinition {
  kind: FeedRailKind;
  title: string;
  description: string;
  singularLabel: string;
  capsules: FeedCapsuleDefinition[];
}

interface StoryRailCapsule {
  id: string;
  title: string;
  subtitle: string;
  dateContext: string;
  imageCount: number;
  coverImage: FeedImage;
  presentation: 'avatar' | 'highlight';
  latestActivityTimestamp: number;
}

interface StoryRailPayload {
  railKind: 'stories';
  railTitle: string;
  railDescription: string;
  railSingularLabel: string;
  hasAvatarStory: boolean;
  avatarStoryId: string | null;
  items: StoryRailCapsule[];
  highlights: StoryRailCapsule[];
}

const REDISCOVER_MIN_AGE_MS = 1000 * 60 * 60 * 24 * 180;
const DIVERSIFIED_FETCH_BATCH_SIZE = 72;
const MAX_DIVERSIFIED_CANDIDATES = 2400;
const THIS_WEEK_RADIUS_DAYS = 7;
const LAST_YEAR_RADIUS_DAYS = 45;
const HIGHLIGHT_BATCH_CANDIDATE_LIMIT = 180;
const HIGHLIGHT_BATCH_COUNT = 3;
const HIGHLIGHT_CAPSULE_MAX_ITEMS = 30;
// Keep the rail visually distinct from the first home-feed screen when enough alternatives exist.
const HIGHLIGHT_FEED_OVERLAP_WINDOW = 18;
const RAIL_COVER_CANDIDATE_LIMIT = 12;
const FALLBACK_AVATAR_STORY_LIMIT = 10;
const FALLBACK_AVATAR_STORY_ID = '__story-avatar-fallback__';
const SUPPORTED_LOCALES = ['en', 'es', 'zh'] as const;

interface PlaceRowFields {
  placeId?: number | null;
  placeSlug?: string | null;
  placeName?: string | null;
  placeKind?: PlaceKind | null;
  placeIsApproximate?: number | null;
}

type IndexedFeedImage = FeedImage & PlaceRowFields & { playbackStrategy?: PlaybackStrategy | null };
type IndexedImageDetail = ImageDetail & PlaceRowFields & { playbackStrategy?: PlaybackStrategy | null; exifJson?: string | null };
type IndexedTrashImage = TrashImage & PlaceRowFields & { playbackStrategy?: PlaybackStrategy | null };
type ScanSummaryRecord = ReturnType<typeof scanRunRepository.latestCompleted>;

function toViewerSafeScanSummary(scan: ScanSummaryRecord | null) {
  if (!scan) {
    return null;
  }

  return {
    ...scan,
    error_text: null,
    warning_text: null
  };
}

function buildViewerSafeStorageReason(libraryAvailable: boolean): string | null {
  return libraryAvailable ? null : 'Configured library storage is unavailable.';
}

function parseFeedMode(value: string | null): FeedMode {
  return value === 'recent' || value === 'rediscover' || value === 'random' ? value : 'random';
}

function getDefaultHomeFeedMode(): FeedMode {
  const storedMode = appSettingsRepository.get(HOME_FEED_DEFAULT_MODE_SETTING_KEY);
  return storedMode === null && appConfig.cosGalleryMode ? 'recent' : parseFeedMode(storedMode);
}

function parseSupportedLocale(value: string | null): SupportedLocale | null {
  if (!value) {
    return null;
  }

  return (SUPPORTED_LOCALES as readonly string[]).includes(value) ? (value as SupportedLocale) : null;
}

function getDefaultLocale(): SupportedLocale | null {
  return parseSupportedLocale(appSettingsRepository.get(APP_DEFAULT_LOCALE_SETTING_KEY));
}

function parseReelsFeedMode(value: string | null): ReelsFeedMode {
  return value === 'recommended' || value === 'recent' || value === 'random' ? value : 'random';
}

function getDefaultReelsFeedMode(): ReelsFeedMode {
  return parseReelsFeedMode(appSettingsRepository.get(REELS_FEED_DEFAULT_MODE_SETTING_KEY));
}

function parseFolderImageOrder(value: string | null): FolderImageOrder {
  return value === 'oldest' ? 'oldest' : 'newest';
}

function getDefaultFolderImageOrder(): FolderImageOrder {
  return parseFolderImageOrder(appSettingsRepository.get(FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY));
}

function getNestedFolderTitleFormat(): NestedFolderTitleFormat {
  return parseNestedFolderTitleFormatSetting(appSettingsRepository.get(NESTED_FOLDER_TITLE_FORMAT_SETTING_KEY));
}

function getTreatStoriesAsFolders(): boolean {
  return parseTreatStoriesAsFoldersSetting(appSettingsRepository.get(TREAT_STORIES_AS_FOLDERS_SETTING_KEY));
}

function getTreatCarouselsAsFolders(): boolean {
  return parseTreatCarouselsAsFoldersSetting(appSettingsRepository.get(TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY));
}

function getCustomExcludedFolders(): string[] {
  return parseExcludedFolderRulesFromSetting(appSettingsRepository.get(EXCLUDED_FOLDERS_SETTING_KEY));
}

function getExcludedFolderSettings() {
  const envExcludedFolders = [...appConfig.galleryExcludedFolders];
  const customExcludedFolders = getCustomExcludedFolders();

  return {
    envExcludedFolders,
    customExcludedFolders,
    effectiveExcludedFolders: getEffectiveExcludedFolderRules({
      envRules: envExcludedFolders,
      customRules: customExcludedFolders
    })
  };
}

function getStoriesMigrationStatus() {
  return {
    hasLegacyStoriesCandidates: folderRepository.hasLegacyStoriesCandidates(),
    decisionPending: appSettingsRepository.get(STORIES_MIGRATION_DECISION_SETTING_KEY) === null
  };
}

function getCarouselsMigrationStatus() {
  const decision = appSettingsRepository.get(CAROUSELS_MIGRATION_DECISION_SETTING_KEY);
  const selectedMode = serializeTreatCarouselsAsFoldersSetting(getTreatCarouselsAsFolders());
  const appliedMode = appSettingsRepository.get(CAROUSELS_APPLIED_MODE_SETTING_KEY);

  return {
    hasLegacyCarouselsCandidates: folderRepository.hasLegacyCarouselsCandidates(),
    decisionPending: decision === null,
    reconciliationPending: decision !== null && appliedMode !== selectedMode
  };
}

function mediaVersion(image: { derivativeSourceVersion?: string; mediaType: string }, kind: 'thumbnail' | 'preview'): string | null {
  return image.derivativeSourceVersion ? buildDerivativeVersion(image.derivativeSourceVersion, kind, image.mediaType) : null;
}

function toPublicMediaUrl(basePath: '/thumbnails' | '/previews', relativePath: string, version?: string | null): string {
  const encodedSegments = relativePath.split('/').map(encodeURIComponent).join('/');
  if (!version) {
    return `${basePath}/${encodedSegments}`;
  }

  return `${basePath}/${encodedSegments}?v=${encodeURIComponent(version)}`;
}

function buildOriginalUrl(id: number): string {
  return `/api/originals/${id}`;
}

function appendVersion(url: string, version?: string | null): string {
  if (!version) {
    return url;
  }

  return `${url}?v=${encodeURIComponent(version)}`;
}

function buildShareThumbnailUrl(id: number, version?: string | null): string {
  return appendVersion(`/api/share/images/${id}/thumbnail`, version);
}

function buildSharePreviewUrl(id: number, version?: string | null): string {
  return appendVersion(`/api/share/images/${id}/preview`, version);
}

function buildPreviewUrl(
  image: {
    id: number;
    mediaType: MediaType;
    previewUrl: string;
  },
  useOriginalForImages = false,
  version?: string | null
): string {
  if (useOriginalForImages && image.mediaType === 'image') {
    return buildOriginalUrl(image.id);
  }

  return toPublicMediaUrl('/previews', image.previewUrl, version);
}

function mapPlaceSummaryFromRow(image: PlaceRowFields) {
  if (!image.placeId || !image.placeSlug || !image.placeName || !image.placeKind) {
    return null;
  }

  return {
    id: image.placeId,
    slug: image.placeSlug,
    name: image.placeName,
    kind: image.placeKind,
    isApproximate: image.placeIsApproximate === 1
  };
}

function resolveOriginalMediaFile(id: number): { path: string; filename: string } | null {
  if (!storageService.getState().libraryAvailable || scannerService.isLibraryRebuildRequired()) {
    return null;
  }

  const detail = imageRepository.getById(id);
  if (!detail || detail.is_deleted || detail.is_trashed) {
    return null;
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveOriginalPath(detail.relative_path);
  } catch {
    return null;
  }

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return null;
  }

  return {
    path: resolvedPath,
    filename: detail.filename
  };
}

function countDerivativeFilesOnDisk(rootPath: string, kind: 'thumbnail' | 'preview'): number {
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      const entryPath = path.join(rootPath, entry.name);

      if (entry.isDirectory()) {
        count += countDerivativeFilesOnDisk(entryPath, kind);
        continue;
      }

      if (entry.isFile() && isPublishedDerivativeFile(entry.name, kind)) {
        count += 1;
      }
    }

    return count;
  } catch (error) {
    const filesystemError = error as NodeJS.ErrnoException;
    if (filesystemError.code === 'ENOENT') {
      return 0;
    }

    throw error;
  }
}

function getParentFolderDisplayName(folderPath: string): string | null {
  const parentFolderPath = getParentRelativePath(folderPath);
  if (!parentFolderPath) {
    return null;
  }

  const parentFolder = folderRepository.getByFolderPath(parentFolderPath);
  if (parentFolder?.name.trim()) {
    return parentFolder.name.trim();
  }

  return getLeafPathName(parentFolderPath);
}

function mapFeedCover(image: IndexedFeedImage): Omit<FeedImage, 'mediaItems'> {
  const { derivativeSourceVersion, playbackStrategy, placeId, placeSlug, placeName, placeKind, placeIsApproximate, isSaved, mediaItems, itemCount, ...rest } = image;
  return {
    ...rest,
    postType: rest.postType ?? 'single',
    carouselTitle: rest.workDisplayTitle ?? (rest.postType === 'carousel' && rest.sourcePath ? getLeafPathName(rest.sourcePath) : null),
    isAnimated: Boolean(rest.isAnimated),
    isSaved: Boolean(isSaved),
    folderParentName: getParentFolderDisplayName(rest.folderPath),
    folderBreadcrumb: getPathBreadcrumb(rest.folderPath),
    thumbnailUrl: toPublicMediaUrl('/thumbnails', rest.thumbnailUrl, mediaVersion(image, 'thumbnail')),
    previewUrl: buildPreviewUrl({
      id: rest.id,
      mediaType: rest.mediaType,
      previewUrl: rest.previewUrl
    }, false, mediaVersion(image, 'preview')),
    place: mapPlaceSummaryFromRow({ placeId, placeSlug, placeName, placeKind, placeIsApproximate }),
    itemCount: itemCount ?? (mediaItems ? mediaItems.length : 1)
  };
}

function mapFeedImage(image: IndexedFeedImage): FeedImage {
  return {
    ...mapFeedCover(image),
    mediaItems: (image.mediaItems ?? []).map((item) => ({
      imageId: item.imageId,
      position: item.position,
      filename: item.filename,
      mediaType: item.mediaType,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
      isAnimated: Boolean(item.isAnimated),
      thumbnailUrl: toPublicMediaUrl('/thumbnails', item.thumbnailUrl, mediaVersion(item, 'thumbnail')),
      previewUrl: buildPreviewUrl({
        id: item.imageId,
        mediaType: item.mediaType,
        previewUrl: item.previewUrl
      }, false, mediaVersion(item, 'preview')),
      originalUrl: buildOriginalUrl(item.imageId),
      playbackStrategy: item.playbackStrategy ?? 'preview',
      mimeType: item.mimeType,
      fileSize: item.fileSize,
      relativePath: item.relativePath,
      exif: item.exif ?? null
    }))
  };
}

function mapCanonicalWorkSummary(item: CanonicalWorkSummary): CanonicalWorkSummary {
  const { cardCover, ...firstMedia } = item;
  return {
    ...mapFeedCover(firstMedia),
    ...(cardCover ? { cardCover: {
      imageId: cardCover.imageId,
      filename: cardCover.filename,
      thumbnailUrl: toPublicMediaUrl('/thumbnails', cardCover.thumbnailUrl,
        mediaVersion({ derivativeSourceVersion: cardCover.derivativeSourceVersion, mediaType: 'image' }, 'thumbnail'))
    } } : {}),
    representation: 'summary',
    postType: item.postType,
    itemCount: item.itemCount,
    imageCount: item.imageCount,
    videoCount: item.videoCount
  };
}

function resolvePostRecord(id: number, isLegacyImageAlias = false): PostRecord | undefined {
  if (isLegacyImageAlias) {
    return postRepository.findByImageId(id);
  }
  return postRepository.findById(id);
}

function isCoverPost(postId: number): boolean {
  return postRepository.isExplicitFolderCover(postId);
}

function mapSharedMediaItem(item: PostMediaItem): PostMediaItem {
  return {
    imageId: item.imageId,
    position: item.position,
    filename: item.filename,
    mediaType: item.mediaType,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    isAnimated: Boolean(item.isAnimated),
    thumbnailUrl: buildShareThumbnailUrl(item.imageId, mediaVersion(item, 'thumbnail')),
    previewUrl: buildSharePreviewUrl(item.imageId, mediaVersion(item, 'preview')),
    playbackStrategy: item.playbackStrategy ?? 'preview',
    mimeType: item.mimeType,
    fileSize: item.fileSize
  };
}

function mapSharedFeedImage(image: IndexedFeedImage): SharedFeedItem {
  const mediaItems = image.mediaItems ?? [];
  const representativeImageId = mediaItems[0]?.imageId ?? image.id;
  return {
    id: image.id,
    folderId: image.folderId,
    folderSlug: image.folderSlug,
    folderName: image.folderName,
    filename: image.filename,
    caption: image.caption,
    carouselTitle: image.workDisplayTitle ?? (image.postType === 'carousel' && image.sourcePath ? getLeafPathName(image.sourcePath) : null),
    width: image.width,
    height: image.height,
    mediaType: image.mediaType,
    durationMs: image.durationMs,
    isAnimated: Boolean(image.isAnimated),
    thumbnailUrl: buildShareThumbnailUrl(representativeImageId, mediaVersion(image, 'thumbnail')),
    previewUrl: buildSharePreviewUrl(representativeImageId, mediaVersion(image, 'preview')),
    sortTimestamp: image.sortTimestamp,
    postType: image.postType ?? 'single',
    itemCount: image.itemCount ?? (mediaItems.length || 1),
    mediaItems: mediaItems.map((item) => mapSharedMediaItem(item))
  };
}

function mapImageDetail(image: IndexedImageDetail): ImageDetail {
  const { derivativeSourceVersion, playbackStrategy, exifJson, placeId, placeSlug, placeName, placeKind, placeIsApproximate, isSaved, mediaItems, itemCount, ...rest } = image as any;
  const useOriginalForImages = appConfig.imageDetailSource === 'original';
  const representativeImageId = mediaItems?.[0]?.imageId ?? rest.id;
  return {
    ...rest,
    postType: rest.postType ?? 'single',
    carouselTitle: rest.workDisplayTitle ?? (rest.postType === 'carousel' && rest.sourcePath ? getLeafPathName(rest.sourcePath) : null),
    isAnimated: Boolean(rest.isAnimated),
    isSaved: Boolean(isSaved),
    exif: deserializeImageExifData(exifJson),
    folderParentName: getParentFolderDisplayName(rest.folderPath),
    folderBreadcrumb: getPathBreadcrumb(rest.folderPath),
    thumbnailUrl: toPublicMediaUrl('/thumbnails', rest.thumbnailUrl, mediaVersion(image, 'thumbnail')),
    previewUrl: buildPreviewUrl({
      id: representativeImageId,
      mediaType: rest.mediaType,
      previewUrl: rest.previewUrl
    }, useOriginalForImages, mediaVersion(image, 'preview')),
    originalUrl: buildOriginalUrl(representativeImageId),
    playbackStrategy,
    place: mapPlaceSummaryFromRow({ placeId, placeSlug, placeName, placeKind, placeIsApproximate }),
    mediaItems: (mediaItems ?? []).map((item: any) => ({
      imageId: item.imageId,
      position: item.position,
      filename: item.filename,
      mediaType: item.mediaType,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
      isAnimated: Boolean(item.isAnimated),
      thumbnailUrl: toPublicMediaUrl('/thumbnails', item.thumbnailUrl, mediaVersion(item, 'thumbnail')),
      previewUrl: buildPreviewUrl({
        id: item.imageId,
        mediaType: item.mediaType,
        previewUrl: item.previewUrl
      }, false, mediaVersion(item, 'preview')),
      originalUrl: buildOriginalUrl(item.imageId),
      playbackStrategy: item.playbackStrategy ?? 'preview',
      mimeType: item.mimeType,
      fileSize: item.fileSize,
      relativePath: item.relativePath,
      exif: item.exif ?? null
    })),
    itemCount: itemCount ?? (mediaItems ? mediaItems.length : 1)
  };
}

function mapSharedImageDetail(image: IndexedImageDetail): SharedImageDetail {
  const mediaItems = image.mediaItems ?? [];
  const representativeImageId = mediaItems[0]?.imageId ?? image.id;
  return {
    id: image.id,
    folderId: image.folderId,
    folderSlug: image.folderSlug,
    folderName: image.folderName,
    filename: image.filename,
    caption: image.caption,
    carouselTitle: image.workDisplayTitle ?? (image.postType === 'carousel' && image.sourcePath ? getLeafPathName(image.sourcePath) : null),
    mediaType: image.mediaType,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    durationMs: image.durationMs,
    isAnimated: Boolean(image.isAnimated),
    thumbnailUrl: buildShareThumbnailUrl(representativeImageId, mediaVersion(image, 'thumbnail')),
    previewUrl: buildSharePreviewUrl(representativeImageId, mediaVersion(image, 'preview')),
    sortTimestamp: image.sortTimestamp,
    nextImageId: image.nextImageId,
    previousImageId: image.previousImageId,
    postType: image.postType ?? 'single',
    itemCount: image.itemCount ?? (mediaItems.length || 1),
    mediaItems: mediaItems.map((item) => mapSharedMediaItem(item))
  };
}

function mapTrashImage(image: IndexedTrashImage): TrashImage {
  const mapped = mapFeedImage(image as IndexedFeedImage);
  return {
    ...mapped,
    trashedAt: image.trashedAt
  };
}

function buildFolderSummary(
  folder: FolderSummaryRecord,
  preloadedCanonicalCreatorId?: number | null
) {
  const workNavigationMode = appConfig.cosGalleryMode && folder.role === 'normal' ? 'work-gallery' : 'post';
  const canonicalCreatorId = preloadedCanonicalCreatorId !== undefined
    ? preloadedCanonicalCreatorId
    : appConfig.cosGalleryMode
      ? canonicalCreatorGalleryRepository.getUniqueCreatorIdForFolder(folder.id)
      : null;
  const hasPreloadedAvatarSummary =
    Object.hasOwn(folder, 'summary_avatar_image_id') || Object.hasOwn(folder, 'summary_avatar_thumbnail_path');

  if (hasPreloadedAvatarSummary) {
    return {
      id: folder.id,
      canonicalCreatorId,
      slug: folder.slug,
      name: folder.name,
      description: folder.description,
      parentFolderName: getParentFolderDisplayName(folder.folder_path),
      folderPath: folder.folder_path,
      breadcrumb: getPathBreadcrumb(folder.folder_path),
      workNavigationMode,
      contentRating: folder.content_rating,
      imageCount: folder.image_count,
      postCount: folder.post_count,
      videoCount: folder.video_count,
      latestImageMtimeMs: folder.latest_image_mtime_ms,
      hasAvatarStory: Boolean(folder.has_avatar_story),
      avatarImageId: folder.summary_avatar_image_id ?? null,
      avatarUrl: folder.summary_avatar_thumbnail_path
        ? toPublicMediaUrl('/thumbnails', folder.summary_avatar_thumbnail_path, folder.summary_avatar_source_version ? buildDerivativeVersion(folder.summary_avatar_source_version, 'thumbnail', folder.summary_avatar_media_type) : null)
        : null
    };
  }

  const preferredAvatarImageId = folder.avatar_image_id ?? imageRepository.getLatestFolderImageId(folder.id);
  let avatar = preferredAvatarImageId ? imageRepository.getImageDetail(preferredAvatarImageId, undefined, true) : undefined;

  if (!avatar) {
    const fallbackAvatarImageId = imageRepository.getLatestFolderImageId(folder.id);
    avatar = fallbackAvatarImageId ? imageRepository.getImageDetail(fallbackAvatarImageId, undefined, true) : undefined;
  }

  return {
    id: folder.id,
    canonicalCreatorId,
    slug: folder.slug,
    name: folder.name,
    description: folder.description,
    parentFolderName: getParentFolderDisplayName(folder.folder_path),
    folderPath: folder.folder_path,
    breadcrumb: getPathBreadcrumb(folder.folder_path),
    workNavigationMode,
    contentRating: folder.content_rating,
    imageCount: folder.image_count,
    postCount: folder.post_count,
    videoCount: folder.video_count,
    latestImageMtimeMs: folder.latest_image_mtime_ms,
    hasAvatarStory: Boolean(folder.has_avatar_story),
    avatarImageId: avatar?.id ?? null,
    avatarUrl: avatar ? mapImageDetail(avatar).thumbnailUrl : null
  };
}

function buildSharedFolderSummary(folder: FolderSummaryRecord): SharedFolderSummary {
  const summary = buildFolderSummary(folder);

  return {
    id: summary.id,
    slug: summary.slug,
    name: summary.name,
    description: summary.description,
    imageCount: summary.imageCount,
    postCount: summary.postCount,
    videoCount: summary.videoCount,
    avatarThumbnailUrl: summary.avatarImageId ? buildShareThumbnailUrl(summary.avatarImageId, summary.avatarUrl ? new URL(summary.avatarUrl, 'http://localhost').searchParams.get('v') : null) : null,
    sortTimestamp: summary.latestImageMtimeMs ?? 0
  };
}

function mapFeedImageForOwnerFolder(
  image: IndexedFeedImage,
  ownerFolder: ReturnType<typeof buildFolderSummary>
): FeedImage {
  return {
    ...mapFeedImage(image),
    folderId: ownerFolder.id,
    folderSlug: ownerFolder.slug,
    folderName: ownerFolder.name,
    folderParentName: ownerFolder.parentFolderName,
    folderPath: ownerFolder.folderPath,
    folderBreadcrumb: ownerFolder.breadcrumb
  };
}

function formatStoryDateContext(timestamp: number | null): string {
  if (timestamp === null) {
    return 'No recent activity';
  }

  return `Latest ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(timestamp))}`;
}

function formatMonthDay(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(date);
}

function formatShortRange(startDate: Date, endDate: Date): string {
  const sameMonth = startDate.getMonth() === endDate.getMonth();
  const sameYear = startDate.getFullYear() === endDate.getFullYear();

  if (sameMonth && sameYear) {
    const month = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(startDate);
    return `${month} ${startDate.getDate()}-${endDate.getDate()}, ${startDate.getFullYear()}`;
  }

  return `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(startDate)} to ${new Intl.DateTimeFormat(
    undefined,
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }
  ).format(endDate)}`;
}

function formatMonthYear(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

function mapFeedItems(items: IndexedFeedImage[]): FeedImage[] {
  return items.map((item) => mapFeedImage(item));
}

function mapCollectionSummary(collection: CollectionSummaryRecord) {
  const previewImages = collection.preview_image_ids
    ? collection.preview_image_ids
      .split(',')
      .map((value) => Number.parseInt(value, 10))
      .filter((value, index, values) => Number.isInteger(value) && value > 0 && values.indexOf(value) === index)
      .map((id) => {
        const previewDetail = imageRepository.getImageDetail(id, undefined, false);
        return previewDetail ? mapImageDetail(previewDetail) : null;
      })
      .filter((image): image is ImageDetail => image !== null)
    : [];
  const coverImage = previewImages[0]
    ?? (collection.cover_image_id
      ? (() => {
          const coverDetail = imageRepository.getImageDetail(collection.cover_image_id, undefined, false);
          return coverDetail ? mapImageDetail(coverDetail) : null;
        })()
      : null);

  return {
    id: collection.id,
    slug: collection.slug,
    name: collection.name,
    isDefault: collection.is_default === 1,
    itemCount: collection.item_count,
    coverImage,
    previewImages,
    createdAt: collection.created_at,
    updatedAt: collection.updated_at
  };
}

function mapCollectionMembership(collection: CollectionMembershipRecord) {
  return {
    ...mapCollectionSummary(collection),
    containsImage: collection.contains_image === 1
  };
}

function buildPaginatedPayload<T extends FeedImage>(items: T[], page: number, limit: number, total: number) {
  return {
    items,
    page,
    limit,
    total,
    hasMore: page * limit < total
  };
}

type CosGalleryIdentityItem = {
  key: string;
  identityType: 'creator' | 'folder';
  id: number;
  slug: string;
  name: string;
  canonicalCreatorId: number | null;
  canonicalName: string | null;
  rosterStatus: 'active' | 'inactive' | 'unlinked';
  linkStatus: 'linked' | 'unlinked';
  preference: 'liked' | 'kept' | null;
  galleryLabels: GalleryLabel[];
  folderIds: number[];
  folderNames: string[];
  folderPath: string;
  workCount: number;
  latestWorkAt: number | null;
  contentRating: 'R15' | 'R18' | null;
  ratingSourceCount: number;
  ratingConflict: boolean;
  aliases: string[];
  coverImageId: number | null;
  coverUrl: string | null;
  coverWidth: number | null;
  coverHeight: number | null;
  avatarUrl: string | null;
  description: string | null;
  localFolders: Array<{ id: number; slug: string; name: string; path: string; workCount: number }>;
};

function chooseCanonicalCreatorCover<T extends {
  folderId: number;
  latestWorkAt: number | null;
  coverImageId: number | null;
  coverPriority: number;
}>(candidates: T[]): T {
  return [...candidates].sort((left, right) => {
    const leftMissing = left.coverImageId === null ? 1 : 0;
    const rightMissing = right.coverImageId === null ? 1 : 0;
    if (leftMissing !== rightMissing) return leftMissing - rightMissing;
    if (left.coverPriority !== right.coverPriority) return left.coverPriority - right.coverPriority;
    if (left.coverPriority < 3) return left.folderId - right.folderId;
    const latestDifference = (right.latestWorkAt ?? 0) - (left.latestWorkAt ?? 0);
    return latestDifference || left.folderId - right.folderId;
  })[0]!;
}

function buildCosGalleryIdentityItems(creatorId?: number): CosGalleryIdentityItem[] {
  const candidates = canonicalCreatorGalleryRepository.listFolderCandidates(creatorId);
  const labelsByCreator = new CreatorGalleryLabelService().list(creatorId);
  const aliasesByCreator = new Map<number, string[]>();
  for (const row of canonicalCreatorGalleryRepository.listAliases(creatorId)) {
    const aliases = aliasesByCreator.get(row.creatorId) ?? [];
    if (!aliases.includes(row.alias)) aliases.push(row.alias);
    aliasesByCreator.set(row.creatorId, aliases);
  }

  const grouped = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = candidate.canonicalCreatorId === null
      ? `folder:${candidate.folderId}`
      : `creator:${candidate.canonicalCreatorId}`;
    const values = grouped.get(key) ?? [];
    values.push(candidate);
    grouped.set(key, values);
  }
  return [...grouped.entries()].map(([key, values]) => {
    const first = values[0]!;
    const coverSource = chooseCanonicalCreatorCover(values);
    const cover = coverSource.coverImageId === null
      ? undefined
      : imageRepository.getById(coverSource.coverImageId);
    const canonicalCreatorId = first.canonicalCreatorId;
    const linked = canonicalCreatorId !== null;
    const localFolders = [...values].sort((left, right) => left.folderId - right.folderId);
    const coverUrl = cover?.thumbnail_path
      ? toPublicMediaUrl('/thumbnails', cover.thumbnail_path, imageDerivativeVersion(cover, 'thumbnail'))
      : null;
    return {
      key,
      identityType: linked ? 'creator' as const : 'folder' as const,
      id: linked ? canonicalCreatorId : first.folderId,
      slug: coverSource.slug,
      name: linked ? first.canonicalName! : first.folderName,
      canonicalCreatorId,
      canonicalName: first.canonicalName,
      rosterStatus: linked
        ? (first.creatorIsActive === 1 ? 'active' as const : 'inactive' as const)
        : 'unlinked' as const,
      linkStatus: linked ? 'linked' as const : 'unlinked' as const,
      preference: linked ? first.preference : null,
      galleryLabels: linked ? labelsByCreator.get(canonicalCreatorId) ?? [] : [],
      folderIds: values.map(value => value.folderId).sort((left, right) => left - right),
      folderNames: values.map(value => value.folderName).sort((left, right) => left.localeCompare(right)),
      folderPath: coverSource.folderPath,
      // Display metadata is read-only and independent of the ingest destination.
      // Retain the first non-empty description by stable physical Folder ID.
      description: localFolders.find(value => value.description?.trim())?.description ?? null,
      localFolders: localFolders.map(value => ({
        id: value.folderId, slug: value.slug, name: value.folderName,
        path: value.folderPath, workCount: Number(value.workCount)
      })),
      workCount: values.reduce((sum, value) => sum + Number(value.workCount), 0),
      latestWorkAt: values.reduce<number | null>((latest, value) => {
        const current = value.latestWorkAt === null ? null : Number(value.latestWorkAt);
        if (current === null) return latest;
        return latest === null || current > latest ? current : latest;
      }, null),
      contentRating: linked ? first.contentRating : null,
      ratingSourceCount: linked ? Number(first.ratingSourceCount) : 0,
      ratingConflict: false,
      aliases: linked ? aliasesByCreator.get(canonicalCreatorId) ?? [] : [],
      coverImageId: cover?.id ?? null,
      coverUrl,
      avatarUrl: coverUrl,
      coverWidth: cover?.width ?? null,
      coverHeight: cover?.height ?? null
    };
  }).sort((left, right) =>
    (right.latestWorkAt ?? 0) - (left.latestWorkAt ?? 0)
    || left.name.localeCompare(right.name)
    || left.key.localeCompare(right.key)
  );
}

function buildTrashPaginatedPayload(items: TrashImage[], page: number, limit: number, total: number) {
  return {
    items,
    page,
    limit,
    total,
    hasMore: page * limit < total
  };
}

function sliceItemsForPage(items: FeedPost[], page: number, limit: number): FeedPost[] {
  const offset = (page - 1) * limit;
  return items.slice(offset, offset + limit);
}

function filterExcludedFeedItems(items: FeedPost[], excludedImageIds: Set<number>): FeedPost[] {
  if (excludedImageIds.size === 0) {
    return items;
  }

  return items.filter((item) => !excludedImageIds.has(item.id));
}

function limitHighlightItems(items: FeedPost[], minimumImageCount: number, excludedImageIds: Set<number>): FeedPost[] {
  const cappedItems = items.slice(0, HIGHLIGHT_CAPSULE_MAX_ITEMS);
  if (excludedImageIds.size === 0) {
    return cappedItems;
  }

  const filteredItems = filterExcludedFeedItems(items, excludedImageIds).slice(0, HIGHLIGHT_CAPSULE_MAX_ITEMS);
  return filteredItems.length >= minimumImageCount ? filteredItems : cappedItems;
}

function buildStaticCapsuleDefinition(
  capsule: Pick<FeedCapsuleDefinition, 'id' | 'title' | 'subtitle' | 'dateContext' | 'minimumImageCount'>,
  items: FeedPost[]
): FeedCapsuleDefinition {
  const cappedItems = items.slice(0, HIGHLIGHT_CAPSULE_MAX_ITEMS);

  return {
    ...capsule,
    count: () => cappedItems.length,
    list: (page, limit) => sliceItemsForPage(cappedItems, page, limit)
  };
}

function listDiversifiedModeItems<T extends FeedImage>(
  total: number,
  page: number,
  limit: number,
  loadBatch: (offset: number, limit: number) => T[]
): T[] {
  if (total === 0) {
    return [];
  }

  const targetCount = Math.min(total, page * limit);
  const candidateLimit = Math.min(total, Math.max(targetCount * 12, 720), MAX_DIVERSIFIED_CANDIDATES);
  const candidates: T[] = [];
  let offset = 0;

  while (offset < candidateLimit) {
    const batch = loadBatch(offset, Math.min(DIVERSIFIED_FETCH_BATCH_SIZE, candidateLimit - offset));
    if (batch.length === 0) {
      break;
    }

    candidates.push(...batch);
    offset += batch.length;

    if (countFeedBursts(candidates) >= targetCount || batch.length < DIVERSIFIED_FETCH_BATCH_SIZE) {
      break;
    }
  }

  const diversified = diversifyFeedCandidates(candidates);
  return diversified.slice((page - 1) * limit, page * limit);
}

function createDailySeed(now = new Date()): number {
  return Number(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`);
}

function toCalendarDateParts(date: Date): CalendarDateParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  };
}

function getRecentBatchHighlightItems(candidates: FeedPost[], excludedImageIds: Set<number>): FeedPost[] {
  const bursts = groupFeedBursts(candidates)
    .filter((burst) => burst.items.length >= 2)
    .slice(0, HIGHLIGHT_BATCH_COUNT * 2);
  const filteredBursts = bursts
    .map((burst) => ({
      ...burst,
      items: filterExcludedFeedItems(burst.items, excludedImageIds)
    }))
    .filter((burst) => burst.items.length >= 2)
    .slice(0, HIGHLIGHT_BATCH_COUNT);

  if (filteredBursts.length > 0) {
    return filteredBursts.flatMap((burst) => burst.items).slice(0, HIGHLIGHT_CAPSULE_MAX_ITEMS);
  }

  return bursts
    .slice(0, HIGHLIGHT_BATCH_COUNT)
    .flatMap((burst) => burst.items)
    .slice(0, HIGHLIGHT_CAPSULE_MAX_ITEMS);
}

function buildMomentRailDefinition(now = new Date()): FeedRailDefinition {
  const currentYear = now.getFullYear();
  const onThisDayKeys = [buildMonthDayKey(now)];
  const weekKeys = listMonthDayKeysAroundDate(now, THIS_WEEK_RADIUS_DAYS, THIS_WEEK_RADIUS_DAYS);
  const lastYearReference = new Date(now);
  lastYearReference.setFullYear(lastYearReference.getFullYear() - 1);
  const lastYearStart = new Date(lastYearReference);
  lastYearStart.setDate(lastYearStart.getDate() - LAST_YEAR_RADIUS_DAYS);
  lastYearStart.setHours(0, 0, 0, 0);
  const lastYearEnd = new Date(lastYearReference);
  lastYearEnd.setDate(lastYearEnd.getDate() + LAST_YEAR_RADIUS_DAYS);
  lastYearEnd.setHours(23, 59, 59, 999);
  const thisWeekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - THIS_WEEK_RADIUS_DAYS);
  const thisWeekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + THIS_WEEK_RADIUS_DAYS);

  return {
    kind: 'moments',
    title: 'Moments',
    description: 'Memory capsules shaped by real capture dates from your library.',
    singularLabel: 'Moment',
    capsules: [
      {
        id: 'on-this-day',
        title: 'On This Day',
        subtitle: `${formatMonthDay(now)} across previous years`,
        dateContext: formatMonthDay(now),
        momentDate: {
          type: 'on-this-day',
          date: toCalendarDateParts(now)
        },
        minimumImageCount: 1,
        count: () => imageRepository.countByMonthDayKeys(onThisDayKeys, currentYear),
        list: (page, limit) => imageRepository.listByMonthDayKeys(onThisDayKeys, currentYear, page, limit, { hydrateMedia: false })
      },
      {
        id: 'this-week-previous-years',
        title: 'This Week',
        subtitle: `${formatShortRange(thisWeekStart, thisWeekEnd)} from previous years`,
        dateContext: formatShortRange(thisWeekStart, thisWeekEnd),
        momentDate: {
          type: 'this-week-previous-years',
          startDate: toCalendarDateParts(thisWeekStart),
          endDate: toCalendarDateParts(thisWeekEnd)
        },
        minimumImageCount: 2,
        count: () => imageRepository.countByMonthDayKeys(weekKeys, currentYear),
        list: (page, limit) => imageRepository.listByMonthDayKeys(weekKeys, currentYear, page, limit, { hydrateMedia: false })
      },
      {
        id: 'from-last-year',
        title: 'Last Year Around Now',
        subtitle: `A revisit to ${formatMonthYear(lastYearReference)}`,
        dateContext: formatShortRange(lastYearStart, lastYearEnd),
        momentDate: {
          type: 'from-last-year',
          referenceDate: toCalendarDateParts(lastYearReference),
          startDate: toCalendarDateParts(lastYearStart),
          endDate: toCalendarDateParts(lastYearEnd)
        },
        minimumImageCount: 1,
        count: () => imageRepository.countByEffectiveTimeRange(lastYearStart.getTime(), lastYearEnd.getTime()),
        list: (page, limit) => imageRepository.listByEffectiveTimeRange(lastYearStart.getTime(), lastYearEnd.getTime(), page, limit, { hydrateMedia: false })
      }
    ]
  };
}

function buildHighlightRailDefinition(now = new Date()): FeedRailDefinition {
  // Both reads used the same stable time/id order and offset. Reuse its prefix
  // for overlap exclusion instead of querying and hydrating the first 18 twice.
  const recentCandidates = imageRepository.listRecentCandidates(0, HIGHLIGHT_BATCH_CANDIDATE_LIMIT, { hydrateMedia: false });
  const excludedImageIds = new Set(recentCandidates.slice(0, HIGHLIGHT_FEED_OVERLAP_WINDOW).map(item => item.id));
  const rediscoverCutoff = now.getTime() - REDISCOVER_MIN_AGE_MS;
  const dailySeed = createDailySeed(now);
  const highlightFetchLimit = HIGHLIGHT_CAPSULE_MAX_ITEMS + HIGHLIGHT_FEED_OVERLAP_WINDOW;
  const recentBatchItems = getRecentBatchHighlightItems(recentCandidates, excludedImageIds);
  const forgottenFavoriteItems = limitHighlightItems(
    likeRepository.listLikedOlderThan(1, highlightFetchLimit, rediscoverCutoff, { hydrateMedia: false }),
    1,
    excludedImageIds
  );
  const deepCutItems = limitHighlightItems(
    listDiversifiedModeItems(imageRepository.countRediscover(rediscoverCutoff), 1, highlightFetchLimit, (offset, batchLimit) =>
      imageRepository.listRediscoverCandidates(offset, batchLimit, rediscoverCutoff, { hydrateMedia: false })
    ),
    1,
    excludedImageIds
  );
  const luckyDipItems = limitHighlightItems(imageRepository.listRandom(1, highlightFetchLimit, dailySeed, { hydrateMedia: false }), 1, excludedImageIds);
  const recentBatchCount = groupFeedBursts(recentBatchItems).length;

  return {
    kind: 'highlights',
    title: 'Stories',
    description: 'Curated story-style sets from your library when capture dates are sparse or synthetic.',
    singularLabel: 'Story',
    capsules: [
      buildStaticCapsuleDefinition(
        {
          id: 'highlight-recent-batches',
          title: 'Recent Batches',
          subtitle: 'Latest runs gathered into one set',
          dateContext: `${recentBatchCount} batch${recentBatchCount === 1 ? '' : 'es'}`,
          minimumImageCount: 2
        },
        recentBatchItems
      ),
      buildStaticCapsuleDefinition(
        {
          id: 'highlight-forgotten-favorites',
          title: 'Forgotten Favorites',
          subtitle: 'Older liked posts worth another look',
          dateContext: 'Liked and older than 6 months',
          minimumImageCount: 1
        },
        forgottenFavoriteItems
      ),
      buildStaticCapsuleDefinition(
        {
          id: 'highlight-deep-cuts',
          title: 'Deep Cuts',
          subtitle: 'Older posts resurfaced from the archive',
          dateContext: 'Older than 6 months',
          minimumImageCount: 1
        },
        deepCutItems
      ),
      buildStaticCapsuleDefinition(
        {
          id: 'highlight-lucky-dip',
          title: 'Lucky Dip',
          subtitle: 'A playful mix from across the library',
          dateContext: 'Stable for today',
          minimumImageCount: 1
        },
        luckyDipItems
      )
    ]
  };
}

function materializeRailDefinition(definition: FeedRailDefinition) {
  const usedCoverImageIds = new Set<number>();

  const capsules = definition.capsules
    .map((capsule) => {
      const imageCount = capsule.count();
      if (imageCount < capsule.minimumImageCount) {
        return null;
      }

      const coverCandidates = capsule.list(1, RAIL_COVER_CANDIDATE_LIMIT);
      const coverImage = coverCandidates.find((image) => !usedCoverImageIds.has(image.id)) ?? coverCandidates[0];
      if (!coverImage) {
        return null;
      }

      usedCoverImageIds.add(coverImage.id);

      return {
        id: capsule.id,
        title: capsule.title,
        subtitle: capsule.subtitle,
        dateContext: capsule.dateContext,
        momentDate: capsule.momentDate,
        imageCount,
        coverImage
      };
    })
    .filter((capsule): capsule is NonNullable<typeof capsule> => capsule !== null);

  // Selection only reads id/folder/time. Load full media for all final covers
  // together, rather than hydrating every candidate or querying each cover.
  postRepository.hydratePostItems(capsules.map(capsule => capsule.coverImage));
  return {
    ...definition,
    capsules: capsules.map(capsule => ({ ...capsule, coverImage: mapFeedImage(capsule.coverImage) }))
  };
}

function getSelectedFeedRail(now = new Date()) {
  const totalImages = imageRepository.countFeed();
  const exifImages = imageRepository.countByTakenAtSource('exif');
  const preferMoments = shouldPreferMomentRail(totalImages, exifImages);
  const build = (moments: boolean) => {
    const definition = moments ? buildMomentRailDefinition(now) : buildHighlightRailDefinition(now);
    return { definition, rail: materializeRailDefinition(definition) };
  };
  // Do not assemble the unused rail. The definitions belong to this read only:
  // capture-date windows, local calendar day and daily seed are recomputed next time.
  const preferred = build(preferMoments);
  if (preferred.rail.capsules.length > 0) return preferred;
  const fallback = build(!preferMoments);
  if (fallback.rail.capsules.length > 0) return fallback;
  // Preserve the original empty result's Highlights metadata regardless of preference.
  return preferMoments ? fallback : preferred;
}

function buildFolderStoryRail(folder: FolderSummaryRecord): StoryRailPayload {
  const ownerFolder = buildFolderSummary(folder);
  const storyFolders = folderRepository.listOwnedStoryFolders(folder.id);
  const rootStoryFolder = storyFolders.find((entry) => entry.role === 'story_root') ?? null;
  const highlightStoryFolders = storyFolders.filter((entry) => entry.role === 'story_capsule');

  const rootStoryCapsule = rootStoryFolder ? buildStoryRailCapsule(rootStoryFolder, ownerFolder) : null;
  const highlightCapsules = highlightStoryFolders
    .map((storyFolder) => buildStoryRailCapsule(storyFolder, ownerFolder))
    .filter((capsule): capsule is StoryRailCapsule => capsule !== null)
    .sort((left, right) => {
      if (left.latestActivityTimestamp !== right.latestActivityTimestamp) {
        return right.latestActivityTimestamp - left.latestActivityTimestamp;
      }

      return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
    });
  const avatarStoryCapsule = rootStoryCapsule ?? buildFallbackAvatarStoryCapsule(ownerFolder);
  const items = avatarStoryCapsule ? [avatarStoryCapsule, ...highlightCapsules] : highlightCapsules;

  return {
    railKind: 'stories',
    railTitle: 'Stories',
    railDescription: `Stories and highlights for ${folder.name}.`,
    railSingularLabel: 'Story',
    hasAvatarStory: avatarStoryCapsule !== null,
    avatarStoryId: avatarStoryCapsule?.id ?? null,
    items,
    highlights: highlightCapsules
  };
}

function buildStoryRailCapsule(
  storyFolder: FolderRecord,
  ownerFolder: ReturnType<typeof buildFolderSummary>
): StoryRailCapsule | null {
  const imageCount = imageRepository.countStoryMediaByFolder(storyFolder.id);
  if (imageCount === 0) {
    return null;
  }

  const coverImage = imageRepository.listStoryFolderImages(storyFolder.id, 1, 1)[0];
  if (!coverImage) {
    return null;
  }

  const latestActivityTimestamp = imageRepository.getLatestEffectiveTimestampByFolder(storyFolder.id) ?? 0;
  const presentation = storyFolder.role === 'story_root' ? 'avatar' as const : 'highlight' as const;

  return {
    id: storyFolder.slug,
    title: presentation === 'avatar' ? ownerFolder.name : storyFolder.name,
    subtitle: presentation === 'avatar' ? `${ownerFolder.name} story set` : 'Profile highlight',
    dateContext: formatStoryDateContext(latestActivityTimestamp),
    imageCount,
    coverImage: mapFeedImageForOwnerFolder(coverImage, ownerFolder),
    presentation,
    latestActivityTimestamp
  };
}

function buildFallbackAvatarStoryCapsule(
  ownerFolder: ReturnType<typeof buildFolderSummary>
): StoryRailCapsule | null {
  const imageCount = Math.min(imageRepository.countStoryCapsuleMediaByOwnerFolder(ownerFolder.id), FALLBACK_AVATAR_STORY_LIMIT);
  if (imageCount === 0) {
    return null;
  }

  const coverImage = imageRepository.listStoryCapsuleImagesByOwnerFolder(ownerFolder.id, 1, 1)[0];
  if (!coverImage) {
    return null;
  }

  const latestActivityTimestamp = coverImage.takenAt ?? coverImage.sortTimestamp;

  return {
    id: FALLBACK_AVATAR_STORY_ID,
    title: ownerFolder.name,
    subtitle: 'Latest from highlights',
    dateContext: formatStoryDateContext(latestActivityTimestamp),
    imageCount,
    coverImage: mapFeedImageForOwnerFolder(coverImage, ownerFolder),
    presentation: 'avatar',
    latestActivityTimestamp
  };
}

function listFallbackAvatarStoryItems(
  ownerFolder: ReturnType<typeof buildFolderSummary>,
  page: number,
  limit: number
) {
  const total = Math.min(imageRepository.countStoryCapsuleMediaByOwnerFolder(ownerFolder.id), FALLBACK_AVATAR_STORY_LIMIT);
  const offset = (page - 1) * limit;
  const remaining = Math.max(total - offset, 0);
  const items =
    remaining > 0
      ? imageRepository
          .listStoryCapsuleImagesByOwnerFolder(ownerFolder.id, page, Math.min(limit, remaining))
          .map((image) => mapFeedImageForOwnerFolder(image, ownerFolder))
      : [];

  return {
    total,
    items
  };
}

function presentGalleryCreator(creator: CosGalleryIdentityItem, includePreference: boolean) {
  const { preference, ...publicCreator } = creator;
  return includePreference ? { ...publicCreator, preference } : publicCreator;
}

export const galleryService = {
  getCosGalleryCreators(
    page = 1,
    limit = 60,
    contentRating?: 'R15' | 'R18' | 'unclassified' | 'unlinked' | 'inactive',
    query?: string,
    preference?: 'liked' | 'kept',
    label?: GalleryLabel,
    includePreference = false
  ) {
    if (!storageService.getState().libraryAvailable) {
      return {
        items: [], page, limit, total: 0, hasMore: false,
        summary: { all: 0, R15: 0, R18: 0, unclassified: 0, unlinked: 0, inactive: 0 }
      };
    }

    const normalizedQuery = query?.trim().toLocaleLowerCase() ?? '';
    // A gallery label replaces even legacy lifecycle/rating query values.
    if (label) contentRating = undefined;
    if (!includePreference) preference = undefined;
    const allItems = buildCosGalleryIdentityItems();
    const summary = {
      all: allItems.filter(item => item.rosterStatus !== 'inactive').length,
      R15: allItems.filter(item => item.rosterStatus !== 'inactive' && item.contentRating === 'R15').length,
      R18: allItems.filter(item => item.rosterStatus !== 'inactive' && item.contentRating === 'R18').length,
      unclassified: allItems.filter(item => item.rosterStatus !== 'inactive' && item.linkStatus === 'linked' && item.contentRating === null).length,
      unlinked: allItems.filter(item => item.rosterStatus !== 'inactive' && item.linkStatus === 'unlinked').length,
      inactive: allItems.filter(item => item.rosterStatus === 'inactive').length
    };
    const filtered = allItems.filter((creator) => {
      // Apply user preference to the complete canonical identity range, before
      // pagination. It is not a work like, collection, or task priority.
      if (preference && creator.preference !== preference) return false;
      if (label && !creator.galleryLabels.includes(label)) return false;
      if (contentRating === 'inactive') {
        if (creator.rosterStatus !== 'inactive') return false;
      } else {
        if (creator.rosterStatus === 'inactive') return false;
        if (contentRating === 'unlinked' && creator.linkStatus !== 'unlinked') return false;
        if (contentRating === 'unclassified' && (creator.linkStatus !== 'linked' || creator.contentRating !== null)) return false;
        if ((contentRating === 'R15' || contentRating === 'R18') && creator.contentRating !== contentRating) return false;
      }
      if (!normalizedQuery) return true;
      return [creator.name, creator.canonicalName, ...creator.aliases, ...creator.folderNames]
        .some(value => value?.toLocaleLowerCase().includes(normalizedQuery));
    });
    const offset = (page - 1) * limit;
    return {
      items: filtered.slice(offset, offset + limit).map(creator => presentGalleryCreator(creator, includePreference)),
      page,
      limit,
      total: filtered.length,
      hasMore: offset + limit < filtered.length,
      summary
    };
  },

  updateCreatorContentRating(id: number, contentRating: 'R15' | 'R18' | null) {
    // This legacy route has always received a physical Folder ID. Keep that
    // contract intact; canonical-creator APIs use their own explicit routes.
    const canonical = new ManagedCreatorService().updateFolderRating(id, { contentRating });
    return buildCosGalleryIdentityItems().find(creator =>
      creator.identityType === 'creator' && creator.id === canonical.id
    ) ?? null;
  },

  getCanonicalCreator(id: number, includePreference = false) {
    if (!storageService.getState().libraryAvailable) return null;
    const creator = buildCosGalleryIdentityItems(id)[0];
    return creator ? {
      ...presentGalleryCreator(creator, includePreference),
      ...canonicalCreatorGalleryRepository.getVisibleMediaSummary(id),
      unavailablePrimaryWorks: canonicalCreatorGalleryRepository.listPrimaryCopies(id)
        .filter(copy => copy.indexedAvailable !== 1)
        .map(copy => ({ workId: copy.workId, postId: copy.postId, title: copy.title,
          reason: '主副本未索引或不可用，未自动切换其他副本' }))
    } : null;
  },

  getCanonicalCreatorWorks(
    id: number,
    page: number,
    limit: number,
    mediaType?: MediaType,
    includePreference = false
  ) {
    const creator = this.getCanonicalCreator(id, includePreference);
    if (!creator) return null;
    const total = canonicalCreatorGalleryRepository.countVisibleWorks(id, mediaType);
    const items = canonicalCreatorGalleryRepository.listVisibleWorks(
      id,
      page,
      limit,
      getDefaultFolderImageOrder(),
      mediaType
    );
    return {
      creator,
      ...buildPaginatedPayload(items.map(item => mapCanonicalWorkSummary(item)), page, limit, total)
    };
  },

  getPostSummary(postId: number) {
    if (!storageService.getState().libraryAvailable) return null;
    const summary = postRepository.getVisiblePostSummary(postId);
    return summary ? mapCanonicalWorkSummary(summary) : null;
  },

  getCanonicalCreatorWork(id: number, postId: number, mediaType?: MediaType) {
    if (!storageService.getState().libraryAvailable || !canonicalCreatorGalleryRepository.ownsVisiblePost(id, postId)) return null;
    const detail = this.getImageDetail(postId, mediaType);
    if (!detail) return null;
    return { ...detail, sortTimestamp: canonicalCreatorGalleryRepository.effectiveSortTimestamp(postId) ?? detail.sortTimestamp };
  },

  getCosGalleryWorks(
    page: number,
    limit: number,
    contentRating?: 'R15' | 'R18',
    query?: string
  ) {
    if (!storageService.getState().libraryAvailable) {
      return { items: [], page, limit, total: 0, hasMore: false };
    }

    const total = postRepository.countCosGalleryWorks(contentRating, query);
    const items = postRepository.listCosGalleryWorks(page, limit, contentRating, query);
    return buildPaginatedPayload(mapFeedItems(items), page, limit, total);
  },

  getFeed(page: number, limit: number, mode: FeedMode = 'random', randomSeed?: number) {
    if (!storageService.getState().libraryAvailable) {
      return {
        mode,
        items: [],
        page,
        limit,
        total: 0,
        hasMore: false
      };
    }

    if (mode === 'random') {
      const total = imageRepository.countFeed();
      const seed = Number.isFinite(randomSeed)
        ? Number(randomSeed)
        : Number(new Date().toISOString().slice(0, 10).replaceAll('-', ''));

      return {
        mode,
        ...buildPaginatedPayload(mapFeedItems(imageRepository.listRandom(page, limit, seed)), page, limit, total)
      };
    }

    if (mode === 'rediscover') {
      const cutoffTimestamp = Date.now() - REDISCOVER_MIN_AGE_MS;
      const total = imageRepository.countRediscover(cutoffTimestamp);
      const items = listDiversifiedModeItems(total, page, limit, (offset, batchLimit) =>
        imageRepository.listRediscoverCandidates(offset, batchLimit, cutoffTimestamp)
      );

      return {
        mode,
        ...buildPaginatedPayload(mapFeedItems(items), page, limit, total)
      };
    }

    const total = imageRepository.countFeed();
    const offset = (page - 1) * limit;
    const items = imageRepository.listRecentCandidates(offset, limit);

    return {
      mode,
      ...buildPaginatedPayload(mapFeedItems(items), page, limit, total)
    };
  },

  getReels(page: number, limit: number, mode: ReelsFeedMode = 'recommended', seed?: number, signals: ReelAffinitySignals = {}, cursor?: string) {
    if (!storageService.getState().libraryAvailable) {
      return {
        mode,
        items: [],
        page,
        limit,
        total: 0,
        hasMore: false,
        nextCursor: null
      };
    }

    if (page > 1 && !cursor) throw new ReelQueueExpiredError();
    const payload = readReelPage({
      database: databaseManager.connection,
      key: JSON.stringify([appConfig.galleryRoot, mode, seed ?? null,
        signals.lastOpenedFolderSlug ?? null, signals.recentOpenedFolderSlugs ?? []]),
      cursor,
      limit,
      build: () => {
        const candidates = imageRepository.listVisibleVideoCandidates();
        if (mode === 'recent') return candidates;
        const sessionSeed = Number.isFinite(seed)
          ? Number(seed)
          : Number(new Date().toISOString().slice(0, 10).replaceAll('-', ''));
        const ordered = mode === 'random'
          ? shuffleReelCandidates(candidates, sessionSeed)
          : buildReelQueue(candidates, sessionSeed, signals);
        const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
        return ordered.map(candidate => byId.get(candidate.id)!);
      },
      read: ids => imageRepository.listVisibleVideoCandidatesByIds(ids)
    });
    return {
      mode,
      ...payload,
      page,
      limit,
      items: payload.items.map(({ sourceIdentity, scopedPreviewUrl, likedAt, ...candidate }) => ({
        ...mapFeedImage(candidate),
        previewUrl: scopedPreviewUrl,
        mediaId: candidate.mediaId,
        postId: candidate.postId,
        mediaPosition: candidate.mediaPosition
      }))
    };
  },

  searchMedia(query: string, page: number, limit: number) {
    if (!storageService.getState().libraryAvailable) {
      return {
        items: [],
        page,
        limit,
        total: 0,
        hasMore: false
      };
    }

    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      return {
        items: [],
        page,
        limit,
        total: 0,
        hasMore: false
      };
    }

    const total = imageRepository.countVisibleSearch(normalizedQuery);
    const items = total > 0 ? imageRepository.listVisibleSearch(normalizedQuery, page, limit) : [];

    return buildPaginatedPayload(mapFeedItems(items), page, limit, total);
  },

  listMoments() {
    if (!storageService.getState().libraryAvailable) {
      return {
        railKind: 'moments' as FeedRailKind,
        railTitle: 'Moments',
        railDescription: 'Memory capsules shaped by real capture dates from your library.',
        railSingularLabel: 'Moment',
        items: []
      };
    }

    const { rail } = getSelectedFeedRail(new Date());
    return {
      railKind: rail.kind,
      railTitle: rail.title,
      railDescription: rail.description,
      railSingularLabel: rail.singularLabel,
      items: rail.capsules
    };
  },

  getMomentFeed(id: string, page: number, limit: number) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const now = new Date();
    const { rail, definition: selectedDefinition } = getSelectedFeedRail(now);
    const capsule = rail.capsules.find((entry) => entry.id === id);

    if (!capsule) {
      return null;
    }

    const definition = selectedDefinition.capsules.find(
      (entry) => entry.id === id
    );
    if (!definition) {
      return null;
    }

    const total = capsule.imageCount;

    return {
      railKind: rail.kind,
      railTitle: rail.title,
      railDescription: rail.description,
      railSingularLabel: rail.singularLabel,
      moment: capsule,
      ...buildPaginatedPayload(mapFeedItems(postRepository.hydratePostItems(definition.list(page, limit))), page, limit, total)
    };
  },

  listFolders() {
    if (!storageService.getState().libraryAvailable) {
      return [];
    }

    const creatorIds = new Map(appConfig.cosGalleryMode
      ? canonicalCreatorGalleryRepository.listUniqueFolderCreatorIds().map(row => [row.folderId, row.creatorId])
      : []);
    return folderRepository.getAllSummaries().map(folder => buildFolderSummary(folder, creatorIds.get(folder.id) ?? null));
  },

  listPlaces() {
    if (!storageService.getState().libraryAvailable) {
      return [];
    }

    return placeRepository.list().map((place) => ({
      ...placeResolutionService.placeDetail(place, place.post_count)
    }));
  },

  getPlaceBySlug(slug: string) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const place = placeRepository.getBySlug(slug);
    if (!place) {
      return null;
    }

    return placeResolutionService.placeDetail(place, placeRepository.countVisibleImages(place.id));
  },

  getPlaceImages(slug: string, page: number, limit: number, mediaType?: MediaType) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const place = placeRepository.getBySlug(slug);
    if (!place) {
      return null;
    }

    const total = placeRepository.countVisibleImages(place.id, mediaType);

    return {
      place: placeResolutionService.placeDetail(place, total),
      items: imageRepository.listPlaceImages(place.id, page, limit, mediaType).map((image) => mapFeedImage(image)),
      page,
      limit,
      total,
      hasMore: page * limit < total
    };
  },

  getFolderBySlug(slug: string) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const folder = folderRepository.getSummaryBySlug(slug);
    if (!folder) {
      return null;
    }

    return buildFolderSummary(folder);
  },

  getSharedFolderBySlug(slug: string) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const folder = folderRepository.getSummaryBySlug(slug);
    if (!folder) {
      return null;
    }

    return buildSharedFolderSummary(folder);
  },

  updateFolderMetadata(slug: string, name: string, description: string | null) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    folderRepository.updateMetadata(slug, name, description);
    const folder = folderRepository.getSummaryBySlug(slug);
    if (!folder) {
      return null;
    }

    return buildFolderSummary(folder);
  },

  updateImageCaption(id: number, caption: string | null, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed) {
      return null;
    }

    const defaultFolderImageOrder = getDefaultFolderImageOrder();
    const existing = imageRepository.getImageDetail(post.id, undefined, false, defaultFolderImageOrder);
    if (!existing) {
      return null;
    }

    postRepository.updateCaption(post.id, caption);

    const updated = imageRepository.getImageDetail(post.id, undefined, false, defaultFolderImageOrder);
    return updated ? mapImageDetail(updated) : null;
  },

  updatePostContentRating(id: number, contentRating: 'R15' | 'R18') {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = postRepository.findById(id);
    if (!post || post.is_deleted || post.is_trashed) {
      return null;
    }

    const updated = postRepository.updateContentRating(id, contentRating);
    return updated ? { id: updated.id, contentRating: updated.content_rating } : null;
  },

  setFolderAvatar(slug: string, imageId: number) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const folder = folderRepository.getNormalBySlug(slug);
    if (!folder) {
      return null;
    }

    const image = imageRepository.getById(imageId);
    const imageFolder = image ? folderRepository.getById(image.folder_id) : undefined;
    const belongsToFolder = image?.folder_id === folder.id || (
      imageFolder?.role === 'carousel_source' && imageFolder.carousel_owner_folder_id === folder.id
    );
    if (!image || !belongsToFolder || image.is_deleted !== 0 || image.is_trashed !== 0) {
      return null;
    }

    folderRepository.setAvatar(folder.id, imageId, 'manual');
    return true;
  },

  getFolderStories(slug: string) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const folder = folderRepository.getSummaryBySlug(slug);
    if (!folder) {
      return null;
    }

    return buildFolderStoryRail(folder);
  },

  getFolderStoryFeed(slug: string, storyId: string, page: number, limit: number) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const folder = folderRepository.getSummaryBySlug(slug);
    if (!folder) {
      return null;
    }

    const rail = buildFolderStoryRail(folder);
    const capsule = rail.items.find((entry) => entry.id === storyId);
    if (!capsule) {
      return null;
    }

    const ownerFolder = buildFolderSummary(folder);
    if (storyId === FALLBACK_AVATAR_STORY_ID) {
      const fallbackFeed = listFallbackAvatarStoryItems(ownerFolder, page, limit);

      return {
        railKind: 'stories' as const,
        railTitle: rail.railTitle,
        railDescription: rail.railDescription,
        railSingularLabel: rail.railSingularLabel,
        story: capsule,
        ...buildPaginatedPayload(fallbackFeed.items, page, limit, fallbackFeed.total)
      };
    }

    const storyFolder = folderRepository.getOwnedStoryFolderBySlug(folder.id, storyId);
    if (!storyFolder) {
      return null;
    }

    const total = imageRepository.countStoryMediaByFolder(storyFolder.id);
    const items = imageRepository
      .listStoryFolderImages(storyFolder.id, page, limit)
      .map((image) => mapFeedImageForOwnerFolder(image, ownerFolder));

    return {
      railKind: 'stories' as const,
      railTitle: rail.railTitle,
      railDescription: rail.railDescription,
      railSingularLabel: rail.railSingularLabel,
      story: capsule,
      ...buildPaginatedPayload(items, page, limit, total)
    };
  },

  getFolderImages(slug: string, page: number, limit: number, mediaType?: MediaType) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const folder = folderRepository.getSummaryBySlug(slug);
    if (!folder) {
      return null;
    }

    const total = imageRepository.countVisibleByFolder(folder.id, mediaType);
    const defaultFolderImageOrder = getDefaultFolderImageOrder();

    return {
      folder: buildFolderSummary(folder),
      items: imageRepository
        .listFolderImages(folder.id, page, limit, mediaType, defaultFolderImageOrder)
        .map((image) => mapFeedImage(image)),
      page,
      limit,
      total,
      hasMore: page * limit < total
    };
  },

  getSharedFolderImages(slug: string, page: number, limit: number, mediaType?: MediaType) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const folder = folderRepository.getSummaryBySlug(slug);
    if (!folder) {
      return null;
    }

    const total = imageRepository.countVisibleByFolder(folder.id, mediaType);
    const defaultFolderImageOrder = getDefaultFolderImageOrder();

    return {
      folder: buildSharedFolderSummary(folder),
      items: imageRepository
        .listFolderImages(folder.id, page, limit, mediaType, defaultFolderImageOrder)
        .map((image) => mapSharedFeedImage(image)),
      page,
      limit,
      total,
      hasMore: page * limit < total
    };
  },

  getImageDetail(id: number, mediaType?: MediaType, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed) {
      return null;
    }

    const defaultFolderImageOrder = getDefaultFolderImageOrder();
    let detail = imageRepository.getImageDetail(post.id, mediaType, false, defaultFolderImageOrder);
    if (!detail) {
      const avatarDetail = imageRepository.getImageDetail(post.id, mediaType, true, defaultFolderImageOrder);
      if (avatarDetail && avatarDetail.folderAvatarImageId === avatarDetail.id) {
        detail = avatarDetail;
      }
    }

    if (!detail) {
      return null;
    }

    return mapImageDetail(detail);
  },

  getSharedImageDetail(id: number, mediaType?: MediaType, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed) {
      return null;
    }

    const defaultFolderImageOrder = getDefaultFolderImageOrder();
    const detail = imageRepository.getImageDetail(post.id, mediaType, false, defaultFolderImageOrder);
    if (!detail) {
      return null;
    }

    return mapSharedImageDetail(detail);
  },

  getShareDerivativeImage(id: number): ImageRecord | null {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const image = imageRepository.getById(id);
    if (!image || image.is_deleted || image.is_trashed) {
      return null;
    }

    const folder = folderRepository.getById(image.folder_id);
    if (!folder) {
      return null;
    }

    if (folder.role === 'normal') return image;
    if (folder.role === 'carousel_source' && folder.carousel_owner_folder_id) {
      return { ...image, folder_id: folder.carousel_owner_folder_id };
    }
    return null;
  },

  getPlacesStatus() {
    return geodataService.getStatus();
  },

  async preparePlacesGeodata() {
    return geodataService.prepare();
  },

  rebuildPlaces() {
    return placeResolutionService.rebuildAssignments();
  },

  getTrashImages(page: number, limit: number) {
    if (!storageService.getState().libraryAvailable) {
      return {
        items: [],
        page,
        limit,
        total: 0,
        hasMore: false
      };
    }

    const total = imageRepository.countTrashed();
    const items = imageRepository.listTrashed(page, limit).map((image) => mapTrashImage(image as IndexedTrashImage));

    return buildTrashPaginatedPayload(items, page, limit, total);
  },

  getCollections() {
    if (!storageService.getState().libraryAvailable) {
      return {
        items: []
      };
    }
    return {
      items: collectionRepository.listSummaries().map((collection) => mapCollectionSummary(collection))
    };
  },

  getCollectionImages(slug: string, page: number, limit: number) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const collection = collectionRepository.getBySlug(slug);
    if (!collection) {
      return null;
    }

    const total = collectionRepository.countImages(slug);

    return {
      collection: mapCollectionSummary(
        collectionRepository.listSummaries().find((entry) => entry.slug === slug) ?? {
          ...collection,
          item_count: total,
          cover_image_id: null,
          cover_thumbnail_path: null,
          preview_image_ids: null
        }
      ),
      ...buildPaginatedPayload(
        collectionRepository.listImages(slug, page, limit).map((image) => mapFeedImage(image)),
        page,
        limit,
        total
      )
    };
  },

  getImageCollections(id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed) {
      return null;
    }
    return {
      imageId: post.id,
      isSaved: collectionRepository.isImageSaved(post.id),
      items: collectionRepository.listMembershipsForImage(post.id).map((collection) => mapCollectionMembership(collection))
    };
  },

  createCollection(name: string) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const collection = collectionRepository.create(name);
    const summary = collectionRepository.listSummaries().find((entry) => entry.id === collection.id);
    return summary ? mapCollectionSummary(summary) : null;
  },

  updateCollection(slug: string, name: string) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const collection = collectionRepository.updateName(slug, name);
    if (!collection) {
      return null;
    }

    const summary = collectionRepository.listSummaries().find((entry) => entry.id === collection.id);
    return summary ? mapCollectionSummary(summary) : null;
  },

  deleteCollection(slug: string) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const summary = collectionRepository.listSummaries().find((entry) => entry.slug === slug);
    if (!summary) {
      return null;
    }

    const deleted = collectionRepository.delete(slug);
    if (!deleted) {
      return null;
    }

    return mapCollectionSummary(summary);
  },

  saveImage(id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed || isCoverPost(post.id)) {
      return null;
    }

    const collection = collectionRepository.saveToDefault(post.id);
    const summary = collectionRepository.listSummaries().find((entry) => entry.id === collection.id);

    return {
      id: post.id,
      imageId: post.id,
      isSaved: collectionRepository.isImageSaved(post.id),
      collection: summary ? mapCollectionSummary(summary) : undefined
    };
  },

  unsaveImage(id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed || isCoverPost(post.id)) {
      return null;
    }

    collectionRepository.unsaveEverywhere(post.id);

    return {
      id: post.id,
      imageId: post.id,
      isSaved: false
    };
  },

  addImageToCollection(slug: string, id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed || isCoverPost(post.id)) {
      return null;
    }

    const collection = slug === collectionConstants.defaultCollectionSlug
      ? collectionRepository.saveToDefault(post.id)
      : collectionRepository.addImage(slug, post.id);
    if (!collection) {
      return null;
    }

    const summary = collectionRepository.listSummaries().find((entry) => entry.id === collection.id);

    return {
      id: post.id,
      imageId: post.id,
      isSaved: true,
      collection: summary ? mapCollectionSummary(summary) : undefined
    };
  },

  removeImageFromCollection(slug: string, id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed || isCoverPost(post.id)) {
      return null;
    }

    const collection = collectionRepository.getBySlug(slug);
    if (!collection) {
      return null;
    }

    if (collection.is_default === 1) {
      collectionRepository.unsaveEverywhere(post.id);
      return {
        id: post.id,
        imageId: post.id,
        isSaved: false
      };
    }

    collectionRepository.removeImage(slug, post.id);
    const summary = collectionRepository.listSummaries().find((entry) => entry.id === collection.id);

    return {
      id: post.id,
      imageId: post.id,
      isSaved: collectionRepository.isImageSaved(post.id),
      collection: summary ? mapCollectionSummary(summary) : undefined
    };
  },

  getLikes() {
    if (!storageService.getState().libraryAvailable) {
      return {
        items: []
      };
    }

    return {
      items: mapFeedItems(likeRepository.listLikedImages())
    };
  },

  likeImage(id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed || isCoverPost(post.id)) {
      return null;
    }

    likeRepository.upsert(post.id);

    return {
      id: post.id,
      liked: true
    };
  },

  unlikeImage(id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed || isCoverPost(post.id)) {
      return null;
    }

    likeRepository.remove(post.id);

    return {
      id: post.id,
      liked: false
    };
  },

  trashImage(id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted) {
      return null;
    }

    assertLegacyPostRemovalAllowed(post.id);

    const folder = folderRepository.getById(post.folder_id);
    if (!folder) {
      return null;
    }

    if (post.is_trashed === 0) {
      imageRepository.moveToTrash(post.id);
      folderRepository.syncAvatarSelection(post.folder_id);
    }

    return {
      id: post.id,
      folderSlug: folder.slug
    };
  },

  restoreImage(id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post || post.is_deleted || post.is_trashed === 0) {
      return null;
    }

    assertLegacyPostRestoreAllowed(post.id);

    const folder = folderRepository.getById(post.folder_id);
    if (!folder) {
      return null;
    }

    imageRepository.restoreFromTrash(post.id);
    folderRepository.syncAvatarSelection(post.folder_id);

    return {
      id: post.id,
      folderSlug: folder.slug
    };
  },

  getStatus() {
    const storageState = storageService.getState();
    const rebuildRequired = appSettingsRepository.get(LIBRARY_REBUILD_REQUIRED_SETTING_KEY) === '1';
    const defaultHomeFeedMode = getDefaultHomeFeedMode();
    const defaultLocale = getDefaultLocale();
    const defaultReelsFeedMode = getDefaultReelsFeedMode();
    const defaultFolderImageOrder = getDefaultFolderImageOrder();
    const nestedFolderTitleFormat = getNestedFolderTitleFormat();
    const treatStoriesAsFolders = getTreatStoriesAsFolders();
    const storiesMigration = getStoriesMigrationStatus();
    const treatCarouselsAsFolders = getTreatCarouselsAsFolders();
    const carouselsMigration = getCarouselsMigrationStatus();
    const postCounts = storageState.libraryAvailable ? imageRepository.countVisiblePostSummary() : { posts: 0, carousels: 0 };
    const indexedPosts = postCounts.posts;

    return {
      folders: storageState.libraryAvailable ? folderRepository.count() : 0,
      indexedImages: indexedPosts,
      indexedPosts,
      galleryStatistics: storageState.libraryAvailable ? getGalleryStatistics() : { creators: 0, works: 0, photos: 0 },
      indexedMediaAssets: storageState.libraryAvailable ? imageRepository.countVisibleMediaAssets() : 0,
      indexedCarousels: postCounts.carousels,
      indexedVideos: storageState.libraryAvailable ? imageRepository.countVisibleVideoCandidates() : 0,
      scan: this.getScanProgress(),
      storage: {
        available: storageState.libraryAvailable,
        reason: buildViewerSafeStorageReason(storageState.libraryAvailable)
      },
      libraryIndex: {
        rebuildRequired,
        reason: rebuildRequired ? 'gallery_root_changed' : null,
        ignoredRootMediaCount: storageState.libraryAvailable ? countSupportedRootMediaFiles(appConfig.galleryRoot) : 0
      },
      preferences: {
        accentColor: parseAccentColor(appSettingsRepository.get(APP_ACCENT_COLOR_SETTING_KEY)),
        defaultLocale,
        defaultHomeFeedMode,
        defaultReelsFeedMode,
        defaultFolderImageOrder,
        nestedFolderTitleFormat,
        treatStoriesAsFolders,
        treatCarouselsAsFolders
      },
      storiesMigration,
      carouselsMigration
    };
  },

  getScanProgress() {
    const lastCompletedScan = scanRunRepository.latestCompleted() ?? null;
    const scanProgress = scannerService.getProgress();

    return {
      ...scanProgress,
      currentFolder: null,
      currentFile: null,
      lastCompletedScan: toViewerSafeScanSummary(lastCompletedScan)
    };
  },

  getAdminScanProgress() {
    const lastCompletedScan = scanRunRepository.latestCompleted() ?? null;
    const scanProgress = scannerService.getProgress();

    return {
      ...scanProgress,
      lastCompletedScan
    };
  },

  getStats() {
    const lastCompletedScan = scanRunRepository.latestCompleted() ?? null;
    const storageState = storageService.getState();
    const currentGalleryRoot = appConfig.galleryRoot;
    const previousGalleryRoot = appSettingsRepository.get(PREVIOUS_GALLERY_ROOT_SETTING_KEY);
    const rebuildRequired = appSettingsRepository.get(LIBRARY_REBUILD_REQUIRED_SETTING_KEY) === '1';
    const lastSuccessfulGalleryRoot = appSettingsRepository.get(LAST_SUCCESSFUL_GALLERY_ROOT_SETTING_KEY);
    const pendingDerivativeMigrationRows = storageState.libraryAvailable ? imageRepository.countPendingDerivativeMigrationRows() : 0;
    const postCounts = storageState.libraryAvailable ? imageRepository.countVisiblePostSummary() : { posts: 0, carousels: 0 };
    const indexedPosts = postCounts.posts;
    const defaultHomeFeedMode = getDefaultHomeFeedMode();
    const defaultLocale = getDefaultLocale();
    const defaultReelsFeedMode = getDefaultReelsFeedMode();
    const defaultFolderImageOrder = getDefaultFolderImageOrder();
    const nestedFolderTitleFormat = getNestedFolderTitleFormat();
    const treatStoriesAsFolders = getTreatStoriesAsFolders();
    const storiesMigration = getStoriesMigrationStatus();
    const treatCarouselsAsFolders = getTreatCarouselsAsFolders();
    const carouselsMigration = getCarouselsMigrationStatus();
    const excludedFolders = getExcludedFolderSettings();

    return {
      folders: storageState.libraryAvailable ? folderRepository.count() : 0,
      indexedImages: indexedPosts,
      indexedPosts,
      indexedMediaAssets: storageState.libraryAvailable ? imageRepository.countVisibleMediaAssets() : 0,
      indexedCarousels: postCounts.carousels,
      indexedVideos: storageState.libraryAvailable ? imageRepository.countVisibleVideoCandidates() : 0,
      deletedImages: storageState.libraryAvailable ? imageRepository.countDeleted() : 0,
      galleryStatistics: storageState.libraryAvailable ? getGalleryStatistics() : { creators: 0, works: 0, photos: 0 },
      thumbnailCount: storageState.libraryAvailable ? countDerivativeFilesOnDisk(appConfig.thumbnailsDir, 'thumbnail') : 0,
      previewCount: storageState.libraryAvailable ? countDerivativeFilesOnDisk(appConfig.previewsDir, 'preview') : 0,
      lastScan: lastCompletedScan,
      scan: this.getAdminScanProgress(),
      storage: {
        available: storageState.libraryAvailable,
        reason: storageState.reason,
        usingInMemoryDatabase: storageState.usingInMemoryDatabase
      },
      libraryIndex: {
        rebuildRequired,
        reason: rebuildRequired ? 'gallery_root_changed' : null,
        currentGalleryRoot,
        previousGalleryRoot,
        lastSuccessfulGalleryRoot,
        legacyDerivativeMigrationPending: pendingDerivativeMigrationRows > 0,
        pendingDerivativeMigrationRows,
        ignoredRootMediaCount: storageState.libraryAvailable ? countSupportedRootMediaFiles(currentGalleryRoot) : 0
      },
      preferences: {
        accentColor: parseAccentColor(appSettingsRepository.get(APP_ACCENT_COLOR_SETTING_KEY)),
        defaultLocale,
        defaultHomeFeedMode,
        defaultReelsFeedMode,
        defaultFolderImageOrder,
        nestedFolderTitleFormat,
        treatStoriesAsFolders,
        treatCarouselsAsFolders
      },
      storiesMigration,
      carouselsMigration,
      excludedFolders
    };
  },

  setDefaultHomeFeedMode(mode: FeedMode) {
    appSettingsRepository.set(HOME_FEED_DEFAULT_MODE_SETTING_KEY, mode);

    return {
      defaultMode: mode
    };
  },

  setAccentColor(accentColor: AccentColor) {
    appSettingsRepository.set(APP_ACCENT_COLOR_SETTING_KEY, accentColor);
    return { accentColor };
  },

  setDefaultLocale(defaultLocale: SupportedLocale) {
    appSettingsRepository.set(APP_DEFAULT_LOCALE_SETTING_KEY, defaultLocale);

    return {
      defaultLocale
    };
  },

  setDefaultReelsFeedMode(mode: ReelsFeedMode) {
    appSettingsRepository.set(REELS_FEED_DEFAULT_MODE_SETTING_KEY, mode);

    return {
      defaultMode: mode
    };
  },

  setDefaultFolderImageOrder(order: FolderImageOrder) {
    appSettingsRepository.set(FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY, order);

    return {
      defaultOrder: order
    };
  },

  setNestedFolderTitleFormat(titleFormat: NestedFolderTitleFormat) {
    appSettingsRepository.set(
      NESTED_FOLDER_TITLE_FORMAT_SETTING_KEY,
      serializeNestedFolderTitleFormatSetting(titleFormat)
    );

    return {
      titleFormat
    };
  },

  setTreatStoriesAsFolders(treatStoriesAsFolders: boolean) {
    appSettingsRepository.set(TREAT_STORIES_AS_FOLDERS_SETTING_KEY, serializeTreatStoriesAsFoldersSetting(treatStoriesAsFolders));
    appSettingsRepository.set(STORIES_MIGRATION_DECISION_SETTING_KEY, treatStoriesAsFolders ? 'legacy' : 'stories');

    return {
      treatStoriesAsFolders
    };
  },

  setExcludedFolders(rules: string[]) {
    const serializedRules = serializeExcludedFolderRulesForSetting(rules);

    if (serializedRules.length > 0) {
      appSettingsRepository.set(EXCLUDED_FOLDERS_SETTING_KEY, serializedRules);
    } else {
      appSettingsRepository.remove(EXCLUDED_FOLDERS_SETTING_KEY);
    }

    return {
      ...getExcludedFolderSettings(),
      requiresScan: true
    };
  },

  getOriginalMediaFile(id: number): { path: string; filename: string } | null {
    return resolveOriginalMediaFile(id);
  },

  getOriginalImagePath(id: number): string | null {
    return resolveOriginalMediaFile(id)?.path ?? null;
  },

  async deleteImage(id: number, options: { isLegacyImageAlias?: boolean } = {}) {
    if (!storageService.getState().libraryAvailable || scannerService.isLibraryRebuildRequired()) {
      return null;
    }

    const post = resolvePostRecord(id, options.isLegacyImageAlias);
    if (!post) {
      return null;
    }

    assertLegacyPostRemovalAllowed(post.id);

    return permanentDeletionService.deletePost(post.id);
  },

  setTreatCarouselsAsFolders(treatCarouselsAsFolders: boolean) {
    appSettingsRepository.setMany([
      {
        key: TREAT_CAROUSELS_AS_FOLDERS_SETTING_KEY,
        value: serializeTreatCarouselsAsFoldersSetting(treatCarouselsAsFolders)
      },
      {
        key: CAROUSELS_MIGRATION_DECISION_SETTING_KEY,
        value: treatCarouselsAsFolders ? 'restore' : 'carousels'
      }
    ]);

    return this.getStats();
  },

  setCarouselsMigrationDecision(decision: 'restore' | 'carousels') {
    return this.setTreatCarouselsAsFolders(decision === 'restore');
  }
};
