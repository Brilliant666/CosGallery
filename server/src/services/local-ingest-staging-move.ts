import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeLocalIngestPath } from '../utils/local-ingest-paths.js';
import { isKnownAdvertisementImage } from '../utils/local-advertisements.js';

export const STAGING_MOVE_MANIFEST = '.staging-move.json';
const BUILD_DIRECTORY = 'ready-building-move';

export type StagingMoveBinding = {
  jobId: number;
  sourceWorkId: number;
  archiveDownloadTaskId: number;
  sourceArchiveSha256: string;
  targetPath: string;
  processingPath: string;
  levelTwoRoot: string;
};

export type StagingMoveFile = {
  relativePath: string;
  kind: 'image' | 'video' | 'advertisement' | 'ignored';
  size: number;
  dev: string;
  ino: string;
  mtimeNs: string;
};

export type StagingMoveManifest = {
  version: 1;
  jobId: number;
  sourceWorkId: number;
  archiveDownloadTaskId: number;
  sourceArchiveSha256: string;
  targetPath: string;
  contentRoot: string;
  files: StagingMoveFile[];
  summary: Record<string, unknown>;
};

export class StagingMoveFailure extends Error {
  readonly code = 'STAGING_MOVE_REVIEW_REQUIRED';
  constructor(message: string) { super(message); this.name = 'StagingMoveFailure'; }
}

function fail(message: string): never { throw new StagingMoveFailure(message); }
function key(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }
function isMedia(file: StagingMoveFile): boolean { return file.kind === 'image' || file.kind === 'video'; }

async function statOrMissing(value: string) {
  try { return await fs.lstat(value, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function safeRelative(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.replace(/\\/g, '/').split('/').some((part) => !part || part === '.' || part === '..' || /[:\x00]/.test(part));
}

// Reject links at every component, including links that resolve back inside the
// job root. The service has already checked the configured processing boundary.
async function checkedPath(root: string, candidate: string): Promise<void> {
  const canonicalRoot = await fs.realpath(root);
  const relative = path.relative(key(canonicalRoot), key(await canonicalizeLocalIngestPath(candidate)));
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('Staging path leaves the job directory');
  const rootStats = await statOrMissing(root);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) fail('Staging root is not a regular directory');
  let current = path.resolve(candidate);
  for (;;) {
    const stats = await statOrMissing(current);
    if (stats) {
      if (stats.isSymbolicLink() || (current !== path.resolve(candidate) && !stats.isDirectory())) fail('Staging path contains a link or a non-directory parent');
      if (key(await fs.realpath(current)) === key(canonicalRoot)) break;
    }
    const parent = path.dirname(current);
    if (parent === current) fail('Staging path cannot be traced to its root');
    current = parent;
  }
}

async function checkedManifest(binding: StagingMoveBinding, value: unknown): Promise<StagingMoveManifest> {
  if (!value || typeof value !== 'object') fail('Invalid staging manifest');
  const manifest = value as StagingMoveManifest;
  if (manifest.version !== 1 || manifest.jobId !== binding.jobId || manifest.sourceWorkId !== binding.sourceWorkId
    || manifest.archiveDownloadTaskId !== binding.archiveDownloadTaskId || manifest.sourceArchiveSha256 !== binding.sourceArchiveSha256
    || typeof manifest.targetPath !== 'string' || key(path.resolve(manifest.targetPath)) !== key(path.resolve(binding.targetPath))
    || typeof manifest.contentRoot !== 'string' || !path.isAbsolute(manifest.contentRoot)
    || !Array.isArray(manifest.files) || manifest.files.length === 0) fail('Staging manifest does not match this job, source, or target');
  await checkedPath(binding.processingPath, binding.levelTwoRoot);
  await checkedPath(binding.levelTwoRoot, manifest.contentRoot);
  if (key(await fs.realpath(manifest.contentRoot)) !== key(manifest.contentRoot)) fail('Staging content root changed');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!file || !safeRelative(file.relativePath) || !['image', 'video', 'advertisement', 'ignored'].includes(file.kind)
      || !Number.isSafeInteger(file.size) || file.size <= 0
      || ![file.dev, file.ino, file.mtimeNs].every((part) => typeof part === 'string' && /^\d+$/.test(part))
      || file.ino === '0') fail('Invalid staging file identity');
    const relativeKey = key(file.relativePath.replace(/\\/g, '/'));
    if (seen.has(relativeKey)) fail('Duplicate staging file identity');
    seen.add(relativeKey);
    const extension = path.extname(file.relativePath).toLowerCase();
    if ((file.kind === 'image' && !['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension))
      || (file.kind === 'video' && !['.mp4', '.mov', '.mkv', '.ts'].includes(extension))
      || (file.kind === 'advertisement' && !['.txt', '.html', '.htm', '.url'].includes(extension)
        && !isKnownAdvertisementImage(file.relativePath))
      || (file.kind === 'ignored' && file.relativePath !== '.DS_Store')) fail('Staging file classification changed');
  }
  if (!manifest.files.some(isMedia)) fail('Staging manifest has no media');
  const summary = manifest.summary;
  const images = manifest.files.filter((file) => file.kind === 'image');
  const videos = manifest.files.filter((file) => file.kind === 'video');
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)
    || summary.sourceWorkId !== binding.sourceWorkId || summary.archiveDownloadTaskId !== binding.archiveDownloadTaskId
    || summary.sourceArchiveSha256 !== binding.sourceArchiveSha256
    || summary.plannedTargetPath !== binding.targetPath || summary.readyPath !== path.join(binding.processingPath, 'ready')
    || summary.imageCount !== images.length || summary.videoCount !== videos.length
    || summary.totalMediaCount !== images.length + videos.length
    || summary.totalBytes !== [...images, ...videos].reduce((total, file) => total + file.size, 0)
    || !Array.isArray(summary.warnings) || summary.warnings.some((warning) => typeof warning !== 'string')) {
    fail('Staging validation summary does not match the complete manifest');
  }
  return manifest;
}

export async function readStagingMoveManifest(binding: StagingMoveBinding): Promise<StagingMoveManifest | null> {
  const filename = path.join(binding.processingPath, STAGING_MOVE_MANIFEST);
  await checkedPath(binding.processingPath, filename);
  const stats = await statOrMissing(filename);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) fail('Staging manifest is not a private regular file');
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { fail('Staging manifest is incomplete or unreadable'); }
  return checkedManifest(binding, parsed);
}

export async function createStagingMoveManifest(
  binding: StagingMoveBinding,
  contentRoot: string,
  files: Array<Pick<StagingMoveFile, 'relativePath' | 'kind' | 'size'>>,
  summary: Record<string, unknown>
): Promise<StagingMoveManifest | null> {
  const destinationStats = await fs.stat(binding.processingPath, { bigint: true });
  const entries: StagingMoveFile[] = [];
  for (const file of files) {
    const filename = path.join(contentRoot, file.relativePath);
    await checkedPath(contentRoot, filename);
    const stats = await fs.lstat(filename, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || Number(stats.size) !== file.size) fail('Validated staging file changed');
    // Choose copy before creating any manifest or moving anything. No runtime
    // link/rename error may switch an already-started move to copy.
    if (stats.dev === 0n || destinationStats.dev === 0n || stats.dev !== destinationStats.dev || stats.ino === 0n || stats.nlink !== 1n) return null;
    entries.push({ ...file, dev: String(stats.dev), ino: String(stats.ino), mtimeNs: String(stats.mtimeNs) });
  }
  const manifest = await checkedManifest(binding, {
    version: 1, jobId: binding.jobId, sourceWorkId: binding.sourceWorkId, archiveDownloadTaskId: binding.archiveDownloadTaskId,
    sourceArchiveSha256: binding.sourceArchiveSha256, targetPath: path.resolve(binding.targetPath),
    contentRoot: await fs.realpath(contentRoot), files: entries, summary
  });
  if (await statOrMissing(path.join(binding.processingPath, BUILD_DIRECTORY))
    || await statOrMissing(path.join(binding.processingPath, 'ready'))) fail('Unowned staging directory already exists');
  const filename = path.join(binding.processingPath, STAGING_MOVE_MANIFEST);
  const handle = await fs.open(filename, 'wx');
  try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync(); } finally { await handle.close(); }
  return manifest;
}

async function fileInventory(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const stats = await fs.lstat(filename, { bigint: true });
      if (stats.isSymbolicLink()) fail('Staging inventory contains a link');
      if (stats.isDirectory()) await visit(filename);
      else if (stats.isFile()) result.push(path.relative(root, filename));
      else fail('Staging inventory contains a special file');
    }
  }
  const stats = await statOrMissing(root);
  if (stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail('Staging directory changed');
    await visit(root);
  }
  return result;
}

async function assertIdentity(filename: string, file: StagingMoveFile): Promise<void> {
  const stats = await statOrMissing(filename);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || String(stats.dev) !== file.dev
    || String(stats.ino) !== file.ino || String(stats.mtimeNs) !== file.mtimeNs || Number(stats.size) !== file.size) {
    fail('Staging file identity, size, timestamp, or link count changed');
  }
}

export async function verifyStagingMoveState(
  binding: StagingMoveBinding,
  manifest: StagingMoveManifest,
  validateMedia?: (filename: string, kind: 'image' | 'video') => Promise<void>
): Promise<{ destinationRoot: string; ready: boolean; pending: StagingMoveFile[] }> {
  await checkedManifest(binding, manifest);
  const buildRoot = path.join(binding.processingPath, BUILD_DIRECTORY);
  const readyRoot = path.join(binding.processingPath, 'ready');
  await checkedPath(binding.processingPath, buildRoot);
  await checkedPath(binding.processingPath, readyRoot);
  const [buildStats, readyStats] = await Promise.all([statOrMissing(buildRoot), statOrMissing(readyRoot)]);
  if (buildStats && readyStats) fail('Both build and ready directories exist');
  const destinationRoot = readyStats ? readyRoot : buildRoot;
  const [sourceFiles, stagedFiles] = await Promise.all([fileInventory(manifest.contentRoot), fileInventory(destinationRoot)]);
  const expected = new Map(manifest.files.map((file) => [key(file.relativePath.replace(/\\/g, '/')), file]));
  if (sourceFiles.some((file) => !expected.has(key(file.replace(/\\/g, '/')))) || stagedFiles.some((file) => {
    const entry = expected.get(key(file.replace(/\\/g, '/')));
    return !entry || !isMedia(entry);
  })) fail('Staging inventory has files outside the validated manifest');
  const pending: StagingMoveFile[] = [];
  for (const file of manifest.files) {
    const source = path.join(manifest.contentRoot, file.relativePath);
    const destination = path.join(destinationRoot, file.relativePath);
    await checkedPath(manifest.contentRoot, source);
    await checkedPath(binding.processingPath, destination);
    const [sourceStats, destinationStats] = await Promise.all([statOrMissing(source), statOrMissing(destination)]);
    if (isMedia(file)) {
      if (Boolean(sourceStats) === Boolean(destinationStats)) fail('A media file is missing or present on both sides of the move');
      if (readyStats && sourceStats) fail('Ready staging is incomplete');
      const filename = sourceStats ? source : destination;
      await assertIdentity(filename, file);
      if (validateMedia) await validateMedia(filename, file.kind as 'image' | 'video');
      if (sourceStats) pending.push(file);
    } else {
      if (!sourceStats || destinationStats) fail('Non-media staging inventory changed');
      await assertIdentity(source, file);
    }
  }
  return { destinationRoot, ready: Boolean(readyStats), pending };
}

export async function finishStagingMove(binding: StagingMoveBinding, manifest: StagingMoveManifest): Promise<void> {
  const state = await verifyStagingMoveState(binding, manifest);
  if (state.ready) return;
  await fs.mkdir(state.destinationRoot, { recursive: true });
  const destinationStats = await fs.stat(state.destinationRoot, { bigint: true });
  for (const file of state.pending) {
    if (String(destinationStats.dev) !== file.dev) fail('Staging destination volume changed');
    const source = path.join(manifest.contentRoot, file.relativePath);
    const destination = path.join(state.destinationRoot, file.relativePath);
    await checkedPath(binding.processingPath, destination);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await checkedPath(manifest.contentRoot, source);
    await checkedPath(binding.processingPath, destination);
    await assertIdentity(source, file);
    // link is an atomic no-replace operation; unlink completes the move without
    // copying bytes. A crash between them is an explicit two-sided review case.
    await fs.link(source, destination);
    const linked = await fs.lstat(destination, { bigint: true });
    const original = await fs.lstat(source, { bigint: true });
    if (String(linked.dev) !== file.dev || String(linked.ino) !== file.ino || String(original.ino) !== file.ino
      || linked.nlink !== 2n || original.nlink !== 2n || String(linked.mtimeNs) !== file.mtimeNs || Number(linked.size) !== file.size) {
      fail('Staging identity changed during the move');
    }
    try { await fs.unlink(source); } catch {
      fail('The linked media remains on both sides; review is required before retrying');
    }
    await assertIdentity(destination, file);
  }
  await verifyStagingMoveState(binding, manifest);
  if (await statOrMissing(path.join(binding.processingPath, 'ready'))) fail('Ready directory appeared during the move');
  await fs.rename(state.destinationRoot, path.join(binding.processingPath, 'ready'));
}
