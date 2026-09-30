import type { AdmissionBatch, AdmissionExecutionTotals, AdmissionItem } from '../types/local-admission';

const indexingError = 'Scoped media indexing did not complete';
const chineseMessageStart = /^\s*[“「（【]?\s*[\u3400-\u9fff]/;

/** Keep raw errors available as evidence, while the visible notice stays in Chinese. */
export function admissionErrorMessage(error?: string | null, message?: string | null): string {
  if (message && chineseMessageStart.test(message)) return message;
  if (!error && !message) return '';
  if (error?.includes(indexingError) || message?.includes(indexingError)) return '图集索引未完成，请核对异常文件';
  if (error && chineseMessageStart.test(error)) return error;
  return '入库未完成，请查看技术详情并核对原因';
}

export function admissionItemError(item: AdmissionItem): string {
  return admissionErrorMessage(item.lastError, item.errorMessage ?? item.executionIssue?.message);
}

export function admissionIssueKind(item: AdmissionItem): 'review' | 'dependency' | 'system' | undefined {
  if (item.executionIssue) return item.executionIssue.kind;
  if (item.lastError) return 'system';
  return undefined;
}

export function admissionItemPhase(item: AdmissionItem): string {
  const kind = admissionIssueKind(item);
  if (kind === 'review') return '待审核';
  if (kind === 'dependency') return '等待依赖';
  const phase = ({
    completed: '已完成', skip: '跳过，等待区保留', skipped: '跳过，等待区保留',
    defer: '人工暂缓，等待区保留', deferred: '人工暂缓，等待区保留',
    not_started: '尚未执行', new: '尚未执行', existing: '尚未执行', planned: '尚未执行', pending: '尚未执行',
    preview: '预览', move_intent: '移动检查点', files_verified: '文件已核验', moving: '目录移动', moved: '目录已移动',
    indexing: '媒体索引', indexed: '已索引', linking: '来源关联', failed: '异常暂停', needs_review: '待审核'
  } as Record<string, string>)[item.state] ?? '状态待核对';
  return kind === 'system' && phase !== '异常暂停' ? `异常暂停 · ${phase}` : phase;
}

export function admissionExecutionSummary(totals: AdmissionExecutionTotals, items: AdmissionItem[] = []): string {
  const review = totals.review ?? items.filter(item => admissionIssueKind(item) === 'review').length;
  const dependency = totals.dependency ?? items.filter(item => admissionIssueKind(item) === 'dependency').length;
  const unstarted = totals.unstarted ?? Math.min(
    items.filter(item => !admissionIssueKind(item) && ['not_started', 'new', 'existing', 'planned', 'pending'].includes(item.state)).length,
    Math.max(0, totals.selected - totals.completed - review - dependency)
  );
  return `${totals.completed} 已完成 · ${review} 待审核 · ${dependency} 等待依赖 · ${unstarted} 尚未执行 · ${totals.deferred} 人工暂缓 · ${totals.skipped} 跳过`;
}

export function admissionQueueNotice(active: boolean, items: AdmissionItem[], batches: AdmissionBatch[]): string {
  const currentItems = items.filter(item => item.currentDisposition?.status !== 'completed_later');
  const system = currentItems.find(item => admissionIssueKind(item) === 'system');
  const retained = currentItems.some(item => ['review', 'dependency'].includes(admissionIssueKind(item) ?? ''));
  // Retry keeps the old item diagnostics until the new attempt updates them.
  if (active) return retained ? '异常项已保留，其余可执行图集继续处理' : system ? '服务端正在执行，异常结果仍保留，请等待最新进度' : '';
  if (system) return `队列因异常暂停：${admissionItemError(system) || '请查看技术详情并核对原因'}`;
  // Old batches may have a batch-level failure without item diagnostics.
  const failed = batches.find(batch => {
    if (batch.state === 'failed' || batch.state === 'interrupted') return true;
    if (batch.state !== 'needs_review' || !batch.error) return false;
    // This summary is emitted only after apply finishes all executable items.
    if (batch.error === '部分图集需要核对；其余独立图集已按原计划执行') return false;
    return !(batch.items ?? []).some(item => admissionIssueKind(item) === 'review' && (
      batch.error === item.lastError || batch.error === item.executionIssue?.detail || batch.error === item.executionIssue?.message
    ));
  });
  if (failed) return `队列已暂停：${admissionErrorMessage(failed.error, failed.errorMessage) || '请核对中断原因后继续原计划'}`;
  const unstarted = batches.some(batch => (batch.totals?.unstarted ?? 0) > 0)
    || currentItems.some(item => !admissionIssueKind(item) && ['not_started', 'new', 'existing', 'planned', 'pending'].includes(item.state));
  if (unstarted) return '本计划仍有未执行项，请核对原因后继续';
  if (retained) return '可执行项目已处理，剩余项目待审核或等待依赖';
  return '';
}
