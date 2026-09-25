import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readMovableImageMetadata } from '../utils/movable-image-metadata.js';
import { z } from 'zod';
import { appConfig } from '../config/env.js';
import { databaseManager } from '../db/database.js';
import { assertPathInsideLocalIngestRoot } from '../utils/local-ingest-paths.js';
import { LocalFolderAdmissionService, admissionPlanSchema, inventoryAdmissionDirectory, type AdmissionPlan } from './local-folder-admission-service.js';
import { LocalIngestService, localIngestService } from './local-ingest-service.js';
import { normalizeReviewPath } from './local-ingest-review-inventory.js';
import { reviewPlanHash, type LocalIngestReviewPlan } from './local-ingest-review-plan.js';
import { RETAINED_ORIGINALS_DIRECTORY } from '../constants/retained-originals.js';

/** Explicit review guards are conflicts; unexpected I/O/programming errors are not. */
export class LocalReviewError extends Error {}

const id = z.number().int().positive();
const key = z.string().trim().min(1).max(120);
export const localReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stage3'), jobId: id }).strict(),
  z.object({ kind: z.literal('admission'), planId: key, itemKey: key }).strict()
]);
export type LocalReviewTarget = z.infer<typeof localReviewTargetSchema>;
const choiceSchema = z.object({ relativePath: z.string().min(1).transform((value, context) => {
  try { return normalizeReviewPath(value); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsafe review relative path' }); return z.NEVER; }
}),
  action: z.enum(['retain_original', 'retain_attachment', 'quarantine']),
  reason: z.enum(['pixel_limit', 'attachment', 'damaged', 'advertisement']) }).strict();
export const localReviewExecuteSchema = z.object({ requestKey: key, confirmed: z.literal(true),
  note: z.string().trim().min(1).max(2000), quarantineConfirmed: z.boolean().optional(),
  choices: z.array(choiceSchema).max(2000) }).strict();
type Choice = z.infer<typeof choiceSchema>;
type Confirmation = z.infer<typeof localReviewExecuteSchema>;
type Status = 'preparing' | 'ready' | 'submitted' | 'running' | 'interrupted' | 'completed' | 'failed';
type Fingerprint = { size: number; dev: string; ino: string; mtimeNs: string; sha256: string };
export type LocalReviewFile = { relativePath: string; size: number; kind: 'image' | 'video' | 'attachment' | 'other';
  issue: 'pixel_limit' | 'attachment' | 'damaged' | 'advertisement_candidate' | 'unsupported' | null;
  message: string; allowedActions: Choice['action'][]; suggestedAction: Choice['action'] | null;
  fingerprint?: Fingerprint };
type Baseline = { title: string; root: string; quarantineRoot: string; files: LocalReviewFile[];
  stage3?: LocalIngestReviewPlan; admission?: AdmissionPlan; contentHash?: string;
  inventory?: Awaited<ReturnType<typeof inventoryAdmissionDirectory>> };
type Row = { id: string; creator_id: number; target_key: string; target_json: string; request_key: string;
  status: Status; phase: string; owner_pid: number | null; baseline_json: string | null; execute_key: string | null;
  title: string; total_files: number; issue_count: number;
  choices_json: string | null; recovery_json: string | null; result_json: string | null; error: string | null;
  created_at: string; updated_at: string };
type ActionRow = { relative_path: string; source_path: string; quarantine_path: string;
  fingerprint_json: string; state: 'intent' | 'moved' };
const active = new Map<string, Promise<void>>();
const encoded = (value: unknown) => JSON.stringify(value);
const same = (left: unknown, right: unknown) => encoded(left) === encoded(right);
const targetKey = (target: LocalReviewTarget) => target.kind === 'stage3' ? `stage3:${target.jobId}` : `admission:${target.planId}:${target.itemKey}`;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
  throw new LocalReviewError('审核所有者进程状态无法确认；保留现场。');
} }
async function exists(filename: string) { try { await fs.lstat(filename); return true; } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error;
} }

/** Reject every linked path component, including in-root aliases. No arbitrary-path API. */
async function safePath(root: string, filename: string) {
  const normalizedRoot = path.resolve(root), resolved = path.resolve(filename);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new LocalReviewError('审核文件越出已确认范围。');
  await assertPathInsideLocalIngestRoot(normalizedRoot, resolved, { allowRoot: true });
  let current = path.parse(normalizedRoot).root;
  for (const component of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw new LocalReviewError('审核范围不允许目录链接或重解析点。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
  }
  return resolved;
}

async function fingerprint(root: string, relative: string): Promise<Fingerprint> {
  const filename = await safePath(root, path.join(root, normalizeReviewPath(relative)));
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new LocalReviewError('审核仅支持普通、非硬链接文件。');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes as Buffer);
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(filename, { bigint: true });
    for (const actual of [after, current]) if (before.dev !== actual.dev || before.ino !== actual.ino || before.size !== actual.size
      || before.mtimeNs !== actual.mtimeNs || before.ctimeNs !== actual.ctimeNs || before.nlink !== actual.nlink) throw new LocalReviewError('审核读取期间文件变化。');
    return { size: Number(before.size), dev: String(before.dev), ino: String(before.ino), mtimeNs: String(before.mtimeNs), sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

/** Persistent HTTP orchestration. All media registration / completion stays in the original services. */
export class LocalReviewWebService {
  private readonly folder: LocalFolderAdmissionService;
  private readonly ingest: LocalIngestService;
  private readonly galleryRoot: string;
  constructor(private readonly db: DatabaseSync = databaseManager.connection,
    options: { galleryRoot?: string; admission?: LocalFolderAdmissionService; ingest?: LocalIngestService } = {}) {
    this.galleryRoot = options.galleryRoot ?? appConfig.galleryRoot;
    this.folder = options.admission ?? new LocalFolderAdmissionService(db, this.galleryRoot);
    this.ingest = options.ingest ?? localIngestService;
  }

  private row(sessionId: string, lightweight = false): Row {
    const projection = lightweight ? `id,creator_id,target_key,target_json,request_key,status,phase,owner_pid,title,total_files,issue_count,
      NULL AS baseline_json,execute_key,choices_json,NULL AS recovery_json,result_json,error,created_at,updated_at` : '*';
    const row = this.db.prepare(`SELECT ${projection} FROM local_review_web_sessions WHERE id=?`).get(sessionId) as Row | undefined;
    if (!row) throw new LocalReviewError('审核批次不存在。');
    if (['preparing', 'submitted', 'running'].includes(row.status) && !active.has(row.id)
      && (!row.owner_pid || !alive(row.owner_pid))) {
      this.update(row.id, { status: 'interrupted', phase: 'interrupted', owner_pid: null, error: '服务进程已中断；原范围保留，请明确继续。' });
      return this.row(sessionId, lightweight);
    }
    return row;
  }

  private update(sessionId: string, values: Partial<Row>) {
    const data = { ...values, updated_at: new Date().toISOString() };
    const fields = Object.keys(data) as Array<keyof typeof data>;
    this.db.prepare(`UPDATE local_review_web_sessions SET ${fields.map(name => `${name}=?`).join(',')} WHERE id=?`)
      .run(...fields.map(name => data[name] as string | number | null), sessionId);
  }

  private folderState(target: Extract<LocalReviewTarget, { kind: 'admission' }>, creatorId: number) {
    const saved = this.db.prepare('SELECT payload_json,content_hash FROM archive_local_admission_plans WHERE plan_id=?').get(target.planId) as { payload_json: string; content_hash: string } | undefined;
    if (!saved) throw new LocalReviewError('原接纳计划不存在。');
    const plan = admissionPlanSchema.parse(JSON.parse(saved.payload_json));
    if (plan.creatorId !== creatorId) throw new LocalReviewError('接纳计划不属于当前博主。');
    const item = plan.items.find(value => value.key === target.itemKey);
    const state = this.db.prepare(`SELECT a.state,a.work_id,a.local_work_id,l.post_id FROM archive_local_admission_items a
      LEFT JOIN archive_catalog_local_works l ON l.id=a.local_work_id WHERE a.plan_id=? AND a.item_key=?`).get(target.planId, target.itemKey) as { state: string; work_id: number; local_work_id: number; post_id: number | null } | undefined;
    if (!item || !state) throw new LocalReviewError('原接纳项目不存在。');
    return { plan, item, state, contentHash: saved.content_hash };
  }

  target(input: unknown, creatorId: number) {
    const target = localReviewTargetSchema.parse(input); id.parse(creatorId);
    let title: string, reason: string | null = null;
    if (target.kind === 'stage3') {
      const job = this.ingest.getJob(target.jobId);
      if (job.creatorId !== creatorId) throw new LocalReviewError('Stage3任务不属于当前博主。');
      title = `${job.creatorName} · ${job.sourceArchiveName}`;
      if (job.status !== 'awaiting_review' || job.phase !== 'validating'
        || !['MEDIA_UNREADABLE', 'UNKNOWN_FILE_TYPE', 'NESTED_DEPTH_EXCEEDED', 'UNSAFE_OR_EMPTY_FILE'].includes(job.errorCode ?? '')) {
        reason = '仅支持已完成原两层解压、在媒体验证阶段暂停的未提交任务；其他状态沿用原任务流程。';
      }
    } else {
      const data = this.folderState(target, creatorId); title = data.item.displayTitle;
      if (data.state.state !== 'files_verified' || data.state.post_id !== null) reason = '网页文件审核只作用于已移动且尚未完成索引的原项目；不会修改已完成图集。';
    }
    const previous = this.db.prepare(`SELECT id FROM local_review_web_sessions WHERE target_key=? AND status<>'completed'
      ORDER BY created_at DESC LIMIT 1`).get(targetKey(target)) as { id: string } | undefined;
    return { target, creatorId, title, eligible: reason === null, reason, sessionId: previous?.id ?? null };
  }

  create(input: unknown) {
    const request = z.object({ creatorId: id, target: localReviewTargetSchema, requestKey: key }).strict().parse(input);
    const previous = this.db.prepare('SELECT id,creator_id,target_key FROM local_review_web_sessions WHERE request_key=?').get(request.requestKey) as { id: string; creator_id: number; target_key: string } | undefined;
    if (previous) {
      if (previous.creator_id !== request.creatorId || previous.target_key !== targetKey(request.target)) throw new LocalReviewError('同一请求键不能用于另一任务。');
      return this.get(previous.id);
    }
    const overview = this.target(request.target, request.creatorId);
    if (!overview.eligible) throw new LocalReviewError(overview.reason!);
    if (overview.sessionId) {
      const old = this.row(overview.sessionId);
      if (old.choices_json || !['failed', 'interrupted'].includes(old.status)) return this.get(old.id);
    }
    const sessionId = randomUUID(), now = new Date().toISOString();
    this.db.prepare(`INSERT INTO local_review_web_sessions(id,creator_id,target_key,target_json,request_key,status,phase,owner_pid,created_at,updated_at)
      VALUES(?,?,?,?,?,'preparing','inspecting',?,?,?)`).run(sessionId, request.creatorId, targetKey(request.target), encoded(request.target), request.requestKey, process.pid, now, now);
    this.schedule(sessionId, () => this.inspect(sessionId));
    return this.get(sessionId);
  }

  get(sessionId: string) {
    const row = this.row(sessionId, true);
    const actions = this.db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN state='moved' THEN 1 ELSE 0 END) completed
      FROM local_review_web_file_actions WHERE session_id=?`).get(sessionId) as { total: number; completed: number | null };
    return { sessionId: row.id, creatorId: row.creator_id, target: JSON.parse(row.target_json) as LocalReviewTarget,
      title: row.title, status: row.status, phase: row.phase,
      message: row.error ?? (row.status === 'ready' ? '请选择本次明确处置；未选择的附件保持。' : row.phase),
      totalFiles: row.total_files, issueCount: row.issue_count,
      error: row.error, confirmed: Boolean(row.choices_json), choices: row.choices_json ? JSON.parse(row.choices_json).choices as Choice[] : [],
      result: row.result_json ? JSON.parse(row.result_json) : null, createdAt: row.created_at, updatedAt: row.updated_at,
      completedFileActions: actions.completed ?? 0, fileActionCount: actions.total };
  }

  files(sessionId: string, query: { page?: number; limit?: number; issuesOnly?: boolean } = {}) {
    const row = this.row(sessionId), baseline = row.baseline_json ? JSON.parse(row.baseline_json) as Baseline : null;
    const page = z.number().int().positive().parse(query.page ?? 1), limit = z.number().int().positive().max(100).parse(query.limit ?? 50);
    const files = baseline?.files.filter(file => !query.issuesOnly || file.issue !== null) ?? [];
    const actions = this.db.prepare('SELECT relative_path,quarantine_path,state FROM local_review_web_file_actions WHERE session_id=?');
    const moved = new Map((actions.all(sessionId) as Array<{ relative_path: string; quarantine_path: string; state: string }>).map(row => [row.relative_path, row]));
    return { items: files.slice((page - 1) * limit, page * limit).map(({ fingerprint: _fingerprint, ...file }) => ({ ...file,
      ...(moved.has(file.relativePath) ? { preservedAt: moved.get(file.relativePath)!.quarantine_path, actionState: moved.get(file.relativePath)!.state } : {}) })), total: files.length, page, limit };
  }

  private schedule(sessionId: string, action: () => Promise<void>) {
    if (active.has(sessionId)) return;
    const work = Promise.resolve().then(action).catch(error => {
      this.update(sessionId, { status: 'failed', phase: 'failed', owner_pid: null, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => active.delete(sessionId));
    active.set(sessionId, work);
  }

  /** Test/maintenance wait only. HTTP never awaits the long operation. */
  async wait(sessionId: string) { await active.get(sessionId); return this.get(sessionId); }

  private async classify(root: string, relativePath: string, size: number, stage3: boolean): Promise<LocalReviewFile> {
    const extension = path.extname(relativePath).toLowerCase();
    const file: LocalReviewFile = { relativePath, size, kind: 'other', issue: null, message: '原样保留', allowedActions: [], suggestedAction: null };
    const image = /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(extension);
    const video = /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(extension);
    if (image) {
      file.kind = 'image';
      try { await readMovableImageMetadata(await safePath(root, path.join(root, relativePath))); file.message = '正常媒体，无需额外批准'; }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        file.issue = /Input image exceeds pixel limit/i.test(detail) && ['.jpg', '.jpeg'].includes(extension) ? 'pixel_limit' : 'damaged';
        file.message = detail; file.allowedActions = file.issue === 'pixel_limit' ? ['retain_original', 'quarantine'] : ['quarantine'];
        file.suggestedAction = file.issue === 'pixel_limit' ? 'retain_original' : null;
      }
    } else if (video) {
      file.kind = 'video'; file.message = '由原媒体校验继续验证';
      if (size === 0) { file.issue = 'damaged'; file.message = '空视频文件'; file.allowedActions = ['quarantine']; }
    }
    else if (extension === '.pdf') {
      file.kind = 'attachment'; file.message = 'PDF保留附件，不计入图片，不转换或当作广告';
      if (stage3) { file.issue = 'attachment'; file.allowedActions = ['retain_attachment']; file.suggestedAction = 'retain_attachment'; }
    } else if (['.txt', '.url'].includes(extension)) {
      file.kind = 'attachment'; file.issue = 'advertisement_candidate'; file.message = '默认保留附件，不计图片；仅明确确认本文件为广告后可恢复移出';
      file.allowedActions = stage3 ? ['retain_attachment', 'quarantine'] : ['quarantine'];
      file.suggestedAction = stage3 ? 'retain_attachment' : null;
    } else if (stage3 && !['.tif', '.tiff', '.heic', '.heif'].includes(extension)) {
      file.issue = 'unsupported'; file.message = '未知附件或剩余压缩包，不能自动放行';
      // A still-present inner archive is not automatically damaged and receives no removal shortcut.
    }
    if (file.issue !== null && file.allowedActions.length) file.fingerprint = await fingerprint(root, relativePath);
    return file;
  }

  private async inspect(sessionId: string) {
    const row = this.row(sessionId), target = localReviewTargetSchema.parse(JSON.parse(row.target_json));
    const overview = this.target(target, row.creator_id); if (!overview.eligible) throw new LocalReviewError(overview.reason!);
    let baseline: Baseline;
    if (target.kind === 'stage3') {
      const plan = await this.ingest.previewReview({ jobId: target.jobId, removedFiles: [], retainedFiles: [], note: '网页只读审核，尚未确认任何文件操作' });
      baseline = { title: overview.title, root: path.join(plan.processingPath, 'level-2'),
        quarantineRoot: path.join(path.dirname(plan.processingPath), '.local-review-attachments'), files: [], stage3: plan };
      await safePath(baseline.root, baseline.root);
      for (const file of plan.files) baseline.files.push(await this.classify(baseline.root, file.relativePath, file.size, true));
    } else {
      const data = this.folderState(target, row.creator_id);
      if (path.resolve(data.plan.galleryRoot) !== path.resolve(this.galleryRoot)) throw new LocalReviewError('原计划正式图库配置已变化。');
      await safePath(this.galleryRoot, data.item.targetPath);
      const inventory = await inventoryAdmissionDirectory(data.item.targetPath);
      baseline = { title: overview.title, root: data.item.targetPath,
        quarantineRoot: path.join(data.plan.inputRoot, '.local-review-attachments'), files: [], admission: data.plan,
        contentHash: data.contentHash, inventory };
      for (const file of inventory) if (file.kind !== 'directory') baseline.files.push(await this.classify(baseline.root, file.relativePath, file.size, false));
    }
    this.update(sessionId, { baseline_json: encoded(baseline), title: baseline.title, total_files: baseline.files.length,
      issue_count: baseline.files.filter(file => file.issue !== null).length, status: 'ready', phase: 'ready', owner_pid: null, error: null });
  }

  execute(sessionId: string, input: unknown) {
    const confirmation = localReviewExecuteSchema.parse(input), row = this.row(sessionId);
    if (row.choices_json) {
      if (!same(JSON.parse(row.choices_json), confirmation)) throw new LocalReviewError('已确认审核不可改写；请继续原请求，不重复新建决定。');
      return this.get(sessionId);
    }
    if (row.status !== 'ready' || !row.baseline_json) throw new LocalReviewError('请等待实际文件审核预览完成。');
    const baseline = JSON.parse(row.baseline_json) as Baseline, seen = new Set<string>();
    for (const choice of confirmation.choices) {
      const file = baseline.files.find(value => value.relativePath === choice.relativePath);
      if (!file || seen.has(choice.relativePath) || !file.allowedActions.includes(choice.action)) throw new LocalReviewError('处置必须对应预览中的具体文件及支持动作。');
      seen.add(choice.relativePath);
      if (choice.action === 'retain_original' && choice.reason !== 'pixel_limit'
        || choice.action === 'retain_attachment' && choice.reason !== 'attachment'
        || choice.action === 'quarantine' && (file.issue === 'advertisement_candidate' ? choice.reason !== 'advertisement' : choice.reason !== 'damaged')) throw new LocalReviewError('处置原因与文件问题不符。');
    }
    const blockers = baseline.files.filter(file => file.issue && !['advertisement_candidate'].includes(file.issue));
    if (blockers.some(file => !seen.has(file.relativePath))) throw new LocalReviewError('仍有未处置的阻断文件；可以暂缓，不能忽略后继续。');
    if (!baseline.files.some(file => ['image', 'video'].includes(file.kind) && !seen.has(file.relativePath))) throw new LocalReviewError('处置后没有可正常展示的媒体；请暂缓，不移动任何文件。');
    if (confirmation.choices.some(choice => choice.action === 'quarantine') && confirmation.quarantineConfirmed !== true) throw new LocalReviewError('请单独确认列出的文件将可恢复移出，不会永久删除。');
    const changed = this.db.prepare(`UPDATE local_review_web_sessions SET choices_json=?,execute_key=?,status='submitted',phase='submitted',owner_pid=?,updated_at=?
      WHERE id=? AND choices_json IS NULL AND status='ready'`).run(encoded(confirmation), confirmation.requestKey, process.pid, new Date().toISOString(), sessionId);
    const current = this.row(sessionId);
    if (current.choices_json !== encoded(confirmation)) throw new LocalReviewError('并发确认已变化，请刷新。');
    if (!changed.changes) return this.get(sessionId);
    this.schedule(sessionId, () => this.perform(sessionId));
    return this.get(sessionId);
  }

  retry(sessionId: string, requestKey: string) {
    key.parse(requestKey); const row = this.row(sessionId);
    if (['running', 'submitted', 'preparing', 'completed'].includes(row.status)) return this.get(sessionId);
    if (!['failed', 'interrupted'].includes(row.status)) throw new LocalReviewError('当前审核不需要继续。');
    const changed = this.db.prepare(`UPDATE local_review_web_sessions SET status=?,phase='resuming',owner_pid=?,error=NULL,updated_at=?
      WHERE id=? AND status=? AND updated_at=?`).run(row.choices_json ? 'submitted' : 'preparing', process.pid,
        new Date().toISOString(), sessionId, row.status, row.updated_at);
    if (!changed.changes) return this.get(sessionId);
    this.schedule(sessionId, () => row.choices_json ? this.perform(sessionId) : this.inspect(sessionId));
    return this.get(sessionId);
  }

  private assertIdle(target: LocalReviewTarget, creatorId: number) {
    if (this.db.prepare("SELECT id FROM scan_runs WHERE status='running' LIMIT 1").get()) throw new LocalReviewError('图库扫描仍在运行，未处理文件。');
    if (this.db.prepare(`SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id
      JOIN archive_catalog_works w ON w.id=s.work_id WHERE w.creator_id=? AND t.status IN ('claimed','downloading') LIMIT 1`).get(creatorId)) throw new LocalReviewError('相关博主存在活动领取/下载，未处理文件。');
    if (this.db.prepare(`SELECT id FROM local_ingest_jobs WHERE creator_id=? AND (status IN ('running','reconciling') OR claim_token IS NOT NULL)
      AND id<>? LIMIT 1`).get(creatorId, target.kind === 'stage3' ? target.jobId : -1)) throw new LocalReviewError('同博主仍有活动入库，未处理文件。');
  }

  private async moveSelected(row: Row, baseline: Baseline, confirmation: Confirmation) {
    const target = localReviewTargetSchema.parse(JSON.parse(row.target_json));
    for (const choice of confirmation.choices.filter(value => value.action === 'quarantine')) {
      this.assertIdle(target, row.creator_id);
      const file = baseline.files.find(value => value.relativePath === choice.relativePath)!;
      if (!file.fingerprint) throw new LocalReviewError('预览缺少精确文件证据。');
      const source = await safePath(baseline.root, path.join(baseline.root, choice.relativePath));
      const destination = await safePath(baseline.quarantineRoot, path.join(baseline.quarantineRoot, row.id, choice.relativePath));
      let action = this.db.prepare('SELECT * FROM local_review_web_file_actions WHERE session_id=? AND relative_path=?').get(row.id, choice.relativePath) as ActionRow | undefined;
      if (!action) {
        if (await exists(destination)) throw new LocalReviewError('可恢复附件目标已存在，不覆盖。');
        if (!same(await fingerprint(baseline.root, choice.relativePath), file.fingerprint)) throw new LocalReviewError('文件自预览后变化，未执行移出。');
        this.db.prepare(`INSERT INTO local_review_web_file_actions(session_id,relative_path,source_path,quarantine_path,fingerprint_json,state)
          VALUES(?,?,?,?,?,'intent')`).run(row.id, choice.relativePath, source, destination, encoded(file.fingerprint));
        action = this.db.prepare('SELECT * FROM local_review_web_file_actions WHERE session_id=? AND relative_path=?').get(row.id, choice.relativePath) as ActionRow;
      }
      if (action.source_path !== source || action.quarantine_path !== destination || action.fingerprint_json !== encoded(file.fingerprint)) throw new LocalReviewError('已保存文件操作范围不一致。');
      const from = await exists(source), to = await exists(destination);
      if (from === to) throw new LocalReviewError('文件两处同时存在或同时缺失；保留现场，不覆盖。');
      if (from) {
        if (action.state === 'moved') throw new LocalReviewError('已移出的文件重新出现；不能重复处理。');
        if (!same(await fingerprint(baseline.root, choice.relativePath), file.fingerprint)) throw new LocalReviewError('文件在操作前被替换。');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await safePath(baseline.quarantineRoot, destination);
        if ((await fs.stat(path.dirname(destination), { bigint: true })).dev.toString() !== file.fingerprint.dev) throw new LocalReviewError('可恢复移出必须同卷，不执行复制后删除。');
        this.assertIdle(target, row.creator_id);
        if (await exists(destination)) throw new LocalReviewError('可恢复附件目标已被占用，不覆盖。');
        await fs.rename(source, destination);
      }
      if (!same(await fingerprint(baseline.quarantineRoot, path.relative(baseline.quarantineRoot, destination).split(path.sep).join('/')), file.fingerprint)) throw new LocalReviewError('可恢复位置文件证据不匹配；未登记成功。');
      this.db.prepare("UPDATE local_review_web_file_actions SET state='moved',moved_at=COALESCE(moved_at,?) WHERE session_id=? AND relative_path=?")
        .run(new Date().toISOString(), row.id, choice.relativePath);
    }
  }

  private async validateRemainingFiles(row: Row, baseline: Baseline) {
    const moves = this.db.prepare('SELECT * FROM local_review_web_file_actions WHERE session_id=?').all(row.id) as ActionRow[];
    for (const file of baseline.files.filter(value => value.fingerprint)) {
      const move = moves.find(value => value.relative_path === file.relativePath);
      const root = move && !await exists(move.source_path) ? baseline.quarantineRoot : baseline.root;
      const relative = root === baseline.root ? file.relativePath : path.relative(root, move!.quarantine_path).split(path.sep).join('/');
      if (!same(await fingerprint(root, relative), file.fingerprint)) throw new LocalReviewError('审核文件内容或身份已变化，请核对原范围。');
    }
  }

  /** Persist a completion receipt once; status polling must not rebuild media evidence. */
  private async completedSummary(row: Row, target: LocalReviewTarget) {
    const quarantined = Number((this.db.prepare("SELECT COUNT(*) n FROM local_review_web_file_actions WHERE session_id=? AND state='moved'")
      .get(row.id) as { n: number }).n);
    const count = (value: unknown) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new LocalReviewError('原任务完成计数缺失，保留检查点等待核对。');
      return value;
    };
    if (target.kind === 'stage3') {
      const job = this.ingest.getJob(target.jobId), summary = job.summary;
      if (job.status !== 'ingested' || !summary) throw new LocalReviewError('原任务尚未完成，不能记录完成摘要。');
      return { images: count(summary.galleryIndexedImageCount ?? summary.imageCount), videos: count(summary.galleryIndexedVideoCount ?? summary.videoCount),
        retainedOriginals: count(summary.retainedOriginalCount ?? 0), retainedAttachments: count(summary.retainedAttachmentCount ?? 0), quarantined };
    }
    const data = this.folderState(target, row.creator_id);
    if (data.state.state !== 'completed' || data.state.post_id === null) throw new LocalReviewError('原接纳尚未完成指定图集索引，不能记录完成摘要。');
    const media = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN i.media_type='image' THEN 1 ELSE 0 END),0) images,
      COALESCE(SUM(CASE WHEN i.media_type='video' THEN 1 ELSE 0 END),0) videos
      FROM posts p JOIN post_items pi ON pi.post_id=p.id JOIN images i ON i.id=pi.image_id
      WHERE p.id=? AND p.is_deleted=0 AND p.is_trashed=0 AND i.is_deleted=0 AND i.is_trashed=0`).get(data.state.post_id) as { images: number; videos: number };
    const decisions = this.db.prepare(`SELECT payload_json FROM archive_catalog_work_decisions
      WHERE local_work_id=? AND kind='admission_file_removal' AND state='active'`).all(data.state.local_work_id)
      .map(value => JSON.parse(String(value.payload_json)) as { planId: string; itemKey: string; contentHash: string;
        retainOriginal?: boolean; entry: AdmissionPlan['items'][number]['manifest'][number] });
    for (const decision of decisions) if (decision.planId !== target.planId || decision.itemKey !== target.itemKey
      || decision.contentHash !== data.contentHash || !data.item.manifest.some(entry => same(entry, decision.entry))) throw new LocalReviewError('原恢复决定不属于已完成项目。');
    const removed = new Set(decisions.filter(value => !value.retainOriginal).map(value => value.entry.relativePath));
    const retained = decisions.filter(value => value.retainOriginal).map(value => value.entry);
    const attachments = data.item.manifest.filter(entry => entry.kind === 'other' && /\.(pdf|txt|url)$/i.test(entry.relativePath)
      && !removed.has(entry.relativePath) && !data.item.approvedAds.includes(entry.relativePath));
    // The original engine verified the full manifest before completion. Check the precise
    // retained destinations here too: choices alone are not proof that a file was preserved.
    for (const [entries, prefix] of [[retained, RETAINED_ORIGINALS_DIRECTORY], [attachments, '']] as const) {
      for (const entry of entries) {
        const filename = await safePath(data.item.targetPath, path.join(data.item.targetPath, prefix, entry.relativePath));
        const actual = await fs.lstat(filename, { bigint: true });
        if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1n || String(actual.dev) !== entry.dev
          || String(actual.ino) !== entry.ino || Number(actual.size) !== entry.size || String(actual.mtimeNs) !== entry.mtimeNs) throw new LocalReviewError('保留文件完成证据不匹配。');
      }
    }
    return { images: count(media.images), videos: count(media.videos), retainedOriginals: retained.length, retainedAttachments: attachments.length, quarantined };
  }

  private async perform(sessionId: string) {
    let row = this.row(sessionId);
    const baseline = JSON.parse(row.baseline_json!) as Baseline, confirmation = JSON.parse(row.choices_json!) as Confirmation;
    const target = localReviewTargetSchema.parse(JSON.parse(row.target_json));
    this.update(sessionId, { status: 'running', phase: 'verifying', owner_pid: process.pid, error: null });
    let result: unknown;
    if (target.kind === 'stage3') {
      result = await this.ingest.withWebReviewPreparation(target.jobId, async () => {
        this.assertIdle(target, row.creator_id);
        row = this.row(sessionId);
        let recovery: LocalIngestReviewPlan;
        if (row.recovery_json) recovery = JSON.parse(row.recovery_json) as LocalIngestReviewPlan;
        else {
          await this.validateRemainingFiles(row, baseline);
          const journal = this.db.prepare('SELECT * FROM local_review_web_file_actions WHERE session_id=?').all(row.id) as ActionRow[];
          const removed = [];
          for (const action of journal) if (!await exists(action.source_path)) removed.push({ relativePath: action.relative_path, size: JSON.parse(action.fingerprint_json).size as number });
          const before = await this.ingest.previewReview({ jobId: target.jobId, removedFiles: removed, retainedFiles: [], note: baseline.stage3!.request.note });
          const original = baseline.stage3!;
          // Only journaled removals may differ from the immutable initial archive/identity snapshot.
          const normalized = { ...before, planId: original.planId, files: original.files, removedFiles: [], request: original.request };
          if (reviewPlanHash(normalized) !== reviewPlanHash(original)) throw new LocalReviewError('原包、映射、检查点或目标自审核后变化。');
          const actual = before.files, removedSet = new Set(removed.map(file => file.relativePath));
          if (!same(actual, original.files.filter(file => !removedSet.has(file.relativePath)))) throw new LocalReviewError('未批准的媒体成员变化。');
          this.update(sessionId, { phase: 'preserving_files' });
          await this.moveSelected(row, baseline, confirmation);
          recovery = await this.ingest.previewReview({ jobId: target.jobId,
            removedFiles: confirmation.choices.filter(choice => choice.action === 'quarantine').map(choice => ({ relativePath: choice.relativePath, size: baseline.files.find(file => file.relativePath === choice.relativePath)!.size })),
            retainedFiles: [
              ...confirmation.choices.filter(choice => choice.action !== 'quarantine').map(choice => ({ relativePath: choice.relativePath, reason: choice.action === 'retain_original' ? 'pixel_limit' as const : 'attachment' as const })),
              ...baseline.files.filter(file => file.issue === 'advertisement_candidate'
                && !confirmation.choices.some(choice => choice.relativePath === file.relativePath)).map(file => ({ relativePath: file.relativePath, reason: 'attachment' as const }))
            ],
            note: confirmation.note });
          recovery = { ...recovery, confirmed: true };
          this.update(sessionId, { recovery_json: encoded(recovery) });
        }
        this.update(sessionId, { phase: 'resuming_original_job' });
        return this.ingest.resumeReview(recovery);
      });
      const job = result as ReturnType<LocalIngestService['getJob']>;
      if (job.status !== 'ingested') throw new LocalReviewError(`原任务停在 ${job.phase}: ${job.errorDetail ?? job.status}；保留原检查点，可继续原审核。`);
    } else {
      this.assertIdle(target, row.creator_id);
      const data = this.folderState(target, row.creator_id);
      if (data.contentHash !== baseline.contentHash || !same(data.plan, baseline.admission)) throw new LocalReviewError('原不可变接纳计划已变化。');
      if (data.state.state !== 'completed') {
        if (!row.recovery_json) {
          if (data.state.state !== 'files_verified' || data.state.post_id !== null) throw new LocalReviewError('当前不是原未完成文件审核阶段。');
          await this.validateRemainingFiles(row, baseline);
          const recover = { confirmed: true, planId: target.planId, key: `web-${row.id}`, reason: confirmation.note,
            evidence: `网页具体文件确认；受控移出证据见 local_review_web_file_actions，审核 ${row.id}`,
            removals: confirmation.choices.map(choice => {
              const entry = data.item.manifest.find(value => value.relativePath === choice.relativePath);
              if (!entry) throw new LocalReviewError('选择不属于原manifest。');
              return { itemKey: target.itemKey, entry, ...(choice.action === 'retain_original' ? { retainOriginal: true } : {}),
                ...(choice.reason === 'advertisement' ? { approvedAdvertisement: true } : {}) };
            }) };
          if (recover.removals.length) await this.folder.recover(recover, async () => {
            this.assertIdle(target, row.creator_id);
            await this.validateRemainingFiles(row, baseline);
            const current = await inventoryAdmissionDirectory(baseline.root);
            const removed = this.db.prepare('SELECT relative_path,source_path FROM local_review_web_file_actions WHERE session_id=?').all(row.id) as Array<{ relative_path: string; source_path: string }>;
            const absent = new Set<string>(); for (const file of removed) if (!await exists(file.source_path)) absent.add(file.relative_path);
            if (!same(current, baseline.inventory!.filter(entry => !absent.has(entry.relativePath)))) throw new LocalReviewError('未批准的目录成员或文件事实变化。');
            // Recheck the safety-limit diagnosis immediately before storing its recovery decision.
            for (const choice of confirmation.choices.filter(value => value.action === 'retain_original')) {
              const check = await this.classify(baseline.root, choice.relativePath, data.item.manifest.find(file => file.relativePath === choice.relativePath)!.size, false);
              if (check.issue !== 'pixel_limit') throw new LocalReviewError('当前解码器未确认JPEG像素上限，不授予其他解码例外。');
            }
            this.update(sessionId, { phase: 'preserving_files' });
            await this.moveSelected(row, baseline, confirmation);
          });
          this.update(sessionId, { recovery_json: encoded(recover) });
        }
        this.update(sessionId, { phase: 'resuming_original_plan' });
        result = await this.folder.apply(data.plan);
      } else {
        if (!row.recovery_json) throw new LocalReviewError('项目已由其他操作完成；本审核未执行，不修改已完成作品。');
        result = { completed: true, planId: target.planId };
      }
    }
    const summary = await this.completedSummary(row, target);
    this.update(sessionId, { status: 'completed', phase: 'completed', owner_pid: null, error: null,
      result_json: encoded({ completed: true, message: '原任务已完成；可恢复附件和原件按确认范围保留。', summary,
        ...(target.kind === 'stage3' ? { jobId: target.jobId } : { planId: target.planId }) }) });
  }
}
