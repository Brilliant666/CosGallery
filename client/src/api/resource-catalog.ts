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
export interface ResourcePage {
  creator: { id: number; canonicalName: string };
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
  legacyGaps: { postId: number; title: string; reason: string }[];
  items: ResourceRow[];
  page: number;
  pageSize: number;
  total: number;
}
export interface ResourceDetail {
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
  id: number,
  filters: ResourceFilters,
  page: number,
  revision?: string
) =>
  requestJson<ResourcePage>(
    `${root}/${id}?${params({ ...filters, page, pageSize: 50, revision })}`
  );
export const fetchResourceDetail = (
  id: number,
  workId: number,
  revision: string
) =>
  requestJson<ResourceDetail>(
    `${root}/${id}/works/${workId}?${params({ revision })}`
  );
export async function exportResourceCatalog(
  id: number,
  filters: ResourceFilters,
  revision: string,
  scope: 'all' | 'filtered',
  format: 'txt' | 'csv'
) {
  const response = await fetch(
    `${root}/${id}/export?${params({ ...filters, revision, scope, format })}`,
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
  return response.text();
}
