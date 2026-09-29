import { randomUUID } from 'node:crypto';

interface QueueIdentity { id: number; sourceIdentity: string }
interface Snapshot {
  key: string;
  expiresAt: number;
  identities: QueueIdentity[];
}

export class ReelQueueExpiredError extends Error {
  constructor() { super('短片队列已过期，请重新加载短片。'); }
}

/** Cache ordering only. Every page re-reads current visibility and source identity;
 * no cached row grants access to media. Cursors address the original snapshot so
 * removals cannot shift later pages, and new videos join on an explicit refresh.
 */
export function createReelQueuePager(options: {
  now?: () => number;
  ttlMs?: number;
  maxQueues?: number;
  maxIdentities?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 4 * 60 * 60_000;
  const maxQueues = options.maxQueues ?? 32;
  const maxIdentities = options.maxIdentities ?? 500_000;
  const stores = new WeakMap<object, Map<string, Snapshot>>();

  return function page<T extends QueueIdentity>(input: {
    database: object;
    key: string;
    cursor?: string;
    limit: number;
    build: () => T[];
    read: (ids: number[]) => T[];
  }): { items: T[]; total: number; hasMore: boolean; nextCursor: string | null } {
    const store = stores.get(input.database) ?? new Map<string, Snapshot>();
    stores.set(input.database, store);
    const timestamp = now();
    for (const [token, entry] of store) if (entry.expiresAt <= timestamp) store.delete(token);
    let token: string;
    let offset = 0;
    let snapshot: Snapshot;
    if (input.cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' ||
            !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) throw new ReelQueueExpiredError();
        [token, offset] = parsed as [string, number];
        const existing = store.get(token);
        if (!existing || existing.key !== input.key || offset > existing.identities.length) throw new ReelQueueExpiredError();
        snapshot = existing;
        snapshot.expiresAt = timestamp + ttlMs;
      } catch { throw new ReelQueueExpiredError(); }
    } else {
      token = randomUUID();
      snapshot = {
        key: input.key,
        expiresAt: timestamp + ttlMs,
        identities: input.build().map(({ id, sourceIdentity }) => ({ id, sourceIdentity }))
      };
      // Bound aggregate retained snapshots, always allowing the current queue.
      let size = snapshot.identities.length;
      for (const entry of store.values()) size += entry.identities.length;
      while (store.size && (store.size >= maxQueues || size > maxIdentities)) {
        const oldest = store.keys().next().value!;
        size -= store.get(oldest)!.identities.length;
        store.delete(oldest);
      }
      store.set(token, snapshot);
    }
    const items: T[] = [];
    while (items.length < input.limit && offset < snapshot.identities.length) {
      const chunk = snapshot.identities.slice(offset, offset + Math.max(input.limit - items.length, 32));
      const visible = new Map(input.read(chunk.map(entry => entry.id)).map(item => [item.id, item]));
      for (const expected of chunk) {
        offset++;
        const item = visible.get(expected.id);
        if (item && item.sourceIdentity === expected.sourceIdentity) items.push(item);
        if (items.length === input.limit) break;
      }
    }
    const hasMore = offset < snapshot.identities.length;
    return {
      items,
      // This is the initial queue size, not a current availability assertion.
      total: snapshot.identities.length,
      hasMore,
      nextCursor: hasMore ? Buffer.from(JSON.stringify([token, offset])).toString('base64url') : null
    };
  };
}
