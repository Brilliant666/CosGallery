export type AdmissionExecutionIssue = {
  kind: 'review' | 'dependency' | 'system';
  code: string;
  message: string;
  detail?: string;
  blockedByItemKey?: string;
};

const prefix = 'local-admission-execution-issue-v1:';

export function encodeAdmissionIssue(issue: AdmissionExecutionIssue): string {
  return prefix + JSON.stringify(issue);
}

export function decodeAdmissionIssue(value: unknown): AdmissionExecutionIssue | undefined {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
  try {
    const issue = JSON.parse(value.slice(prefix.length));
    if (!issue || !['review', 'dependency', 'system'].includes(issue.kind)
      || typeof issue.code !== 'string' || typeof issue.message !== 'string'
      || (issue.detail !== undefined && typeof issue.detail !== 'string')
      || (issue.blockedByItemKey !== undefined && typeof issue.blockedByItemKey !== 'string')) return undefined;
    return issue as AdmissionExecutionIssue;
  } catch { return undefined; }
}

export function admissionErrorDetail(value: string | null): string | null {
  const issue = decodeAdmissionIssue(value);
  return issue ? issue.detail ?? issue.message : value;
}

export function admissionErrorMessage(value: string | null): string | null {
  if (!value) return null;
  const issue = decodeAdmissionIssue(value);
  if (issue) return issue.message;
  if (value === 'Scoped media indexing did not complete') return '图集索引未完成，请核对异常文件';
  if (value.startsWith('Scoped media indexing did not complete:')) return '图集索引未完成，请查看技术详情并核对原因';
  if (/Scoped Post was not found/.test(value)) return '图集索引后未找到作品记录，请核对原因后继续原计划';
  if (/Both source and target exist or both are absent/.test(value)) return '原目录与目标目录的状态不确定，请先核对文件位置';
  if (/Directory changed since confirmation|Source changed since preview|Moved directory manifest differs/.test(value)) return '目录文件与原确认内容不一致，请先核对文件变化';
  if (/Target exists|Target occupied/.test(value)) return '目标目录已被占用，请先核对，不能覆盖';
  if (/Cross-volume/.test(value)) return '原目录和目标目录不在同一磁盘，当前无法安全移动';
  if (/^[\u3400-\u9fff]/u.test(value.trim())) return value;
  return '入库未完成，请查看技术详情并核对原因';
}

export class AdmissionReviewRequiredError extends Error {
  constructor(readonly issue: AdmissionExecutionIssue) { super(issue.detail ?? issue.message); }
}
