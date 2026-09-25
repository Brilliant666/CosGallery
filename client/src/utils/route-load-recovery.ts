import { shallowRef } from 'vue';
import type { Router } from 'vue-router';

type Reason = 'checking' | 'version' | 'offline' | 'network' | 'unknown';
export interface RouteLoadFailure { target: string; reason: Reason; retrying: boolean }
interface RecoveryOptions {
  online?: () => boolean;
  currentEntry?: string | null;
  fetchHtml?: () => Promise<string>;
  reload?: (target: string) => void;
}

export function isRouteChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS for|Loading chunk [\w-]+ failed/i.test(message);
}

function entryIn(document: Document): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
  if (!src) return null;
  const url = new URL(src, window.location.href);
  return url.origin === window.location.origin ? url.pathname + url.search : null;
}

/** Only route import failures reach this state. No polling, implicit reload or business action. */
export function installRouteLoadRecovery(router: Router, options: RecoveryOptions = {}) {
  const state = shallowRef<RouteLoadFailure | null>(null);
  const online = options.online ?? (() => navigator.onLine);
  const currentEntry = options.currentEntry ?? entryIn(document);
  const fetchHtml = options.fetchHtml ?? (async () => {
    const response = await fetch(import.meta.env.BASE_URL, {
      cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('HTML unavailable');
    return response.text();
  });
  const reloadDocument = options.reload ?? ((target: string) => {
    // assign preserves the previous page as Back context. Initial deep links must
    // not add duplicate entries. Existing admission pagehide saves its tab draft.
    if (target === location.pathname + location.search + location.hash) location.reload();
    else location.assign(target);
  });
  let generation = 0;
  const cancel = () => { generation++; state.value = null; };
  const removeError = router.onError((error, to) => {
    if (!isRouteChunkError(error)) return;
    if (state.value?.target === to.fullPath && !state.value.retrying) return;
    const current = ++generation;
    state.value = { target: to.fullPath, reason: online() ? 'checking' : 'offline', retrying: false };
    if (!online()) return;
    void fetchHtml().then(html => {
      if (current !== generation || !state.value) return;
      const nextEntry = entryIn(new DOMParser().parseFromString(html, 'text/html'));
      state.value = { ...state.value, reason: currentEntry && nextEntry && currentEntry !== nextEntry ? 'version' : 'unknown' };
    }).catch(() => {
      if (current === generation && state.value) state.value = { ...state.value, reason: online() ? 'network' : 'offline' };
    });
  });
  const removeAfter = router.afterEach((_to, _from, failure) => { if (!failure) cancel(); });
  async function retry() {
    if (!state.value || state.value.retrying) return;
    const target = state.value.target;
    state.value = { ...state.value, retrying: true };
    try { await router.push(target); }
    catch { /* onError updates one visible prompt; the browser may cache import failures. */ }
  }
  function reload() {
    if (!state.value) return;
    const target = state.value.target;
    if (!target.startsWith('/') || target.startsWith('//')) return;
    reloadDocument(target);
  }
  return { state, cancel, retry, reload, dispose() { cancel(); removeError(); removeAfter(); } };
}

export type RouteLoadRecovery = ReturnType<typeof installRouteLoadRecovery>;
