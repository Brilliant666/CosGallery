import { requestJson } from './http';
export type WorkRemovalMode = 'trash' | 'restore' | 'permanent';
export interface WorkRemovalPreview {
  previewToken: string;
  work: { id: number; title: string; creatorId: number };
  mode: WorkRemovalMode;
  localCopies: {
    id: number;
    directoryName: string;
    path: string;
    postId: number | null;
    imageCount: number;
    videoCount: number;
    fileCount: number;
    bytes: number;
  }[];
  fileCount: number;
  totalBytes: number;
  blockers: string[];
  canExecute: boolean;
}
export interface WorkRemovalResult {
  operationId: number | string;
  workId: number;
  mode: WorkRemovalMode;
  state:
    | 'completed'
    | 'committed'
    | 'cleanup_pending'
    | 'recovery_pending'
    | 'failed';
  filesRemoved: boolean;
  cleanupPending: boolean;
  recoveryPending?: boolean;
  message?: string | null;
}
export interface PendingWorkRemoval extends WorkRemovalResult {
  title: string;
}
export interface TrashedWork {
  workId: number;
  title: string;
  creatorId: number;
  localCopyCount: number;
  trashedAt: string;
}
export const previewWorkRemoval = (
  workId: number,
  mode: WorkRemovalMode,
  revision?: string,
  revisionScope?: 'all' | 'creator',
) =>
  requestJson<WorkRemovalPreview>(`/api/works/${workId}/removal-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, revision, revisionScope }),
  });
export const executeWorkRemoval = (workId: number, previewToken: string) =>
  requestJson<WorkRemovalResult>(`/api/works/${workId}/removal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewToken }),
  });
export const fetchTrashedWorks = () =>
  requestJson<{
    items: TrashedWork[];
    pendingOperations?: PendingWorkRemoval[];
  }>('/api/trash/works');
export const retryWorkRemoval = (operationId: string | number) =>
  requestJson<WorkRemovalResult>(
    `/api/work-removal-operations/${encodeURIComponent(operationId)}/retry`,
    { method: 'POST' },
  );
