import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { appConfig, environmentFile, repositoryRoot, supportedEnvironmentKeys } from '../config/env.js';
import { isSameOrWithinPath } from '../utils/path-utils.js';
import { ApplicationRecoveryService, waitForRecoveryCreates } from './application-recovery-core.js';

// This adapter deliberately never imports databaseManager or business services:
// migration protection must observe the original schema before any app writes.
function readRecoveryFacts(databasePath: string) {
  const forbiddenRoots = [appConfig.galleryRoot, appConfig.thumbnailsDir, appConfig.previewsDir,
    ...['cos待入库', 'cos处理中', 'cos等待入库'].map(name => path.join(path.dirname(appConfig.galleryRoot), name)),
    path.join(repositoryRoot, 'client', 'public'), path.join(repositoryRoot, 'client', 'dist')];
  const requiredPrivateFiles: string[] = [];
  if (fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()) {
        const get = (key: string) => (database.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
        const settings = get('local_ingest.settings');
        if (settings) {
          const stored = JSON.parse(settings) as Record<string, unknown>;
          for (const key of ['libraryRoot', 'inboxRoot', 'processingRoot']) {
            if (typeof stored[key] === 'string' && stored[key]) forbiddenRoots.push(stored[key]);
          }
        }
        const password = get('local_ingest.archive_password');
        if (password && JSON.parse(password).disabled !== true) requiredPrivateFiles.push('local-ingest-archive-password.key');
        const waitingRoot = get('local-admission.waiting-root.v1');
        if (waitingRoot) forbiddenRoots.push(waitingRoot);
      }
    } finally { database.close(); }
  }
  return { forbiddenRoots, requiredPrivateFiles };
}

function readConfigurationText(filename: string): string {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('RECOVERY_CONFIGURATION: unsupported configuration file.');
  return fs.readFileSync(filename, 'utf8');
}

function backedRunEnvironment(): Array<{ filename: string; values: Record<string, string> }> {
  const directory = path.join(repositoryRoot, '.run');
  if (!appConfig.runConfigurationFile && !fs.existsSync(directory)) return [];
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const candidates = appConfig.runConfigurationFile ? [appConfig.runConfigurationFile]
    : fs.readdirSync(directory).filter(name => name.endsWith('.run.xml')).map(name => path.join(directory, name));
  const matches = candidates.flatMap(filename => {
    if (!fs.existsSync(filename)) return [];
    const xml = readConfigurationText(filename);
    const entries = [...xml.matchAll(/<env\s+name="([^"]*)"\s+value="([^"]*)"\s*\/?\s*>/g)]
      .map(([, key, value]) => [decode(key!), decode(value!)] as const);
    // Only configurations compatible with this actual process are candidates.
    // File values are retained in memory solely for equality; never metadata.
    const values = Object.fromEntries(entries);
    if (!appConfig.runConfigurationFile && (!entries.length || entries.some(([key, value]) => process.env[key] !== value))) return [];
    return [{ filename, values }];
  });
  return matches.length === 1 ? matches : [];
}

let version: string | undefined;
function codeVersion(): string {
  if (version) return version;
  try { version = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { version = 'unavailable'; }
  return version;
}

export function createApplicationRecoveryService(databasePath = appConfig.databasePath): ApplicationRecoveryService {
  if (isSameOrWithinPath(repositoryRoot, appConfig.backupRoot)
    && !isSameOrWithinPath(path.join(repositoryRoot, 'data_backup'), appConfig.backupRoot)) {
    throw new Error('RECOVERY_CONFIGURATION: repository-local BACKUP_ROOT must be data_backup or a child directory; choose an external directory otherwise.');
  }
  if (!appConfig.backupRootExplicit && fs.existsSync(path.join(repositoryRoot, '.git')) && fs.statSync(path.join(repositoryRoot, '.git')).isFile()) {
    throw new Error('RECOVERY_CONFIGURATION: development worktrees require an explicit isolated BACKUP_ROOT.');
  }
  const envPath = environmentFile;
  const envValues = fs.existsSync(envPath) ? dotenv.parse(readConfigurationText(envPath)) : {};
  const runEnvironments = backedRunEnvironment();
  // Only report configuration names, never their values or arbitrary process.env.
  const injected = supportedEnvironmentKeys
    .filter(key => process.env[key] !== undefined && process.env[key] !== envValues[key]
      && !runEnvironments.some(({ values }) => values[key] === process.env[key]));
  return new ApplicationRecoveryService({
    backupRoot: appConfig.backupRoot, sourceDbPath: databasePath,
    instanceId: `cosgallery-${appConfig.port}-${createHash('sha256').update(path.resolve(databasePath)).digest('hex').slice(0, 12)}`, codeVersion: codeVersion(),
    configFiles: [{ path: envPath, label: '.env' }, ...runEnvironments.map(({ filename }, index) => ({ path: filename, label: `.run/${index}-${path.basename(filename)}` }))],
    privateRoot: path.join(appConfig.dataRoot, 'private'),
    automatic: appConfig.backupAutomatic,
    configurationGaps: [
      ...injected.map(key => `Process-injected ${key} must be restored separately; its value is not exported.`),
      ...(!runEnvironments.length ? ['No matching active .run configuration was identified; process-only launch settings need separate restoration.'] : [])
    ],
    ...readRecoveryFacts(databasePath)
  });
}

export async function createPreRebuildRecoveryPoint(): Promise<void> {
  await createApplicationRecoveryService().create('pre-rebuild');
}

let timer: ReturnType<typeof setInterval> | null = null;
let automaticRun: Promise<unknown> | null = null;
export async function checkAutomaticRecoveryPoint(): Promise<void> {
  if (!appConfig.backupAutomatic.enabled || automaticRun) return;
  const service = createApplicationRecoveryService();
  const status = service.getStatus();
  if (status.active) return;
  const lastDaily = status.points.filter(point => point.reason === 'daily' && point.instanceId === service.config.instanceId)
    .reduce((latest, point) => Math.max(latest, Date.parse(point.completedAt)), 0);
  if (Date.now() - lastDaily < appConfig.backupAutomatic.intervalHours * 3_600_000) return;
  automaticRun = service.create('daily');
  try { await automaticRun; } finally { automaticRun = null; }
}

export function startAutomaticRecoveryPoints(): void {
  if (timer || !appConfig.backupAutomatic.enabled) return;
  const check = () => { void checkAutomaticRecoveryPoint().catch(() => {
    // The core persists a sanitized failure; an optional backup must not crash browsing.
    console.error('[server] Automatic recovery point failed; see backup status.');
  }); };
  check();
  timer = setInterval(check, 60_000);
  timer.unref();
}

export async function stopAutomaticRecoveryPoints(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await automaticRun?.catch(() => undefined);
  await waitForRecoveryCreates();
}
