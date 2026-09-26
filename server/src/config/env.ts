import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

import { parseExcludedFolderRulesFromEnv } from '../utils/excluded-folder-rules.js';
import { getRelativePathWithinRoot, isSameOrWithinPath, normalizePath } from '../utils/path-utils.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(moduleDirectory, '../../..');
export const environmentFile = path.resolve(repositoryRoot, process.env.APP_ENV_FILE ?? '.env');

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: environmentFile });
}

const envSchema = z.object({
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_ALLOWED_HOSTS: z.string().optional(),
  SERVER_PORT: z.coerce.number().int().positive().optional(),
  DEV_SERVER_PORT: z.coerce.number().int().positive().optional(),
  DEV_CLIENT_PORT: z.coerce.number().int().positive().optional(),
  DATA_ROOT: z.string().default('./data'),
  DATA_DIR: z.string().optional(),
  GALLERY_ROOT: z.string().optional(),
  DB_DIR: z.string().optional(),
  BACKUP_ROOT: z.string().trim().min(1).optional(),
  APP_RUN_CONFIG_FILE: z.string().trim().min(1).optional(),
  BACKUP_AUTO_ENABLED: z.enum(['true', 'false', '1', '0']).default('false'),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(24).default(24),
  BACKUP_RETAIN_DAILY: z.coerce.number().int().min(1).max(365).default(7),
  BACKUP_RETAIN_WEEKLY: z.coerce.number().int().min(1).max(104).default(4),
  THUMBNAILS_DIR: z.string().optional(),
  PREVIEWS_DIR: z.string().optional(),
  FFMPEG_PATH: z.string().trim().min(1).optional(),
  FFPROBE_PATH: z.string().trim().min(1).optional(),
  LOCAL_INGEST_SEVEN_ZIP_PATH: z.string().trim().default(''),
  FFMPEG_VIDEO_ENCODER: z.enum(['libx264', 'h264_nvenc']).default('libx264'),
  LOG_VERBOSE: z.string().optional(),
  SCAN_MEDIA_ERROR_MODE: z.enum(['skip', 'fail']).default('skip'),
  SCAN_DISCOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  SCAN_DERIVATIVE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  PUBLIC_DEMO_MODE: z.string().optional(),
  COS_GALLERY_MODE: z.string().optional(),
  LOCAL_INGEST_STARTUP_SCAN: z.enum(['true', 'false', '1', '0']).default('true'),
  CSRF_TRUSTED_ORIGINS: z.string().optional(),
  GALLERY_EXCLUDED_FOLDERS: z.string().optional(),
  IMAGE_DETAIL_SOURCE: z.enum(['preview', 'original']).default('preview'),
  DERIVATIVE_MODE: z.enum(['eager', 'lazy']).default('eager'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
});

const parsed = envSchema.parse(process.env);
// Names only: recovery compares supported process overrides without exporting values.
export const supportedEnvironmentKeys = [...Object.keys(envSchema.shape), 'APP_ENV_FILE', 'LOCAL_INGEST_ARCHIVE_PASSWORD'];
type ParsedEnvironment = z.infer<typeof envSchema>;
const productionPortDefault = 4141, developmentPortDefault = 4140, clientPortDefault = 4141;
const ffmpegDefault = 'ffmpeg', ffprobeDefault = 'ffprobe';
const isProduction = parsed.NODE_ENV === 'production';
const devClientPort = parsed.DEV_CLIENT_PORT ?? clientPortDefault;
const serverPort = isProduction
  ? parsed.SERVER_PORT ?? productionPortDefault
  : parsed.DEV_SERVER_PORT ?? developmentPortDefault;
const devClientPorts = Array.from({ length: 4 }, (_, index) => devClientPort + index);

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value);
}

function resolveConfiguredPath(value: string | null | undefined, fallbackAbsolutePath: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return resolveFromRoot(value);
  }

  return fallbackAbsolutePath;
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function parseBooleanFlag(value: string | undefined): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

function normalizeConfiguredOrigin(origin: string): string {
  let parsedOrigin: URL;

  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`Invalid CSRF_TRUSTED_ORIGINS entry: ${origin}`);
  }

  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error(`Invalid CSRF_TRUSTED_ORIGINS entry: ${origin}`);
  }

  return parsedOrigin.origin;
}

function parseConfiguredOrigins(value: string | undefined): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  return uniq(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizeConfiguredOrigin(entry))
  );
}

function storagePaths(environment: ParsedEnvironment) {
  const dataRoot = resolveConfiguredPath(environment.DATA_ROOT ?? environment.DATA_DIR, resolveFromRoot('./data'));
  return {
    dataRoot,
    galleryRoot: resolveConfiguredPath(environment.GALLERY_ROOT, path.join(dataRoot, 'gallery')),
    dbDir: resolveConfiguredPath(environment.DB_DIR, path.join(dataRoot, 'db')),
    backupRoot: resolveConfiguredPath(environment.BACKUP_ROOT, path.join(repositoryRoot, 'data_backup')),
    thumbnailsDir: resolveConfiguredPath(environment.THUMBNAILS_DIR, path.join(dataRoot, 'thumbnails')),
    previewsDir: resolveConfiguredPath(environment.PREVIEWS_DIR, path.join(dataRoot, 'previews'))
  };
}
const { dataRoot, galleryRoot, dbDir, backupRoot, thumbnailsDir, previewsDir } = storagePaths(parsed);
const geodataDir = path.join(dataRoot, 'geodata');
const scanErrorReportDir = path.join(dataRoot, 'scan-errors');
const logVerbose = parseBooleanFlag(parsed.LOG_VERBOSE);
const publicDemoMode = parseBooleanFlag(parsed.PUBLIC_DEMO_MODE);
const cosGalleryMode = parseBooleanFlag(parsed.COS_GALLERY_MODE);
const csrfTrustedOrigins = parseConfiguredOrigins(parsed.CSRF_TRUSTED_ORIGINS);
const galleryExcludedFolders = parseExcludedFolderRulesFromEnv(parsed.GALLERY_EXCLUDED_FOLDERS);

/** Compare recovery materials using the application's existing schema/defaults,
 * not a second loader or a dump of the process environment. */
export function isEnvironmentValueRestorable(key: string, value: string, materials: Record<string, string>): boolean {
  if (key === 'LOCAL_INGEST_ARCHIVE_PASSWORD') return materials[key] === value;
  if (!(key in envSchema.shape)) return materials[key] === value;
  // Derive the baseline only from captured materials and existing defaults.
  // Uncaptured process overrides must not prove one another recoverable.
  const baseline = envSchema.safeParse(materials);
  const candidate = envSchema.safeParse({ ...parsed, [key]: value });
  if (!baseline.success || !candidate.success) return false;
  const effective = (environment: ParsedEnvironment): unknown => {
    const paths = storagePaths(environment);
    switch (key) {
      case 'DATA_ROOT': case 'DATA_DIR': return paths.dataRoot;
      case 'GALLERY_ROOT': return paths.galleryRoot;
      case 'DB_DIR': return paths.dbDir;
      case 'BACKUP_ROOT': return paths.backupRoot;
      case 'THUMBNAILS_DIR': return paths.thumbnailsDir;
      case 'PREVIEWS_DIR': return paths.previewsDir;
      // Select the relevant port in the actual runtime mode; NODE_ENV itself
      // is checked independently, so a missing mode cannot hide a port gap.
      case 'SERVER_PORT': return parsed.NODE_ENV === 'production' ? environment.SERVER_PORT ?? productionPortDefault : undefined;
      case 'DEV_SERVER_PORT': return parsed.NODE_ENV !== 'production' ? environment.DEV_SERVER_PORT ?? developmentPortDefault : undefined;
      case 'DEV_CLIENT_PORT': return environment.DEV_CLIENT_PORT ?? clientPortDefault;
      case 'FFMPEG_PATH': return environment.FFMPEG_PATH ?? ffmpegDefault;
      case 'FFPROBE_PATH': return environment.FFPROBE_PATH ?? ffprobeDefault;
      case 'LOG_VERBOSE': case 'PUBLIC_DEMO_MODE': case 'COS_GALLERY_MODE': return parseBooleanFlag(environment[key]);
      case 'BACKUP_AUTO_ENABLED': case 'LOCAL_INGEST_STARTUP_SCAN': return environment[key] === 'true' || environment[key] === '1';
      default: return environment[key as keyof ParsedEnvironment];
    }
  };
  return effective(baseline.data) === effective(candidate.data);
}

const derivativeDirectoriesOverlap =
  isSameOrWithinPath(thumbnailsDir, previewsDir) || isSameOrWithinPath(previewsDir, thumbnailsDir);

if (derivativeDirectoriesOverlap) {
  throw new Error('Invalid storage configuration: THUMBNAILS_DIR and PREVIEWS_DIR must point to separate non-overlapping directories.');
}

const scanErrorReportDirectoryOverlapsServedMedia =
  isSameOrWithinPath(scanErrorReportDir, thumbnailsDir) ||
  isSameOrWithinPath(thumbnailsDir, scanErrorReportDir) ||
  isSameOrWithinPath(scanErrorReportDir, previewsDir) ||
  isSameOrWithinPath(previewsDir, scanErrorReportDir);

if (scanErrorReportDirectoryOverlapsServedMedia) {
  throw new Error('Invalid storage configuration: scan error reports must not overlap THUMBNAILS_DIR or PREVIEWS_DIR.');
}

if (isSameOrWithinPath(thumbnailsDir, galleryRoot)) {
  throw new Error('Invalid storage configuration: THUMBNAILS_DIR cannot contain GALLERY_ROOT.');
}

if (isSameOrWithinPath(previewsDir, galleryRoot)) {
  throw new Error('Invalid storage configuration: PREVIEWS_DIR cannot contain GALLERY_ROOT.');
}

const managedGalleryRelativeIgnores = uniq(
  [dbDir, thumbnailsDir, previewsDir, scanErrorReportDir]
    .map((directoryPath) => getRelativePathWithinRoot(galleryRoot, directoryPath))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => normalizePath(value))
);

export const appConfig = {
  host: parsed.SERVER_HOST,
  allowedHosts: (parsed.SERVER_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  port: serverPort,
  devClientPort,
  devClientPorts,
  nodeEnv: parsed.NODE_ENV,
  isDevelopment: parsed.NODE_ENV === 'development',
  dataRoot,
  galleryRoot,
  dbDir,
  backupRoot,
  backupRootExplicit: parsed.BACKUP_ROOT !== undefined,
  runConfigurationFile: parsed.APP_RUN_CONFIG_FILE ? resolveFromRoot(parsed.APP_RUN_CONFIG_FILE) : null,
  backupAutomatic: {
    enabled: parsed.BACKUP_AUTO_ENABLED === 'true' || parsed.BACKUP_AUTO_ENABLED === '1',
    intervalHours: parsed.BACKUP_INTERVAL_HOURS,
    retainDaily: parsed.BACKUP_RETAIN_DAILY,
    retainWeekly: parsed.BACKUP_RETAIN_WEEKLY
  },
  geodataDir,
  thumbnailsDir,
  previewsDir,
  ffmpegPath: parsed.FFMPEG_PATH ?? ffmpegDefault,
  ffprobePath: parsed.FFPROBE_PATH ?? ffprobeDefault,
  sevenZipPath: parsed.LOCAL_INGEST_SEVEN_ZIP_PATH,
  ffmpegVideoEncoder: parsed.FFMPEG_VIDEO_ENCODER,
  scanErrorReportDir,
  managedGalleryRelativeIgnores,
  galleryExcludedFolders,
  logVerbose,
  scanMediaErrorMode: parsed.SCAN_MEDIA_ERROR_MODE,
  publicDemoMode,
  cosGalleryMode,
  localIngestStartupScan: parsed.LOCAL_INGEST_STARTUP_SCAN === 'true' || parsed.LOCAL_INGEST_STARTUP_SCAN === '1',
  csrfTrustedOrigins,
  scanDiscoveryConcurrency: parsed.SCAN_DISCOVERY_CONCURRENCY,
  scanDerivativeConcurrency: parsed.SCAN_DERIVATIVE_CONCURRENCY,
  databasePath: path.join(dbDir, 'gallery.sqlite'),
  geodataPath: path.join(geodataDir, 'geonames-cities500.sqlite'),
  geodataMetadataPath: path.join(geodataDir, 'geonames-cities500.meta.json'),
  imageDetailSource: parsed.IMAGE_DETAIL_SOURCE,
  derivativeMode: parsed.DERIVATIVE_MODE
};
