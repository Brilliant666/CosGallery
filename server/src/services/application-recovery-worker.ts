import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ApplicationRecoveryConfig, RecoveryPoint, RecoveryReason, RecoveryPointError, readRecoveryPoints } from './application-recovery-core.js';
import { LocalIngestPasswordStore } from './local-ingest-password-store.js';

const fail = (code: string, message: string): never => { throw new RecoveryPointError(code, message); };
const contained = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
function resolved(value: string): string {
  if (!path.isAbsolute(value)) return fail('RECOVERY_UNSAFE_PATH', '恢复点路径必须由实例配置解析为绝对路径。');
  let cursor = path.resolve(value);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) { suffix.unshift(path.basename(cursor)); const parent = path.dirname(cursor); if (parent === cursor) return fail('RECOVERY_UNSAFE_PATH', '无法核对恢复点目录。'); cursor = parent; }
  return path.join(fs.realpathSync(cursor), ...suffix);
}
export function validateRecoveryRoot(config: ApplicationRecoveryConfig): string {
  const root = resolved(config.backupRoot);
  if (root === path.parse(root).root || fs.existsSync(root) && !fs.lstatSync(root).isDirectory()) return fail('RECOVERY_UNSAFE_PATH', '恢复点目录不可用。');
  const protectedPaths = [config.sourceDbPath, ...config.forbiddenRoots, ...(config.privateRoot ? [config.privateRoot] : []), ...config.configFiles.map(file => file.path)];
  for (const item of protectedPaths) {
    const actual = resolved(item);
    if (contained(root, actual) || contained(actual, root)) return fail('RECOVERY_UNSAFE_PATH', '恢复点目录与数据库、配置、媒体或对外目录重叠。');
  }
  return root;
}
function secureDirectory(root: string) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.stdout?.match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) return fail('RECOVERY_PERMISSIONS', '无法确认恢复点访问权限。');
    // Replace rather than append ACLs: pre-existing explicit Everyone grants must not survive.
    const literal = root.replace(/'/g, "''");
    const script = `$ErrorActionPreference='Stop'; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $sid=New-Object System.Security.Principal.SecurityIdentifier('${sid}'); $acl.SetOwner($sid); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl('${literal}',$acl)`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) return fail('RECOVERY_PERMISSIONS', '无法限制恢复点访问权限，未复制配置或密钥。');
  } else fs.chmodSync(root, 0o700);
}
function shaFile(filename: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  try { const buffer = Buffer.allocUnsafe(1024 * 1024); let n: number; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
interface InputFile { source: string; name: string; bytes: number; sha256: string }
function collectInputs(config: ApplicationRecoveryConfig) {
  const files: InputFile[] = [];
  const gaps = [...(config.configurationGaps ?? [])];
  function add(source: string, name: string, required: boolean) {
    if (/[\\\u0000:]/.test(name) || name.split('/').includes('..') || name.startsWith('/')) return fail('RECOVERY_UNSAFE_PATH', '恢复点文件标签无效。');
    if (!fs.existsSync(source)) { if (required) return fail('RECOVERY_REQUIRED_FILE_MISSING', '恢复所需配置或密钥文件缺失。'); gaps.push(`${name}: missing`); return; }
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) return fail('RECOVERY_UNSAFE_PATH', '配置或密钥符号链接需要明确解析后再备份。');
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(source).sort()) add(path.join(source, child), `${name}/${child}`, required);
    } else if (stat.isFile()) {
      // Configuration is small; refuse accidental inclusion of archives/media under private.
      if (stat.size > 16 * 1024 * 1024) return fail('RECOVERY_CONFIG_TOO_LARGE', '配置或密钥文件异常过大，未将其作为配置复制。');
      files.push({ source, name, bytes: stat.size, sha256: shaFile(source) });
    } else return fail('RECOVERY_UNSAFE_PATH', '配置或密钥不是普通文件。');
  }
  for (const input of config.configFiles) add(input.path, `config/${input.label}`, !!input.required);
  if (config.privateRoot) add(config.privateRoot, 'private', false);
  for (const name of config.requiredPrivateFiles ?? []) {
    if (!config.privateRoot || !files.some(file => file.name === `private/${name}`)) return fail('RECOVERY_REQUIRED_FILE_MISSING', '数据库使用的加密密钥缺失，无法建立可恢复点。');
  }
  if (new Set(files.map(file => file.name)).size !== files.length) return fail('RECOVERY_UNSAFE_PATH', '恢复点配置标签重复。');
  return { files, gaps: [...new Set(gaps)].sort() };
}
function inventory(db: DatabaseSync) {
  const tables = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>);
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const schemaVersions = tables.some(table => table.name === 'schema_migrations') ? db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => String(row.version)) : [];
  return { tables, objects, schemaVersions };
}
export function validateRecoveryDatabase(filename: string, expected: ReturnType<typeof inventory>) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const actual = inventory(db);
    if (!actual.tables.length || JSON.stringify(actual) !== JSON.stringify(expected)) return fail('RECOVERY_SCHEMA_CHANGED', '源库结构在生成期间发生变化或副本结构不完整。');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') return fail('RECOVERY_VALIDATION_FAILED', '恢复点完整性校验失败。');
    if (db.prepare('PRAGMA foreign_key_check').all().length) return fail('RECOVERY_VALIDATION_FAILED', '恢复点外键校验失败。');
    return { integrity: 'ok' as const, foreignKeys: 0 as const, tables: actual.tables.length };
  } finally { db.close(); }
}
function validateSnapshotConfiguration(filename: string, partial: string, config: ApplicationRecoveryConfig) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()) return;
    const get = (key: string) => db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
    const password = get('local_ingest.archive_password');
    if (typeof password === 'string') {
      // Snapshot facts, not a pre-spawn hint, decide whether the captured key is required.
      try { new LocalIngestPasswordStore(path.join(partial, 'private')).decrypt(password); }
      catch { return fail('RECOVERY_KEY_MISMATCH', '副本中的加密配置缺少匹配密钥，恢复点未发布。'); }
    }
    const roots: string[] = [];
    const setting = get('local_ingest.settings');
    if (typeof setting === 'string') {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(setting); } catch { return fail('RECOVERY_CONFIGURATION_INVALID', '副本配置无法验证，恢复点未发布。'); }
      for (const key of ['libraryRoot', 'inboxRoot', 'processingRoot']) if (typeof parsed[key] === 'string' && parsed[key]) roots.push(parsed[key]);
    }
    const waiting = get('local-admission.waiting-root.v1');
    if (typeof waiting === 'string' && waiting) roots.push(waiting);
    validateRecoveryRoot({ ...config, forbiddenRoots: [...config.forbiddenRoots, ...roots] });
  } finally { db.close(); }
}
function acquire(root: string, owner: { pid: number; id: string; startedAt: string; reason: RecoveryReason }) {
  const lock = path.join(root, '.recovery-lock');
  try { fs.mkdirSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let live = true;
    try { const prior = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); try { process.kill(prior.pid, 0); } catch (e) { live = (e as NodeJS.ErrnoException).code !== 'ESRCH'; } } catch { live = Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000; }
    if (live) return fail('RECOVERY_BUSY', '已有恢复点正在生成，请等待其完成。');
    // Rename an abandoned lock first; never remove a newly acquired competitor's lock.
    const abandoned = path.join(root, `.interrupted-lock-${crypto.randomUUID()}`);
    try { fs.renameSync(lock, abandoned); fs.mkdirSync(lock); } catch { return fail('RECOVERY_BUSY', '另一个进程正在接管恢复点任务。'); }
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  return () => { try { const current = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); if (current.id === owner.id) { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); } } catch { /* Preserve uncertain ownership. */ } };
}
export function applyRecoveryRetention(root: string, instanceId: string, daily = 7, weekly = 4) {
  const points = readRecoveryPoints(root).filter(point => point.instanceId === instanceId && point.reason === 'daily');
  const keep = new Set(points.slice(0, Math.max(1, daily)).map(point => point.id));
  const weeks = new Set<string>();
  for (const point of points) {
    const timestamp = Date.parse(point.completedAt); if (!Number.isFinite(timestamp)) { keep.add(point.id); continue; }
    const week = String(Math.floor((timestamp - 4 * 86_400_000) / (7 * 86_400_000)));
    if (!weeks.has(week) && weeks.size < Math.max(1, weekly)) { weeks.add(week); keep.add(point.id); }
  }
  for (const point of points) if (!keep.has(point.id)) {
    const target = path.join(root, point.id);
    if (!contained(root, fs.realpathSync(target)) || fs.lstatSync(target).isSymbolicLink()) continue;
    fs.rmSync(target, { recursive: true });
  }
}
export async function generateRecoveryPoint(config: ApplicationRecoveryConfig, reason: RecoveryReason): Promise<RecoveryPoint> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const id = `point-${startedAt.replace(/[^0-9]/g, '')}-${crypto.randomUUID()}`;
  const root = validateRecoveryRoot(config);
  secureDirectory(root);
  const release = acquire(root, { pid: process.pid, id, startedAt, reason });
  const partial = path.join(root, `.partial-${id}`);
  let source: DatabaseSync | undefined;
  try {
    if (reason === 'daily') {
      const latest = readRecoveryPoints(root).find(point => point.reason === 'daily' && point.instanceId === config.instanceId);
      if (latest && Date.now() - Date.parse(latest.completedAt) < (config.automatic?.intervalHours ?? 24) * 3600_000) return latest;
    }
    fs.mkdirSync(partial, { mode: 0o700 });
    const inputs = collectInputs(config);
    const sourceSize = fs.statSync(config.sourceDbPath).size;
    const space = fs.statfsSync(root);
    if (space.bavail * space.bsize < sourceSize * 2 + inputs.files.reduce((n, file) => n + file.bytes, 0) + 16 * 1024 * 1024) return fail('RECOVERY_NO_SPACE', '恢复点目录剩余空间不足。');
    source = new DatabaseSync(config.sourceDbPath, { readOnly: true });
    source.exec('PRAGMA busy_timeout=5000');
    const expected = inventory(source);
    const copyStart = performance.now();
    const destination = path.join(partial, 'gallery.sqlite');
    await backup(source, destination, { rate: 256 });
    const backupMs = performance.now() - copyStart;
    for (const file of inputs.files) {
      const target = path.join(partial, ...file.name.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file.source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      if (shaFile(target) !== file.sha256) return fail('RECOVERY_CONFIG_CHANGED', '生成期间配置或密钥发生变化，请重试；旧恢复点保持。');
    }
    const validationStart = performance.now();
    const validation = validateRecoveryDatabase(destination, expected);
    validateSnapshotConfiguration(destination, partial, config);
    const validationMs = performance.now() - validationStart;
    if (JSON.stringify(inventory(source)) !== JSON.stringify(expected) || JSON.stringify(collectInputs(config)) !== JSON.stringify(inputs)) return fail('RECOVERY_CONFIG_CHANGED', '生成期间结构、配置或密钥发生变化，请重试；旧恢复点保持。');
    source.close(); source = undefined;
    fs.chmodSync(destination, 0o600);
    const files = [{ name: 'gallery.sqlite', bytes: fs.statSync(destination).size, sha256: shaFile(destination) }, ...inputs.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))];
    const point: RecoveryPoint = { format: 'cosgallery-application-recovery-v1', id, status: 'success', reason, startedAt, completedAt: new Date().toISOString(), instanceId: config.instanceId, codeVersion: config.codeVersion, schemaVersions: expected.schemaVersions, files, configuration: { complete: !inputs.gaps.length, gaps: inputs.gaps }, validation, timings: { backupMs, validationMs, totalMs: performance.now() - started }, bytes: files.reduce((n, file) => n + file.bytes, 0) };
    fs.writeFileSync(path.join(partial, 'metadata.json'), JSON.stringify(point, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(partial, path.join(root, id));
    // Publication is complete before retention. Cleanup failure never invalidates a usable point.
    try { applyRecoveryRetention(root, config.instanceId, config.automatic?.retainDaily, config.automatic?.retainWeekly); } catch { /* Keep more recovery points on cleanup failure. */ }
    return point;
  } catch (error) {
    const code = error instanceof RecoveryPointError ? error.code : (error as NodeJS.ErrnoException).code === 'ENOSPC' ? 'RECOVERY_NO_SPACE' : 'RECOVERY_FAILED';
    const message = error instanceof RecoveryPointError ? error.message : '恢复点生成失败；未发布不完整结果，已有成功恢复点保持。';
    const failure = { at: new Date().toISOString(), code, message };
    try { fs.writeFileSync(path.join(root, 'last-failure.json'), JSON.stringify(failure), { mode: 0o600 }); if (fs.existsSync(partial)) fs.writeFileSync(path.join(partial, 'failure.json'), JSON.stringify(failure), { mode: 0o600 }); } catch { /* Disk full may prevent recording; partial name still marks failure. */ }
    throw new RecoveryPointError(code, message);
  } finally { source?.close(); release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    const request = JSON.parse(input) as { config: ApplicationRecoveryConfig; reason: RecoveryReason };
    const point = await generateRecoveryPoint(request.config, request.reason);
    process.stdout.write(JSON.stringify({ point }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: { code: error instanceof RecoveryPointError ? error.code : 'RECOVERY_FAILED', message: error instanceof RecoveryPointError ? error.message : '恢复点生成失败，已有成功恢复点保持。' } }));
    process.exitCode = 1;
  }
}
