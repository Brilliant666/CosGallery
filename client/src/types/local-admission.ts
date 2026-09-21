export interface AdmissionPage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface AdmissionSettings { waitingRoot: string; galleryRoot: string; archiveInboxRoot: string }
export interface AdmissionDirectory {
  name: string; selectable: boolean; reason?: string; matchedCreatorIds: number[]; matchesSelectedCreator: boolean;
}
export interface AdmissionDirectories {
  root: string; parent: string | null; creator: { id: number; name: string }; items: AdmissionDirectory[];
}
export interface AdmissionSource {
  sourceWorkId: number; title: string; sourceOrder: number | string | null; mediaSummary: string | null; taskIds: number[];
}
export interface AdmissionWork {
  workId: number; title: string; catalogNo: number | string | null; images: number; videos: number;
  thumbnailUrl: string | null; primaryLocalWorkId: number | null; localState: string;
  originalDirectories: string[]; sources: AdmissionSource[];
}
export type AdmissionActionKind = 'new' | 'existing' | 'same-as' | 'skip' | 'defer';
export interface AdmissionAction {
  key: string; action: AdmissionActionKind; workId?: number; sameAsKey?: string; primary?: boolean;
  displayTitle?: string; approvedAds?: string[]; acceptSourceIds?: number[]; reason?: string;
}
export interface AdmissionItem {
  key: string; sourceRelativePath: string; targetPath: string; displayTitle: string; group: 'A' | 'B' | 'C' | 'D';
  summary: { images: number; videos: number; other: number; bytes: number }; candidates: AdmissionWork[];
  conflicts: string[]; ads: Array<{ relativePath: string; size: number }>; state: string; lastError?: string | null;
  workId?: number | null; localWorkId?: number | null; postId?: number | null;
  suggestedAction?: AdmissionAction;
}
export type AdmissionState = 'draft' | 'queued' | 'running' | 'completed' | 'needs_review' | 'interrupted' | 'failed';
export interface AdmissionBatch {
  id: string; planId: string | null; creatorId: number; creatorName: string; state: AdmissionState;
  createdAt: string; updatedAt: string; error?: string | null; inputRoot: string; sourceEvidenceId?: number | null;
  totals: { total: number; selected: number; completed: number; skipped: number; deferred: number };
  items?: AdmissionItem[];
}
export interface AdmissionPreviewInput {
  creatorId: number; parent: string; directories: string[]; sourceEvidenceId?: number; acceptExistingVersion: boolean;
}
export interface AdmissionExecuteInput {
  requestKey: string; confirmed: true; acceptExistingVersion: boolean; actions: AdmissionAction[]; adsConfirmed?: true;
}
export interface AdmissionResumeInput { requestKey: string; confirmed: true }
