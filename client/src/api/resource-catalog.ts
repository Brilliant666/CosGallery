import { AUTH_REQUIRED_EVENT, RequestError, requestJson } from './http';

export interface ResourceSource {
  sourceWorkId: number;
  platform: string;
  sourceOrder: number | null;
  sourceOrderLabel: string | null;
  title: string;
  mediaSummary: string | null;
  url: string | null;
  active: boolean;
}
export interface ResourceRow {
  creatorId: number;
  creatorName: string;
  workId: number;
  no: string | null;
  title: string;
  sortTimestamp: number | null;
  primaryPostId: number | null;
  primaryLocalWorkId: number | null;
  imageCount: number | null;
  videoCount: number | null;
  mediaBytes: number | null;
  originalDirectory: string | null;
  localState: string;
  reason: string | null;
  statisticsBasis: 'indexed' | 'last-indexed' | 'unknown';
  copyCount: number;
  sources: ResourceSource[];
  text: string;
}
export interface ResourceReadModel {
  status: 'ready' | 'updating' | 'uninitialized' | 'failed';
  complete: boolean;
  pendingCreators: number;
  failedCreators: number;
  initializedCreators: number;
  totalCreators: number;
  updatedAt: string | null;
}
export interface ResourcePage {
  creator: { id: number; canonicalName: string } | null;
  readModel: ResourceReadModel;
  revision: string;
  generatedAt: string;
  sortOrder: 'newest' | 'oldest';
  summary: {
    totalWorks: number;
    numberedWorks: number;
    unarrangedWorks: number;
    multipleCopyWorks: number;
    unavailableWorks: number;
    sourceOnlyWorks: number;
    legacyPosts: number;
    excludedDeletedWorks: number;
  };
  legacyGaps: { postId: number; title: string; reason: string; creatorId?: number; creatorName?: string }[];
  items: ResourceRow[];
  page: number;
  pageSize: number;
  total: number;
}
export interface ResourceDetail {
  readModel: ResourceReadModel;
  revision: string;
  item: ResourceRow;
  copies: {
    localWorkId: number;
    postId: number | null;
    directoryName: string;
    primary: boolean;
    indexedAvailable: boolean;
    imageCount: number | null;
    videoCount: number | null;
    mediaBytes: number | null;
    otherFileCount: number | null;
    retainedOriginalCount: number | null;
  }[];
  notes: string[];
}
export interface ResourceFilters {
  q: string;
  localState: string;
  source: string;
  order?: 'newest' | 'oldest';
}
export interface ResourceCreator {
  id: number;
  canonicalName: string;
  preference: string | null;
  enabled: boolean;
}
const root = '/api/admin/archive-catalog/resource-catalog';
const params = (value: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)])
  );
export const findResourceCreators = (q: string) =>
  requestJson<{ items: ResourceCreator[]; total: number }>(
    `${root}/creators?${params({ q })}`
  );
export const fetchResourceCatalog = (
  id: number | null,
  filters: ResourceFilters,
  page: number,
  revision?: string
) =>
  requestJson<ResourcePage>(
    `${root}/${id ?? 'all'}?${params({ ...filters, page, pageSize: 50, revision })}`
  );
export const fetchResourceDetail = (
  id: number,
  workId: number,
  revision: string,
  revisionScope?: 'all'
) =>
  requestJson<ResourceDetail>(
    `${root}/${id}/works/${workId}?${params({ revision, revisionScope })}`
  );
export async function exportResourceCatalog(
  id: number | null,
  filters: ResourceFilters,
  revision: string,
  scope: 'all' | 'filtered',
  format: 'txt' | 'csv'
) {
  const response = await fetch(
    `${root}/${id ?? 'all'}/export?${params({ ...filters, revision, scope, format })}`,
    { credentials: 'same-origin', cache: 'no-store' }
  );
  if (!response.ok) {
    if (
      response.status === 401 &&
      response.headers.get('x-foldergram-auth-required') === '1'
    )
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    throw new RequestError('导出失败，请稍后重试。', response.status);
  }
  let metadata: Record<string, unknown> | null = null;
  if (format === 'csv') {
    try {
      const header = response.headers.get('X-Resource-Catalog-Metadata');
      if (!header) throw new Error('missing');
      const parsed: unknown = JSON.parse(decodeURIComponent(header));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      metadata = parsed as Record<string, unknown>;
      if (metadata.revision !== revision || metadata.scope !== scope || metadata.creatorId !== id || typeof metadata.generatedAt !== 'string' || !Number.isSafeInteger(metadata.rowCount)) throw new Error('mismatch');
    } catch {
      throw new Error('CSV 缺少有效的同版本元信息，未下载，请刷新后重试。');
    }
  }
  return { text: await response.text(), metadata };
}
