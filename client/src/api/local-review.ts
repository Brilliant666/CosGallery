import { requestJson } from './http';
export type LocalReviewTarget = { kind: 'stage3'; jobId: number } | { kind: 'admission'; planId: string; itemKey: string };
export type LocalReviewAction = 'retain_original' | 'retain_attachment' | 'quarantine';
export type LocalReviewReason = 'pixel_limit' | 'decode_failed' | 'attachment' | 'damaged' | 'advertisement';
export interface LocalReviewChoice { relativePath: string; action: LocalReviewAction; reason: LocalReviewReason }
export interface LocalReviewEligibility { target: LocalReviewTarget; creatorId: number; title: string; eligible: boolean; reason: string | null; sessionId: string | null }
export interface LocalReviewFile {
  relativePath: string; size: number; kind: 'image' | 'video' | 'attachment' | 'other';
  issue: 'pixel_limit' | 'decode_failed' | 'attachment' | 'damaged' | 'advertisement_candidate' | 'unsupported' | null;
  allowedActions: LocalReviewAction[]; suggestedAction: LocalReviewAction | null; message?: string;
  preservedAt?: string | null; actionState?: string | null;
}
export interface LocalReviewFiles { items: LocalReviewFile[]; total: number; page: number; limit: number }
export interface LocalReviewExecuteInput { requestKey: string; confirmed: true; note: string; choices: LocalReviewChoice[]; quarantineConfirmed?: boolean }
export interface LocalReviewSession {
  sessionId: string; creatorId: number; target: LocalReviewTarget; title: string;
  status: 'preparing' | 'ready' | 'submitted' | 'running' | 'interrupted' | 'completed' | 'failed';
  totalFiles: number; issueCount: number; error: string | null; confirmed: boolean; choices: LocalReviewChoice[];
  phase: string; message: string; completedFileActions: number; fileActionCount: number;
  previewNeedsRefresh?: boolean;
  continuation?: { totalItems: number; completedItems: number; pendingItems: number };
  result: { completed: boolean; message: string; jobId?: number; planId?: string;
    summary?: { images: number; videos: number; retainedOriginals: number; retainedAttachments: number; quarantined: number };
  } | null;
}
const root = '/api/admin/local-review';
const send = <T>(path: string, input: unknown) => requestJson<T>(`${root}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
export function fetchLocalReviewTarget(target: LocalReviewTarget, creatorId: number) {
  const params = new URLSearchParams({ creatorId: String(creatorId), kind: target.kind });
  if (target.kind === 'stage3') params.set('jobId', String(target.jobId));
  else { params.set('planId', target.planId); params.set('itemKey', target.itemKey); }
  return requestJson<LocalReviewEligibility>(`${root}/target?${params}`);
}
export const createLocalReviewSession = (target: LocalReviewTarget, creatorId: number, requestKey: string) => send<{ sessionId: string; status: 'preparing' }>('/sessions', { target, creatorId, requestKey });
export const fetchLocalReviewSession = (id: string) => requestJson<LocalReviewSession>(`${root}/sessions/${encodeURIComponent(id)}`);
export const refreshLocalReviewSession = (id: string, requestKey: string) => send<LocalReviewSession>(`/sessions/${encodeURIComponent(id)}/refresh`, { requestKey });
export const fetchLocalReviewFiles = (id: string, page = 1, issuesOnly = true) => requestJson<LocalReviewFiles>(`${root}/sessions/${encodeURIComponent(id)}/files?page=${page}&limit=50&issuesOnly=${issuesOnly}`);
export const executeLocalReview = (id: string, input: LocalReviewExecuteInput) => send<LocalReviewSession>(`/sessions/${encodeURIComponent(id)}/execute`, input);
export const retryLocalReview = (id: string, requestKey: string) => send<LocalReviewSession>(`/sessions/${encodeURIComponent(id)}/retry`, { requestKey });
