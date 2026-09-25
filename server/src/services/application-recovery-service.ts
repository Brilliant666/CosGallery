import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { appConfig, environmentFile, repositoryRoot, supportedEnvironmentKeys, isEnvironmentValueRestorable } from '../config/env.js';
import { isSameOrWithinPath } from '../utils/path-utils.js';
import { ApplicationRecoveryService, waitForRecoveryCreates } from './application-recovery-core.js';
import { buildInfo } from '../build-info.js';

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

function runEnvironment(xml: string): Record<string, string> | null {
  // Strictly read the small IDE XML subset; no DTD/entity expansion or execution.
  const stack: string[] = [], values: Record<string, string> = {};
  let configurations = 0, roots = 0;
  const decode = (value: string) => value.replace(/&(?:quot|apos|lt|gt|amp|#\d+|#x[0-9a-fA-F]+);/g, entity => {
    const known: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
    return known[entity] ?? String.fromCodePoint(parseInt(entity.slice(entity.startsWith('&#x') ? 3 : 2, -1), entity.startsWith('&#x') ? 16 : 10));
  });
  try {
    const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) ?? [];
    if (tokens.join('') !== xml) return null;
    for (const token of tokens) {
      if (token.startsWith('<!--') || token.startsWith('<?')) continue;
      if (!token.startsWith('<')) { if (token.trim()) return null; continue; }
      if (token.startsWith('</')) { if (token !== `</${stack.pop()}>`) return null; continue; }
      const tag = token.match(/^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/);
      if (!tag) return null;
      const [, name, rawAttributes, selfClosing] = tag;
      const attributes: Record<string, string> = {};
      let rest = rawAttributes!;
      while (rest.trim()) {
        const attribute = rest.match(/^\s+([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/);
        if (!attribute || attribute[1]! in attributes) return null;
        const value = attribute[2]!.slice(1, -1);
        if (value.includes('<') || /&(?!(?:quot|apos|lt|gt|amp|#\d+|#x[0-9a-fA-F]+);)/.test(value)) return null;
        attributes[attribute[1]!] = decode(value); rest = rest.slice(attribute[0].length);
      }
      if (!stack.length) { if (++roots !== 1 || name !== 'component') return null; }
      if (name === 'configuration') configurations++;
      if (name === 'env') {
        if (stack.at(-1) !== 'envs' || !attributes.name || attributes.value === undefined || attributes.name in values) return null;
        values[attributes.name] = attributes.value;
      }
      if (!selfClosing) stack.push(name!);
    }
    return !stack.length && roots === 1 && configurations === 1 ? values : null;
  } catch { return null; }
}

function backedRunEnvironment(uncovered: string[]) {
  const directory = path.join(repositoryRoot, '.run');
  const explicit = appConfig.runConfigurationFile;
  const gaps: string[] = [];
  const empty = () => ({ files: [] as Array<{ filename: string; values: Record<string, string> }>, gaps });
  if (!explicit && !fs.existsSync(directory)) return empty();
  const candidates = appConfig.runConfigurationFile ? [appConfig.runConfigurationFile]
    : fs.readdirSync(directory).filter(name => name.endsWith('.run.xml')).map(name => path.join(directory, name));
  const matches = candidates.flatMap(filename => {
    if (!fs.existsSync(filename)) { if (explicit) gaps.push('APP_RUN_CONFIG_FILE: missing; restore the explicitly selected run configuration.'); return []; }
    let values: Record<string, string> | null;
    try { values = runEnvironment(readConfigurationText(filename)); } catch { values = null; }
    if (!values) { if (explicit) gaps.push('APP_RUN_CONFIG_FILE: invalid; verify the explicitly selected run configuration.'); return []; }
    const entries = Object.entries(values).filter(([key]) => supportedEnvironmentKeys.includes(key));
    const actual = Object.fromEntries(supportedEnvironmentKeys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    if (entries.some(([key, value]) => key === 'APP_ENV_FILE' ? path.resolve(repositoryRoot, value) !== environmentFile
      : key === 'APP_RUN_CONFIG_FILE' ? path.resolve(repositoryRoot, value) !== appConfig.runConfigurationFile
      : !isEnvironmentValueRestorable(key, value, actual))) {
      if (explicit) gaps.push('APP_RUN_CONFIG_FILE: mismatch; the selected run configuration does not reproduce this instance.');
      return [];
    }
    // A sole file is not launch evidence. Implicit selection must explain a real
    // process override not already recoverable from .env and the code defaults.
    if (!explicit && !entries.some(([key, value]) => uncovered.includes(key) && process.env[key] === value)) return [];
    return [{ filename, values }];
  });
  if (matches.length > 1) gaps.push('Run configuration source unconfirmed: multiple candidates; uncovered process settings require separate restoration.');
  return { files: matches.length === 1 ? matches : [], gaps };
}

function codeVersion(): string {
  // A checkout may move while a server remains running. Recovery evidence must
  // describe these loaded build artifacts, never the current checkout's HEAD.
  if (!buildInfo.commit) return 'unbuilt';
  return `${buildInfo.commit}${buildInfo.dirty === true ? '-dirty' : buildInfo.dirty === null ? '-unverified' : ''}`;
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
  const uncovered = supportedEnvironmentKeys.filter(key => !key.startsWith('APP_') && process.env[key] !== undefined
    && !isEnvironmentValueRestorable(key, process.env[key]!, envValues));
  const run = backedRunEnvironment(uncovered);
  const runEnvironments = run.files;
  // Only report configuration names, never their values or arbitrary process.env.
  const backedValues = { ...envValues, ...(runEnvironments[0]?.values ?? {}) };
  const injected = uncovered.filter(key => !isEnvironmentValueRestorable(key, process.env[key]!, backedValues));
  const hasEnvFile = fs.existsSync(envPath);
  return new ApplicationRecoveryService({
    backupRoot: appConfig.backupRoot, sourceDbPath: databasePath,
    instanceId: `cosgallery-${appConfig.port}-${createHash('sha256').update(path.resolve(databasePath)).digest('hex').slice(0, 12)}`, codeVersion: codeVersion(),
    configFiles: [...(hasEnvFile ? [{ path: envPath, label: '.env' }] : []), ...runEnvironments.map(({ filename }, index) => ({ path: filename, label: `.run/${index}-${path.basename(filename)}` }))],
    privateRoot: path.join(appConfig.dataRoot, 'private'),
    automatic: appConfig.backupAutomatic,
    configurationGaps: [
      ...injected.map(key => `Process-injected ${key} must be restored separately; its value is not exported.`),
      ...run.gaps,
      ...(!hasEnvFile && process.env.APP_ENV_FILE ? ['APP_ENV_FILE: missing; restore the explicitly selected environment file.'] : [])
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
  // Daily recovery points do not need minute-level polling. Keep the startup
  // check, but bound repeated status reads and failure retries to 15 minutes.
  timer = setInterval(check, 15 * 60_000);
  timer.unref();
}

export async function stopAutomaticRecoveryPoints(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await automaticRun?.catch(() => undefined);
  await waitForRecoveryCreates();
}
