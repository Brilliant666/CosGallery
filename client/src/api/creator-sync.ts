import { requestJson } from './http';
import type { ArchiveDownloadTask, ArchiveDownloadTaskStatus, ArchiveDownloadTaskSummary, ArchiveMetadataTask, ArchiveSourceState } from '../types/api';

export interface CreatorSyncFilters {
  q?: string;
  preference?: 'all' | 'liked' | 'kept' | 'unset';
  rating?: 'all' | 'R15' | 'R18' | 'unclassified';
  enabled?: 'all' | 'enabled' | 'disabled';
  local?: 'all' | 'present' | 'absent';
  source?: 'all' | 'present' | 'absent';
}
export interface SyncPage<T> { items: T[]; total: number; page: number; limit: number; hasMore: boolean; readAt: string }
export interface CreatorSyncRow {
  creatorId: number; creatorName: string; aliases: string[]; isActive: boolean;
  preference: 'liked' | 'kept' | null; rating: 'R15' | 'R18' | null;
  localWorks: number; sourceWorks: number; missingWorks: number; sourceCollections: number;
  latestSourceAt: string | null; sourceState: ArchiveSourceState;
  /** Optional while a new client is served by an older backend. */
  pendingSupplementalTitles?: string[];
  metadataTask: Pick<ArchiveMetadataTask, 'id' | 'status' | 'attemptCount' | 'claimedBy' | 'claimedAt' | 'completedAt' | 'lastError' | 'updatedAt'> | null;
}
export interface CreatorSyncStats {
  readAt: string;
  creators: { total: number; enabled: number; disabled: number; withLocal: number; withSource: number };
  works: { source: number; local: number; matchedLocal: number; unresolvedLocal: number; missing: number };
  execution: { metadata: Record<string, number>; download: ArchiveDownloadTaskSummary; ingest: Record<string, number> };
  unlinkedLocalFolders: { total: number; localWorks: number };
}
export type MetadataCreatorPage = SyncPage<CreatorSyncRow> & {
  summary: { sourceCreators: number; sourceCollections: number; taskTotal: number; tasks: Record<ArchiveMetadataTask['status'] | 'total', number> };
};
export interface DownloadCreatorSummary {
  localSatisfied?: number;
  acquisitionReviewRequired?: number;
  creatorId: number; creatorName: string; preference: 'liked' | 'kept' | null;
  rating: 'R15' | 'R18' | null; isActive: boolean; total: number; summary: ArchiveDownloadTaskSummary;
}
export type DownloadCreatorPage = SyncPage<DownloadCreatorSummary> & { summary: ArchiveDownloadTaskSummary; taskTotal: number };
export type DownloadTaskPage = SyncPage<ArchiveDownloadTask> & { summary: ArchiveDownloadTaskSummary };
export type DownloadFilters = CreatorSyncFilters & { status?: ArchiveDownloadTaskStatus };
function query(options: object) {
  return new URLSearchParams(Object.entries(options).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString();
}
const root = '/api/admin/archive-catalog';
export function fetchCreatorSyncRoster(options: CreatorSyncFilters & { page?: number; limit?: number }) {
  return requestJson<SyncPage<CreatorSyncRow>>(`${root}/creator-sync/roster?${query(options)}`);
}
export function fetchCreatorSyncStats(options: CreatorSyncFilters = {}) {
  return requestJson<CreatorSyncStats>(`${root}/creator-sync/stats?${query(options)}`);
}
export function fetchMetadataCreators(options: CreatorSyncFilters & { page?: number; limit?: number } = {}) {
  return requestJson<MetadataCreatorPage>(`${root}/creator-sync/metadata-creators?${query(options)}`);
}
export function fetchDownloadCreators(options: DownloadFilters & { page?: number; limit?: number } = {}) {
  return requestJson<DownloadCreatorPage>(`${root}/download-creators?${query(options)}`);
}
export function fetchDownloadTaskPage(options: DownloadFilters & { creatorId: number; page?: number; limit?: number }) {
  if (!Number.isSafeInteger(options.creatorId) || options.creatorId <= 0) return Promise.reject(new Error('必须指定规范博主 ID。'));
  return requestJson<DownloadTaskPage>(`${root}/download-task-page?${query(options)}`);
}
