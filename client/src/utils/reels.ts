export interface ReelPanelMetrics {
  id: number;
  offsetTop: number;
  offsetHeight: number;
}

export interface ReelsAffinitySnapshot {
  lastFolder: string | null;
  recentFolders: string[];
}

export function resolveReelsAffinitySnapshot(
  existingSnapshot: ReelsAffinitySnapshot | null,
  lastFolder: string | null,
  recentFolders: string[]
): ReelsAffinitySnapshot {
  if (existingSnapshot) {
    return existingSnapshot;
  }

  const normalizedLastFolder = typeof lastFolder === 'string' && lastFolder.trim().length > 0 ? lastFolder.trim() : null;
  const normalizedRecentFolders = recentFolders
    .map((folder) => folder.trim())
    .filter((folder, index, items) => folder.length > 0 && items.indexOf(folder) === index);

  return {
    lastFolder: normalizedLastFolder,
    recentFolders: normalizedLastFolder
      ? [normalizedLastFolder, ...normalizedRecentFolders.filter((folder) => folder !== normalizedLastFolder)]
      : normalizedRecentFolders
  };
}

export function getActiveReelId(
  panels: ReelPanelMetrics[],
  scrollTop: number,
  viewportHeight: number
): number | null {
  if (panels.length === 0) {
    return null;
  }

  const viewportCenter = scrollTop + viewportHeight / 2;
  let activePanel = panels[0] ?? null;
  let smallestOffset = Number.POSITIVE_INFINITY;

  for (const panel of panels) {
    const panelCenter = panel.offsetTop + panel.offsetHeight / 2;
    const centerOffset = Math.abs(panelCenter - viewportCenter);
    if (centerOffset < smallestOffset) {
      smallestOffset = centerOffset;
      activePanel = panel;
    }
  }

  return activePanel?.id ?? null;
}

export function shouldPrefetchReels(activeIndex: number, totalItems: number, remainingThreshold = 3): boolean {
  if (activeIndex < 0 || totalItems <= 0) {
    return false;
  }

  return activeIndex >= totalItems - remainingThreshold;
}
