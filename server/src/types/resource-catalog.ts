export type ResourceCatalogState = 'indexed' | 'unavailable' | 'unarranged';
export interface ResourceCatalogSource {
  sourceWorkId: number;
  platform: string;
  sourceOrder: number | null;
  sourceOrderLabel: string | null;
  title: string;
  mediaSummary: string | null;
  url: string | null;
  active: boolean;
}
export interface ResourceCatalogRow {
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
  localState: ResourceCatalogState;
  reason: string | null;
  statisticsBasis: 'indexed' | 'last-indexed' | 'unknown';
  copyCount: number;
  sources: ResourceCatalogSource[];
  text: string;
}
export interface ResourceCatalogCopy {
  localWorkId: number;
  postId: number | null;
  directoryName: string;
  primary: boolean;
  indexedAvailable: boolean;
  imageCount: number | null;
  videoCount: number | null;
  mediaBytes: number | null;
  otherFileCount: number;
  retainedOriginalCount: number | null;
}
export interface ResourceCatalogPage {
  creator: {
    id: number;
    canonicalName: string;
  };
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
  items: ResourceCatalogRow[];
  page: number;
  pageSize: number;
  total: number;
  legacyGaps: Array<{
    postId: number;
    title: string;
    reason: string;
  }>;
}
export interface ResourceCatalogFilter {
  q?: string;
  localState?: 'all' | ResourceCatalogState;
  source?: 'all' | 'linked' | 'unlinked';
  page?: number;
  pageSize?: number;
  revision?: string;
}
export interface ResourceCatalogDetail {
  revision: string;
  item: ResourceCatalogRow;
  copies: ResourceCatalogCopy[];
  notes: string[];
}
