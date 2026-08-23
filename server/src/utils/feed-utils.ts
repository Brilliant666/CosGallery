export interface FeedOrderingItem {
  id: number;
  folderId: number;
  sortTimestamp: number;
  takenAt: number | null;
}

export interface DiversifyFeedOptions {
  burstWindowMs?: number;
  maxConsecutiveByFolder?: number;
}

export interface FeedBurst<T extends FeedOrderingItem> {
  folderId: number;
  startedAt: number;
  orderIndex: number;
  items: T[];
}

export const DEFAULT_BURST_WINDOW_MS = 1000 * 60 * 20;
export const DEFAULT_MAX_CONSECUTIVE_BY_FOLDER = 2;

export function getEffectiveFeedTimestamp(item: Pick<FeedOrderingItem, 'takenAt' | 'sortTimestamp'>): number {
  return item.takenAt ?? item.sortTimestamp;
}

function wouldExceedFolderRun<T extends FeedOrderingItem>(
  items: T[],
  folderId: number,
  maxConsecutiveByFolder: number
): boolean {
  if (maxConsecutiveByFolder <= 0 || items.length < maxConsecutiveByFolder) {
    return false;
  }

  for (let index = items.length - maxConsecutiveByFolder; index < items.length; index += 1) {
    if (items[index]?.folderId !== folderId) {
      return false;
    }
  }

  return true;
}

export function groupFeedBursts<T extends FeedOrderingItem>(
  items: T[],
  {
    burstWindowMs = DEFAULT_BURST_WINDOW_MS
  }: DiversifyFeedOptions = {}
): FeedBurst<T>[] {
  const bursts: FeedBurst<T>[] = [];

  for (const item of items) {
    const currentTimestamp = getEffectiveFeedTimestamp(item);
    const lastBurst = bursts[bursts.length - 1];
    const lastItem = lastBurst?.items[lastBurst.items.length - 1];
    const lastTimestamp = lastItem ? getEffectiveFeedTimestamp(lastItem) : null;
    const shouldAppend =
      lastBurst !== undefined &&
      lastBurst.folderId === item.folderId &&
      lastTimestamp !== null &&
      Math.abs(lastTimestamp - currentTimestamp) <= burstWindowMs;

    if (shouldAppend) {
      lastBurst.items.push(item);
      continue;
    }

    bursts.push({
      folderId: item.folderId,
      startedAt: currentTimestamp,
      orderIndex: bursts.length,
      items: [item]
    });
  }

  return bursts;
}

export function countFeedBursts<T extends FeedOrderingItem>(items: T[], options: DiversifyFeedOptions = {}): number {
  return groupFeedBursts(items, options).length;
}

export function diversifyFeedCandidates<T extends FeedOrderingItem>(
  items: T[],
  {
    burstWindowMs = DEFAULT_BURST_WINDOW_MS,
    maxConsecutiveByFolder = DEFAULT_MAX_CONSECUTIVE_BY_FOLDER
  }: DiversifyFeedOptions = {}
): T[] {
  const bursts = groupFeedBursts(items, { burstWindowMs });
  const cursors = bursts.map(() => 0);
  const diversified: T[] = [];

  while (true) {
    let placedInRound = 0;

    for (let burstIndex = 0; burstIndex < bursts.length; burstIndex += 1) {
      const burst = bursts[burstIndex];
      const cursor = cursors[burstIndex] ?? 0;

      if (cursor >= burst.items.length) {
        continue;
      }

      if (wouldExceedFolderRun(diversified, burst.folderId, maxConsecutiveByFolder)) {
        continue;
      }

      diversified.push(burst.items[cursor] as T);
      cursors[burstIndex] = cursor + 1;
      placedInRound += 1;
    }

    if (placedInRound > 0) {
      continue;
    }

    const nextBurstIndex = bursts.findIndex((burst, burstIndex) => (cursors[burstIndex] ?? 0) < burst.items.length);
    if (nextBurstIndex < 0) {
      return diversified;
    }

    const cursor = cursors[nextBurstIndex] ?? 0;
    diversified.push(bursts[nextBurstIndex]?.items[cursor] as T);
    cursors[nextBurstIndex] = cursor + 1;
  }
}

export function buildMonthDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

export function listMonthDayKeysAroundDate(date: Date, beforeDays: number, afterDays: number): string[] {
  const keys = new Set<string>();

  for (let offset = beforeDays * -1; offset <= afterDays; offset += 1) {
    const candidate = new Date(date);
    candidate.setDate(candidate.getDate() + offset);
    keys.add(buildMonthDayKey(candidate));
  }

  return [...keys];
}
