import { getActivePinia } from 'pinia';
import { shallowRef } from 'vue';
import { useAuthStore } from '../stores/auth';

export type MediaLoadCode = 'SOURCE_INDEX_OUTDATED' | 'DERIVATIVE_VERSION_CHANGED';
export const mediaLoadNotice = shallowRef<{ code: MediaLoadCode; count: number } | null>(null);
const reported = new Map<string, MediaLoadCode>();
const recent = new Map<string, { expires: number; promise: Promise<MediaLoadCode | null> }>();
const queue: Array<() => Promise<void>> = [];
let active = 0;
let epoch = 0;

export function mediaAccessKey() {
  if (!getActivePinia()) return 'no-session';
  const auth = useAuthStore();
  return JSON.stringify([auth.authenticated, auth.role, auth.accessMode, auth.capabilities]);
}

export function clearMediaDiagnostics() {
  epoch += 1;
  recent.clear();
  reported.clear();
  mediaLoadNotice.value = null;
}

export function reportMediaLoadIssue(url: string, code: MediaLoadCode) {
  if (reported.size >= 128 && !reported.has(url)) reported.delete(reported.keys().next().value!);
  reported.set(url, code);
  mediaLoadNotice.value = {
    code: [...reported.values()].includes('SOURCE_INDEX_OUTDATED') ? 'SOURCE_INDEX_OUTDATED' : code,
    count: reported.size,
  };
}

function pump() {
  while (active < 2 && queue.length) {
    const task = queue.shift()!;
    active += 1;
    void task().finally(() => { active -= 1; pump(); });
  }
}

async function readDiagnostic(url: string): Promise<MediaLoadCode | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Range: 'bytes=0-0' }, signal: controller.signal });
    if (response.status !== 409 || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    let text = '', size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) return null;
        text += decoder.decode(chunk.value, { stream: true });
      }
      const code: unknown = JSON.parse(text + decoder.decode()).code;
      return code === 'SOURCE_INDEX_OUTDATED' || code === 'DERIVATIVE_VERSION_CHANGED' ? code : null;
    } finally { await reader.cancel().catch(() => {}); }
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

/** Only after a media element fails: bounded Range read, never a scan or write.
 * Two active / 24 queued, 128 short-lived entries, exact output+version+access
 * dedup. A successful media response is cancelled, not downloaded into memory. */
export function diagnoseMediaFailure(source: string | null): Promise<MediaLoadCode | null> {
  if (!source) return Promise.resolve(null);
  let url: URL;
  try { url = new URL(source, window.location.href); } catch { return Promise.resolve(null); }
  if (url.origin !== window.location.origin || !/^(?:\/(?:thumbnails|previews)\/|\/api\/share\/images\/\d+\/(?:thumbnail|preview)$)/.test(url.pathname)) return Promise.resolve(null);
  url.searchParams.delete('retry');
  const key = `${epoch}:${mediaAccessKey()}:${url.href}`;
  const now = Date.now();
  for (const [k, entry] of recent) if (entry.expires <= now) recent.delete(k);
  const existing = recent.get(key);
  if (existing) return existing.promise;
  if (queue.length >= 24) return Promise.resolve(null);
  while (recent.size >= 128) {
    const evictable = [...recent].find(([, entry]) => Number.isFinite(entry.expires));
    if (!evictable) return Promise.resolve(null);
    recent.delete(evictable[0]);
  }
  const generation = epoch;
  const promise = new Promise<MediaLoadCode | null>(resolve => {
    queue.push(async () => {
      const code = generation === epoch ? await readDiagnostic(url.href) : null;
      resolve(generation === epoch ? code : null);
    });
  });
  const entry = { expires: Infinity, promise };
  recent.set(key, entry);
  void promise.finally(() => { entry.expires = Date.now() + 10000; });
  pump();
  return promise;
}
