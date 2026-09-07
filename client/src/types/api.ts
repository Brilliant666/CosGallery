import type { SupportedLocale } from '../locales';

export type FeedMode = 'recent' | 'rediscover' | 'random';
export type ReelsFeedMode = 'recommended' | 'recent' | 'random';
export type FolderImageOrder = 'newest' | 'oldest';
export type NestedFolderTitleFormat = 'folder' | 'parent-plus-folder';
export type FeedRailKind = 'moments' | 'highlights';
export type StoryCapsulePresentation = 'avatar' | 'highlight';
export type MediaType = 'image' | 'video';

export type ScanOperation =
  | 'checking_derivatives'
  | 'backfilling_asset_key'
  | 'moving_thumbnail'
  | 'moving_preview'
  | 'repairing_thumbnail'
  | 'repairing_preview'
  | 'regenerating_derivatives'
  | 'discovering_media'
  | 'generating_thumbnail'
  | 'generating_preview'
  | 'generating_thumbnail_and_preview';

export interface HomeFeedDefaultSetting {
  defaultMode: FeedMode;
}

export interface AppLocaleSetting {
  defaultLocale: SupportedLocale;
}

export interface ReelsFeedDefaultSetting {
  defaultMode: ReelsFeedMode;
}

export interface FolderImageOrderDefaultSetting {
  defaultOrder: FolderImageOrder;
}

export interface NestedFolderTitleFormatSetting {
  titleFormat: NestedFolderTitleFormat;
}

export interface StoriesModeSetting {
  treatStoriesAsFolders: boolean;
}

export interface ExcludedFoldersSettings {
  envExcludedFolders: string[];
  customExcludedFolders: string[];
  effectiveExcludedFolders: string[];
}

export interface UpdateExcludedFoldersSettingResult extends ExcludedFoldersSettings {
  requiresScan: boolean;
}

export type PostType = 'single' | 'carousel';
export type ContentRating = 'R15' | 'R18';

export interface PostMediaItem {
  imageId: number;
  position: number;
  filename: string;
  mediaType: MediaType;
  width: number;
  height: number;
  durationMs: number | null;
  isAnimated: boolean | null;
  thumbnailUrl: string;
  previewUrl: string;
  playbackStrategy?: 'preview' | 'original' | null;
  originalUrl?: string;
  mimeType?: string;
  fileSize?: number;
  relativePath?: string;
  exif?: ImageExifData | null;
}

export interface FeedItem {
  id: number;
  folderId: number;
  folderSlug: string;
  folderName: string;
  folderParentName?: string | null;
  folderPath: string;
  folderBreadcrumb: string | null;
  filename: string;
  sourcePath?: string;
  caption?: string | null;
  carouselTitle?: string | null;
  contentRating?: ContentRating;
  postType?: PostType;
  width: number;
  height: number;
  mediaType: 'image' | 'video';
  durationMs: number | null;
  isAnimated?: boolean | null;
  thumbnailUrl: string;
  previewUrl: string;
  sortTimestamp: number;
  takenAt: number | null;
  isSaved?: boolean;
  place?: PlaceSummary | null;
  mediaItems?: PostMediaItem[];
  itemCount?: number;
}

export type PlaceKind = 'city' | 'approximate_spot' | 'manual';

export interface PlaceSummary {
  id: number;
  slug: string;
  name: string;
  kind: PlaceKind;
  isApproximate: boolean;
}

export interface PlaceDetail extends PlaceSummary {
  latitude: number | null;
  longitude: number | null;
  cityName: string | null;
  admin1Name: string | null;
  countryName: string | null;
  countryCode: string | null;
  description: string | null;
  postCount: number;
}

export interface FolderSummary {
  canonicalCreatorId?: number | null;
  id: number;
  slug: string;
  name: string;
  description: string | null;
  parentFolderName?: string | null;
  folderPath: string;
  breadcrumb: string | null;
  workNavigationMode?: 'post' | 'work-gallery';
  contentRating: ContentRating;
  imageCount: number;
  videoCount: number;
  latestImageMtimeMs: number | null;
  hasAvatarStory?: boolean;
  avatarImageId: number | null;
  avatarUrl: string | null;
}

export interface ImageExifData {
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  fNumber?: number;
  exposureTimeSeconds?: number;
  iso?: number;
  focalLengthMm?: number;
  focalLength35mmMm?: number;
  latitude?: number;
  longitude?: number;
  altitudeMeters?: number;
}

export interface PaginatedFeed {
  mode?: FeedMode;
  items: FeedItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface PaginatedReels {
  mode?: ReelsFeedMode;
  items: FeedItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface RailCapsule {
  id: string;
  title: string;
  subtitle: string;
  dateContext: string;
  imageCount: number;
  coverImage: FeedItem;
  presentation?: StoryCapsulePresentation;
  latestActivityTimestamp?: number | null;
}

export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

export type MomentDateMetadata =
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

export interface MomentCapsule extends RailCapsule {
  momentDate?: MomentDateMetadata;
}

export interface MomentsPayload {
  railKind: FeedRailKind;
  railTitle: string;
  railDescription: string;
  railSingularLabel: string;
  items: MomentCapsule[];
}

export interface MomentFeedPayload extends PaginatedFeed {
  railKind: FeedRailKind;
  railTitle: string;
  railDescription: string;
  railSingularLabel: string;
  moment: MomentCapsule;
}

export interface FolderStoriesPayload {
  railKind: 'stories';
  railTitle: string;
  railDescription: string;
  railSingularLabel: string;
  hasAvatarStory: boolean;
  avatarStoryId: string | null;
  items: RailCapsule[];
  highlights: RailCapsule[];
}

export interface FolderStoryFeedPayload extends PaginatedFeed {
  railKind: 'stories';
  railTitle: string;
  railDescription: string;
  railSingularLabel: string;
  story: RailCapsule;
}

export interface FolderImagesPayload extends PaginatedFeed {
  folder: FolderSummary;
}

export type FolderShareLinkStatus = 'active' | 'expired' | 'revoked';
export type FolderShareExpirationPreset = '1h' | '24h' | '7d' | 'custom' | 'unlimited';

export interface FolderShareLink {
  id: number;
  folderId: number;
  tokenPrefix: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  status: FolderShareLinkStatus;
}

export interface FolderSharePasswordStatus {
  enabled: boolean;
  updatedAt: string | null;
}

export interface FolderShareLinksPayload {
  links: FolderShareLink[];
  password: FolderSharePasswordStatus;
  publicFolderUrl: string;
  publicAccess: boolean;
}

export interface CreateFolderShareLinkInput {
  expiresIn: FolderShareExpirationPreset;
  customExpiresAt?: string | null;
  unlimited?: boolean;
}

export interface CreateFolderShareLinkResult {
  ok: boolean;
  shareUrl: string;
  link: FolderShareLink;
}

export interface FolderSharePasswordMutationResult {
  ok: boolean;
  password: FolderSharePasswordStatus;
}

export interface FolderShareAccessState {
  exists: boolean;
  granted: boolean;
  hasPassword: boolean;
  publicAccess: boolean;
}

export interface SharedFolderSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  imageCount: number;
  postCount: number;
  videoCount: number;
  avatarThumbnailUrl: string | null;
  sortTimestamp: number;
}

export interface SharedFeedItem {
  id: number;
  folderId: number;
  folderSlug: string;
  folderName: string;
  filename: string;
  caption: string | null;
  carouselTitle?: string | null;
  width: number;
  height: number;
  mediaType: MediaType;
  durationMs: number | null;
  isAnimated?: boolean | null;
  thumbnailUrl: string;
  previewUrl: string;
  sortTimestamp: number;
  postType?: PostType;
  itemCount?: number;
  mediaItems?: PostMediaItem[];
}

export interface SharedImageDetail {
  id: number;
  folderId: number;
  folderSlug: string;
  folderName: string;
  filename: string;
  caption: string | null;
  carouselTitle?: string | null;
  mediaType: MediaType;
  mimeType: string;
  width: number;
  height: number;
  durationMs: number | null;
  isAnimated?: boolean | null;
  thumbnailUrl: string;
  previewUrl: string;
  sortTimestamp: number;
  nextImageId: number | null;
  previousImageId: number | null;
  postType?: PostType;
  itemCount?: number;
  mediaItems?: PostMediaItem[];
}

export interface SharedFolderImagesPayload {
  items: SharedFeedItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  folder: SharedFolderSummary;
}

export interface FolderShareUnlockResult {
  ok: boolean;
}

export interface PlaceImagesPayload extends PaginatedFeed {
  place: PlaceDetail;
}

export interface PlacesStatus {
  prepared: boolean;
  databasePath: string;
  metadata: {
    source: string;
    sourceUrl: string;
    importedAt: string;
    rowCount: number;
  } | null;
}

export interface PlacesPrepareResult {
  ok: boolean;
  status: PlacesStatus;
}

export interface PlacesRebuildResult {
  ok: boolean;
  processed: number;
  assigned: number;
  skipped: number;
}

export interface LikesPayload {
  items: FeedItem[];
}

export interface CollectionSummary {
  id: number;
  slug: string;
  name: string;
  isDefault: boolean;
  itemCount: number;
  coverImage: FeedItem | null;
  previewImages: FeedItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionMembership extends CollectionSummary {
  containsImage: boolean;
}

export interface CollectionsPayload {
  items: CollectionSummary[];
}

export interface ImageCollectionsPayload {
  imageId: number;
  isSaved: boolean;
  items: CollectionMembership[];
}

export interface CollectionImagesPayload extends PaginatedFeed {
  collection: CollectionSummary;
}

export interface CreateCollectionResult {
  ok: boolean;
  collection: CollectionSummary;
}

export interface UpdateCollectionResult {
  ok: boolean;
  collection: CollectionSummary;
}

export interface DeleteCollectionResult {
  ok: boolean;
  collection: CollectionSummary;
}

export interface CollectionMutationResult {
  ok: boolean;
  id?: number;
  imageId: number;
  isSaved: boolean;
  collection?: CollectionSummary;
}

export interface ImageDetail extends FeedItem {
  folderAvatarImageId: number | null;
  relativePath: string;
  mimeType: string;
  fileSize: number;
  exif: ImageExifData | null;
  originalUrl: string;
  playbackStrategy?: 'preview' | 'original' | null;
  nextImageId: number | null;
  previousImageId: number | null;
}

export interface TrashItem extends FeedItem {
  trashedAt: string | null;
}

export interface TrashImagesPayload {
  items: TrashItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface DeleteImageResult {
  id: number;
  folderSlug: string;
}

export type TrashImageResult = DeleteImageResult;
export type RestoreImageResult = DeleteImageResult;

export interface ImageCaptionMutationResult {
  ok: boolean;
  image: ImageDetail;
}

export interface CosGalleryCreator {
  avatarUrl?: string | null;
  description?: string | null;
  imageCount?: number;
  videoCount?: number;
  latestImageMtimeMs?: number | null;
  localFolders?: Array<{ id: number; slug: string; name: string; path: string; workCount: number }>;
  key: string;
  identityType: 'creator' | 'folder';
  canonicalCreatorId: number | null;
  canonicalName: string | null;
  rosterStatus: 'active' | 'inactive' | 'unlinked';
  linkStatus: 'linked' | 'unlinked';
  id: number;
  slug: string;
  name: string;
  folderPath: string;
  folderIds: number[];
  folderNames: string[];
  aliases: string[];
  preference: ArchiveCatalogPreference | null;
  workCount: number;
  latestWorkAt: number | null;
  contentRating: ContentRating | null;
  ratingSourceCount: number;
  ratingConflict: boolean;
  coverImageId: number | null;
  coverUrl: string | null;
  coverWidth: number | null;
  coverHeight: number | null;
}

export interface CosGalleryCreatorsPayload {
  items: CosGalleryCreator[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  summary: {
    all: number;
    R15: number;
    R18: number;
    unclassified: number;
    unlinked: number;
    inactive: number;
  };
}

export interface CanonicalCreatorWorksPayload extends PaginatedFeed {
  creator: CosGalleryCreator;
}

export interface LocalIngestDestinationCandidate {
  localCreatorFolderId: number;
  galleryFolderId: number;
  name: string;
  folderPath: string;
  absolutePath: string;
  workCount: number;
  valid: boolean;
  unavailableReason: string | null;
}

export interface LocalIngestDestinationPreference {
  creatorId: number;
  creatorName: string;
  preferredLocalCreatorFolderId: number | null;
  mode: 'explicit' | 'single-linked' | 'new-creator' | 'selection-required' | 'preferred-unavailable' | 'linked-folders-unavailable';
  resolvedLocalCreatorFolderId: number | null;
  resolvedGalleryFolderId: number | null;
  resolvedCreatorDirectory: string | null;
  message: string;
  candidates: LocalIngestDestinationCandidate[];
}

export type ArchiveCatalogPreference = 'liked' | 'kept';
export type ArchiveCatalogState = 'missing' | 'complete' | 'no-local' | 'no-source' | 'unresolved';

export interface ArchiveCatalogSummary {
  activeCreators:number; inactiveCreators:number; unsetPreference:number; unclassified:number;
  creatorsWithoutLocalWorks:number; unlinkedLocalFolders:number;
  creators: number;
  liked: number;
  kept: number;
  r15: number;
  r18: number;
  creatorsWithSources: number;
  creatorsWithLocalWorks: number;
  sourceCollections: number;
  remoteWorks: number;
  localWorks: number;
  matchedWorks: number;
  missingWorks: number;
  unresolvedCreatorFolders: number;
  unresolvedLocalWorks: number;
}

export interface ArchiveCatalogCreator {
  isActive:boolean; seedSource:string; seedSourceCreatorId:string; createdAt:string; updatedAt:string; deactivatedAt:string|null;
  aliasCount:number; sourceCount:number; localFolderCount:number;
  id: number;
  name: string;
  preference: ArchiveCatalogPreference | null;
  rating: ContentRating | null;
  sourceCollections: number;
  remoteWorks: number;
  localWorks: number;
  matchedWorks: number;
  missingWorks: number;
  unresolvedLocalWorks: number;
  latestSourceObservation: string | null;
}

export interface ArchiveCatalogCreatorsPayload {
  summary: ArchiveCatalogSummary;
  items: ArchiveCatalogCreator[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface ManagedLocalFolder {
  id:number; catalogFolderId:number|null; name:string; folderPath:string; creatorId:number|null;
  matchStatus:string; matchMethod:string|null; workCount:number;
}

export interface ArchiveCatalogCreatorDetail extends ArchiveCatalogCreator {
  localFolders: ManagedLocalFolder[];
  unlinkedLocalFolders: ManagedLocalFolder[];
  impact: { sources:number; collections:number; remoteWorks:number; localWorks:number; unfinishedDownloadTasks:number; localFolders:number };
  aliases: Array<{ id:string; alias: string; source: string; editable:boolean }>;
  sources: Array<{
    source: string;
    sourceCreatorId: string;
    displayName: string;
    url: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
  collections: Array<{
    id: number;
    source: string;
    sourceCollectionId: string;
    title: string;
    url: string | null;
    declaredWorkCount: number | null;
    observedAt: string;
    deliveries: Array<{
      provider: string;
      type: string;
      status: string | null;
      sourceFolderName: string | null;
      destinationPath: string | null;
      transferredAt: string | null;
    }>;
  }>;
  missing: Array<{
    workId: number;
    source: string;
    sourceCollectionId: string;
    sourceOrder: number | null;
    sourceOrderLabel: string | null;
    title: string;
  }>;
  unresolved: Array<{
    folderName: string;
    relativePath: string;
    parsedSourceOrder: number | null;
    status: 'unmatched' | 'ambiguous';
  }>;
}

export type ArchiveDownloadTaskStatus =
  | 'pending'
  | 'claimed'
  | 'staged'
  | 'downloading'
  | 'downloaded'
  | 'ingested'
  | 'failed'
  | 'cancelled';

export interface ArchiveDownloadTaskSummary {
  total: number;
  pending: number;
  claimed: number;
  staged: number;
  downloading: number;
  downloaded: number;
  ingested: number;
  failed: number;
  cancelled: number;
}

export interface ArchiveDownloadTask {
  id: number;
  creatorId: number;
  creatorName: string;
  preference: ArchiveCatalogPreference | null;
  rating: ContentRating | null;
  workId: number;
  sourceWorkId: number;
  collectionId: number;
  source: string;
  sourceCollectionId: string;
  sourceOrder: number;
  sourceOrderLabel: string | null;
  title: string;
  provider: string;
  sourceFolderName: string;
  destinationPath: string;
  targetRoot: string;
  targetRelativeDirectory: string;
  targetFilename: string;
  status: ArchiveDownloadTaskStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  downloadId: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveDownloadTasksPayload {
  summary: ArchiveDownloadTaskSummary;
  items: ArchiveDownloadTask[];
  total: number;
}

export interface ArchiveDownloadPlanResult {
  created: number;
  existing: number;
  removedOutOfScope: number;
  reconciledLocal: number;
  skippedWithoutOrder: number;
  skippedWithoutDelivery: number;
  targetRoot: string;
}

export type ArchiveMetadataTaskStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'not_found'
  | 'failed'
  | 'cancelled';

export interface ArchiveMetadataTaskSummary {
  total: number;
  actionable: number;
  pending: number;
  claimed: number;
  completed: number;
  not_found: number;
  failed: number;
  cancelled: number;
}

export interface ArchiveMetadataTask {
  id: number;
  creatorId: number;
  creatorName: string;
  preference: ArchiveCatalogPreference | null;
  rating: ContentRating | null;
  source: string;
  localWorks: number;
  status: ArchiveMetadataTaskStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sourceState?: ArchiveSourceState;
}

export interface ArchiveSourceState {
  metadataAccepted: boolean;
  deliveryReady: boolean;
  deliveryEvidence: 'verified' | 'historical' | 'missing';
  missing: string[];
}

export interface ArchiveMetadataTasksPayload {
  summary: ArchiveMetadataTaskSummary;
  items: ArchiveMetadataTask[];
  total: number;
}

export interface ArchiveMetadataPlanResult {
  source: string;
  candidates: number;
  created: number;
  requeued: number;
  reconciled: number;
  summary: ArchiveMetadataTaskSummary;
}

export type LocalIngestStatus = 'queued' | 'running' | 'awaiting_review' | 'reconciling' | 'ingested' | 'failed';
export type LocalIngestCleanupStatus = 'not_ready' | 'pending' | 'recycling' | 'recycled' | 'failed';

export interface LocalIngestSettings {
  libraryRoot: string;
  inboxRoot: string;
  processingRoot: string;
  sevenZipPath: string;
  fileStableSeconds: number;
  recycleAfterIngest: boolean;
  maxExtractionDepth: 2;
  allowlist: string[];
  archivePasswordConfigured: boolean;
}

export interface LocalIngestSettingsValidation {
  valid: boolean;
  passwordConfigured: boolean;
  sevenZip: { valid: boolean; version: string | null; error: string | null };
  paths: Record<'libraryRoot' | 'inboxRoot' | 'processingRoot', {
    path: string;
    exists: boolean;
    readable: boolean;
    writable: boolean;
    freeBytes: number | null;
    volume: string;
    error: string | null;
  }>;
  sameVolume: boolean;
  errors: string[];
}

export interface LocalIngestJob {
  id: number;
  archiveDownloadTaskId: number | null;
  sourceWorkId: number | null;
  creatorId: number;
  creatorName: string;
  sourceArchivePath: string;
  sourceArchiveName: string;
  sourceArchiveSize: number;
  sourceArchiveMtime: number;
  sourceArchiveSha256: string;
  status: LocalIngestStatus;
  phase: string;
  validationStatus: 'unknown' | 'passed' | 'warning' | 'failed';
  cleanupStatus: LocalIngestCleanupStatus;
  processingPath: string | null;
  targetPath: string | null;
  attemptCount: number;
  errorCode: string | null;
  errorDetail: string | null;
  summary: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface LocalIngestDiscoveryResult {
  discoveredCreators: number;
  discoveredArchives: number;
  createdJobs: number;
  existingJobs: number;
  waitingStable: number;
  awaitingReview: number;
  reconciledDownloadedTasks: number;
  ignoredFiles: number;
}

export interface LocalIngestBatchResult {
  total: number;
  examined: number;
  settled: number;
  ingested: number;
  failed: number;
  awaitingReview: number;
  reconciling: number;
  claimUnavailable: number;
  unchanged: number;
}

export type LocalIngestJobFilter = 'pending' | 'running' | 'awaiting_review' | 'failed' | 'completed';

export interface LocalIngestJobSummary {
  total: number;
  pending: number;
  running: number;
  ingested: number;
  awaitingReview: number;
  failed: number;
}

export interface LocalIngestCreatorJobSummary extends LocalIngestJobSummary {
  creatorId: number;
  creatorName: string;
  progressPercent: number;
  isCurrent: boolean;
}

export interface LocalIngestJobsDashboard {
  summary: LocalIngestJobSummary;
  creators: LocalIngestCreatorJobSummary[];
  items: LocalIngestJob[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export type LocalIngestOperationState = 'idle' | 'scanning' | 'running';
export type LocalIngestOperationKind =
  | 'scan'
  | 'batch'
  | 'single-job'
  | 'cleanup'
  | 'discover-creators'
  | 'save-settings'
  | 'validation'
  | 'recycle-test';

export interface LocalIngestOperationCurrentJob {
  id: number;
  creatorId: number;
  creatorName: string;
  archiveName: string;
  status: string;
  phase: string;
}

export interface LocalIngestOperationRun {
  total: number;
  examined: number;
  settled: number;
  ingested: number;
  failed: number;
  awaitingReview: number;
  reconciling: number;
  claimUnavailable: number;
  unchanged: number;
  remaining: number;
  currentJob: LocalIngestOperationCurrentJob | null;
}

export interface LocalIngestCompletedOperation {
  kind: LocalIngestOperationKind;
  state: Exclude<LocalIngestOperationState, 'idle'>;
  startedAt: string;
  finishedAt: string;
  succeeded: boolean;
  summary: Record<string, unknown>;
}

export interface LocalIngestOperation {
  state: LocalIngestOperationState;
  kind: LocalIngestOperationKind | null;
  startedAt: string | null;
  updatedAt: string | null;
  elapsedMs: number;
  message: string | null;
  run: LocalIngestOperationRun | null;
  lastCompleted: LocalIngestCompletedOperation | null;
}

export interface LocalIngestOperationActivePayload {
  code: 'LOCAL_INGEST_OPERATION_ACTIVE';
  message: string;
  operation: LocalIngestOperation;
}

export type LocalIngestInboxCreatorMappingStatus = 'matched' | 'unmatched' | 'ambiguous';

export interface LocalIngestInboxCreatorCandidate {
  folderName: string;
  folderNames: string[];
  creatorId: number | null;
  canonicalName: string | null;
  mappingStatus: LocalIngestInboxCreatorMappingStatus;
  mappingReason: string;
  archiveCount: number;
  queuedJobCount: number;
  failedJobCount: number;
  awaitingReviewJobCount: number;
}

export interface LocalIngestInboxCreatorsResult {
  inboxRoot: string;
  detected: LocalIngestInboxCreatorCandidate[];
  unmapped: LocalIngestInboxCreatorCandidate[];
  summary: {
    directoryCount: number;
    matchedDirectoryCount: number;
    matchedCreatorCount: number;
    unmappedDirectoryCount: number;
    ambiguousDirectoryCount: number;
    archiveCount: number;
    queuedJobCount: number;
    failedJobCount: number;
    awaitingReviewJobCount: number;
  };
}

export interface PostContentRatingMutationResult {
  ok: boolean;
  id: number;
  contentRating: ContentRating;
}

export interface DeleteFolderResult {
  slug: string;
  deletedImageCount: number;
  deletedFolderCount: number;
  deletedSourceFolder: boolean;
}

export interface LikeMutationResult {
  id: number;
  liked: boolean;
  ok: boolean;
}

export interface ScanRunSummary {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  scanned_files: number;
  new_files: number;
  updated_files: number;
  removed_files: number;
  error_text: string | null;
  warning_count: number;
  warning_text: string | null;
}

export interface ScanProgress {
  isScanning: boolean;
  scanReason: string | null;
  phase: 'idle' | 'migration' | 'discovery' | 'derivatives';
  startedAt: string | null;
  runId: number | null;
  migrationTotalRows: number;
  processedMigrationRows: number;
  migratedDerivativeFiles: number;
  missingDerivativeFiles: number;
  repairedDerivativeFiles: number;
  backfilledAssetKeys: number;
  discoveredFolders: number;
  processedFolders: number;
  discoveredImages: number;
  processedImages: number;
  queuedDerivativeJobs: number;
  processedDerivativeJobs: number;
  generatedThumbnails: number;
  generatedPreviews: number;
  currentOperation: ScanOperation | null;
  currentFile: string | null;
  currentPhaseMessage: string | null;
  currentFolder: string | null;
  lastCompletedScan: ScanRunSummary | null;
}

export interface ManualScanResult {
  ok: boolean;
  lastScan: ScanRunSummary | null;
  archiveCatalog: {
    refreshedAt: string;
    local: {
      rootPath: string;
      creatorFolders: number;
      matchedCreatorFolders: number;
      unmatchedCreatorFolders: string[];
      ambiguousCreatorFolders: string[];
      localWorks: number;
      matchedWorks: number;
      unmatchedWorks: number;
      ambiguousWorks: number;
    };
    report: {
      creators: number;
      remoteWorks: number;
      localWorks: number;
      matchedWorks: number;
      missingWorks: number;
      unresolvedCreatorFolders: number;
      unresolvedLocalWorks: number;
    };
    reportPath: string;
    plan: ArchiveDownloadPlanResult;
    tasks: ArchiveDownloadTaskSummary;
  };
}

export interface RebuildLibraryResult {
  ok: boolean;
  lastScan: ScanRunSummary | null;
}

export interface RebuildThumbnailsResult {
  ok: boolean;
  lastScan: ScanRunSummary | null;
}

export interface AppStatus {
  folders: number;
  indexedImages: number;
  indexedPosts: number;
  indexedMediaAssets: number;
  indexedCarousels: number;
  indexedVideos: number;
  scan: ScanProgress;
  storage: {
    available: boolean;
    reason: string | null;
  };
  libraryIndex: {
    rebuildRequired: boolean;
    reason: 'gallery_root_changed' | null;
    ignoredRootMediaCount: number;
  };
  preferences: {
    defaultLocale?: SupportedLocale | null;
    defaultHomeFeedMode: FeedMode;
    defaultReelsFeedMode: ReelsFeedMode;
    defaultFolderImageOrder?: FolderImageOrder;
    nestedFolderTitleFormat?: NestedFolderTitleFormat;
    treatStoriesAsFolders: boolean;
    treatCarouselsAsFolders: boolean;
  };
  storiesMigration: {
    hasLegacyStoriesCandidates: boolean;
    decisionPending: boolean;
  };
  carouselsMigration: {
    hasLegacyCarouselsCandidates: boolean;
    decisionPending: boolean;
    reconciliationPending?: boolean;
  };
}

export interface AppStats extends AppStatus {
  deletedImages: number;
  thumbnailCount: number;
  previewCount: number;
  excludedFolders: ExcludedFoldersSettings;
  storage: AppStatus['storage'] & {
    usingInMemoryDatabase: boolean;
  };
  libraryIndex: AppStatus['libraryIndex'] & {
    currentGalleryRoot: string;
    previousGalleryRoot: string | null;
    lastSuccessfulGalleryRoot: string | null;
    legacyDerivativeMigrationPending: boolean;
    pendingDerivativeMigrationRows: number;
  };
  lastScan: ScanRunSummary | null;
}

export type AuthRole = 'admin' | 'viewer' | 'anonymous';
export type ViewerAccessMode = 'off' | 'password' | 'public';
export type LikesMode = 'shared' | 'local';

export interface AuthCapabilities {
  canManageLibrary: boolean;
  canDeleteMedia: boolean;
  canAccessSettings: boolean;
  canUseSharedLikes: boolean;
  canUseLocalFavorites: boolean;
  canUseSharedCollections?: boolean;
  canUseLocalCollections?: boolean;
}

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  role: AuthRole;
  accessMode: ViewerAccessMode;
  likesMode: LikesMode;
  defaultLocale: SupportedLocale | null;
  capabilities: AuthCapabilities;
}

export interface AuthMutationResult {
  ok: boolean;
  auth: AuthStatus;
}

export interface RailViewerStoreContract {
  currentCapsule: RailCapsule | null;
  currentImages: FeedItem[];
  currentHasMore: boolean;
  currentError?: string | null;
  loadCapsule(id: string, reset?: boolean): Promise<void>;
}
