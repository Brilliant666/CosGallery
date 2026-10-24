export type SidebarInteraction = 'click' | 'hover';

export const SIDEBAR_INTERACTION_KEY = 'cosgallery-sidebar-interaction-v1';
export const SIDEBAR_CLICK_EXPANDED_KEY = 'cosgallery-sidebar-click-expanded-v1';

export function readSidebarInteraction(): SidebarInteraction {
  try {
    return localStorage.getItem(SIDEBAR_INTERACTION_KEY) === 'hover' ? 'hover' : 'click';
  } catch {
    return 'click';
  }
}

export function readSidebarClickExpanded(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_CLICK_EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveSidebarPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The current tab remains usable when browser storage is unavailable.
  }
}
