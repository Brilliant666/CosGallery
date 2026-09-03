import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';

import { appConfig } from '../config/env.js';
import { databaseManager } from '../db/database.js';
import { normalizeCreatorIdentity } from './creator-rating-import-service.js';
import { ArchiveCatalogPipelineService } from './archive-catalog-pipeline-service.js';
import {
  localIngestSettingsService,
  type LocalIngestSettingsService,
  type LocalIngestSettingsView
} from './local-ingest-settings-service.js';
import { recycleBinAdapter, type RecycleBinAdapter } from './recycle-bin-adapter.js';
import {
  assertLocalIngestRootPolicy,
  assertPathInsideLocalIngestRoot,
  canonicalizeLocalIngestPath,
  LocalIngestPathError
} from '../utils/local-ingest-paths.js';
import { ProcessTimeoutError, runProcessWithTimeout } from '../utils/run-process.js';

const SOURCE_ARCHIVE_EXTENSIONS = new Set(['.7z', '.7zz', '.zip']);
const NESTED_ARCHIVE_EXTENSIONS = new Set(['.7z', '.7zz', '.zip', '.rar', '.tar', '.gz', '.bz2', '.xz']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv']);
const ADVERTISEMENT_EXTENSIONS = new Set(['.txt', '.html', '.htm']);
const TEMPORARY_SUFFIXES = ['.crdownload', '.tmp', '.downloading', '.part'];
const EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000;

export type LocalIngestStatus = 'queued' | 'running' | 'awaiting_review' | 'reconciling' | 'ingested' | 'failed';
export type LocalIngestPhase =
  | 'discovered' | 'waiting_stable' | 'mapping' | 'testing_outer' | 'extracting_outer'
  | 'detecting_inner' | 'renaming_inner' | 'testing_inner' | 'extracting_inner'
  | 'validating' | 'awaiting_commit' | 'committing' | 'rescanning' | 'reconciling'
  | 'cleanup' | 'done';
export type LocalIngestValidationStatus = 'unknown' | 'passed' | 'warning' | 'failed';
export type LocalIngestCleanupStatus = 'not_ready' | 'pending' | 'recycling' | 'recycled' | 'failed';

type LocalIngestJobRow = {
  id: number;
  archive_download_task_id: number | null;
  source_work_id: number | null;
  creator_id: number;
  source_archive_path: string;
  source_archive_name: string;
  source_archive_size: number;
  source_archive_mtime: number;
  source_archive_sha256: string;
  status: LocalIngestStatus;
  phase: LocalIngestPhase;
  validation_status: LocalIngestValidationStatus;
  cleanup_status: LocalIngestCleanupStatus;
  processing_path: string | null;
  target_path: string | null;
  attempt_count: number;
  error_code: string | null;
  error_detail: string | null;
  summary_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  claim_heartbeat_at: string | null;
};

type LocalIngestObservationRow = {
  source_archive_path: string;
  creator_id: number;
  source_archive_name: string;
  observed_size: number;
  observed_mtime: number;
  stable_since: string;
  last_observed_at: string;
};

type MappingRow = {
  archive_download_task_id: number;
  source_work_id: number;
  work_id: number;
  creator_id: number;
  creator_name: string;
  collection_id: number;
  source_collection_id: string;
  source_order: number | null;
  source_order_label: string | null;
  source_title: string;
  raw_title: string | null;
  media_summary: string | null;
  target_filename: string;
};

type CreatorRow = { id: number; canonical_name: string };

type InboxJobRow = {
  creator_id: number;
  source_archive_path: string;
  status: 'queued' | 'failed' | 'awaiting_review';
};

type InboxJobCounts = {
  queuedJobCount: number;
  failedJobCount: number;
  awaitingReviewJobCount: number;
};

type SevenZipResult = { code: number | null; stdout: string; stderr: string };

export type LocalIngestRuntimeDependencies = {
  now?: () => Date;
  hashFile?: (filePath: string) => Promise<string>;
  runCommand?: (command: string, args: string[], timeoutMs: number) => Promise<SevenZipResult>;
  extractionTimeoutMs?: number;
  claimLeaseMs?: number;
  expectedGalleryRoot?: string;
};

type LocalIngestRescanResult = {
  scanRunId: number;
  scanStatus: string;
  scanError: string | null;
};

export async function runCreatorScopedLocalIngestReconciliation(
  database: DatabaseSync,
  libraryRoot: string,
  creatorId: number,
  creatorFolderName: string
): Promise<LocalIngestRescanResult> {
  // ScannerService reads the database when its singleton is constructed.
  // Load it only for a real reconciliation run so importing LocalIngest in
  // tests or build tooling cannot open the configured production database.
  const { scannerService } = await import('./scanner-service.js');
  const scan = await scannerService.scanCosCreators(
    [creatorFolderName],
    'local-ingest',
    { repairUnchangedDerivatives: false, allowDerivativeMigration: false }
  );
  if (!scan) throw new LocalIngestFailure('COSGALLERY_SCAN_FAILED', 'CosGallery did not return a scan result');
  await new ArchiveCatalogPipelineService(database).refreshAfterCreatorGalleryScan({
    galleryRoot: libraryRoot,
    creatorId,
    creatorFolderName
  });
  return {
    scanRunId: scan.id,
    scanStatus: scan.status,
    scanError: scan.error_text
  };
}

export type LocalIngestJob = {
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
  phase: LocalIngestPhase;
  validationStatus: LocalIngestValidationStatus;
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
};

export type LocalIngestDiscoveryResult = {
  allowlist: string[];
  discoveredArchives: number;
  createdJobs: number;
  existingJobs: number;
  waitingStable: number;
  awaitingReview: number;
  ignoredFiles: number;
  jobs: LocalIngestJob[];
};

export type LocalIngestInboxCreatorMappingStatus = 'matched' | 'unmatched' | 'ambiguous';

export type LocalIngestInboxCreatorCandidate = {
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
};

export type LocalIngestInboxCreatorsResult = {
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
};

type ValidationSummary = {
  creator: string;
  sourceWorkId: number;
  archiveDownloadTaskId: number;
  sourceTitle: string;
  rawTitle: string | null;
  sourceArchivePath: string;
  sourceArchiveSha256: string;
  outerFormat: string;
  levelOneOutput: string[];
  innerOriginalName: string;
  innerWorkingName: string;
  imageCount: number;
  videoCount: number;
  totalMediaCount: number;
  totalBytes: number;
  mediaType: 'image' | 'video' | 'mixed';
  advertisementFileCount: number;
  unknownFiles: string[];
  nestedArchives: string[];
  warnings: string[];
  plannedTargetPath: string;
  readyPath: string;
  declaredMediaSummary: string | null;
  declaredImageCount?: number;
  declaredVideoCount?: number;
  declaredTotalBytes?: number;
  declaredVsActualByteDifference?: number;
  localWorkId?: number;
  localCopyRelativePath?: string;
  sourceReconciled?: boolean;
  missingDifferenceCleared?: boolean;
  galleryScanRunId?: number;
  galleryScanStatus?: string;
  galleryIndexedImageCount?: number;
  galleryIndexedVideoCount?: number;
  galleryPostItemCount?: number;
  sourceArchiveRecycled?: boolean;
  processingDirectoryRecycled?: boolean;
};

class LocalIngestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly review = false
  ) {
    super(message);
    this.name = 'LocalIngestFailure';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSecret(value: string, secret: string): string {
  return secret.length > 0 ? value.split(secret).join('[REDACTED]') : value;
}

function safeJsonParse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sanitizeWindowsDirectoryName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!sanitized) throw new LocalIngestFailure('INVALID_TARGET_NAME', 'The mapped work has no usable directory name', true);
  return sanitized.slice(0, 220).replace(/[. ]+$/g, '');
}

function isTemporaryName(filename: string): boolean {
  const lower = filename.toLocaleLowerCase();
  return TEMPORARY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function archiveExtension(filename: string): string {
  return path.extname(filename).toLocaleLowerCase();
}

export function isSupportedSourceArchiveName(filename: string): boolean {
  return !isTemporaryName(filename) && SOURCE_ARCHIVE_EXTENSIONS.has(archiveExtension(filename));
}

function naturalNameCompare(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function filesystemPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function emptyInboxJobCounts(): InboxJobCounts {
  return { queuedJobCount: 0, failedJobCount: 0, awaitingReviewJobCount: 0 };
}

function totalInboxJobCounts(counts: Iterable<InboxJobCounts>): InboxJobCounts {
  const total = emptyInboxJobCounts();
  for (const count of counts) {
    total.queuedJobCount += count.queuedJobCount;
    total.failedJobCount += count.failedJobCount;
    total.awaitingReviewJobCount += count.awaitingReviewJobCount;
  }
  return total;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs.access(targetPath).then(() => true, () => false);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex').toUpperCase();
}

async function listTree(root: string): Promise<Array<{ absolutePath: string; relativePath: string; directory: boolean; symbolic: boolean; size: number }>> {
  const result: Array<{ absolutePath: string; relativePath: string; directory: boolean; symbolic: boolean; size: number }> = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath);
      const stats = await fs.lstat(absolutePath);
      result.push({ absolutePath, relativePath, directory: stats.isDirectory(), symbolic: stats.isSymbolicLink(), size: stats.size });
      if (stats.isDirectory() && !stats.isSymbolicLink()) await visit(absolutePath);
    }
  }
  if (await pathExists(root)) await visit(root);
  return result;
}

async function discoverContentRoot(levelTwoRoot: string): Promise<string> {
  let current = levelTwoRoot;
  for (;;) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const visible = entries.filter((entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store');
    const files = visible.filter((entry) => !entry.isDirectory());
    const directories = visible.filter((entry) => entry.isDirectory());
    if (files.length === 0 && directories.length === 1) {
      current = path.join(current, directories[0].name);
      continue;
    }
    return current;
  }
}

function parseSevenZipEntryPaths(stdout: string): string[] {
  const separatorIndex = stdout.indexOf('----------');
  const body = separatorIndex >= 0 ? stdout.slice(separatorIndex) : stdout;
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Path = '))
    .map((line) => line.slice('Path = '.length).trim())
    .filter(Boolean);
}

export function assertSafeArchiveEntry(entryPath: string): void {
  const normalized = entryPath.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new LocalIngestFailure('UNSAFE_ARCHIVE_PATH', `Archive entry uses an unsafe path: ${entryPath}`, true);
  }
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<SevenZipResult> {
  return runProcessWithTimeout(command, args, timeoutMs);
}

function classifySevenZipFailure(output: string): LocalIngestFailure {
  if (/wrong password|data error in encrypted file|password is incorrect/i.test(output)) {
    return new LocalIngestFailure('PASSWORD_INVALID', 'The configured archive password was rejected');
  }
  if (/enter password|password is required/i.test(output)) {
    return new LocalIngestFailure('PASSWORD_REQUIRED', 'The archive requires a password');
  }
  if (/unsupported method/i.test(output)) {
    return new LocalIngestFailure('UNSUPPORTED_ARCHIVE', 'The archive format is not supported', true);
  }
  return new LocalIngestFailure('ARCHIVE_CORRUPT', 'Archive integrity validation failed');
}

async function validateImage(filePath: string): Promise<void> {
  try {
    const metadata = await sharp(filePath, { failOn: 'error' }).metadata();
    if (!metadata.format || !metadata.width || !metadata.height) throw new Error('missing image metadata');
  } catch {
    throw new LocalIngestFailure('MEDIA_UNREADABLE', `Image cannot be decoded: ${path.basename(filePath)}`, true);
  }
}

async function validateVideo(filePath: string): Promise<void> {
  const result = await runCommand(
    appConfig.ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    60_000
  ).catch(() => null);
  if (!result || result.code !== 0) {
    throw new LocalIngestFailure('MEDIA_UNREADABLE', `Video cannot be probed: ${path.basename(filePath)}`, true);
  }
}

function mapJob(row: LocalIngestJobRow & { creator_name?: string }): LocalIngestJob {
  return {
    id: row.id,
    archiveDownloadTaskId: row.archive_download_task_id,
    sourceWorkId: row.source_work_id,
    creatorId: row.creator_id,
    creatorName: row.creator_name ?? '',
    sourceArchivePath: row.source_archive_path,
    sourceArchiveName: row.source_archive_name,
    sourceArchiveSize: row.source_archive_size,
    sourceArchiveMtime: row.source_archive_mtime,
    sourceArchiveSha256: row.source_archive_sha256,
    status: row.status,
    phase: row.phase,
    validationStatus: row.validation_status,
    cleanupStatus: row.cleanup_status,
    processingPath: row.processing_path,
    targetPath: row.target_path,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    summary: safeJsonParse(row.summary_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

export class LocalIngestService {
  private readonly databaseOverride: DatabaseSync | undefined;
  private readonly now: () => Date;
  private readonly hashFile: (filePath: string) => Promise<string>;
  private readonly commandRunner: (command: string, args: string[], timeoutMs: number) => Promise<SevenZipResult>;
  private readonly extractionTimeoutMs: number;
  private readonly claimLeaseMs: number;
  private readonly expectedGalleryRoot: string;
  private readonly inFlightJobs = new Map<number, Promise<LocalIngestJob>>();

  constructor(
    database: DatabaseSync | undefined = undefined,
    private readonly settingsService: LocalIngestSettingsService = localIngestSettingsService,
    private readonly recycleAdapter: RecycleBinAdapter = recycleBinAdapter,
    private readonly rescanAndReconcile: (
      database: DatabaseSync,
      libraryRoot: string,
      creatorId: number,
      creatorFolderName: string
    ) => Promise<LocalIngestRescanResult | void> = runCreatorScopedLocalIngestReconciliation,
    dependencies: LocalIngestRuntimeDependencies = {}
  ) {
    this.databaseOverride = database;
    this.now = dependencies.now ?? (() => new Date());
    this.hashFile = dependencies.hashFile ?? sha256File;
    this.commandRunner = dependencies.runCommand ?? runCommand;
    this.extractionTimeoutMs = dependencies.extractionTimeoutMs ?? EXTRACTION_TIMEOUT_MS;
    this.claimLeaseMs = dependencies.claimLeaseMs ?? 2 * 60 * 1000;
    this.expectedGalleryRoot = dependencies.expectedGalleryRoot ?? appConfig.galleryRoot;
  }

  private get database(): DatabaseSync {
    // Keep the application singleton import side-effect free. This matters in
    // tests and build tooling: merely importing the service must never open or
    // migrate the configured production database.
    return this.databaseOverride ?? databaseManager.connection;
  }

  private jobSelect(): string {
    return `SELECT jobs.*, creators.canonical_name AS creator_name
            FROM local_ingest_jobs jobs
            JOIN archive_catalog_creators creators ON creators.id = jobs.creator_id`;
  }

  listJobs(options: { status?: LocalIngestStatus; creatorId?: number; limit?: number } = {}): LocalIngestJob[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.status) { clauses.push('jobs.status = ?'); parameters.push(options.status); }
    if (options.creatorId) { clauses.push('jobs.creator_id = ?'); parameters.push(options.creatorId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    return (this.database.prepare(`${this.jobSelect()} ${where} ORDER BY jobs.id DESC LIMIT ?`).all(...parameters, limit) as Array<LocalIngestJobRow & { creator_name: string }>).map(mapJob);
  }

  getJob(id: number): LocalIngestJob {
    const row = this.database.prepare(`${this.jobSelect()} WHERE jobs.id = ?`).get(id) as (LocalIngestJobRow & { creator_name: string }) | undefined;
    if (!row) throw new Error(`Local ingest job ${id} was not found`);
    return mapJob(row);
  }

  async discoverInboxCreators(): Promise<LocalIngestInboxCreatorsResult> {
    const settings = await this.checkedSettings();
    const activeJobs = this.database.prepare(
      `SELECT creator_id, source_archive_path, status
       FROM local_ingest_jobs
       WHERE status IN ('queued', 'failed', 'awaiting_review')`
    ).all() as InboxJobRow[];
    const jobCountsByDirectory = new Map<string, Map<number, InboxJobCounts>>();
    const resolvedInboxRoot = path.resolve(settings.inboxRoot);
    for (const job of activeJobs) {
      const relative = path.relative(resolvedInboxRoot, path.resolve(job.source_archive_path));
      const segments = relative.split(path.sep).filter(Boolean);
      if (segments.length !== 2 || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const key = filesystemPathKey(path.join(resolvedInboxRoot, segments[0]));
      const byCreator = jobCountsByDirectory.get(key) ?? new Map<number, InboxJobCounts>();
      const counts = byCreator.get(job.creator_id) ?? emptyInboxJobCounts();
      if (job.status === 'queued') counts.queuedJobCount += 1;
      if (job.status === 'failed') counts.failedJobCount += 1;
      if (job.status === 'awaiting_review') counts.awaitingReviewJobCount += 1;
      byCreator.set(job.creator_id, counts);
      jobCountsByDirectory.set(key, byCreator);
    }

    const directoryEntries = (await fs.readdir(settings.inboxRoot, { withFileTypes: true }))
      .sort((left, right) => naturalNameCompare(left.name, right.name));
    const matchedByCreator = new Map<number, LocalIngestInboxCreatorCandidate>();
    const unmapped: LocalIngestInboxCreatorCandidate[] = [];
    let candidateDirectoryCount = 0;
    let matchedDirectoryCount = 0;
    let archiveCount = 0;
    let queuedJobCount = 0;
    let failedJobCount = 0;
    let awaitingReviewJobCount = 0;

    for (const entry of directoryEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directoryPath = path.join(settings.inboxRoot, entry.name);
      try {
        await this.assertInside(
          settings.inboxRoot,
          directoryPath,
          'SOURCE_PATH_OUTSIDE_ALLOWED_ROOT',
          'Creator inbox directory',
          { directChild: true }
        );
      } catch {
        continue;
      }
      const directoryStats = await fs.lstat(directoryPath);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) continue;

      let directoryArchiveCount = 0;
      for (const child of await fs.readdir(directoryPath, { withFileTypes: true })) {
        if (!child.isFile() || child.isSymbolicLink() || !isSupportedSourceArchiveName(child.name)) continue;
        const childStats = await fs.lstat(path.join(directoryPath, child.name));
        if (childStats.isFile() && !childStats.isSymbolicLink()) directoryArchiveCount += 1;
      }
      const creatorMatches = this.findCreatorByFolder(entry.name);
      const jobsForDirectory = jobCountsByDirectory.get(filesystemPathKey(directoryPath));
      const jobCounts = creatorMatches.length === 1
        ? jobsForDirectory?.get(creatorMatches[0].id) ?? emptyInboxJobCounts()
        : totalInboxJobCounts(jobsForDirectory?.values() ?? []);
      const unfinishedJobCount = jobCounts.queuedJobCount
        + jobCounts.failedJobCount
        + jobCounts.awaitingReviewJobCount;
      if (directoryArchiveCount === 0 && unfinishedJobCount === 0) continue;

      candidateDirectoryCount += 1;
      archiveCount += directoryArchiveCount;
      queuedJobCount += jobCounts.queuedJobCount;
      failedJobCount += jobCounts.failedJobCount;
      awaitingReviewJobCount += jobCounts.awaitingReviewJobCount;
      if (creatorMatches.length !== 1) {
        const mappingStatus: LocalIngestInboxCreatorMappingStatus = creatorMatches.length === 0
          ? 'unmatched'
          : 'ambiguous';
        unmapped.push({
          folderName: entry.name,
          folderNames: [entry.name],
          creatorId: null,
          canonicalName: null,
          mappingStatus,
          mappingReason: mappingStatus === 'unmatched'
            ? '未找到匹配的博主或别名'
            : `匹配到 ${creatorMatches.length} 位博主，无法唯一确认`,
          archiveCount: directoryArchiveCount,
          ...jobCounts
        });
        continue;
      }

      matchedDirectoryCount += 1;
      const creator = creatorMatches[0];
      const existing = matchedByCreator.get(creator.id);
      if (existing) {
        existing.folderNames.push(entry.name);
        existing.archiveCount += directoryArchiveCount;
        existing.queuedJobCount += jobCounts.queuedJobCount;
        existing.failedJobCount += jobCounts.failedJobCount;
        existing.awaitingReviewJobCount += jobCounts.awaitingReviewJobCount;
      } else {
        matchedByCreator.set(creator.id, {
          folderName: entry.name,
          folderNames: [entry.name],
          creatorId: creator.id,
          canonicalName: creator.canonical_name,
          mappingStatus: 'matched',
          mappingReason: '已唯一映射到规范博主',
          archiveCount: directoryArchiveCount,
          ...jobCounts
        });
      }
    }

    const detected = [...matchedByCreator.values()]
      .sort((left, right) => naturalNameCompare(left.folderName, right.folderName));
    return {
      inboxRoot: settings.inboxRoot,
      detected,
      unmapped: unmapped.sort((left, right) => naturalNameCompare(left.folderName, right.folderName)),
      summary: {
        directoryCount: candidateDirectoryCount,
        matchedDirectoryCount,
        matchedCreatorCount: detected.length,
        unmappedDirectoryCount: unmapped.filter((entry) => entry.mappingStatus === 'unmatched').length,
        ambiguousDirectoryCount: unmapped.filter((entry) => entry.mappingStatus === 'ambiguous').length,
        archiveCount,
        queuedJobCount,
        failedJobCount,
        awaitingReviewJobCount
      }
    };
  }

  private getJobRow(id: number): LocalIngestJobRow {
    const row = this.database.prepare('SELECT * FROM local_ingest_jobs WHERE id = ?').get(id) as LocalIngestJobRow | undefined;
    if (!row) throw new Error(`Local ingest job ${id} was not found`);
    return row;
  }

  private updateJob(id: number, patch: Partial<{
    status: LocalIngestStatus;
    phase: LocalIngestPhase;
    validationStatus: LocalIngestValidationStatus;
    cleanupStatus: LocalIngestCleanupStatus;
    processingPath: string | null;
    targetPath: string | null;
    errorCode: string | null;
    errorDetail: string | null;
    summaryJson: string | null;
    completedAt: string | null;
    incrementAttempt: boolean;
  }>): void {
    const columns: string[] = ['updated_at = ?'];
    const parameters: Array<string | number | null> = [nowIso()];
    const add = (column: string, value: string | number | null): void => { columns.push(`${column} = ?`); parameters.push(value); };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.phase !== undefined) add('phase', patch.phase);
    if (patch.validationStatus !== undefined) add('validation_status', patch.validationStatus);
    if (patch.cleanupStatus !== undefined) add('cleanup_status', patch.cleanupStatus);
    if (patch.processingPath !== undefined) add('processing_path', patch.processingPath);
    if (patch.targetPath !== undefined) add('target_path', patch.targetPath);
    if (patch.errorCode !== undefined) add('error_code', patch.errorCode);
    if (patch.errorDetail !== undefined) add('error_detail', patch.errorDetail);
    if (patch.summaryJson !== undefined) add('summary_json', patch.summaryJson);
    if (patch.completedAt !== undefined) add('completed_at', patch.completedAt);
    if (patch.incrementAttempt) columns.push('attempt_count = attempt_count + 1');
    parameters.push(id);
    this.database.prepare(`UPDATE local_ingest_jobs SET ${columns.join(', ')} WHERE id = ?`).run(...parameters);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async checkedSettings(): Promise<LocalIngestSettingsView> {
    const settings = this.settingsService.get();
    try {
      await assertLocalIngestRootPolicy(settings, this.expectedGalleryRoot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Local ingest root policy validation failed';
      throw new LocalIngestFailure('ROOT_PATH_POLICY_VIOLATION', detail, true);
    }
    return settings;
  }

  private observationFor(sourcePath: string): LocalIngestObservationRow | undefined {
    return this.database.prepare(
      'SELECT * FROM local_ingest_file_observations WHERE source_archive_path = ?'
    ).get(sourcePath) as LocalIngestObservationRow | undefined;
  }

  private observeFile(
    creatorId: number,
    sourcePath: string,
    sourceName: string,
    size: number,
    mtime: number,
    resetStableSince: boolean
  ): void {
    const timestamp = this.timestamp();
    const previous = this.observationFor(sourcePath);
    const stableSince = resetStableSince || !previous ? timestamp : previous.stable_since;
    this.database.prepare(
      `INSERT INTO local_ingest_file_observations (
         source_archive_path, creator_id, source_archive_name, observed_size,
         observed_mtime, stable_since, last_observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_archive_path) DO UPDATE SET
         creator_id = excluded.creator_id,
         source_archive_name = excluded.source_archive_name,
         observed_size = excluded.observed_size,
         observed_mtime = excluded.observed_mtime,
         stable_since = excluded.stable_since,
         last_observed_at = excluded.last_observed_at`
    ).run(sourcePath, creatorId, sourceName, size, mtime, stableSince, timestamp);
  }

  private clearObservation(sourcePath: string): void {
    this.database.prepare(
      'DELETE FROM local_ingest_file_observations WHERE source_archive_path = ?'
    ).run(sourcePath);
  }

  private clearMissingObservations(creatorId: number, creatorDirectory: string, presentPaths: Set<string>): void {
    const rows = this.database.prepare(
      'SELECT source_archive_path FROM local_ingest_file_observations WHERE creator_id = ?'
    ).all(creatorId) as Array<{ source_archive_path: string }>;
    const comparedDirectory = process.platform === 'win32'
      ? path.resolve(creatorDirectory).toLocaleLowerCase()
      : path.resolve(creatorDirectory);
    for (const row of rows) {
      const comparedParent = process.platform === 'win32'
        ? path.dirname(path.resolve(row.source_archive_path)).toLocaleLowerCase()
        : path.dirname(path.resolve(row.source_archive_path));
      const comparedSource = process.platform === 'win32'
        ? path.resolve(row.source_archive_path).toLocaleLowerCase()
        : path.resolve(row.source_archive_path);
      if (comparedParent === comparedDirectory && !presentPaths.has(comparedSource)) {
        this.clearObservation(row.source_archive_path);
      }
    }
  }

  private async hasRelatedTemporaryFile(creatorDirectory: string, archiveName: string): Promise<boolean> {
    const stem = archiveName.slice(0, -path.extname(archiveName).length).toLocaleLowerCase();
    const entries = await fs.readdir(creatorDirectory, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && isTemporaryName(entry.name) && entry.name.toLocaleLowerCase().startsWith(stem));
  }

  private tryClaim(id: number): string | null {
    const token = randomUUID();
    const timestamp = this.timestamp();
    const cutoff = new Date(this.now().getTime() - this.claimLeaseMs).toISOString();
    const claimed = this.database.prepare(
      `UPDATE local_ingest_jobs
       SET claim_token = ?, claimed_at = ?, claim_heartbeat_at = ?, updated_at = ?
       WHERE id = ?
         AND (
           claim_token IS NULL
           OR claim_heartbeat_at IS NULL
           OR claim_heartbeat_at < ?
         )`
    ).run(token, timestamp, timestamp, timestamp, id, cutoff);
    return claimed.changes === 1 ? token : null;
  }

  private heartbeatClaim(id: number, token: string): void {
    const timestamp = this.timestamp();
    this.database.prepare(
      `UPDATE local_ingest_jobs
       SET claim_heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND claim_token = ?`
    ).run(timestamp, timestamp, id, token);
  }

  private releaseClaim(id: number, token: string): void {
    this.database.prepare(
      `UPDATE local_ingest_jobs
       SET claim_token = NULL, claimed_at = NULL, claim_heartbeat_at = NULL, updated_at = ?
       WHERE id = ? AND claim_token = ?`
    ).run(this.timestamp(), id, token);
  }

  private runWithClaim(id: number, executor: () => Promise<LocalIngestJob>): Promise<LocalIngestJob> {
    const existing = this.inFlightJobs.get(id);
    if (existing) return existing;
    const execution = (async () => {
      const token = this.tryClaim(id);
      if (!token) return this.getJob(id);
      const heartbeatEvery = Math.max(250, Math.min(10_000, Math.floor(this.claimLeaseMs / 3)));
      const heartbeat = setInterval(() => {
        try {
          this.heartbeatClaim(id, token);
        } catch {
          // The active operation remains the only in-process executor. A stale
          // lease is recovered explicitly on the next process startup.
        }
      }, heartbeatEvery);
      heartbeat.unref();
      try {
        return await executor();
      } finally {
        clearInterval(heartbeat);
        this.releaseClaim(id, token);
      }
    })();
    this.inFlightJobs.set(id, execution);
    void execution.finally(() => {
      if (this.inFlightJobs.get(id) === execution) this.inFlightJobs.delete(id);
    }).catch(() => undefined);
    return execution;
  }

  async recoverInterruptedJobs(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.claimLeaseMs).toISOString();
    const timestamp = this.timestamp();
    const running = this.database.prepare(
      `UPDATE local_ingest_jobs
       SET status = 'failed',
           error_code = 'INTERRUPTED_PROCESS',
           error_detail = 'The previous process stopped before this task completed; it can be continued safely',
           claim_token = NULL,
           claimed_at = NULL,
           claim_heartbeat_at = NULL,
           updated_at = ?
       WHERE status = 'running'
         AND (
           claim_token IS NULL
           OR claim_heartbeat_at IS NULL
           OR claim_heartbeat_at < ?
         )`
    ).run(timestamp, cutoff);
    const reconciling = this.database.prepare(
      `UPDATE local_ingest_jobs
       SET error_code = 'INTERRUPTED_PROCESS',
           error_detail = 'The previous process stopped during reconciliation; reconciliation can be continued safely',
           claim_token = NULL,
           claimed_at = NULL,
           claim_heartbeat_at = NULL,
           updated_at = ?
       WHERE status = 'reconciling'
         AND (
           claim_token IS NULL
           OR claim_heartbeat_at IS NULL
           OR claim_heartbeat_at < ?
         )`
    ).run(timestamp, cutoff);
    const cleanup = this.database.prepare(
      `UPDATE local_ingest_jobs
       SET cleanup_status = 'failed',
           error_code = 'INTERRUPTED_PROCESS',
           error_detail = 'The previous process stopped during recycle-bin cleanup; cleanup can be retried safely',
           claim_token = NULL,
           claimed_at = NULL,
           claim_heartbeat_at = NULL,
           updated_at = ?
       WHERE status = 'ingested'
         AND cleanup_status = 'recycling'
         AND (
           claim_token IS NULL
           OR claim_heartbeat_at IS NULL
           OR claim_heartbeat_at < ?
         )`
    ).run(timestamp, cutoff);
    return Number(running.changes) + Number(reconciling.changes) + Number(cleanup.changes);
  }

  private async assertInside(
    root: string,
    candidate: string,
    code: string,
    label: string,
    options: { allowRoot?: boolean; directChild?: boolean } = {}
  ): Promise<{ root: string; candidate: string; relative: string }> {
    try {
      return await assertPathInsideLocalIngestRoot(root, candidate, { ...options, code, label });
    } catch (error) {
      if (error instanceof LocalIngestPathError) throw new LocalIngestFailure(code, error.message, true);
      throw error;
    }
  }

  private async assertSourcePath(
    job: LocalIngestJobRow,
    mapping: MappingRow,
    settings: LocalIngestSettingsView
  ): Promise<void> {
    const checked = await this.assertInside(
      settings.inboxRoot,
      job.source_archive_path,
      'SOURCE_PATH_OUTSIDE_ALLOWED_ROOT',
      'Source archive'
    );
    const segments = checked.relative.split(path.sep).filter(Boolean);
    if (segments.length !== 2 || segments[1].toLocaleLowerCase() !== job.source_archive_name.toLocaleLowerCase()) {
      throw new LocalIngestFailure('SOURCE_PATH_OUTSIDE_ALLOWED_ROOT', 'Source archive is not a direct file in an allowed creator directory', true);
    }
    const creatorMatches = this.findCreatorByFolder(segments[0]);
    if (creatorMatches.length !== 1 || creatorMatches[0].id !== mapping.creator_id) {
      throw new LocalIngestFailure('SOURCE_PATH_CREATOR_MISMATCH', 'The source directory no longer maps to this job creator', true);
    }
    if (!this.resolveAllowedCreatorIds(settings.allowlist).has(mapping.creator_id)) {
      throw new LocalIngestFailure('CREATOR_NOT_ALLOWED', 'The mapped creator is not in the local ingest allowlist', true);
    }
    const stats = await fs.lstat(job.source_archive_path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new LocalIngestFailure('SOURCE_PATH_OUTSIDE_ALLOWED_ROOT', 'Source archive must be a regular non-symbolic file', true);
    }
  }

  private safeCreatorDirectoryName(creatorName: string): string {
    const sanitized = sanitizeWindowsDirectoryName(creatorName);
    if (sanitized !== creatorName.trim()) {
      throw new LocalIngestFailure('INVALID_TARGET_NAME', 'Creator name contains path or reserved filename characters', true);
    }
    return sanitized;
  }

  private findCreatorByFolder(folderName: string): CreatorRow[] {
    const normalized = normalizeCreatorIdentity(folderName);
    return this.database.prepare(
      `SELECT DISTINCT creators.id, creators.canonical_name
       FROM archive_catalog_creators creators
       LEFT JOIN archive_catalog_creator_aliases aliases ON aliases.creator_id = creators.id
       WHERE creators.normalized_name = ? OR aliases.normalized_alias = ?`
    ).all(normalized, normalized) as CreatorRow[];
  }

  private resolveAllowedCreatorIds(allowlist: string[]): Set<number> {
    const creatorIds = new Set<number>();
    for (const name of allowlist) {
      const matches = this.findCreatorByFolder(name);
      if (matches.length === 1) creatorIds.add(matches[0].id);
    }
    return creatorIds;
  }

  private findMapping(creatorId: number, filename: string): MappingRow[] {
    return this.database.prepare(
      `SELECT
         tasks.id AS archive_download_task_id,
         source_works.id AS source_work_id,
         works.id AS work_id,
         works.creator_id,
         creators.canonical_name AS creator_name,
         collections.id AS collection_id,
         collections.source_collection_id,
         source_works.source_order,
         source_works.source_order_label,
         source_works.source_title,
         source_works.raw_title,
         source_works.media_summary,
         tasks.target_filename
       FROM archive_catalog_download_tasks tasks
       JOIN archive_catalog_source_works source_works ON source_works.id = tasks.source_work_id
       JOIN archive_catalog_works works ON works.id = source_works.work_id
       JOIN archive_catalog_creators creators ON creators.id = works.creator_id
       JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
       WHERE works.creator_id = ?
         AND tasks.provider = 'baidu'
         AND source_works.is_active = 1
         AND collections.is_active = 1
         AND lower(tasks.target_filename) = lower(?)`
    ).all(creatorId, filename) as MappingRow[];
  }

  private localWorkExists(sourceWorkId: number): boolean {
    const row = this.database.prepare(
      `SELECT 1 AS present
       FROM archive_catalog_source_works source_works
       JOIN archive_catalog_local_works local_works ON local_works.work_id = source_works.work_id
       JOIN archive_catalog_local_creator_folders local_folders ON local_folders.id = local_works.local_creator_folder_id
       WHERE source_works.id = ? AND local_works.is_active = 1 AND local_folders.is_active = 1
       LIMIT 1`
    ).get(sourceWorkId) as { present: number } | undefined;
    return row?.present === 1;
  }

  async scanInbox(allowlistInput?: string[]): Promise<LocalIngestDiscoveryResult> {
    const settings = await this.checkedSettings();
    const allowlist = [...new Set((allowlistInput ?? settings.allowlist).map((entry) => entry.trim()).filter(Boolean))];
    if (allowlist.length === 0) throw new Error('Local ingest allowlist is empty');
    const result: LocalIngestDiscoveryResult = {
      allowlist,
      discoveredArchives: 0,
      createdJobs: 0,
      existingJobs: 0,
      waitingStable: 0,
      awaitingReview: 0,
      ignoredFiles: 0,
      jobs: []
    };

    const allowedCreatorIds = this.resolveAllowedCreatorIds(allowlist);
    const creatorDirectories: Array<{ creatorDirectory: string; creator: CreatorRow }> = [];
    const inboxEntries = (await fs.readdir(settings.inboxRoot, { withFileTypes: true }))
      .sort((left, right) => naturalNameCompare(left.name, right.name));
    for (const inboxEntry of inboxEntries) {
      if (!inboxEntry.isDirectory() || inboxEntry.isSymbolicLink()) continue;
      const creatorMatches = this.findCreatorByFolder(inboxEntry.name);
      if (creatorMatches.length !== 1 || !allowedCreatorIds.has(creatorMatches[0].id)) continue;
      const creatorDirectory = path.join(settings.inboxRoot, inboxEntry.name);
      await this.assertInside(
        settings.inboxRoot,
        creatorDirectory,
        'SOURCE_PATH_OUTSIDE_ALLOWED_ROOT',
        'Creator inbox directory',
        { directChild: true }
      );
      if (!(await pathExists(creatorDirectory))) continue;
      const creatorDirectoryStats = await fs.lstat(creatorDirectory);
      if (!creatorDirectoryStats.isDirectory() || creatorDirectoryStats.isSymbolicLink()) {
        throw new LocalIngestFailure('SOURCE_PATH_OUTSIDE_ALLOWED_ROOT', 'Creator inbox must be a regular directory, not a link', true);
      }
      creatorDirectories.push({ creatorDirectory, creator: creatorMatches[0] });
    }

    for (const { creatorDirectory, creator } of creatorDirectories) {
      const entries = await fs.readdir(creatorDirectory, { withFileTypes: true });
      const presentArchivePaths = new Set(
        entries
          .filter((entry) => entry.isFile() && isSupportedSourceArchiveName(entry.name))
          .map((entry) => {
            const value = path.resolve(creatorDirectory, entry.name);
            return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
          })
      );
      this.clearMissingObservations(creator.id, creatorDirectory, presentArchivePaths);
      for (const entry of entries) {
        if (!entry.isFile() || !isSupportedSourceArchiveName(entry.name)) {
          result.ignoredFiles += 1;
          continue;
        }
        result.discoveredArchives += 1;
        const sourcePath = path.join(creatorDirectory, entry.name);
        await this.assertInside(
          settings.inboxRoot,
          sourcePath,
          'SOURCE_PATH_OUTSIDE_ALLOWED_ROOT',
          'Source archive'
        );
        const stats = await fs.lstat(sourcePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new LocalIngestFailure('SOURCE_PATH_OUTSIDE_ALLOWED_ROOT', 'Source archive must be a regular non-symbolic file', true);
        }
        const unchangedExisting = this.database.prepare(
          `SELECT id FROM local_ingest_jobs
           WHERE creator_id = ?
             AND source_archive_path = ?
             AND source_archive_size = ?
             AND source_archive_mtime = ?
           ORDER BY id DESC
           LIMIT 1`
        ).get(creator.id, sourcePath, stats.size, stats.mtimeMs) as { id: number } | undefined;
        if (unchangedExisting) {
          this.clearObservation(sourcePath);
          result.existingJobs += 1;
          result.jobs.push(this.getJob(unchangedExisting.id));
          continue;
        }
        const relatedTemporary = await this.hasRelatedTemporaryFile(creatorDirectory, entry.name);
        const observation = this.observationFor(sourcePath);
        const unchanged = Boolean(
          observation
          && observation.creator_id === creator.id
          && observation.observed_size === stats.size
          && observation.observed_mtime === stats.mtimeMs
        );
        const stableSinceMs = observation ? Date.parse(observation.stable_since) : Number.NaN;
        const stableForMs = Number.isFinite(stableSinceMs) ? this.now().getTime() - stableSinceMs : 0;
        if (
          stats.size <= 0
          || relatedTemporary
          || !unchanged
          || stableForMs < settings.fileStableSeconds * 1000
        ) {
          this.observeFile(
            creator.id,
            sourcePath,
            entry.name,
            stats.size,
            stats.mtimeMs,
            !unchanged || relatedTemporary || stats.size <= 0
          );
          result.waitingStable += 1;
          continue;
        }

        const beforeHash = await fs.lstat(sourcePath);
        if (await this.hasRelatedTemporaryFile(creatorDirectory, entry.name)) {
          this.observeFile(creator.id, sourcePath, entry.name, beforeHash.size, beforeHash.mtimeMs, true);
          result.waitingStable += 1;
          continue;
        }
        const hash = await this.hashFile(sourcePath);
        const afterHash = await fs.lstat(sourcePath);
        const temporaryAfterHash = await this.hasRelatedTemporaryFile(creatorDirectory, entry.name);
        if (
          temporaryAfterHash
          || beforeHash.size !== afterHash.size
          || beforeHash.mtimeMs !== afterHash.mtimeMs
          || stats.size !== afterHash.size
          || stats.mtimeMs !== afterHash.mtimeMs
        ) {
          this.observeFile(creator.id, sourcePath, entry.name, afterHash.size, afterHash.mtimeMs, true);
          result.waitingStable += 1;
          continue;
        }
        const mappings = this.findMapping(creator.id, entry.name);
        const existing = mappings.length === 1
          ? this.database.prepare(
            'SELECT id, phase FROM local_ingest_jobs WHERE source_work_id = ? AND source_archive_sha256 = ?'
          ).get(mappings[0].source_work_id, hash) as { id: number; phase: LocalIngestPhase } | undefined
          : this.database.prepare(
            `SELECT id, phase FROM local_ingest_jobs
             WHERE creator_id = ? AND source_archive_path = ? AND source_archive_sha256 = ? AND source_work_id IS NULL`
          ).get(creator.id, sourcePath, hash) as { id: number; phase: LocalIngestPhase } | undefined;
        if (existing) {
          if (existing.phase === 'waiting_stable') {
            this.updateJob(existing.id, { phase: 'discovered', errorCode: null, errorDetail: null });
          }
          this.clearObservation(sourcePath);
          result.existingJobs += 1;
          result.jobs.push(this.getJob(existing.id));
          continue;
        }

        let status: LocalIngestStatus = 'queued';
        let phase: LocalIngestPhase = 'discovered';
        let validationStatus: LocalIngestValidationStatus = 'unknown';
        let errorCode: string | null = null;
        let errorDetail: string | null = null;
        let mapping: MappingRow | null = mappings.length === 1 ? mappings[0] : null;
        let targetPath: string | null = null;
        if (mappings.length !== 1) {
          status = 'awaiting_review';
          phase = 'mapping';
          validationStatus = 'failed';
          errorCode = mappings.length === 0 ? 'MAPPING_NOT_FOUND' : 'MAPPING_AMBIGUOUS';
          errorDetail = mappings.length === 0
            ? 'No exact archive download task matches this creator and filename'
            : 'More than one archive download task matches this creator and filename';
          result.awaitingReview += 1;
        } else {
          mapping = mappings[0];
          const title = mapping.raw_title?.trim() || mapping.source_title.trim();
          const creatorDirectoryName = this.safeCreatorDirectoryName(creator.canonical_name);
          const targetCreatorDirectory = path.join(settings.libraryRoot, creatorDirectoryName);
          await this.assertInside(
            settings.libraryRoot,
            targetCreatorDirectory,
            'TARGET_PATH_OUTSIDE_LIBRARY',
            'Target creator directory',
            { directChild: true }
          );
          targetPath = path.join(targetCreatorDirectory, sanitizeWindowsDirectoryName(title));
          await this.assertInside(settings.libraryRoot, targetPath, 'TARGET_PATH_OUTSIDE_LIBRARY', 'Target directory');
          if (this.localWorkExists(mapping.source_work_id)) {
            status = 'awaiting_review';
            phase = 'mapping';
            validationStatus = 'failed';
            errorCode = 'SOURCE_WORK_ALREADY_LOCAL';
            errorDetail = 'The mapped source work is already associated with an active local work';
            result.awaitingReview += 1;
          } else if (await pathExists(targetPath)) {
            status = 'awaiting_review';
            phase = 'mapping';
            validationStatus = 'failed';
            errorCode = 'TARGET_EXISTS';
            errorDetail = 'The planned target directory already exists';
            result.awaitingReview += 1;
          }
        }

        const timestamp = nowIso();
        const insert = this.database.prepare(
          `INSERT OR IGNORE INTO local_ingest_jobs (
             archive_download_task_id, source_work_id, creator_id,
             source_archive_path, source_archive_name, source_archive_size,
             source_archive_mtime, source_archive_sha256, status, phase,
             validation_status, cleanup_status, target_path, error_code,
             error_detail, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_ready', ?, ?, ?, ?, ?)`
        ).run(
          mapping?.archive_download_task_id ?? null,
          mapping?.source_work_id ?? null,
          creator.id,
          sourcePath,
          entry.name,
          stats.size,
          stats.mtimeMs,
          hash,
          status,
          phase,
          validationStatus,
          targetPath,
          errorCode,
          errorDetail,
          timestamp,
          timestamp
        );
        this.clearObservation(sourcePath);
        if (insert.changes === 1) {
          const id = Number(insert.lastInsertRowid);
          result.createdJobs += 1;
          result.jobs.push(this.getJob(id));
        } else {
          const raced = mapping
            ? this.database.prepare(
              'SELECT id FROM local_ingest_jobs WHERE source_work_id = ? AND source_archive_sha256 = ?'
            ).get(mapping.source_work_id, hash) as { id: number } | undefined
            : this.database.prepare(
              `SELECT id FROM local_ingest_jobs
               WHERE creator_id = ? AND source_archive_path = ? AND source_archive_sha256 = ? AND source_work_id IS NULL`
            ).get(creator.id, sourcePath, hash) as { id: number } | undefined;
          if (!raced) throw new Error('Local ingest job insert was ignored without an idempotent match');
          result.existingJobs += 1;
          result.jobs.push(this.getJob(raced.id));
        }
      }
    }
    return result;
  }

  private mappingForJob(job: LocalIngestJobRow): MappingRow {
    if (job.source_work_id === null || job.archive_download_task_id === null) {
      throw new LocalIngestFailure('MAPPING_NOT_FOUND', 'The ingest job is not mapped to a source work', true);
    }
    const row = this.database.prepare(
      `SELECT
         tasks.id AS archive_download_task_id,
         source_works.id AS source_work_id,
         works.id AS work_id,
         works.creator_id,
         creators.canonical_name AS creator_name,
         collections.id AS collection_id,
         collections.source_collection_id,
         source_works.source_order,
         source_works.source_order_label,
         source_works.source_title,
         source_works.raw_title,
         source_works.media_summary,
         tasks.target_filename
       FROM archive_catalog_source_works source_works
       JOIN archive_catalog_download_tasks tasks ON tasks.id = ? AND tasks.source_work_id = source_works.id
       JOIN archive_catalog_works works ON works.id = source_works.work_id
       JOIN archive_catalog_creators creators ON creators.id = works.creator_id
       JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
       WHERE source_works.id = ? AND works.creator_id = ?`
    ).get(job.archive_download_task_id, job.source_work_id, job.creator_id) as MappingRow | undefined;
    if (!row) throw new LocalIngestFailure('MAPPING_NOT_FOUND', 'The mapped ledger relationship no longer exists', true);
    return row;
  }

  private async runSevenZip(jobId: number, operation: 'list' | 'test' | 'extract', archivePath: string, outputPath?: string): Promise<SevenZipResult> {
    const settings = this.settingsService.get();
    const secret = this.settingsService.getArchivePassword();
    const action = operation === 'list' ? 'l' : operation === 'test' ? 't' : 'x';
    const args = [action, '-y', `-p${secret}`];
    if (operation === 'list') args.push('-slt');
    if (operation === 'extract' && outputPath) args.push(`-o${outputPath}`, '-aoa');
    args.push(archivePath);
    let result: SevenZipResult;
    try {
      result = await this.commandRunner(settings.sevenZipPath, args, this.extractionTimeoutMs);
    } catch (error) {
      if (error instanceof ProcessTimeoutError) {
        throw new LocalIngestFailure('EXTRACTION_TIMEOUT', `Archive operation for job ${jobId} timed out and was terminated`);
      }
      if (error instanceof LocalIngestFailure) throw error;
      throw new LocalIngestFailure('EXTRACTION_TOOL_MISSING', '7-Zip could not be started');
    }
    if (result.code !== 0) {
      throw classifySevenZipFailure(sanitizeSecret(`${result.stdout}\n${result.stderr}`, secret));
    }
    return {
      ...result,
      stdout: sanitizeSecret(result.stdout, secret),
      stderr: sanitizeSecret(result.stderr, secret)
    };
  }

  private async assertArchiveSafe(jobId: number, archivePath: string): Promise<void> {
    const result = await this.runSevenZip(jobId, 'list', archivePath);
    for (const entryPath of parseSevenZipEntryPaths(result.stdout)) assertSafeArchiveEntry(entryPath);
  }

  private async assertExtractedTreeSafe(root: string): Promise<void> {
    for (const entry of await listTree(root)) {
      if (entry.symbolic || !isPathWithin(root, entry.absolutePath)) {
        throw new LocalIngestFailure('UNSAFE_ARCHIVE_PATH', `Extracted entry is unsafe: ${entry.relativePath}`, true);
      }
    }
  }

  private async assertDiskSpace(job: LocalIngestJobRow, processingRoot: string): Promise<void> {
    const stats = await fs.statfs(processingRoot);
    const available = Number(stats.bavail) * Number(stats.bsize);
    const required = Math.max(job.source_archive_size * 3, 1024 * 1024 * 1024);
    if (available < required) throw new LocalIngestFailure('DISK_SPACE_INSUFFICIENT', 'Insufficient free space for safe two-level extraction');
  }

  private async validateAndStage(
    job: LocalIngestJobRow,
    mapping: MappingRow,
    levelTwoRoot: string,
    processingPath: string,
    levelOneOutput: string[],
    innerOriginalName: string,
    innerWorkingName: string
  ): Promise<ValidationSummary> {
    this.updateJob(job.id, { phase: 'validating' });
    const settings = await this.checkedSettings();
    await this.assertInside(settings.processingRoot, processingPath, 'PROCESSING_PATH_OUTSIDE_ALLOWED_ROOT', 'Job processing directory', { directChild: true });
    await this.assertInside(processingPath, levelTwoRoot, 'PROCESSING_PATH_OUTSIDE_ALLOWED_ROOT', 'Second-level extraction directory');
    const contentRoot = await discoverContentRoot(levelTwoRoot);
    await this.assertInside(levelTwoRoot, contentRoot, 'UNSAFE_ARCHIVE_PATH', 'Extracted content root', { allowRoot: true });
    const tree = await listTree(contentRoot);
    const media: typeof tree = [];
    const ads: typeof tree = [];
    const unknown: typeof tree = [];
    const nestedArchives: typeof tree = [];
    let imageCount = 0;
    let videoCount = 0;
    let totalBytes = 0;
    for (const entry of tree) {
      if (entry.directory) continue;
      if (entry.symbolic || entry.size === 0) {
        throw new LocalIngestFailure('UNSAFE_OR_EMPTY_FILE', `File requires review: ${entry.relativePath}`, true);
      }
      const extension = path.extname(entry.relativePath).toLocaleLowerCase();
      if (IMAGE_EXTENSIONS.has(extension)) {
        await validateImage(entry.absolutePath);
        imageCount += 1;
        totalBytes += entry.size;
        media.push(entry);
      } else if (VIDEO_EXTENSIONS.has(extension)) {
        await validateVideo(entry.absolutePath);
        videoCount += 1;
        totalBytes += entry.size;
        media.push(entry);
      } else if (ADVERTISEMENT_EXTENSIONS.has(extension)) {
        ads.push(entry);
      } else if (NESTED_ARCHIVE_EXTENSIONS.has(extension)) {
        nestedArchives.push(entry);
      } else if (entry.relativePath !== '.DS_Store') {
        unknown.push(entry);
      }
    }
    if (nestedArchives.length > 0) {
      throw new LocalIngestFailure('NESTED_DEPTH_EXCEEDED', 'An archive remains after the configured extraction depth', true);
    }
    if (unknown.length > 0) {
      throw new LocalIngestFailure('UNKNOWN_FILE_TYPE', `Unknown files require review: ${unknown.map((entry) => entry.relativePath).join(', ')}`, true);
    }
    if (media.length === 0) throw new LocalIngestFailure('NO_VALID_MEDIA', 'No valid image or video was found', true);

    const targetName = sanitizeWindowsDirectoryName(mapping.raw_title?.trim() || mapping.source_title.trim());
    const creatorDirectoryName = this.safeCreatorDirectoryName(mapping.creator_name);
    const targetCreatorDirectory = path.join(settings.libraryRoot, creatorDirectoryName);
    await this.assertInside(settings.libraryRoot, targetCreatorDirectory, 'TARGET_PATH_OUTSIDE_LIBRARY', 'Target creator directory', { directChild: true });
    const targetPath = path.join(targetCreatorDirectory, targetName);
    await this.assertInside(settings.libraryRoot, targetPath, 'TARGET_PATH_OUTSIDE_LIBRARY', 'Target directory');
    if (await pathExists(targetPath)) throw new LocalIngestFailure('TARGET_EXISTS', 'The planned target directory already exists', true);
    const readyBuildPath = path.join(processingPath, `ready-building-${randomUUID()}`);
    const readyPath = path.join(processingPath, 'ready');
    await this.assertInside(processingPath, readyBuildPath, 'PROCESSING_PATH_OUTSIDE_ALLOWED_ROOT', 'Ready build directory', { directChild: true });
    await this.assertInside(processingPath, readyPath, 'PROCESSING_PATH_OUTSIDE_ALLOWED_ROOT', 'Ready directory', { directChild: true });
    if (!(await pathExists(readyPath))) {
      await fs.mkdir(readyBuildPath, { recursive: true });
      for (const entry of media) {
        const relativePath = path.relative(contentRoot, entry.absolutePath);
        const destination = path.join(readyBuildPath, relativePath);
        if (!isPathWithin(readyBuildPath, destination)) throw new LocalIngestFailure('UNSAFE_ARCHIVE_PATH', 'Media path escapes the staging directory', true);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(entry.absolutePath, destination, fs.constants.COPYFILE_EXCL);
      }
      await fs.rename(readyBuildPath, readyPath);
    }

    const warnings: string[] = [];
    const declared = mapping.media_summary ?? '';
    const declaredImages = /(?<!\d)(\d+)P\b/i.exec(declared);
    const declaredVideos = /(?<!\d)(\d+)V\b/i.exec(declared);
    const declaredSize = /(?<![\d.])(\d+(?:\.\d+)?)\s*(KB|K|MB|M|GB|G)\b/i.exec(declared);
    if (declaredImages && Number(declaredImages[1]) !== imageCount) warnings.push(`Declared ${declaredImages[1]} images; extracted ${imageCount}`);
    if (declaredVideos && Number(declaredVideos[1]) !== videoCount) warnings.push(`Declared ${declaredVideos[1]} videos; extracted ${videoCount}`);
    const declaredSizeMultiplier = declaredSize
      ? declaredSize[2].toLocaleUpperCase().startsWith('G') ? 1024 ** 3
        : declaredSize[2].toLocaleUpperCase().startsWith('M') ? 1024 ** 2
          : 1024
      : null;
    const declaredTotalBytes = declaredSize && declaredSizeMultiplier
      ? Math.round(Number(declaredSize[1]) * declaredSizeMultiplier)
      : undefined;
    const summary: ValidationSummary = {
      creator: mapping.creator_name,
      sourceWorkId: mapping.source_work_id,
      archiveDownloadTaskId: mapping.archive_download_task_id,
      sourceTitle: mapping.source_title,
      rawTitle: mapping.raw_title,
      sourceArchivePath: job.source_archive_path,
      sourceArchiveSha256: job.source_archive_sha256,
      outerFormat: archiveExtension(job.source_archive_name).slice(1),
      levelOneOutput,
      innerOriginalName,
      innerWorkingName,
      imageCount,
      videoCount,
      totalMediaCount: imageCount + videoCount,
      totalBytes,
      mediaType: imageCount > 0 && videoCount > 0 ? 'mixed' : imageCount > 0 ? 'image' : 'video',
      advertisementFileCount: ads.length,
      unknownFiles: [],
      nestedArchives: [],
      warnings,
      plannedTargetPath: targetPath,
      readyPath,
      declaredMediaSummary: mapping.media_summary,
      declaredImageCount: declaredImages ? Number(declaredImages[1]) : undefined,
      declaredVideoCount: declaredVideos ? Number(declaredVideos[1]) : undefined,
      declaredTotalBytes,
      declaredVsActualByteDifference: declaredTotalBytes === undefined ? undefined : totalBytes - declaredTotalBytes
    };
    this.updateJob(job.id, {
      status: 'running',
      phase: 'awaiting_commit',
      validationStatus: warnings.length > 0 ? 'warning' : 'passed',
      targetPath,
      summaryJson: JSON.stringify(summary),
      errorCode: null,
      errorDetail: null
    });
    return summary;
  }

  private async reconcile(jobId: number): Promise<LocalIngestJob> {
    const job = this.getJobRow(jobId);
    const mapping = this.mappingForJob(job);
    const settings = await this.checkedSettings();
    if (!job.target_path || !(await pathExists(job.target_path))) {
      throw new LocalIngestFailure('TARGET_MISSING_AFTER_COMMIT', 'The committed target directory cannot be found');
    }
    const expectedCreatorDirectory = path.join(settings.libraryRoot, this.safeCreatorDirectoryName(mapping.creator_name));
    const expectedTargetPath = path.join(
      expectedCreatorDirectory,
      sanitizeWindowsDirectoryName(mapping.raw_title?.trim() || mapping.source_title.trim())
    );
    await this.assertInside(settings.libraryRoot, expectedCreatorDirectory, 'TARGET_PATH_OUTSIDE_LIBRARY', 'Target creator directory', { directChild: true });
    const checkedTarget = await this.assertInside(settings.libraryRoot, job.target_path, 'TARGET_PATH_OUTSIDE_LIBRARY', 'Committed target directory');
    const canonicalExpectedTarget = await canonicalizeLocalIngestPath(expectedTargetPath);
    const sameTarget = process.platform === 'win32'
      ? checkedTarget.candidate.toLocaleLowerCase() === canonicalExpectedTarget.toLocaleLowerCase()
      : checkedTarget.candidate === canonicalExpectedTarget;
    if (!sameTarget) throw new LocalIngestFailure('TARGET_PATH_OUTSIDE_LIBRARY', 'Committed target no longer matches the ledger mapping', true);
    this.updateJob(jobId, { status: 'reconciling', phase: 'rescanning' });
    const creatorFolderName = this.safeCreatorDirectoryName(mapping.creator_name);
    const rescanResult = await this.rescanAndReconcile(
      this.database,
      settings.libraryRoot,
      mapping.creator_id,
      creatorFolderName
    );
    this.updateJob(jobId, { status: 'reconciling', phase: 'reconciling' });
    const summary = safeJsonParse(job.summary_json) ?? {};
    if (rescanResult) {
      const targetRelativePath = path.relative(path.resolve(settings.libraryRoot), path.resolve(job.target_path)).replace(/\\/g, '/');
      if (!targetRelativePath || targetRelativePath.startsWith('../') || path.isAbsolute(targetRelativePath)) {
        throw new LocalIngestFailure('GALLERY_INDEX_INCOMPLETE', 'The committed target is outside the configured gallery root');
      }
      const galleryFolder = this.database.prepare(
        `SELECT folders.id,
                folders.role,
                SUM(CASE WHEN images.is_deleted = 0 AND images.is_trashed = 0 AND images.media_type = 'image' THEN 1 ELSE 0 END) AS image_count,
                SUM(CASE WHEN images.is_deleted = 0 AND images.is_trashed = 0 AND images.media_type = 'video' THEN 1 ELSE 0 END) AS video_count
         FROM folders
         LEFT JOIN images ON images.folder_id = folders.id
         WHERE folders.folder_path = ?
         GROUP BY folders.id, folders.role
         LIMIT 1`
      ).get(targetRelativePath) as { id: number; role: string; image_count: number; video_count: number } | undefined;
      const galleryPost = this.database.prepare(
        `SELECT posts.id, COUNT(post_items.image_id) AS item_count
         FROM posts
         LEFT JOIN post_items ON post_items.post_id = posts.id
         WHERE posts.source_path = ?
           AND posts.is_deleted = 0
           AND posts.is_trashed = 0
         GROUP BY posts.id
         LIMIT 1`
      ).get(targetRelativePath) as { id: number; item_count: number } | undefined;
      const expectedImages = Number(summary.imageCount ?? 0);
      const expectedVideos = Number(summary.videoCount ?? 0);
      const indexedImages = Number(galleryFolder?.image_count ?? 0);
      const indexedVideos = Number(galleryFolder?.video_count ?? 0);
      const indexedPostItems = Number(galleryPost?.item_count ?? 0);
      if (
        galleryFolder?.role !== 'carousel_source'
        || indexedImages !== expectedImages
        || indexedVideos !== expectedVideos
        || indexedPostItems !== expectedImages + expectedVideos
      ) {
        this.updateJob(jobId, {
          status: 'reconciling',
          phase: 'reconciling',
          errorCode: 'GALLERY_INDEX_INCOMPLETE',
          errorDetail: `The committed target is not fully indexed (expected ${expectedImages} images and ${expectedVideos} videos; indexed ${indexedImages} images, ${indexedVideos} videos, ${indexedPostItems} post items)`
        });
        return this.getJob(jobId);
      }
      const warnings = Array.isArray(summary.warnings) ? summary.warnings.filter((value): value is string => typeof value === 'string') : [];
      if (!['completed', 'completed_with_errors'].includes(rescanResult.scanStatus)) {
        warnings.push(`CosGallery scan ${rescanResult.scanRunId} ended ${rescanResult.scanStatus} after this target was fully indexed; an unrelated library error remains`);
      }
      Object.assign(summary, {
        warnings,
        galleryScanRunId: rescanResult.scanRunId,
        galleryScanStatus: rescanResult.scanStatus,
        galleryIndexedImageCount: indexedImages,
        galleryIndexedVideoCount: indexedVideos,
        galleryPostItemCount: indexedPostItems
      });
    }
    const local = this.database.prepare(
      `SELECT local_works.id, local_works.relative_path
       FROM archive_catalog_local_works local_works
       JOIN archive_catalog_local_creator_folders local_folders ON local_folders.id = local_works.local_creator_folder_id
       JOIN archive_catalog_source_works source_works ON source_works.work_id = local_works.work_id
       WHERE source_works.id = ?
         AND local_works.is_active = 1
         AND local_folders.is_active = 1
         AND local_folders.root_path = ?
       LIMIT 1`
    ).get(mapping.source_work_id, path.resolve(settings.libraryRoot)) as { id: number; relative_path: string } | undefined;
    if (!local) {
      this.updateJob(jobId, {
        status: 'reconciling',
        phase: 'reconciling',
        errorCode: 'RECONCILIATION_INCOMPLETE',
        errorDetail: 'The target exists, but the source work is not yet linked to an active local work'
      });
      return this.getJob(jobId);
    }
    const task = this.database.prepare('SELECT status FROM archive_catalog_download_tasks WHERE id = ?').get(mapping.archive_download_task_id) as { status: string } | undefined;
    if (task?.status !== 'ingested') {
      this.updateJob(jobId, {
        status: 'reconciling',
        phase: 'reconciling',
        errorCode: 'MISSING_DIFFERENCE_NOT_CLEARED',
        errorDetail: 'The local work is linked, but the download task is still present in the missing set'
      });
      return this.getJob(jobId);
    }
    Object.assign(summary, {
      localWorkId: local.id,
      localCopyRelativePath: local.relative_path,
      sourceReconciled: true,
      missingDifferenceCleared: task?.status === 'ingested'
    });
    this.updateJob(jobId, {
      status: 'ingested',
      phase: 'cleanup',
      cleanupStatus: settings.recycleAfterIngest ? 'pending' : 'not_ready',
      summaryJson: JSON.stringify(summary),
      errorCode: null,
      errorDetail: null,
      completedAt: nowIso()
    });
    if (settings.recycleAfterIngest) return this.retryCleanupClaimed(jobId);
    return this.getJob(jobId);
  }

  async runJob(id: number): Promise<LocalIngestJob> {
    const job = this.getJobRow(id);
    if (job.status === 'awaiting_review' || job.phase === 'waiting_stable') return this.getJob(id);
    if (job.status === 'ingested' && !['pending', 'failed', 'recycling'].includes(job.cleanup_status)) return this.getJob(id);
    return this.runWithClaim(id, () => this.runClaimedJob(id));
  }

  private async runClaimedJob(id: number): Promise<LocalIngestJob> {
    let job = this.getJobRow(id);
    if (job.status === 'ingested') {
      if (job.cleanup_status === 'pending' || job.cleanup_status === 'failed' || job.cleanup_status === 'recycling') return this.retryCleanupClaimed(id);
      return this.getJob(id);
    }
    if (job.status === 'awaiting_review' || job.phase === 'waiting_stable') return this.getJob(id);
    if (job.status === 'reconciling' || (job.target_path && await pathExists(job.target_path))) {
      return this.reconcile(id);
    }
    if (job.source_work_id === null || job.archive_download_task_id === null) return this.getJob(id);
    const mapping = this.mappingForJob(job);
    const settings = await this.checkedSettings();
    if (!this.resolveAllowedCreatorIds(settings.allowlist).has(mapping.creator_id)) {
      throw new LocalIngestFailure('CREATOR_NOT_ALLOWED', 'The mapped creator is not in the local ingest allowlist', true);
    }
    try {
      await this.assertSourcePath(job, mapping, settings);
      const currentStats = await fs.stat(job.source_archive_path);
      if (currentStats.size !== job.source_archive_size || currentStats.mtimeMs !== job.source_archive_mtime) {
        throw new LocalIngestFailure('SOURCE_ARCHIVE_CHANGED', 'The source archive changed after discovery', true);
      }
      const currentHash = await this.hashFile(job.source_archive_path);
      const afterHashStats = await fs.stat(job.source_archive_path);
      if (afterHashStats.size !== currentStats.size || afterHashStats.mtimeMs !== currentStats.mtimeMs) {
        throw new LocalIngestFailure('SOURCE_ARCHIVE_CHANGED', 'The source archive changed while its checksum was being verified', true);
      }
      if (currentHash !== job.source_archive_sha256) throw new LocalIngestFailure('SOURCE_ARCHIVE_CHANGED', 'The source archive checksum changed after discovery', true);
      const expectedProcessingPath = path.join(settings.processingRoot, String(job.id));
      const processingPath = job.processing_path ?? expectedProcessingPath;
      const checkedProcessing = await this.assertInside(
        settings.processingRoot,
        processingPath,
        'PROCESSING_PATH_OUTSIDE_ALLOWED_ROOT',
        'Job processing directory',
        { directChild: true }
      );
      const canonicalExpectedProcessing = await canonicalizeLocalIngestPath(expectedProcessingPath);
      if (process.platform === 'win32'
        ? checkedProcessing.candidate.toLocaleLowerCase() !== canonicalExpectedProcessing.toLocaleLowerCase()
        : checkedProcessing.candidate !== canonicalExpectedProcessing) {
        throw new LocalIngestFailure('PROCESSING_PATH_OUTSIDE_ALLOWED_ROOT', 'Job processing directory does not match this job id', true);
      }
      const levelOneRoot = path.join(processingPath, 'level-1');
      const levelTwoRoot = path.join(processingPath, 'level-2');
      const levelOneCompleteMarker = path.join(processingPath, '.level-1-complete');
      const levelTwoCompleteMarker = path.join(processingPath, '.level-2-complete');
      await fs.mkdir(processingPath, { recursive: true });
      await fs.mkdir(levelOneRoot, { recursive: true });
      await fs.mkdir(levelTwoRoot, { recursive: true });
      await this.assertDiskSpace(job, settings.processingRoot);
      this.updateJob(id, {
        status: 'running',
        phase: 'testing_outer',
        processingPath,
        incrementAttempt: true,
        errorCode: null,
        errorDetail: null
      });
      await this.assertArchiveSafe(id, job.source_archive_path);
      await this.runSevenZip(id, 'test', job.source_archive_path);
      this.updateJob(id, { phase: 'extracting_outer' });
      if (!(await pathExists(levelOneCompleteMarker))) {
        await this.runSevenZip(id, 'extract', job.source_archive_path, levelOneRoot);
        await fs.writeFile(levelOneCompleteMarker, nowIso(), { flag: 'w' });
      }
      await this.assertExtractedTreeSafe(levelOneRoot);
      this.updateJob(id, { phase: 'detecting_inner' });
      const levelOneTree = await listTree(levelOneRoot);
      const originalInnerCandidates = levelOneTree.filter((entry) => !entry.directory && archiveExtension(entry.relativePath) === '.7zz');
      const renamedInnerCandidates = levelOneTree.filter((entry) => !entry.directory && archiveExtension(entry.relativePath) === '.7z');
      if (originalInnerCandidates.length + renamedInnerCandidates.length === 0) {
        throw new LocalIngestFailure('INNER_ARCHIVE_MISSING', 'The first extraction did not produce an inner archive', true);
      }
      if (originalInnerCandidates.length + renamedInnerCandidates.length > 1) {
        throw new LocalIngestFailure('INNER_ARCHIVE_AMBIGUOUS', 'The first extraction produced multiple possible inner archives', true);
      }
      const innerOriginal = originalInnerCandidates[0] ?? renamedInnerCandidates[0];
      const previousSummary = safeJsonParse(this.getJobRow(id).summary_json) ?? {};
      const levelOneOutput = Array.isArray(previousSummary.levelOneOutput)
        ? previousSummary.levelOneOutput.filter((value): value is string => typeof value === 'string')
        : (await fs.readdir(levelOneRoot)).sort();
      let innerWorkingPath = innerOriginal.absolutePath;
      const innerOriginalName = typeof previousSummary.innerOriginalName === 'string'
        ? previousSummary.innerOriginalName
        : innerOriginal.relativePath;
      if (archiveExtension(innerOriginal.relativePath) === '.7zz') {
        innerWorkingPath = innerOriginal.absolutePath.slice(0, -1);
        this.updateJob(id, {
          phase: 'renaming_inner',
          summaryJson: JSON.stringify({
            ...previousSummary,
            levelOneOutput,
            innerOriginalName,
            innerWorkingName: path.relative(levelOneRoot, innerWorkingPath)
          })
        });
        if (!(await pathExists(innerWorkingPath))) await fs.rename(innerOriginal.absolutePath, innerWorkingPath);
      }
      const innerWorkingName = typeof previousSummary.innerWorkingName === 'string'
        ? previousSummary.innerWorkingName
        : path.relative(levelOneRoot, innerWorkingPath);
      this.updateJob(id, { phase: 'testing_inner' });
      await this.assertArchiveSafe(id, innerWorkingPath);
      await this.runSevenZip(id, 'test', innerWorkingPath);
      this.updateJob(id, { phase: 'extracting_inner' });
      if (!(await pathExists(levelTwoCompleteMarker))) {
        await this.runSevenZip(id, 'extract', innerWorkingPath, levelTwoRoot);
        await fs.writeFile(levelTwoCompleteMarker, nowIso(), { flag: 'w' });
      }
      await this.assertExtractedTreeSafe(levelTwoRoot);
      job = this.getJobRow(id);
      const summary = await this.validateAndStage(job, mapping, levelTwoRoot, processingPath, levelOneOutput, innerOriginalName, innerWorkingName);
      const commitSettings = await this.checkedSettings();
      const commitMapping = this.mappingForJob(this.getJobRow(id));
      const expectedCreatorDirectory = path.join(commitSettings.libraryRoot, this.safeCreatorDirectoryName(commitMapping.creator_name));
      const expectedTargetPath = path.join(
        expectedCreatorDirectory,
        sanitizeWindowsDirectoryName(commitMapping.raw_title?.trim() || commitMapping.source_title.trim())
      );
      await this.assertInside(commitSettings.libraryRoot, expectedCreatorDirectory, 'TARGET_PATH_OUTSIDE_LIBRARY', 'Target creator directory', { directChild: true });
      await this.assertInside(commitSettings.libraryRoot, expectedTargetPath, 'TARGET_PATH_OUTSIDE_LIBRARY', 'Target directory');
      await this.assertInside(processingPath, summary.readyPath, 'PROCESSING_PATH_OUTSIDE_ALLOWED_ROOT', 'Ready directory', { directChild: true });
      const plannedCanonical = await canonicalizeLocalIngestPath(summary.plannedTargetPath);
      const expectedCanonical = await canonicalizeLocalIngestPath(expectedTargetPath);
      const sameTarget = process.platform === 'win32'
        ? plannedCanonical.toLocaleLowerCase() === expectedCanonical.toLocaleLowerCase()
        : plannedCanonical === expectedCanonical;
      if (!sameTarget) throw new LocalIngestFailure('TARGET_PATH_OUTSIDE_LIBRARY', 'The planned target no longer matches the ledger mapping', true);
      if (await pathExists(summary.plannedTargetPath)) throw new LocalIngestFailure('TARGET_EXISTS', 'The planned target directory already exists', true);
      await fs.mkdir(path.dirname(summary.plannedTargetPath), { recursive: true });
      this.updateJob(id, { phase: 'committing' });
      await fs.rename(summary.readyPath, summary.plannedTargetPath);
      this.updateJob(id, { status: 'reconciling', phase: 'rescanning', targetPath: summary.plannedTargetPath });
      return await this.reconcile(id);
    } catch (error) {
      const secret = process.env.LOCAL_INGEST_ARCHIVE_PASSWORD ?? '';
      const failure = error instanceof LocalIngestFailure
        ? error
        : new LocalIngestFailure('LOCAL_INGEST_FAILED', error instanceof Error ? error.message : 'Local ingest failed');
      const latestJob = this.getJobRow(id);
      const committedTargetExists = Boolean(latestJob.target_path && await pathExists(latestJob.target_path));
      this.updateJob(id, {
        status: committedTargetExists ? 'reconciling' : failure.review ? 'awaiting_review' : 'failed',
        phase: committedTargetExists ? 'reconciling' : latestJob.phase,
        validationStatus: failure.review ? 'failed' : latestJob.validation_status,
        errorCode: failure.code,
        errorDetail: sanitizeSecret(failure.message, secret)
      });
      return this.getJob(id);
    }
  }

  async retryCleanup(id: number): Promise<LocalIngestJob> {
    const job = this.getJobRow(id);
    if (job.status !== 'ingested') throw new Error('Cleanup is only available after ingest has been confirmed');
    if (job.cleanup_status === 'recycled') return this.getJob(id);
    return this.runWithClaim(id, () => this.retryCleanupClaimed(id));
  }

  private async retryCleanupClaimed(id: number): Promise<LocalIngestJob> {
    const job = this.getJobRow(id);
    if (job.status !== 'ingested') throw new Error('Cleanup is only available after ingest has been confirmed');
    if (job.cleanup_status === 'recycled') return this.getJob(id);
    this.updateJob(id, { phase: 'cleanup', cleanupStatus: 'recycling', errorCode: null, errorDetail: null });
    const summary = safeJsonParse(job.summary_json) ?? {};
    try {
      const settings = await this.checkedSettings();
      const checkedSource = await this.assertInside(
        settings.inboxRoot,
        job.source_archive_path,
        'RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT',
        'Source archive'
      );
      const sourceSegments = checkedSource.relative.split(path.sep).filter(Boolean);
      if (sourceSegments.length !== 2) {
        throw new LocalIngestFailure('RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT', 'Source archive is not a file inside a creator inbox directory', true);
      }
      if (await pathExists(job.source_archive_path)) {
        const sourceStats = await fs.lstat(job.source_archive_path);
        if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
          throw new LocalIngestFailure('RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT', 'Source recycle target must be a regular non-symbolic file', true);
        }
      }
      let checkedProcessing: Awaited<ReturnType<LocalIngestService['assertInside']>> | null = null;
      if (job.processing_path) {
        checkedProcessing = await this.assertInside(
          settings.processingRoot,
          job.processing_path,
          'RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT',
          'Processing directory',
          { directChild: true }
        );
        const expectedProcessing = await canonicalizeLocalIngestPath(path.join(settings.processingRoot, String(job.id)));
        const sameProcessing = process.platform === 'win32'
          ? checkedProcessing.candidate.toLocaleLowerCase() === expectedProcessing.toLocaleLowerCase()
          : checkedProcessing.candidate === expectedProcessing;
        if (!sameProcessing) {
          throw new LocalIngestFailure('RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT', 'Processing directory does not match this job id', true);
        }
        if (await pathExists(job.processing_path)) {
          const processingStats = await fs.lstat(job.processing_path);
          if (!processingStats.isDirectory() || processingStats.isSymbolicLink()) {
            throw new LocalIngestFailure('RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT', 'Processing recycle target must be a regular non-symbolic directory', true);
          }
        }
      }
      if (job.target_path) {
        const checkedTarget = await this.assertInside(
          settings.libraryRoot,
          job.target_path,
          'RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT',
          'Committed target directory'
        );
        const comparedTarget = process.platform === 'win32' ? checkedTarget.candidate.toLocaleLowerCase() : checkedTarget.candidate;
        const comparedSource = process.platform === 'win32' ? checkedSource.candidate.toLocaleLowerCase() : checkedSource.candidate;
        const comparedProcessing = checkedProcessing
          ? process.platform === 'win32' ? checkedProcessing.candidate.toLocaleLowerCase() : checkedProcessing.candidate
          : null;
        if (comparedTarget === comparedSource || comparedTarget === comparedProcessing) {
          throw new LocalIngestFailure('RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT', 'Cleanup may not recycle the committed gallery target', true);
        }
      }
      if (await pathExists(job.source_archive_path)) await this.recycleAdapter.recycle(job.source_archive_path);
      summary.sourceArchiveRecycled = !(await pathExists(job.source_archive_path));
      if (job.processing_path && await pathExists(job.processing_path)) await this.recycleAdapter.recycle(job.processing_path);
      summary.processingDirectoryRecycled = !job.processing_path || !(await pathExists(job.processing_path));
      this.updateJob(id, {
        status: 'ingested',
        phase: 'done',
        cleanupStatus: 'recycled',
        summaryJson: JSON.stringify(summary),
        errorCode: null,
        errorDetail: null
      });
    } catch (error) {
      const boundaryFailure = error instanceof LocalIngestFailure
        && ['RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT', 'ROOT_PATH_POLICY_VIOLATION'].includes(error.code);
      this.updateJob(id, {
        status: 'ingested',
        phase: 'cleanup',
        cleanupStatus: 'failed',
        summaryJson: JSON.stringify(summary),
        errorCode: boundaryFailure ? 'RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT' : 'RECYCLE_FAILED',
        errorDetail: error instanceof Error ? error.message : 'Recycle operation failed'
      });
    }
    return this.getJob(id);
  }

  async runBatch(options: { allowlist?: string[]; jobIds?: number[] } = {}): Promise<LocalIngestJob[]> {
    if (!options.jobIds) await this.scanInbox(options.allowlist);
    const allowlist = options.allowlist ?? this.settingsService.get().allowlist;
    const allowedCreatorIds = this.resolveAllowedCreatorIds(allowlist);
    const rows = this.database.prepare(
      `${this.jobSelect()}
       WHERE jobs.status IN ('queued', 'failed', 'reconciling')
         AND jobs.phase <> 'waiting_stable'
       ORDER BY jobs.creator_id, jobs.id`
    ).all() as Array<LocalIngestJobRow & { creator_name: string }>;
    const selected = rows.filter((row) =>
      (options.jobIds ? options.jobIds.includes(row.id) : allowedCreatorIds.has(row.creator_id))
    );
    const results: LocalIngestJob[] = [];
    for (const row of selected) results.push(await this.runJob(row.id));
    return results;
  }
}

export const localIngestService = new LocalIngestService();
