import { requestJson } from './http';

export interface SourceReuseItem {
  creatorId: number; creatorName: string; collectionId: number;
  sourceOrder: string | number; rawTitle: string; normalizedTitle: string;
  status: 'review' | 'reuse' | 'existing'; reason: string; satisfied: boolean;
  workId?: number; localWorkId?: number; ruleVersion: string | number;
}
export interface SourceReusePage { items: SourceReuseItem[]; total: number; page: number; limit: number; hasMore: boolean }
export function fetchSourceReuse(page = 1) {
  return requestJson<SourceReusePage>(`/api/admin/archive-catalog/creator-sync/source-reuse?page=${page}&limit=20`);
}
