export type SidebarInteraction = 'click' | 'hover';

export const SIDEBAR_INTERACTION_KEY = 'cosgallery-sidebar-interaction-v1';
export const SIDEBAR_CLICK_EXPANDED_KEY = 'cosgallery-sidebar-click-expanded-v1';
export const SIDEBAR_PREFERENCE_EVENT = 'cosgallery-sidebar-preference-change';

// Keep a failed write consistent across page navigation in this browser tab.
let unsavedInteraction: SidebarInteraction | undefined;

export function readSidebarInteraction(fromStorage = false): SidebarInteraction {
  if (fromStorage) unsavedInteraction = undefined;
  if (unsavedInteraction) return unsavedInteraction;
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
    if (key === SIDEBAR_INTERACTION_KEY) unsavedInteraction = undefined;
  } catch {
    // The current tab remains usable when browser storage is unavailable.
    if (key === SIDEBAR_INTERACTION_KEY && (value === 'click' || value === 'hover')) unsavedInteraction = value;
  }
  window.dispatchEvent(new CustomEvent(SIDEBAR_PREFERENCE_EVENT, { detail: { key, value } }));
}
