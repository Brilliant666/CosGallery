import type { FolderSummary } from '../types/api';

const RECENT_CREATOR_COUNT = 8;

export function creatorIdentity(folder: FolderSummary): string {
  return folder.canonicalCreatorId != null
    ? `creator:${folder.canonicalCreatorId}`
    : `folder:${folder.id}`;
}

export function selectRecentCreators(
  folders: FolderSummary[],
  recentHistoryKeys: string[]
): FolderSummary[] {
  const eligibleFolders = folders.filter((folder) => (folder.postCount ?? folder.imageCount) > 0);
  const folderBySlug = new Map(eligibleFolders.map((folder) => [folder.slug, folder]));
  const folderByCreator = new Map<string, FolderSummary>();
  for (const folder of eligibleFolders) {
    const identity = creatorIdentity(folder);
    if (!folderByCreator.has(identity)) folderByCreator.set(identity, folder);
  }

  const selected: FolderSummary[] = [];
  const seen = new Set<string>();
  for (const key of recentHistoryKeys) {
    // Existing browser history contains slugs; new creator routes record stable identities.
    const folder = key.startsWith('creator:') ? folderByCreator.get(key) : folderBySlug.get(key);
    if (!folder) continue;
    const identity = creatorIdentity(folder);
    if (seen.has(identity)) continue;
    seen.add(identity);
    selected.push(folder);
    if (selected.length === RECENT_CREATOR_COUNT) break;
  }
  return selected;
}
