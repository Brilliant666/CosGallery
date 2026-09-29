import express from 'express';
import { z } from 'zod';

import { AUTH_PASSWORD_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH, authService } from '../services/auth-service.js';
import { ARCHIVE_CATALOG_INBOX_ROOT_SETTING_KEY } from '../constants/app-setting-keys.js';
import { appSettingsRepository, maintenanceRepository } from '../db/repositories.js';
import {
  ArchiveCatalogPipelineService,
  type ArchiveCatalogPipelineResult
} from '../services/archive-catalog-pipeline-service.js';
import { ArchiveCatalogQueryService } from '../services/archive-catalog-query-service.js';
import { ManagedCreatorError, ManagedCreatorService, managedFolderRatingSchema } from '../services/managed-creator-service.js';
import { ArchiveBridgeService } from '../services/archive-bridge-service.js';
import { ArchiveDownloadTaskService } from '../services/archive-download-task-service.js';
import { ArchiveMetadataTaskService } from '../services/archive-metadata-task-service.js';
import { createCreatorSyncReadRouter } from './creator-sync-read-routes.js';
import { createResourceCatalogRouter } from './resource-catalog-routes.js';
import { createSourceEvidenceRouter } from './source-evidence-routes.js';
import { createLocalAdmissionWebRouter } from './local-admission-web-routes.js';
import { createLocalReviewRouter } from './local-review-routes.js';
import { createApplicationRecoveryRouter } from './application-recovery-routes.js';
import { createCompanionGrantRouter } from './companion-grant-routes.js';
import { createMediaTrashRouter } from './media-trash-routes.js';
import {
  localIngestService,
  type LocalIngestJob,
  type LocalIngestJobFilter
} from '../services/local-ingest-service.js';
import {
  LocalIngestOperationActiveError,
  localIngestOperationCoordinator,
  type LocalIngestOperationContext,
  type LocalIngestOperationKind,
  type LocalIngestOperationRun,
  type LocalIngestOperationSnapshot
} from '../services/local-ingest-operation-coordinator.js';
import { localIngestSettingsService } from '../services/local-ingest-settings-service.js';
import {
  LocalIngestDestinationError,
  LocalIngestDestinationService
} from '../services/local-ingest-destination-service.js';
import { recycleBinAdapter } from '../services/recycle-bin-adapter.js';
import {
  FOLDER_SHARE_PASSWORD_MAX_LENGTH,
  FOLDER_SHARE_PASSWORD_MIN_LENGTH,
  folderShareService
} from '../services/folder-share-service.js';
import { ReelQueueExpiredError } from '../services/reel-queue.js';
import { galleryService } from '../services/gallery-service.js';
import { ReelPlaybackError, resolveReelPlayback, resolveReelMediaPlayback } from '../services/reel-playback-service.js';
import { serveReelMedia, serveReelPreview } from './reel-media.js';
import { SourceIndexOutdatedError } from '../utils/derivative-version.js';
import { requireCapability } from '../middleware/auth-protection.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { LIBRARY_REBUILD_REQUIRED_MESSAGE, scannerService } from '../services/scanner-service.js';
import { storageService } from '../services/storage-service.js';
import { watcherService } from '../services/watcher-service.js';
import { serveDerivativeForImage } from './lazy-derivatives.js';
import { logRequestFailure, sendUnexpectedError } from '../middleware/http-errors.js';
import { buildInfo } from '../build-info.js';

const router = express.Router();
router.use(createMediaTrashRouter());

function managedResponse(response: express.Response, action: () => unknown, status = 200) {
  try { response.status(status).json(action()); } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ code: 'INVALID_CREATOR_INPUT', message: error.errors.map(issue => issue.message).join('; ') });
      return;
    }
    if (!(error instanceof ManagedCreatorError)) throw error;
    response.status(error.status).json({ code: error.code, message: error.message, candidates: error.candidates });
  }
}

const managedAccess = requireCapability('canManageLibrary', 'Admin access is required.');
router.use('/admin/companion/grants', requireCapability('canAccessSettings', 'Admin access is required.'), createCompanionGrantRouter());
router.use('/admin/recovery-points', requireCapability('canAccessSettings', 'Admin access is required.'), createApplicationRecoveryRouter());
router.use('/admin/local-admission', managedAccess, createLocalAdmissionWebRouter());
router.use('/admin/local-review', managedAccess, createLocalReviewRouter());
router.use('/admin/archive-catalog/source-evidence', managedAccess, createSourceEvidenceRouter());
router.use('/admin/archive-catalog/resource-catalog', requireCapability('canAccessSettings', 'Admin access is required.'), createResourceCatalogRouter());
router.use('/admin/archive-catalog', requireCapability('canAccessSettings', 'Admin access is required.'), createCreatorSyncReadRouter());
router.post('/admin/archive-catalog/creators', managedAccess, (request, response) => {
  managedResponse(response, () => new ManagedCreatorService().create(request.body), 201);
});
router.get('/admin/archive-catalog/creators/:id/editing-state', managedAccess, async (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  try { response.json(await new ManagedCreatorService().editingState(id)); }
  catch (error) { managedResponse(response, () => { throw error; }); }
});
router.put('/admin/archive-catalog/creators/:id/profile-settings', managedAccess, (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  managedResponse(response, () => new ManagedCreatorService().saveProfile(id, request.body));
});
router.put('/admin/archive-catalog/creators/:id/directory-settings', managedAccess, async (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  await managedOperationResponse(response, '正在保存博主目录设置', () =>
    new ManagedCreatorService().saveDirectories(id, request.body));
});
router.get('/admin/archive-catalog/creators/:id/deletion-preview', managedAccess, (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  managedResponse(response, () => new ManagedCreatorService().deletionPreview(id));
});
router.delete('/admin/archive-catalog/creators/:id', managedAccess, (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  managedResponse(response, () => new ManagedCreatorService().deleteUnusedManualCreator(id, request.body));
});
router.patch('/admin/archive-catalog/creators/:id', managedAccess, (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  managedResponse(response, () => new ManagedCreatorService().update(id, request.body));
});
router.post('/admin/archive-catalog/creators/:id/aliases', managedAccess, (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  managedResponse(response, () => new ManagedCreatorService().addAlias(id, request.body));
});
router.delete('/admin/archive-catalog/creators/:id/aliases/:aliasId', managedAccess, (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  const aliasId = z.string().min(1).max(1500).parse(request.params.aliasId);
  managedResponse(response, () => new ManagedCreatorService().deleteAlias(id, aliasId));
});
for (const [operation, active] of [['deactivate', false], ['restore', true]] as const) {
  router.post(`/admin/archive-catalog/creators/:id/${operation}`, managedAccess, (request, response) => {
    const id = imageIdSchema.parse(request.params).id;
    managedResponse(response, () => new ManagedCreatorService().setActive(id, active, request.body));
  });
}
router.get('/admin/archive-catalog/local-creator-folders', managedAccess, (_request, response) => {
  response.json({ items: new ArchiveCatalogQueryService().listLocalFolders() });
});
const managedCreatorDestinationSchema = z.object({
  localCreatorFolderId: z.number().int().positive().nullable()
}).strict();

router.get('/admin/archive-catalog/creators/:id/ingest-destination', managedAccess, async (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  try {
    response.json(await new LocalIngestDestinationService().getPreference(id));
  } catch (error) {
    if (!(error instanceof LocalIngestDestinationError)) throw error;
    response.status(error.status).json({ code: error.code, message: error.message });
  }
});

router.put('/admin/archive-catalog/creators/:id/ingest-destination', managedAccess, async (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  try {
    const body = managedCreatorDestinationSchema.parse(request.body);
    await respondWithLocalIngestOperation(
      response,
      { state: 'running', kind: 'save-settings', message: '正在保存首选入库目录' },
      () => new LocalIngestDestinationService().setPreferred(id, body.localCreatorFolderId),
      (result) => ({
        creatorId: result.creatorId,
        preferredLocalCreatorFolderId: result.preferredLocalCreatorFolderId
      })
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ code: 'INVALID_INGEST_DESTINATION_INPUT', message: error.errors.map(issue => issue.message).join('; ') });
      return;
    }
    if (!(error instanceof LocalIngestDestinationError)) throw error;
    response.status(error.status).json({ code: error.code, message: error.message });
  }
});
router.post('/admin/archive-catalog/local-creator-folders/:id/link', managedAccess, async (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  await managedOperationResponse(response, '正在关联博主目录', () =>
    new ManagedCreatorService().linkFolder(id, request.body));
});
router.post('/admin/archive-catalog/local-creator-folders/:id/unlink', managedAccess, async (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  await managedOperationResponse(response, '正在解除博主目录关联', () =>
    new ManagedCreatorService().unlinkFolder(id, request.body));
});

function operationCurrentJob(job: LocalIngestJob) {
  return {
    id: job.id,
    creatorId: job.creatorId,
    creatorName: job.creatorName,
    archiveName: job.sourceArchiveName,
    status: job.status,
    phase: job.phase
  };
}

function currentLocalIngestOperation(): LocalIngestOperationSnapshot {
  const snapshot = localIngestOperationCoordinator.snapshot();
  const currentId = snapshot.run?.currentJob?.id;
  if (currentId && snapshot.run) {
    try {
      snapshot.run.currentJob = operationCurrentJob(localIngestService.getJob(currentId));
    } catch {
      // A lightweight status read must remain available even if a concurrently
      // completed job was removed by an explicit future maintenance action.
    }
  }
  return snapshot;
}

async function respondWithLocalIngestOperation<T>(
  response: express.Response,
  descriptor: {
    state: 'scanning' | 'running';
    kind: LocalIngestOperationKind;
    message: string;
    run?: LocalIngestOperationRun | null;
  },
  action: (context: LocalIngestOperationContext) => Promise<T> | T,
  summarize: (result: T) => Record<string, unknown> = () => ({})
): Promise<void> {
  try {
    response.json(await localIngestOperationCoordinator.run(descriptor, action, summarize));
  } catch (error) {
    if (error instanceof LocalIngestOperationActiveError) {
      response.status(409).json({
        code: error.code,
        message: error.message,
        operation: currentLocalIngestOperation()
      });
      return;
    }
    throw error;
  }
}

async function managedOperationResponse<T>(
  response: express.Response,
  message: string,
  action: () => T
): Promise<void> {
  try {
    await respondWithLocalIngestOperation(
      response,
      { state: 'running', kind: 'save-settings', message },
      action
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        code: 'INVALID_CREATOR_INPUT',
        message: error.errors.map(issue => issue.message).join('; ')
      });
      return;
    }
    if (!(error instanceof ManagedCreatorError)) throw error;
    response.status(error.status).json({
      code: error.code,
      message: error.message,
      candidates: error.candidates
    });
  }
}

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(24)
});
const mediaTypeQuerySchema = z.object({
  mediaType: z.enum(['image', 'video']).optional()
});
const originalMediaQuerySchema = z.object({
  download: z.preprocess((value) => {
    if (value === undefined) {
      return false;
    }

    if (value === true || value === 1 || value === '1' || value === 'true') {
      return true;
    }

    if (value === false || value === 0 || value === '0' || value === 'false') {
      return false;
    }

    return value;
  }, z.boolean())
});
const deleteFolderQuerySchema = z.object({
  deleteSourceFolder: z.preprocess((value) => {
    if (value === undefined) {
      return false;
    }

    if (value === true || value === 'true') {
      return true;
    }

    if (value === false || value === 'false') {
      return false;
    }

    return value;
  }, z.boolean())
});
const feedQuerySchema = paginationQuerySchema.extend({
  mode: z.enum(['recent', 'rediscover', 'random']).default('random'),
  seed: z.coerce.number().int().nonnegative().optional()
});
const reelsQuerySchema = paginationQuerySchema.extend({
  cursor: z.string().min(1).max(256).optional(),
  mode: z.enum(['recommended', 'recent', 'random']).default('recommended'),
  seed: z.coerce.number().int().nonnegative().optional(),
  lastFolder: z.string().trim().min(1).max(240).optional(),
  recentFolders: z.string().trim().max(2400).optional()
});
const mediaSearchQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(160)
});
const cosGalleryWorksQuerySchema = paginationQuerySchema.extend({
  contentRating: z.enum(['R15', 'R18']).optional(),
  q: z.string().trim().max(160).optional()
});
const cosGalleryCreatorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(60),
  contentRating: z.enum(['R15', 'R18', 'unclassified', 'unlinked', 'inactive']).optional(),
  preference: z.enum(['liked', 'kept']).optional(),
  q: z.string().trim().max(160).optional()
});
const canonicalCreatorWorkParamsSchema = z.object({
  creatorId: z.coerce.number().int().positive(),
  postId: z.coerce.number().int().positive()
});
const archiveCatalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  preference: z.enum(['liked', 'kept', 'unset']).optional(),
  rating: z.enum(['R15', 'R18', 'unclassified']).optional(),
  active: z.enum(['active', 'inactive', 'all']).default('active'),
  hasLocal: z.enum(['yes', 'no']).optional(),
  hasSource: z.enum(['yes', 'no', 'no-unchecked', 'no-not-found']).optional(),
  state: z.enum(['missing', 'complete', 'no-local', 'no-source', 'unresolved']).optional(),
  q: z.string().trim().max(160).optional()
});
const archiveDownloadTaskStatusSchema = z.enum([
  'pending',
  'claimed',
  'staged',
  'downloading',
  'downloaded',
  'ingested',
  'failed',
  'cancelled'
]);
const archiveDownloadTaskQuerySchema = z.object({
  status: archiveDownloadTaskStatusSchema.optional(),
  creatorId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});
const archiveDownloadPlanBodySchema = z.object({
  targetRoot: z.string().trim().min(1).max(500),
  creatorIds: z.array(z.number().int().positive()).max(1000).optional(),
  provider: z.literal('baidu').default('baidu')
});
const archiveMetadataTaskQuerySchema = z.object({
  status: z.enum(['pending', 'claimed', 'completed', 'not_found', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  page:z.coerce.number().int().positive().default(1)
});
const localIngestStatusSchema = z.enum(['pending', 'running', 'awaiting_review', 'failed', 'completed']);
const localIngestJobQuerySchema = z.object({
  status: localIngestStatusSchema.optional(),
  creatorId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
const localIngestScanBodySchema = z.object({}).strict();
const localIngestRunIdListSchema = z.array(z.number().int().positive()).min(1).max(500)
  .transform((values) => [...new Set(values)]);
const localIngestRunBodySchema = z.object({
  jobIds: localIngestRunIdListSchema.optional(),
  creatorIds: localIngestRunIdListSchema.optional()
}).strict().refine((value) => !(value.jobIds && value.creatorIds), {
  message: 'Choose either jobIds or creatorIds for one explicit batch scope, not both'
});
const localIngestSettingsBodySchema = z.object({
  libraryRoot: z.string().trim().min(1).max(500),
  inboxRoot: z.string().trim().min(1).max(500),
  processingRoot: z.string().trim().min(1).max(500),
  sevenZipPath: z.string().trim().max(500),
  fileStableSeconds: z.number().int().min(1).max(3600),
  recycleAfterIngest: z.boolean(),
  maxExtractionDepth: z.literal(2),
  allowlist: z.array(z.string().trim().min(1).max(255)).max(1000).optional(),
  archivePassword: z.string().max(1024).regex(/^[^\r\n\0]*$/, 'Invalid archive password').optional(),
  clearArchivePassword: z.boolean().optional()
}).refine((value) => !(value.clearArchivePassword && value.archivePassword), 'Choose either a new archive password or clear');
const localIngestAllowlistBodySchema = z.object({
  allowlist: z.array(z.string().trim().min(1).max(255)).max(1000)
}).strict();
const homeFeedDefaultBodySchema = z.object({
  defaultMode: z.enum(['recent', 'rediscover', 'random'])
});
const appLocaleBodySchema = z.object({
  defaultLocale: z.enum(['en', 'es', 'zh'])
});
const reelsFeedDefaultBodySchema = z.object({
  defaultMode: z.enum(['recommended', 'recent', 'random'])
});
const folderImageOrderDefaultBodySchema = z.object({
  defaultOrder: z.enum(['newest', 'oldest'])
});
const nestedFolderTitleFormatBodySchema = z.object({
  titleFormat: z.enum(['folder', 'parent-plus-folder'])
});
const storiesModeBodySchema = z.object({
  treatStoriesAsFolders: z.boolean()
});
const excludedFoldersBodySchema = z.object({
  rules: z.array(z.string()).default([])
});
const collectionBodySchema = z.object({
  name: z.string().trim().min(1).max(80)
});

const slugSchema = z.object({
  slug: z.string().min(1).max(240)
});
const momentIdSchema = z.object({
  id: z.string().min(1).max(120)
});
const storyIdSchema = z.object({
  id: z.string().min(1).max(240)
});

const imageIdSchema = z.object({
  id: z.coerce.number().int().positive()
});
const shareLinkIdSchema = z.object({
  linkId: z.coerce.number().int().positive()
});

export const patchFolderBodySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(300).nullable().optional()
});

export const patchImageCaptionBodySchema = z
  .object({
    caption: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim() : value),
      z.string().max(300).nullable().optional()
    )
  })
  .transform((body) => ({
    caption: body.caption === '' ? null : body.caption ?? null
  }));

export const patchPostContentRatingBodySchema = z.object({
  contentRating: z.enum(['R15', 'R18'])
});

export const folderCoverBodySchema = z.object({
  imageId: z.coerce.number().int().positive()
});

const submittedPasswordSchema = z
  .string()
  .min(1, 'Password is required.')
  .max(AUTH_PASSWORD_MAX_LENGTH, `Password must be at most ${AUTH_PASSWORD_MAX_LENGTH} characters.`);
const submittedCurrentPasswordSchema = z
  .string()
  .min(1, 'Current password is required.')
  .max(AUTH_PASSWORD_MAX_LENGTH, `Current password must be at most ${AUTH_PASSWORD_MAX_LENGTH} characters.`);
const passwordFieldSchema = z
  .string()
  .min(AUTH_PASSWORD_MIN_LENGTH, `Password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`)
  .max(AUTH_PASSWORD_MAX_LENGTH, `Password must be at most ${AUTH_PASSWORD_MAX_LENGTH} characters.`)
  .refine((value) => value.trim().length > 0, 'Password cannot be empty.');
const loginBodySchema = z.object({
  password: submittedPasswordSchema
});
const configurePasswordBodySchema = z.object({
  password: passwordFieldSchema
});
const changePasswordBodySchema = z.object({
  currentPassword: submittedCurrentPasswordSchema,
  password: passwordFieldSchema
});
const disablePasswordBodySchema = z.object({
  currentPassword: submittedCurrentPasswordSchema
});
const viewerAccessBodySchema = z
  .object({
    mode: z.enum(['off', 'password', 'public']),
    viewerPassword: passwordFieldSchema.optional()
  })
  .superRefine((body, context) => {
    if (body.mode === 'password' && !body.viewerPassword) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Viewer password is required when viewer access mode is password.',
        path: ['viewerPassword']
      });
    }
  });
const createShareLinkBodySchema = z
  .object({
    expiresIn: z.enum(['1h', '24h', '7d', 'custom', 'unlimited']).default('24h'),
    customExpiresAt: z.string().datetime().nullable().optional(),
    unlimited: z.boolean().default(false)
  })
  .superRefine((body, context) => {
    if (body.unlimited || body.expiresIn === 'unlimited') {
      return;
    }

    if (body.expiresIn === 'custom' && !body.customExpiresAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Custom expiration date is required.',
        path: ['customExpiresAt']
      });
      return;
    }

    if (body.customExpiresAt && Date.parse(body.customExpiresAt) <= Date.now()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Share links must expire in the future.',
        path: ['customExpiresAt']
      });
    }
  });
const shareTokenBodySchema = z.object({
  token: z.string().trim().min(1).max(512)
});
const sharePasswordBodySchema = z.object({
  password: z
    .string()
    .min(FOLDER_SHARE_PASSWORD_MIN_LENGTH, `Password must be at least ${FOLDER_SHARE_PASSWORD_MIN_LENGTH} characters.`)
    .max(FOLDER_SHARE_PASSWORD_MAX_LENGTH, `Password must be at most ${FOLDER_SHARE_PASSWORD_MAX_LENGTH} characters.`)
    .refine((value) => value.trim().length > 0, 'Password cannot be empty.')
});
const submittedSharePasswordBodySchema = z.object({
  password: z
    .string()
    .min(1, 'Password is required.')
    .max(FOLDER_SHARE_PASSWORD_MAX_LENGTH, `Password must be at most ${FOLDER_SHARE_PASSWORD_MAX_LENGTH} characters.`)
});

export const authRequestBodySchemas = {
  login: loginBodySchema,
  configurePassword: configurePasswordBodySchema,
  changePassword: changePasswordBodySchema,
  disablePassword: disablePasswordBodySchema,
  viewerAccess: viewerAccessBodySchema
};

export const settingsRequestBodySchemas = {
  homeFeedDefault: homeFeedDefaultBodySchema,
  appLocale: appLocaleBodySchema,
  reelsFeedDefault: reelsFeedDefaultBodySchema,
  folderImageOrderDefault: folderImageOrderDefaultBodySchema,
  nestedFolderTitleFormat: nestedFolderTitleFormatBodySchema,
  storiesMode: storiesModeBodySchema,
  excludedFolders: excludedFoldersBodySchema
};

export const routeParamSchemas = {
  slug: slugSchema,
  momentId: momentIdSchema,
  storyId: storyIdSchema,
  imageId: imageIdSchema
};

const authRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts. Please try again in a minute.'
});
const shareUnlockRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many share unlock attempts. Please try again in a minute.'
});

function resolveShareLinkExpiration(body: z.infer<typeof createShareLinkBodySchema>): Date | null {
  if (body.unlimited || body.expiresIn === 'unlimited') {
    return null;
  }

  if (body.expiresIn === 'custom') {
    return new Date(body.customExpiresAt as string);
  }

  const durationMs =
    body.expiresIn === '1h'
      ? 60 * 60 * 1000
      : body.expiresIn === '7d'
        ? 7 * 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;

  return new Date(Date.now() + durationMs);
}

function setShareResponseHeaders(response: express.Response): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.vary('Cookie');
}

function sendShareAccessDenied(response: express.Response, status = 401): void {
  setShareResponseHeaders(response);
  response.status(status).json({ message: 'This folder share is expired, revoked, or locked.' });
}

function ensureShareFolderAccess(request: express.Request, response: express.Response, folderId: number): boolean {
  if (!folderShareService.getFolderGrant(request, folderId)) {
    sendShareAccessDenied(response);
    return false;
  }

  setShareResponseHeaders(response);
  return true;
}

const PUBLIC_SENSITIVE_MEDIA_KEYS = new Set([
  'absolutePath',
  'exif',
  'exifJson',
  'relativePath',
  'sourcePath'
]);

function redactPublicMediaMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactPublicMediaMetadata(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PUBLIC_SENSITIVE_MEDIA_KEYS.has(key))
      .map(([key, item]) => [key, redactPublicMediaMetadata(item)])
  );
}

router.use((request, response, next) => {
  const isAnonymousPublicViewer =
    authService.isPublicViewerAccessEnabled() &&
    !authService.isAuthenticatedRequest(request);

  if (!isAnonymousPublicViewer || request.method.toUpperCase() !== 'GET') {
    next();
    return;
  }

  const sendJson = response.json.bind(response);
  response.json = ((body: unknown) => sendJson(redactPublicMediaMetadata(body))) as typeof response.json;
  next();
});

router.get('/health', (_request, response) => {
  const storageState = storageService.getState();
  response.json({
    ok: true,
    timestamp: new Date().toISOString(),
    build: buildInfo,
    storage: {
      available: storageState.libraryAvailable,
      reason: storageState.libraryAvailable ? null : 'Configured library storage is unavailable.',
      usingInMemoryDatabase: storageState.usingInMemoryDatabase
    }
  });
});

router.get('/auth/status', (request, response) => {
  authService.setNoStoreHeaders(response);
  response.json(authService.getStatus(request));
});

router.post('/auth/login', authRateLimiter, (request, response) => {
  authService.setNoStoreHeaders(response);

  if (!authService.isEnabled()) {
    response.status(400).json({ message: 'Password protection is not enabled.' });
    return;
  }

  const body = loginBodySchema.parse(request.body);
  const role = authService.authenticatePassword(body.password);
  if (!role) {
    response.status(401).json({ message: 'Incorrect password.' });
    return;
  }

  authService.setAuthenticatedSession(response, request, role);
  response.json({
    ok: true,
    auth: authService.getAuthenticatedStatus(role)
  });
});

router.post('/auth/unlock-admin', authRateLimiter, (request, response) => {
  authService.setNoStoreHeaders(response);

  if (!authService.isEnabled()) {
    response.status(400).json({ message: 'Password protection is not enabled.' });
    return;
  }

  const body = loginBodySchema.parse(request.body);
  if (!authService.verifyAdminPassword(body.password)) {
    response.status(401).json({ message: 'Incorrect admin password.' });
    return;
  }

  authService.setAuthenticatedSession(response, request, 'admin');
  response.json({
    ok: true,
    auth: authService.getAuthenticatedStatus('admin')
  });
});

router.post('/auth/logout', (request, response) => {
  authService.setNoStoreHeaders(response);
  authService.clearAuthenticatedSession(response, request);
  response.json({
    ok: true,
    auth: authService.getLoggedOutStatus()
  });
});

router.put('/auth/password', authRateLimiter, (request, response) => {
  authService.setNoStoreHeaders(response);

  if (!authService.isEnabled()) {
    const body = configurePasswordBodySchema.parse(request.body);
    const auth = authService.setAdminPassword(body.password);
    authService.setAuthenticatedSession(response, request, 'admin');
    response.json({
      ok: true,
      auth
    });
    return;
  }

  if (!authService.hasCapability(request, 'canAccessSettings')) {
    response.status(403).json({ message: 'Admin access is required.' });
    return;
  }

  const body = changePasswordBodySchema.parse(request.body);
  if (!authService.verifyAdminPassword(body.currentPassword)) {
    response.status(401).json({ message: 'Incorrect current password.' });
    return;
  }

  const auth = authService.setAdminPassword(body.password);
  authService.setAuthenticatedSession(response, request, 'admin');
  response.json({
    ok: true,
    auth
  });
});

router.delete('/auth/password', authRateLimiter, (request, response) => {
  authService.setNoStoreHeaders(response);

  if (!authService.isEnabled()) {
    response.status(400).json({ message: 'Password protection is already disabled.' });
    return;
  }

  if (!authService.hasCapability(request, 'canAccessSettings')) {
    response.status(403).json({ message: 'Admin access is required.' });
    return;
  }

  const body = disablePasswordBodySchema.parse(request.body);
  if (!authService.verifyAdminPassword(body.currentPassword)) {
    response.status(401).json({ message: 'Incorrect current password.' });
    return;
  }

  const auth = authService.disable();
  authService.clearAuthenticatedSession(response, request);
  response.json({
    ok: true,
    auth
  });
});

router.put('/auth/viewer-access', authRateLimiter, (request, response) => {
  authService.setNoStoreHeaders(response);

  if (!authService.isEnabled()) {
    response.status(400).json({ message: 'Enable the admin password before configuring viewer access.' });
    return;
  }

  if (!authService.hasCapability(request, 'canAccessSettings')) {
    response.status(403).json({ message: 'Admin access is required.' });
    return;
  }

  const body = viewerAccessBodySchema.parse(request.body);
  const auth = authService.setViewerAccess(body.mode, body.viewerPassword ?? null);
  authService.setAuthenticatedSession(response, request, 'admin');
  response.json({
    ok: true,
    auth
  });
});

router.get('/feed', (request, response) => {
  const query = feedQuerySchema.parse(request.query);
  response.json(galleryService.getFeed(query.page, query.limit, query.mode, query.seed));
});

router.get('/reels', (request, response) => {
  const query = reelsQuerySchema.parse(request.query);
  const recentOpenedFolderSlugs = query.recentFolders
    ? query.recentFolders
        .split(',')
        .map((slug) => slug.trim())
        .filter((slug, index, items) => slug.length > 0 && items.indexOf(slug) === index)
    : [];

  try {
    response.json(
      galleryService.getReels(query.page, query.limit, query.mode, query.seed, {
        lastOpenedFolderSlug: query.lastFolder ?? null,
        recentOpenedFolderSlugs
      }, query.cursor)
    );
  } catch (error) {
    if (!(error instanceof ReelQueueExpiredError)) throw error;
    response.status(409).json({ code: 'REEL_QUEUE_EXPIRED', message: error.message });
  }
});

router.get('/reels/media/:id/playback', async (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const query = z.object({ fallback: z.literal('1').optional() }).strict().parse(request.query);
  authService.setNoStoreHeaders(response);
  try {
    response.json(await resolveReelMediaPlayback(params.id, query.fallback === '1'));
  } catch (error) {
    if (error instanceof ReelPlaybackError || error instanceof SourceIndexOutdatedError) {
      response.status(error instanceof ReelPlaybackError ? error.status : 409).json({ code: error.code, message: error.message });
    } else {
      sendUnexpectedError(response, error);
    }
  }
});
router.get('/reels/media/:id/preview', async (request, response) => {
  const params = imageIdSchema.parse(request.params);
  await serveReelPreview(request, response, params.id);
});
for (const kind of ['original', 'remux'] as const) {
  router.get(`/reels/media/:id/${kind}`, async (request, response) => {
    const params = imageIdSchema.parse(request.params);
    await serveReelMedia(request, response, params.id, kind, 'media');
  });
}

router.get('/reels/:id/playback', async (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const query = z.object({ fallback: z.literal('1').optional() }).strict().parse(request.query);
  authService.setNoStoreHeaders(response);
  try {
    response.json(await resolveReelPlayback(params.id, query.fallback === '1'));
  } catch (error) {
    if (error instanceof ReelPlaybackError || error instanceof SourceIndexOutdatedError) {
      response.status(error instanceof ReelPlaybackError ? error.status : 409).json({ code: error.code, message: error.message });
    } else {
      sendUnexpectedError(response, error);
    }
  }
});

for (const kind of ['original', 'remux'] as const) {
  router.get(`/reels/:id/${kind}`, async (request, response) => {
    const params = imageIdSchema.parse(request.params);
    await serveReelMedia(request, response, params.id, kind);
  });
}

router.get('/feed/search', (request, response) => {
  const query = mediaSearchQuerySchema.parse(request.query);
  response.json(galleryService.searchMedia(query.q, query.page, query.limit));
});

router.get('/status', (_request, response) => {
  response.json(galleryService.getStatus());
});

router.get('/scan-progress', (_request, response) => {
  response.json(galleryService.getScanProgress());
});

router.get('/admin/scan-progress', requireCapability('canAccessSettings', 'Admin access is required.'), (_request, response) => {
  response.json(galleryService.getAdminScanProgress());
});

router.put(
  '/admin/settings/app-locale',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const body = appLocaleBodySchema.parse(request.body);
    response.json(galleryService.setDefaultLocale(body.defaultLocale));
  }
);

router.put(
  '/admin/settings/home-feed-default',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const body = homeFeedDefaultBodySchema.parse(request.body);
    response.json(galleryService.setDefaultHomeFeedMode(body.defaultMode));
  }
);

router.put(
  '/admin/settings/reels-feed-default',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const body = reelsFeedDefaultBodySchema.parse(request.body);
    response.json(galleryService.setDefaultReelsFeedMode(body.defaultMode));
  }
);

router.put(
  '/admin/settings/folder-image-order-default',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const body = folderImageOrderDefaultBodySchema.parse(request.body);
    response.json(galleryService.setDefaultFolderImageOrder(body.defaultOrder));
  }
);

router.put(
  '/admin/settings/nested-folder-title-format',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const body = nestedFolderTitleFormatBodySchema.parse(request.body);
    response.json(galleryService.setNestedFolderTitleFormat(body.titleFormat));
  }
);

router.put(
  '/admin/settings/stories-mode',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const body = storiesModeBodySchema.parse(request.body);
    response.json(galleryService.setTreatStoriesAsFolders(body.treatStoriesAsFolders));
  }
);

router.put(
  '/admin/settings/excluded-folders',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const body = excludedFoldersBodySchema.parse(request.body);
    response.json(galleryService.setExcludedFolders(body.rules));
  }
);

router.get('/feed/moments', (_request, response) => {
  response.json(galleryService.listMoments());
});

router.get('/feed/moments/:id', (request, response) => {
  const params = momentIdSchema.parse(request.params);
  const query = paginationQuerySchema.parse(request.query);
  const payload = galleryService.getMomentFeed(params.id, query.page, query.limit);

  if (!payload) {
    response.status(404).json({ message: 'Feed capsule not found' });
    return;
  }

  response.json(payload);
});

router.get('/folders', (_request, response) => {
  response.json({
    items: galleryService.listFolders()
  });
});

router.get('/folders/:slug', (request, response) => {
  const params = slugSchema.parse(request.params);
  const folder = galleryService.getFolderBySlug(params.slug);

  if (!folder) {
    response.status(404).json({ message: 'Folder not found' });
    return;
  }

  response.json(folder);
});

router.patch('/folders/:slug', requireCapability('canManageLibrary', 'Admin access is required.'), (request, response) => {
  const params = slugSchema.parse(request.params);
  const body = patchFolderBodySchema.parse(request.body);
  const updated = galleryService.updateFolderMetadata(params.slug, body.name, body.description ?? null);

  if (!updated) {
    response.status(404).json({ message: 'Folder not found' });
    return;
  }

  response.json(updated);
});

router.post('/folders/:slug/cover', requireCapability('canManageLibrary', 'Admin access is required.'), (request, response) => {
  const params = slugSchema.parse(request.params);
  const body = folderCoverBodySchema.parse(request.body);
  const success = galleryService.setFolderAvatar(params.slug, body.imageId);

  if (!success) {
    response.status(404).json({ message: 'Folder or image not found' });
    return;
  }

  response.json({ ok: true });
});

router.get(
  '/admin/folders/:slug/share-links',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (request, response) => {
    const params = slugSchema.parse(request.params);
    const payload = folderShareService.listLinks(params.slug);

    if (!payload) {
      response.status(404).json({ message: 'Folder not found' });
      return;
    }

    response.json({
      links: payload.links,
      password: payload.password,
      publicFolderUrl: `/folders/${encodeURIComponent(payload.folder.slug)}`,
      publicAccess: !authService.isEnabled() || authService.isPublicViewerAccessEnabled()
    });
  }
);

router.post(
  '/admin/folders/:slug/share-links',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (request, response) => {
    const params = slugSchema.parse(request.params);
    const body = createShareLinkBodySchema.parse(request.body);
    const created = folderShareService.createLink(params.slug, {
      expiresAt: resolveShareLinkExpiration(body)
    });

    if (!created) {
      response.status(404).json({ message: 'Folder not found' });
      return;
    }

    response.status(201).json({
      ok: true,
      shareUrl: `/share/${encodeURIComponent(created.folder.slug)}#token=${encodeURIComponent(created.rawToken)}`,
      link: created.link
    });
  }
);

router.delete(
  '/admin/folders/:slug/share-links/:linkId',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (request, response) => {
    const params = slugSchema.merge(shareLinkIdSchema).parse(request.params);
    const link = folderShareService.revokeLink(params.slug, params.linkId);

    if (!link) {
      response.status(404).json({ message: 'Share link not found' });
      return;
    }

    response.json({
      ok: true,
      link
    });
  }
);

router.put(
  '/admin/folders/:slug/share-password',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (request, response) => {
    const params = slugSchema.parse(request.params);
    const body = sharePasswordBodySchema.parse(request.body);
    const password = folderShareService.setPassword(params.slug, body.password);

    if (!password) {
      response.status(404).json({ message: 'Folder not found' });
      return;
    }

    response.json({
      ok: true,
      password: {
        enabled: password.enabled,
        updatedAt: password.updatedAt
      }
    });
  }
);

router.delete(
  '/admin/folders/:slug/share-password',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (request, response) => {
    const params = slugSchema.parse(request.params);
    const password = folderShareService.removePassword(params.slug);

    if (!password) {
      response.status(404).json({ message: 'Folder not found' });
      return;
    }

    response.json({
      ok: true,
      password: {
        enabled: false,
        updatedAt: null
      }
    });
  }
);

router.delete('/folders/:slug', requireCapability('canDeleteMedia', 'Admin access is required.'), async (request, response) => {
  slugSchema.parse(request.params);
  deleteFolderQuerySchema.parse(request.query);
  response.status(410).json({
    code: 'LEGACY_FOLDER_DELETE_RETIRED',
    message: 'Legacy permanent folder deletion has been retired. No files or records were changed.'
  });
});

router.get('/folders/:slug/images', (request, response) => {
  const params = slugSchema.parse(request.params);
  const query = paginationQuerySchema.merge(mediaTypeQuerySchema).parse(request.query);
  const payload = galleryService.getFolderImages(params.slug, query.page, query.limit, query.mediaType);

  if (!payload) {
    response.status(404).json({ message: 'Folder not found' });
    return;
  }

  response.json(payload);
});

router.get('/share/folders/:slug/access', (request, response) => {
  const params = slugSchema.parse(request.params);
  const access = folderShareService.getAccessState(request, params.slug);

  if (!access.exists) {
    response.status(404).json({ message: 'Folder share not found' });
    return;
  }

  setShareResponseHeaders(response);
  response.json(access);
});

router.post('/share/folders/:slug/unlock-link', shareUnlockRateLimiter, (request, response) => {
  const params = slugSchema.parse(request.params);
  const body = shareTokenBodySchema.parse(request.body);
  const grant = folderShareService.verifyLinkToken(params.slug, body.token);

  if (!grant) {
    folderShareService.clearShareSession(response, request);
    sendShareAccessDenied(response, 403);
    return;
  }

  folderShareService.setShareSession(response, request, grant);
  setShareResponseHeaders(response);
  response.json({ ok: true });
});

router.post('/share/folders/:slug/unlock-password', shareUnlockRateLimiter, (request, response) => {
  const params = slugSchema.parse(request.params);
  const body = submittedSharePasswordBodySchema.parse(request.body);
  const grant = folderShareService.verifyPassword(params.slug, body.password);

  if (!grant) {
    folderShareService.clearShareSession(response, request);
    sendShareAccessDenied(response);
    return;
  }

  folderShareService.setShareSession(response, request, grant);
  setShareResponseHeaders(response);
  response.json({ ok: true });
});

router.get('/share/folders/:slug', (request, response) => {
  const params = slugSchema.parse(request.params);
  const folder = galleryService.getSharedFolderBySlug(params.slug);

  if (!folder) {
    response.status(404).json({ message: 'Folder share not found' });
    return;
  }

  if (!ensureShareFolderAccess(request, response, folder.id)) {
    return;
  }

  response.json(folder);
});

router.get('/share/folders/:slug/images', (request, response) => {
  const params = slugSchema.parse(request.params);
  const query = paginationQuerySchema.merge(mediaTypeQuerySchema).parse(request.query);
  const payload = galleryService.getSharedFolderImages(params.slug, query.page, query.limit, query.mediaType);

  if (!payload) {
    response.status(404).json({ message: 'Folder share not found' });
    return;
  }

  if (!ensureShareFolderAccess(request, response, payload.folder.id)) {
    return;
  }

  response.json(payload);
});

router.get('/share/images/:id', (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const query = mediaTypeQuerySchema.parse(request.query);
  const image = galleryService.getSharedImageDetail(params.id, query.mediaType, { isLegacyImageAlias: true });

  if (!image) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  if (!ensureShareFolderAccess(request, response, image.folderId)) {
    return;
  }

  response.json(image);
});

router.get('/share/posts/:id', (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const query = mediaTypeQuerySchema.parse(request.query);
  const image = galleryService.getSharedImageDetail(params.id, query.mediaType);

  if (!image) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  if (!ensureShareFolderAccess(request, response, image.folderId)) {
    return;
  }

  response.json(image);
});

router.get('/share/images/:id/thumbnail', async (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const image = galleryService.getShareDerivativeImage(params.id);

  if (!image) {
    response.status(404).json({ message: 'Thumbnail not found' });
    return;
  }

  if (!ensureShareFolderAccess(request, response, image.folder_id)) {
    return;
  }

  await serveDerivativeForImage(response, image, 'thumbnail', { noStore: true });
});

router.get('/share/images/:id/preview', async (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const image = galleryService.getShareDerivativeImage(params.id);

  if (!image) {
    response.status(404).json({ message: 'Preview not found' });
    return;
  }

  if (!ensureShareFolderAccess(request, response, image.folder_id)) {
    return;
  }

  await serveDerivativeForImage(response, image, 'preview', { noStore: true });
});

router.get('/places', (_request, response) => {
  response.json({
    items: galleryService.listPlaces()
  });
});

router.get('/places/:slug', (request, response) => {
  const params = slugSchema.parse(request.params);
  const place = galleryService.getPlaceBySlug(params.slug);

  if (!place) {
    response.status(404).json({ message: 'Place not found' });
    return;
  }

  response.json(place);
});

router.get('/places/:slug/images', (request, response) => {
  const params = slugSchema.parse(request.params);
  const query = paginationQuerySchema.merge(mediaTypeQuerySchema).parse(request.query);
  const payload = galleryService.getPlaceImages(params.slug, query.page, query.limit, query.mediaType);

  if (!payload) {
    response.status(404).json({ message: 'Place not found' });
    return;
  }

  response.json(payload);
});

router.get('/folders/:slug/stories', (request, response) => {
  const params = slugSchema.parse(request.params);
  const payload = galleryService.getFolderStories(params.slug);

  if (!payload) {
    response.status(404).json({ message: 'Folder not found' });
    return;
  }

  response.json(payload);
});

router.get('/folders/:slug/stories/:id', (request, response) => {
  const params = slugSchema.merge(storyIdSchema).parse(request.params);
  const query = paginationQuerySchema.parse(request.query);
  const payload = galleryService.getFolderStoryFeed(params.slug, params.id, query.page, query.limit);

  if (!payload) {
    response.status(404).json({ message: 'Story capsule not found' });
    return;
  }

  response.json(payload);
});

router.get('/likes', requireCapability('canUseSharedLikes', 'Authentication required.'), (_request, response) => {
  response.json(galleryService.getLikes());
});

router.get('/collections', requireCapability('canUseSharedCollections', 'Authentication required.'), (_request, response) => {
  response.json(galleryService.getCollections());
});

router.post('/collections', requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const body = collectionBodySchema.parse(request.body);
  const collection = galleryService.createCollection(body.name);

  if (!collection) {
    response.status(404).json({ message: 'Collection could not be created' });
    return;
  }

  response.json({
    ok: true,
    collection
  });
});

router.patch('/collections/:slug', requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const params = slugSchema.parse(request.params);
  const body = collectionBodySchema.parse(request.body);
  const collection = galleryService.updateCollection(params.slug, body.name);

  if (!collection) {
    response.status(404).json({ message: 'Collection not found' });
    return;
  }

  response.json({
    ok: true,
    collection
  });
});

router.delete('/collections/:slug', requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const params = slugSchema.parse(request.params);
  const collection = galleryService.deleteCollection(params.slug);

  if (!collection) {
    response.status(404).json({ message: 'Collection not found' });
    return;
  }

  response.json({
    ok: true,
    collection
  });
});

router.get('/collections/:slug/images', requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const params = slugSchema.parse(request.params);
  const query = paginationQuerySchema.parse(request.query);
  const payload = galleryService.getCollectionImages(params.slug, query.page, query.limit);

  if (!payload) {
    response.status(404).json({ message: 'Collection not found' });
    return;
  }

  response.json(payload);
});

router.post(['/collections/:slug/posts/:id', '/collections/:slug/images/:id'], requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const params = slugSchema.merge(imageIdSchema).parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.addImageToCollection(params.slug, params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Collection or image not found' });
    return;
  }

  response.json({
    ok: true,
    ...payload
  });
});

router.delete(['/collections/:slug/posts/:id', '/collections/:slug/images/:id'], requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const params = slugSchema.merge(imageIdSchema).parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.removeImageFromCollection(params.slug, params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Collection or image not found' });
    return;
  }

  response.json({
    ok: true,
    ...payload
  });
});

router.get('/trash/images', requireCapability('canDeleteMedia', 'Admin access is required.'), (request, response) => {
  const query = paginationQuerySchema.parse(request.query);
  response.json(galleryService.getTrashImages(query.page, query.limit));
});

router.get('/posts/:id/summary', (request, response) => {
  const { id } = imageIdSchema.parse(request.params);
  const summary = galleryService.getPostSummary(id);
  if (!summary) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }
  response.json(summary);
});

router.get(['/posts/:id', '/images/:id'], (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const query = mediaTypeQuerySchema.parse(request.query);
  const isLegacyImageAlias = request.path.includes('/images/');
  const image = galleryService.getImageDetail(params.id, query.mediaType, { isLegacyImageAlias });

  if (!image) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  response.json(image);
});

router.patch(['/posts/:id/caption', '/images/:id/caption'], requireCapability('canManageLibrary', 'Admin access is required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const body = patchImageCaptionBodySchema.parse(request.body);
  const isLegacyImageAlias = request.path.includes('/images/');
  const image = galleryService.updateImageCaption(params.id, body.caption, { isLegacyImageAlias });

  if (!image) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  response.json({
    ok: true,
    image
  });
});

router.get('/cos-gallery/works', (request, response) => {
  const query = cosGalleryWorksQuerySchema.parse(request.query);
  response.json(
    galleryService.getCosGalleryWorks(
      query.page,
      query.limit,
      query.contentRating,
      query.q
    )
  );
});

router.get('/cos-gallery/creators', (request, response) => {
  const query = cosGalleryCreatorsQuerySchema.parse(request.query);
  response.json(galleryService.getCosGalleryCreators(query.page, query.limit, query.contentRating, query.q, query.preference));
});

router.get('/cos-gallery/creators/:id', (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  const creator = galleryService.getCanonicalCreator(id);
  if (!creator) {
    response.status(404).json({ message: 'Creator not found' });
    return;
  }
  response.json({ creator });
});

router.get('/cos-gallery/creators/:id/works', (request, response) => {
  const id = imageIdSchema.parse(request.params).id;
  const query = paginationQuerySchema.merge(mediaTypeQuerySchema).parse(request.query);
  const payload = galleryService.getCanonicalCreatorWorks(id, query.page, query.limit, query.mediaType);
  if (!payload) {
    response.status(404).json({ message: 'Creator not found' });
    return;
  }
  response.json(payload);
});

router.get('/cos-gallery/creators/:creatorId/works/:postId', (request, response) => {
  const params = canonicalCreatorWorkParamsSchema.parse(request.params);
  const query = mediaTypeQuerySchema.parse(request.query);
  const work = galleryService.getCanonicalCreatorWork(params.creatorId, params.postId, query.mediaType);
  if (!work) {
    response.status(404).json({ message: 'Creator work not found' });
    return;
  }
  response.json(work);
});

router.patch('/cos-gallery/creators/:id/content-rating', requireCapability('canManageLibrary', 'Admin access is required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const body = managedFolderRatingSchema.parse(request.body);
  managedResponse(response, () => ({ ok: true, creator: galleryService.updateCreatorContentRating(params.id, body.contentRating) }));
});

router.get(
  '/admin/archive-catalog',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const query = archiveCatalogQuerySchema.parse(request.query);
    const service = new ArchiveCatalogQueryService();
    response.json(service.listCreators({
      page: query.page,
      limit: query.limit,
      preference: query.preference,
      rating: query.rating,
      active: query.active,
      hasLocal: query.hasLocal,
      hasSource: query.hasSource,
      state: query.state,
      query: query.q
    }));
  }
);

router.get(
  '/admin/archive-catalog/download-tasks',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const query = archiveDownloadTaskQuerySchema.parse(request.query);
    const service = new ArchiveDownloadTaskService();
    response.json(service.list(query));
  }
);

router.post(
  '/admin/archive-catalog/download-tasks/plan',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (request, response) => {
    const body = archiveDownloadPlanBodySchema.parse(request.body);
    const service = new ArchiveDownloadTaskService();
    const result = service.planMissing(body);
    appSettingsRepository.set(ARCHIVE_CATALOG_INBOX_ROOT_SETTING_KEY, result.targetRoot);
    response.json(result);
  }
);

router.get(
  '/admin/archive-catalog/metadata-tasks/candidates',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request,response) => {
    const query=z.object({q:z.string().trim().max(255).optional(),page:z.coerce.number().int().positive().default(1),
      limit:z.coerce.number().int().min(1).max(100).default(50),active:z.enum(['active','inactive','all']).default('active'),
      hasSource:z.enum(['yes','no','all']).default('no')}).parse(request.query);
    response.json(new ArchiveMetadataTaskService().candidates(query));
  }
);

router.post(
  '/admin/archive-catalog/metadata-tasks/plan-selected',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (request,response) => {
    const body=z.object({creatorIds:z.array(z.number().int().positive()).min(1).max(500),requestId:z.string().trim().min(1).max(120),retry:z.boolean().default(false)}).strict().parse(request.body);
    response.json(new ArchiveMetadataTaskService().planSelected(body));
  }
);

router.get(
  '/admin/archive-catalog/metadata-tasks',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const query = archiveMetadataTaskQuerySchema.parse(request.query);
    const service = new ArchiveMetadataTaskService();
    response.json(service.list({ source: 'costuan', ...query }));
  }
);

router.post(
  '/admin/archive-catalog/metadata-tasks/plan',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (_request, response) => {
    response.status(410).json({ message: 'Select canonical creators and use plan-selected with an explicit requestId.' });
  }
);

router.get(
  '/admin/local-ingest/settings',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (_request, response) => {
    response.json(localIngestSettingsService.get());
  }
);

router.get(
  '/admin/local-ingest/archive-password',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(410).json({ code: 'PASSWORD_READ_RETIRED', message: 'Saved archive passwords cannot be read. Use settings to view configuration status or explicitly replace or clear the password.' });
  }
);

router.get(
  '/admin/local-ingest/operation',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(currentLocalIngestOperation());
  }
);

router.put(
  '/admin/local-ingest/settings',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  async (request, response) => {
    const body = localIngestSettingsBodySchema.parse(request.body);
    await respondWithLocalIngestOperation(
      response,
      { state: 'running', kind: 'save-settings', message: '正在保存 Stage 3 配置' },
      () => localIngestSettingsService.save(body),
      (settings) => ({ saved: true, allowlistCount: settings.allowlist.length })
    );
  }
);

router.post(
  '/admin/local-ingest/settings/validate',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  async (request, response) => {
    const body = request.body && Object.keys(request.body).length > 0
      ? localIngestSettingsBodySchema.parse(request.body)
      : undefined;
    await respondWithLocalIngestOperation(
      response,
      { state: 'running', kind: 'validation', message: '正在验证 Stage 3 环境' },
      () => localIngestSettingsService.validate(body),
      (result) => ({ valid: result.valid, errorCount: result.errors.length })
    );
  }
);

router.put(
  '/admin/local-ingest/allowlist',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  async (request, response) => {
    const body = localIngestAllowlistBodySchema.parse(request.body);
    await respondWithLocalIngestOperation(
      response,
      { state: 'running', kind: 'save-settings', message: '正在保存 Stage 3 博主名单' },
      () => localIngestSettingsService.saveAllowlist(body.allowlist),
      (settings) => ({ saved: true, allowlistCount: settings.allowlist.length })
    );
  }
);

router.post(
  '/admin/local-ingest/recycle-bin-smoke-test',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  async (_request, response) => {
    await respondWithLocalIngestOperation(
      response,
      { state: 'running', kind: 'recycle-test', message: '正在测试 Windows 回收站' },
      async () => {
        const settings = localIngestSettingsService.get();
        return recycleBinAdapter.smokeTest(settings.processingRoot);
      },
      (result) => ({ recycled: result.recycled })
    );
  }
);

router.get(
  '/admin/local-ingest/jobs',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const query = localIngestJobQuerySchema.parse(request.query);
    const operation = currentLocalIngestOperation();
    response.json(localIngestService.listJobDashboard({
      ...query,
      status: query.status as LocalIngestJobFilter | undefined,
      currentCreatorId: operation.run?.currentJob?.creatorId ?? null
    }));
  }
);

router.get(
  '/admin/local-ingest/inbox-creators',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  async (_request, response) => {
    await respondWithLocalIngestOperation(
      response,
      { state: 'running', kind: 'discover-creators', message: '正在读取待入库博主' },
      () => localIngestService.discoverInboxCreators(),
      (result) => ({
        matchedCreatorCount: result.summary.matchedCreatorCount,
        archiveCount: result.summary.archiveCount,
        unmappedDirectoryCount: result.summary.unmappedDirectoryCount,
        ambiguousDirectoryCount: result.summary.ambiguousDirectoryCount
      })
    );
  }
);

router.post(
  '/admin/local-ingest/scan',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  async (request, response) => {
    localIngestScanBodySchema.parse(request.body ?? {});
    await respondWithLocalIngestOperation(
      response,
      { state: 'scanning', kind: 'scan', message: '正在扫描待入库目录' },
      async () => {
        const {
          jobs: _jobs,
          allowlist: _allowlist,
          ...summary
        } = await localIngestService.scanInboxWithStableRecheck();
        return summary;
      },
      (summary) => summary
    );
  }
);

router.post(
  '/admin/local-ingest/jobs/:id/run',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  async (request, response) => {
    const params = imageIdSchema.parse(request.params);
    await respondWithLocalIngestOperation(
      response,
      {
        state: 'running',
        kind: 'single-job',
        message: '正在启动单项 Stage 3 任务',
        run: {
          total: 1,
          examined: 0,
          settled: 0,
          ingested: 0,
          failed: 0,
          awaitingReview: 0,
          reconciling: 0,
          claimUnavailable: 0,
          unchanged: 0,
          remaining: 1,
          currentJob: null
        }
      },
      async (context) => {
        const job = localIngestService.getJob(params.id);
        context.update({
          message: `正在运行 ${job.creatorName}/${job.sourceArchiveName}`,
          run: { currentJob: operationCurrentJob(job) }
        });
        const result = await localIngestService.runJob(params.id);
        context.update({
          run: {
            examined: 1,
            settled: ['ingested', 'failed', 'awaiting_review'].includes(result.status) ? 1 : 0,
            ingested: result.status === 'ingested' ? 1 : 0,
            failed: result.status === 'failed' ? 1 : 0,
            awaitingReview: result.status === 'awaiting_review' ? 1 : 0,
            reconciling: result.status === 'reconciling' ? 1 : 0,
            unchanged: ['queued', 'running'].includes(result.status) ? 1 : 0,
            remaining: 0,
            currentJob: null
          }
        });
        return result;
      },
      (result) => ({ jobId: result.id, status: result.status, phase: result.phase })
    );
  }
);

router.post(
  '/admin/local-ingest/jobs/:id/retry-cleanup',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  async (request, response) => {
    const params = imageIdSchema.parse(request.params);
    await respondWithLocalIngestOperation(
      response,
      {
        state: 'running',
        kind: 'cleanup',
        message: '正在启动 Stage 3 回收清理',
        run: {
          total: 1,
          examined: 0,
          settled: 0,
          ingested: 0,
          failed: 0,
          awaitingReview: 0,
          reconciling: 0,
          claimUnavailable: 0,
          unchanged: 0,
          remaining: 1,
          currentJob: null
        }
      },
      async (context) => {
        const job = localIngestService.getJob(params.id);
        context.update({
          message: `正在重试 ${job.creatorName}/${job.sourceArchiveName} 的回收清理`,
          run: { currentJob: operationCurrentJob(job) }
        });
        const result = await localIngestService.retryCleanup(params.id);
        context.update({
          run: {
            examined: 1,
            settled: 1,
            ingested: result.status === 'ingested' ? 1 : 0,
            failed: result.cleanupStatus === 'failed' ? 1 : 0,
            remaining: 0,
            currentJob: null
          }
        });
        return result;
      },
      (result) => ({ jobId: result.id, status: result.status, cleanupStatus: result.cleanupStatus })
    );
  }
);

router.post(
  '/admin/local-ingest/run',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  async (request, response) => {
    const body = localIngestRunBodySchema.parse(request.body ?? {});
    await respondWithLocalIngestOperation(
      response,
      {
        state: 'running',
        kind: 'batch',
        message: '正在运行 Stage 3 批次',
        run: {
          total: 0,
          examined: 0,
          settled: 0,
          ingested: 0,
          failed: 0,
          awaitingReview: 0,
          reconciling: 0,
          claimUnavailable: 0,
          unchanged: 0,
          remaining: 0,
          currentJob: null
        }
      },
      async (context) => {
        const results = await localIngestService.runBatch(
          { jobIds: body.jobIds, creatorIds: body.creatorIds },
          {
            onProgress: (progress) => context.update({
              message: progress.currentJob
                ? `正在运行 ${progress.currentJob.creatorName}/${progress.currentJob.sourceArchiveName}`
                : '正在运行 Stage 3 批次',
              run: {
                ...progress,
                currentJob: progress.currentJob ? operationCurrentJob(progress.currentJob) : null
              }
            })
          }
        );
        const { items: _items, ...summary } = results;
        return summary;
      },
      (summary) => summary
    );
  }
);

router.get(
  '/admin/archive-catalog/bridge-token',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (_request, response) => {
    const service = new ArchiveBridgeService();
    response.json({ configured: service.isConfigured() });
  }
);

router.post(
  '/admin/archive-catalog/bridge-token',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  (_request, response) => {
    const service = new ArchiveBridgeService();
    response.json({ token: service.rotateToken() });
  }
);

router.get(
  '/admin/archive-catalog/creators/:id',
  requireCapability('canAccessSettings', 'Admin access is required.'),
  (request, response) => {
    const params = imageIdSchema.parse(request.params);
    const service = new ArchiveCatalogQueryService();
    const creator = service.getCreatorDetail(params.id);
    if (!creator) {
      response.status(404).json({ message: 'Archive catalog creator not found' });
      return;
    }
    response.json(creator);
  }
);

router.patch('/posts/:id/content-rating', requireCapability('canManageLibrary', 'Admin access is required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const body = patchPostContentRatingBodySchema.parse(request.body);
  const result = galleryService.updatePostContentRating(params.id, body.contentRating);

  if (!result) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  response.json({ ok: true, ...result });
});

router.get(['/posts/:id/collections', '/images/:id/collections'], requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.getImageCollections(params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  response.json(payload);
});

router.post(['/posts/:id/save', '/images/:id/save'], requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.saveImage(params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Image not found' });
    return;
  }

  response.json({
    ok: true,
    ...payload
  });
});

router.delete(['/posts/:id/save', '/images/:id/save'], requireCapability('canUseSharedCollections', 'Authentication required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.unsaveImage(params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Image not found' });
    return;
  }

  response.json({
    ok: true,
    ...payload
  });
});

router.post(['/posts/:id/like', '/images/:id/like'], requireCapability('canUseSharedLikes', 'Authentication required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.likeImage(params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Image not found' });
    return;
  }

  response.json({
    ok: true,
    ...payload
  });
});

router.delete(['/posts/:id/like', '/images/:id/like'], requireCapability('canUseSharedLikes', 'Authentication required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.unlikeImage(params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Image not found' });
    return;
  }

  response.json({
    ok: true,
    ...payload
  });
});

router.post(['/posts/:id/trash', '/images/:id/trash'], requireCapability('canDeleteMedia', 'Admin access is required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.trashImage(params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  response.json({
    ok: true,
    ...payload
  });
});

router.post(['/posts/:id/restore', '/images/:id/restore'], requireCapability('canDeleteMedia', 'Admin access is required.'), (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const payload = galleryService.restoreImage(params.id, { isLegacyImageAlias });

  if (!payload) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  response.json({
    ok: true,
    ...payload
  });
});

router.delete(['/posts/:id', '/images/:id'], requireCapability('canDeleteMedia', 'Admin access is required.'), async (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const isLegacyImageAlias = request.path.includes('/images/');
  const deleted = await galleryService.deleteImage(params.id, { isLegacyImageAlias });

  if (!deleted) {
    response.status(404).json({ message: 'Post not found' });
    return;
  }

  response.json({
    ok: true,
    ...deleted
  });
});

router.get('/originals/:id', (request, response) => {
  const params = imageIdSchema.parse(request.params);
  const query = originalMediaQuerySchema.parse(request.query);
  const originalMedia = galleryService.getOriginalMediaFile(params.id);

  if (!originalMedia) {
    response.status(404).json({ message: 'Original media not found' });
    return;
  }

  if (query.download) {
    response.download(originalMedia.path, originalMedia.filename);
    return;
  }

  response.sendFile(originalMedia.path);
});

const adminMutationRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many administrative requests. Please try again in a minute.'
});

const requireNoScanInProgress = (_request: express.Request, response: express.Response, next: express.NextFunction) => {
  if (scannerService.getProgress().isScanning) {
    response.status(429).json({
      message: 'A scan or rebuild is already in progress.'
    });
    return;
  }
  next();
};

router.post(
  '/admin/rescan',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  adminMutationRateLimiter,
  requireNoScanInProgress,
  async (_request, response) => {
  try {
    if (scannerService.isLibraryRebuildRequired()) {
      response.status(409).json({
        message: LIBRARY_REBUILD_REQUIRED_MESSAGE
      });
      return;
    }

    const lastScan = await scannerService.scanAll('manual');
    await watcherService.start();
    let archiveCatalog: ArchiveCatalogPipelineResult;
    try {
      archiveCatalog = await new ArchiveCatalogPipelineService().refreshAfterGalleryScan();
    } catch (error) {
      logRequestFailure(response, error);
      response.status(500).json({
        code: 'CATALOG_REFRESH_FAILED',
        message: '图库媒体扫描已完成，但账本核对或缺失任务刷新失败。',
        requestId: response.locals.requestId,
        lastScan
      });
      return;
    }
    response.json({
      ok: true,
      lastScan,
      archiveCatalog
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to run a manual scan and refresh the archive catalog.';
    if (/rebuild required/i.test(message)) response.status(409).json({ code: 'LIBRARY_REBUILD_REQUIRED', message: LIBRARY_REBUILD_REQUIRED_MESSAGE });
    else sendUnexpectedError(response, error);
  }
});

router.post(
  '/admin/rebuild-index',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  adminMutationRateLimiter,
  requireNoScanInProgress,
  async (_request, response) => {
  maintenanceRepository.assertLibraryIndexResetAllowed();
  await watcherService.stop();

  try {
    const lastScan = await scannerService.rebuildLibraryIndex('rebuild');
    response.json({
      ok: true,
      lastScan
    });
  } finally {
    await watcherService.start();
  }
});

router.post(
  '/admin/rebuild-thumbnails',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  adminMutationRateLimiter,
  requireNoScanInProgress,
  async (_request, response) => {
  if (scannerService.isLibraryRebuildRequired()) {
    response.status(409).json({
      message: LIBRARY_REBUILD_REQUIRED_MESSAGE
    });
    return;
  }

  await watcherService.stop();

  try {
    const lastScan = await scannerService.rebuildThumbnails('rebuild-thumbnails');
    response.json({
      ok: true,
      lastScan
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to regenerate thumbnails.';
    if (/rebuild required/i.test(message)) response.status(409).json({ code: 'LIBRARY_REBUILD_REQUIRED', message: LIBRARY_REBUILD_REQUIRED_MESSAGE });
    else sendUnexpectedError(response, error);
  } finally {
    await watcherService.start();
  }
});

router.get('/admin/places/status', requireCapability('canAccessSettings', 'Admin access is required.'), (_request, response) => {
  response.json(galleryService.getPlacesStatus());
});

router.post(
  '/admin/places/geodata/prepare',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  adminMutationRateLimiter,
  async (_request, response) => {
  try {
    response.json({
      ok: true,
      status: await galleryService.preparePlacesGeodata()
    });
  } catch (error) {
    sendUnexpectedError(response, error);
  }
});

router.post(
  '/admin/places/rebuild',
  requireCapability('canManageLibrary', 'Admin access is required.'),
  adminMutationRateLimiter,
  (_request, response) => {
  response.json({
    ok: true,
    ...galleryService.rebuildPlaces()
  });
});

router.post('/admin/settings/carousels-as-folders', requireCapability('canAccessSettings', 'Admin access is required.'), adminMutationRateLimiter, (request, response) => {
  const payloadSchema = z.object({
    treatCarouselsAsFolders: z.boolean()
  });

  const body = payloadSchema.parse(request.body);

  try {
    const stats = galleryService.setTreatCarouselsAsFolders(body.treatCarouselsAsFolders);
    response.json(stats);
  } catch (error) {
    sendUnexpectedError(response, error);
  }
});

router.post('/admin/settings/carousels-migration-decision', requireCapability('canAccessSettings', 'Admin access is required.'), adminMutationRateLimiter, (request, response) => {
  const payloadSchema = z.object({
    decision: z.enum(['restore', 'carousels'])
  });

  const body = payloadSchema.parse(request.body);

  try {
    const stats = galleryService.setCarouselsMigrationDecision(body.decision);
    response.json(stats);
  } catch (error) {
    sendUnexpectedError(response, error);
  }
});

router.get('/admin/stats', requireCapability('canAccessSettings', 'Admin access is required.'), (_request, response) => {
  response.json(galleryService.getStats());
});

export { router as apiRouter };
