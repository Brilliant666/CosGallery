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
  /** Unsubmitted UI choice provenance; not part of the execution payload. */
  selectionOrigin?: 'automatic' | 'manual';
  cancelledAds?: string[];
}
export interface AdmissionItem {
  key: string; sourceRelativePath: string; targetPath: string; displayTitle: string; group: 'A' | 'B' | 'C' | 'D';
  summary: { images: number; videos: number; other: number; bytes: number }; candidates: AdmissionWork[];
  conflicts: string[]; ads: Array<{ relativePath: string; size: number; automatic?: boolean }>; state: string; lastError?: string | null;
  workId?: number | null; localWorkId?: number | null; postId?: number | null;
  suggestedAction?: AdmissionAction;
  structureWarnings?: string[];
  needsBoundaryReview?: boolean;
  reviewFingerprint?: string;
  nextAction?: 'review_files' | 'resume_plan' | 'prepare_preview' | 'none';
  nextActionReason?: string;
  executionState?: string | null;
}
export type AdmissionState = 'draft' | 'queued' | 'running' | 'completed' | 'needs_review' | 'interrupted' | 'failed';
export interface AdmissionBatch {
  id: string; planId: string | null; creatorId: number; creatorName: string; state: AdmissionState;
  createdAt: string; updatedAt: string; error?: string | null; inputRoot: string; sourceEvidenceId?: number | null;
  totals: { total: number; selected: number; completed: number; skipped: number; deferred: number };
  items?: AdmissionItem[];
  collectionId?: string | null;
  parentCleanup?: {status:'recycled'|'not_empty'|'failed'|'not_applicable';message:string};
}
export interface AdmissionPreviewInput {
  creatorId: number; parent: string; directories: string[]; sourceEvidenceId?: number; acceptExistingVersion: boolean;
}
export interface AdmissionExecuteInput {
  requestKey: string; confirmed: true; acceptExistingVersion: boolean; actions: AdmissionAction[]; adsConfirmed?: true;
  advertisementDisposition?: 'recycle_bin';
}
export interface AdmissionResumeInput { requestKey: string; confirmed: true }
export interface AdmissionCreator { id: number; name: string; aliases: string[] }
export interface AdmissionWorkspace extends AdmissionSettings {
  items: Array<{name: string; selectable: boolean; reason?: string; matches: Array<{creatorId:number;creatorName:string;matchedName:string;matchKind:'canonical'|'alias'}>}>;
}
export interface AdmissionCollection {
  id:string; state:'draft'|'queued'|'running'|'completed'|'partial'|'interrupted'; createdAt:string;updatedAt:string;error:string|null;
  totals:{creators:number;total:number;selected:number;completed:number;skipped:number;deferred:number;failedCreators:number};
  batches:Array<AdmissionBatch & {parent:string}>;
  previousCollectionId?:string|null;
  nextCollectionIds?:string[];
  remainingCount?:number;
  directoryRefresh?: {
    added:Array<{creatorId:number;parent:string;name:string}>;
    removed:Array<{creatorId:number;parent:string;name:string}>;
    warnings:string[];
  };
}
export interface AdmissionCollectionExecuteInput {
  requestKey:string;confirmed:true;
  batches:Array<{batchId:string;acceptExistingVersion:boolean;adsConfirmed?:true;advertisementDisposition?:'recycle_bin';actions:AdmissionAction[]}>;
}
