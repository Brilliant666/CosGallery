import type { FolderSummary } from '../types/api';

const RECENT_SELECTION_COUNT = 4;
const RANKED_SELECTION_COUNT = 8;
const DISCOVERY_SELECTION_COUNT = 8;
const TOTAL_SELECTION_COUNT = RECENT_SELECTION_COUNT + RANKED_SELECTION_COUNT + DISCOVERY_SELECTION_COUNT;
const DISCOVERY_POOL_SIZE = 36;
const RECENT_ACTIVITY_WINDOW_MS = 1000 * 60 * 60 * 24 * 45;
const DIVERSITY_SOFT_LIMIT = 2;
const DIVERSITY_RELAXED_LIMIT = 3;

interface RankedSidebarFolder {
  folder: FolderSummary;
  score: number;
  likedImageCount: number;
}

export function selectSidebarFolders(
  folders: FolderSummary[],
  likedCountByFolder: Map<string, number>,
  recentOpenedFolderSlugs: string[],
  now = new Date()
): FolderSummary[] {
  if (folders.length === 0) {
    return [];
  }

  const eligibleFolders = folders.filter((folder) => folder.imageCount > 0);
  const candidates = eligibleFolders.length > 0 ? eligibleFolders : folders;
  const folderBySlug = new Map(candidates.map((folder) => [folder.slug, folder] as const));
  const selectedFolders: FolderSummary[] = [];
  const selectedSlugs = new Set<string>();
  const diversityCounts = new Map<string, number>();

  const recentFolders = recentOpenedFolderSlugs
    .map((slug) => folderBySlug.get(slug))
    .filter((folder): folder is FolderSummary => Boolean(folder))
    .slice(0, RECENT_SELECTION_COUNT);

  appendUniqueFolders(selectedFolders, recentFolders, selectedSlugs, diversityCounts);

  const rankedCandidates = candidates
    .filter((folder) => !selectedSlugs.has(folder.slug))
    .map((folder) => ({
      folder,
      score: getSidebarFolderScore(folder, likedCountByFolder, now.getTime()),
      likedImageCount: likedCountByFolder.get(folder.slug) ?? 0
    }))
    .sort(compareRankedFolders);

  appendFoldersWithDiversity(
    selectedFolders,
    rankedCandidates.map(({ folder }) => folder),
    RANKED_SELECTION_COUNT,
    selectedSlugs,
    diversityCounts
  );

  const remainingDiscoveryCandidates = rankedCandidates
    .map(({ folder }) => folder)
    .filter((folder) => !selectedSlugs.has(folder.slug));
  const discoverySeed = `${createDailySeed(now)}:${candidates.length}:${recentOpenedFolderSlugs.slice(0, 4).join('|')}`;
  const discoveryPool = buildDiscoveryPool(remainingDiscoveryCandidates, discoverySeed);

  appendFoldersWithDiversity(
    selectedFolders,
    discoveryPool,
    DISCOVERY_SELECTION_COUNT,
    selectedSlugs,
    diversityCounts
  );

  const fallbackCandidates = rankedCandidates.map(({ folder }) => folder).filter((folder) => !selectedSlugs.has(folder.slug));
  appendFoldersWithDiversity(
    selectedFolders,
    fallbackCandidates,
    Math.max(0, TOTAL_SELECTION_COUNT - selectedFolders.length),
    selectedSlugs,
    diversityCounts
  );

  return selectedFolders;
}

function appendUniqueFolders(
  target: FolderSummary[],
  folders: FolderSummary[],
  selectedSlugs: Set<string>,
  diversityCounts: Map<string, number>
) {
  for (const folder of folders) {
    if (selectedSlugs.has(folder.slug)) {
      continue;
    }

    target.push(folder);
    selectedSlugs.add(folder.slug);
    trackDiversityKey(diversityCounts, folder);
  }
}

function appendFoldersWithDiversity(
  target: FolderSummary[],
  folders: FolderSummary[],
  count: number,
  selectedSlugs: Set<string>,
  diversityCounts: Map<string, number>
) {
  const selectionStart = target.length;

  appendFoldersWithLimit(target, folders, count, selectedSlugs, diversityCounts, DIVERSITY_SOFT_LIMIT, selectionStart);
  appendFoldersWithLimit(target, folders, count, selectedSlugs, diversityCounts, DIVERSITY_RELAXED_LIMIT, selectionStart);
  appendFoldersWithLimit(target, folders, count, selectedSlugs, diversityCounts, Number.POSITIVE_INFINITY, selectionStart);
}

function appendFoldersWithLimit(
  target: FolderSummary[],
  folders: FolderSummary[],
  count: number,
  selectedSlugs: Set<string>,
  diversityCounts: Map<string, number>,
  maxPerKey: number,
  selectionStart: number
) {
  for (const folder of folders) {
    if (target.length - selectionStart >= count || selectedSlugs.has(folder.slug)) {
      continue;
    }

    const diversityKey = getFolderDiversityKey(folder);
    const diversityCount = diversityCounts.get(diversityKey) ?? 0;
    if (Number.isFinite(maxPerKey) && diversityCount >= maxPerKey) {
      continue;
    }

    target.push(folder);
    selectedSlugs.add(folder.slug);
    diversityCounts.set(diversityKey, diversityCount + 1);
  }
}

function buildDiscoveryPool(folders: FolderSummary[], seed: string): FolderSummary[] {
  if (folders.length <= DISCOVERY_POOL_SIZE) {
    return shuffleWithSeed(folders, seed);
  }

  const primaryPool = shuffleWithSeed(folders.slice(0, DISCOVERY_POOL_SIZE), seed);
  const overflowPool = shuffleWithSeed(folders.slice(DISCOVERY_POOL_SIZE), `${seed}:overflow`);

  return [...primaryPool, ...overflowPool];
}

function trackDiversityKey(diversityCounts: Map<string, number>, folder: FolderSummary) {
  const diversityKey = getFolderDiversityKey(folder);
  diversityCounts.set(diversityKey, (diversityCounts.get(diversityKey) ?? 0) + 1);
}

function getSidebarFolderScore(folder: FolderSummary, likedCountByFolder: Map<string, number>, nowMs: number): number {
  const recentActivityScore = getRecentActivityScore(folder.latestImageMtimeMs, nowMs);
  const likeScore = normalizeLogarithmicValue(likedCountByFolder.get(folder.slug) ?? 0, 6);
  const imageCountScore = normalizeLogarithmicValue(folder.imageCount, 36);

  return recentActivityScore * 0.55 + likeScore * 0.3 + imageCountScore * 0.15;
}

function getRecentActivityScore(latestImageMtimeMs: number | null, nowMs: number): number {
  if (!latestImageMtimeMs) {
    return 0;
  }

  const ageMs = Math.max(0, nowMs - latestImageMtimeMs);
  return Math.max(0, 1 - ageMs / RECENT_ACTIVITY_WINDOW_MS);
}

function normalizeLogarithmicValue(value: number, cap: number): number {
  if (value <= 0) {
    return 0;
  }

  return Math.min(1, Math.log(value + 1) / Math.log(cap));
}

function compareRankedFolders(left: RankedSidebarFolder, right: RankedSidebarFolder): number {
  const scoreComparison = compareNumbers(right.score, left.score);
  if (scoreComparison !== 0) {
    return scoreComparison;
  }

  const likedComparison = compareNumbers(right.likedImageCount, left.likedImageCount);
  if (likedComparison !== 0) {
    return likedComparison;
  }

  const recentComparison = compareNumbers(right.folder.latestImageMtimeMs ?? 0, left.folder.latestImageMtimeMs ?? 0);
  if (recentComparison !== 0) {
    return recentComparison;
  }

  const imageCountComparison = compareNumbers(right.folder.imageCount, left.folder.imageCount);
  if (imageCountComparison !== 0) {
    return imageCountComparison;
  }

  return compareText(left.folder.name, right.folder.name);
}

function getFolderDiversityKey(folder: FolderSummary): string {
  const groupingSource = folder.breadcrumb || folder.folderPath || folder.name;
  const normalizedSource = groupingSource
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const finalSegment = normalizedSource.split('/').at(-1) ?? normalizedSource;
  const candidateKey = finalSegment
    .replace(/\b(?:day|part|set|vol|volume|ep|episode|batch|roll)\s*\d+\b/g, ' ')
    .replace(/\b\d{1,4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = candidateKey.split(' ').filter(Boolean);

  return tokens.slice(0, 2).join(' ') || normalizedSource || folder.slug;
}

function compareNumbers(left: number, right: number): number {
  if (left === right) {
    return 0;
  }

  return left > right ? 1 : -1;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function createDailySeed(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function shuffleWithSeed<T>(items: T[], seed: string): T[] {
  const shuffled = [...items];
  const random = createSeededRandom(seed);

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function createSeededRandom(seed: string): () => number {
  let state = hashSeed(seed);

  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);

    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let hash = 2166136261;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}
