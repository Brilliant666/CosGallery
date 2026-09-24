import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type RecoveryReason = 'manual' | 'daily' | 'pre-migration' | 'pre-rebuild' | 'maintenance';
export interface ApplicationRecoveryConfig {
  backupRoot: string;
  sourceDbPath: string;
  instanceId: string;
  codeVersion: string;
  configFiles: Array<{ path: string; label: string; required?: boolean }>;
  privateRoot?: string;
  requiredPrivateFiles?: string[];
  forbiddenRoots: string[];
  configurationGaps?: string[];
  automatic?: { enabled: boolean; intervalHours?: number; retainDaily?: number; retainWeekly?: number };
  /** Bounded backup/validation execution; integration leaves the 15 minute default. */
  timeoutMs?: number;
}
export interface RecoveryPoint {
  format: 'cosgallery-application-recovery-v1';
  id: string;
  status: 'success';
  reason: RecoveryReason;
  startedAt: string;
  completedAt: string;
  instanceId: string;
  codeVersion: string;
  schemaVersions: string[];
  files: Array<{ name: string; bytes: number; sha256: string }>;
  configuration: { complete: boolean; gaps: string[] };
  validation: { integrity: 'ok'; foreignKeys: 0; tables: number };
  timings: { backupMs: number; validationMs: number; totalMs: number };
  bytes: number;
}
export interface RecoveryFailure { at: string; code: string; message: string }
export interface RecoveryActive { id: string; startedAt: string; reason: RecoveryReason }
export class RecoveryPointError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
const format = 'cosgallery-application-recovery-v1';
const localActive = new Map<string, RecoveryActive>();
const localCreates = new Map<string, Promise<RecoveryPoint>>();
const localFailures = new Map<string, RecoveryFailure>();
export async function waitForRecoveryCreates(): Promise<void> {
  await Promise.allSettled([...localCreates.values()]);
}
export function readRecoveryJson(filename: string): unknown {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid recovery metadata');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function isRecoveryPoint(value: unknown, id: string): value is RecoveryPoint {
  const object = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
  const finiteNonnegative = (input: unknown): input is number => typeof input === 'number' && Number.isFinite(input) && input >= 0;
  const nonemptyString = (input: unknown): input is string => typeof input === 'string' && input.length > 0;
  const stringList = (input: unknown): input is string[] => Array.isArray(input) && input.every(item => typeof item === 'string');
  const timestamp = (input: unknown): input is string => typeof input === 'string' && Number.isFinite(Date.parse(input)) && new Date(input).toISOString() === input;
  if (!object(value) || value.format !== format || value.status !== 'success' || value.id !== id
    || typeof value.reason !== 'string' || !['manual', 'daily', 'pre-migration', 'pre-rebuild', 'maintenance'].includes(value.reason)
    || !timestamp(value.startedAt) || !timestamp(value.completedAt)
    || !nonemptyString(value.instanceId) || !nonemptyString(value.codeVersion)
    || !stringList(value.schemaVersions) || !finiteNonnegative(value.bytes) || !Number.isSafeInteger(value.bytes)) return false;
  if (!Array.isArray(value.files) || !value.files.length || !value.files.every(file => object(file)
    && nonemptyString(file.name) && !/[\\\u0000:]/.test(file.name) && !file.name.startsWith('/') && !file.name.split('/').includes('..')
    && finiteNonnegative(file.bytes) && Number.isSafeInteger(file.bytes)
    && typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256))) return false;
  if (!value.files.some(file => file.name === 'gallery.sqlite') || new Set(value.files.map(file => file.name)).size !== value.files.length) return false;
  return object(value.configuration) && typeof value.configuration.complete === 'boolean' && stringList(value.configuration.gaps)
    && object(value.validation) && value.validation.integrity === 'ok' && value.validation.foreignKeys === 0
    && finiteNonnegative(value.validation.tables) && Number.isSafeInteger(value.validation.tables) && value.validation.tables > 0
    && object(value.timings) && finiteNonnegative(value.timings.backupMs) && finiteNonnegative(value.timings.validationMs) && finiteNonnegative(value.timings.totalMs);
}
export function readRecoveryPoints(root: string): RecoveryPoint[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^point-[a-zA-Z0-9-]+$/.test(entry.name))
    .flatMap(entry => {
      try {
        const point = readRecoveryJson(path.join(root, entry.name, 'metadata.json'));
        const database = fs.lstatSync(path.join(root, entry.name, 'gallery.sqlite'));
        return isRecoveryPoint(point, entry.name) && database.isFile() && !database.isSymbolicLink() ? [point] : [];
      } catch { return []; }
    }).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}
function workerArgs() {
  const js = fileURLToPath(new URL('./application-recovery-worker.js', import.meta.url));
  return fs.existsSync(js) ? [js] : ['--import', 'tsx', fileURLToPath(new URL('./application-recovery-worker.ts', import.meta.url))];
}
function parseWorkerResult(output: string): RecoveryPoint {
  let result: { point?: RecoveryPoint; error?: { code: string; message: string } };
  try { result = JSON.parse(output.trim()); } catch { throw new RecoveryPointError('RECOVERY_WORKER_FAILED', '恢复点后台进程未正常完成；已有成功恢复点保持。'); }
  if (result.error) throw new RecoveryPointError(result.error.code, result.error.message);
  if (!result.point) throw new RecoveryPointError('RECOVERY_WORKER_FAILED', '恢复点后台进程未正常完成；已有成功恢复点保持。');
  return result.point;
}
export class ApplicationRecoveryService {
  constructor(readonly config: ApplicationRecoveryConfig) {}
  getStatus() {
    const points = readRecoveryPoints(this.config.backupRoot);
    let active: RecoveryActive | null = localActive.get(path.resolve(this.config.backupRoot)) ?? null;
    let lastFailure: RecoveryFailure | null = localFailures.get(path.resolve(this.config.backupRoot)) ?? null;
    try {
      const owner = readRecoveryJson(path.join(this.config.backupRoot, '.recovery-lock', 'owner.json')) as RecoveryActive & { pid: number };
      try { process.kill(owner.pid, 0); active = { id: owner.id, startedAt: owner.startedAt, reason: owner.reason }; } catch {
        if (!lastFailure && (!points[0] || owner.startedAt > points[0].completedAt)) lastFailure = { at: owner.startedAt, code: 'RECOVERY_INTERRUPTED', message: '上次恢复点生成被中断；未完成目录不是成功恢复点。' };
      }
    } catch { /* No active worker. */ }
    try { const failure = readRecoveryJson(path.join(this.config.backupRoot, 'last-failure.json')) as RecoveryFailure; if (typeof failure.at === 'string' && typeof failure.code === 'string' && typeof failure.message === 'string' && (!lastFailure || failure.at > lastFailure.at)) lastFailure = failure; } catch { /* No recorded failure. */ }
    return { backupRoot: this.config.backupRoot, automatic: { enabled: false, intervalHours: 24, retainDaily: 7, retainWeekly: 4, ...this.config.automatic }, active, latestSuccess: points[0] ?? null, points, lastFailure };
  }
  create(reason: RecoveryReason): Promise<RecoveryPoint> {
    const key = path.resolve(this.config.backupRoot);
    const pending = localCreates.get(key);
    if (pending) return pending;
    localActive.set(key, { id: 'starting', startedAt: new Date().toISOString(), reason });
    const promise = new Promise<RecoveryPoint>((resolve, reject) => {
      const child = spawn(process.execPath, workerArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(new RecoveryPointError('RECOVERY_TIMEOUT', '恢复点生成超时，未完成产物不会发布。')); }, this.config.timeoutMs ?? 15 * 60_000);
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      // Never forward worker stderr: SQLite or filesystem messages can contain private paths.
      child.stderr.resume();
      child.on('error', () => { clearTimeout(timer); reject(new RecoveryPointError('RECOVERY_WORKER_FAILED', '无法启动恢复点后台进程。')); });
      child.on('close', () => { clearTimeout(timer); try { resolve(parseWorkerResult(output)); } catch (error) { reject(error); } });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ config: this.config, reason }));
    }).then(point => { localFailures.delete(key); return point; }, error => {
      localFailures.set(key, { at: new Date().toISOString(), code: error instanceof RecoveryPointError ? error.code : 'RECOVERY_FAILED', message: error instanceof RecoveryPointError ? error.message : '恢复点生成失败，已有成功恢复点保持。' });
      throw error;
    }).finally(() => { localActive.delete(key); localCreates.delete(key); });
    localCreates.set(key, promise);
    return promise;
  }
  createSync(reason: RecoveryReason): RecoveryPoint {
    const result = spawnSync(process.execPath, workerArgs(), { windowsHide: true, input: JSON.stringify({ config: this.config, reason }), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: this.config.timeoutMs ?? 15 * 60_000 });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new RecoveryPointError('RECOVERY_TIMEOUT', '恢复点生成超时，未完成产物不会发布。');
    return parseWorkerResult(result.stdout ?? '');
  }
}
