import { describe, expect, it, vi } from 'vitest';
import { createReelQueuePager, ReelQueueExpiredError } from '../src/services/reel-queue.js';

function fixture(options: Parameters<typeof createReelQueuePager>[0] = {}) {
  const page = createReelQueuePager(options);
  const database = {};
  let current = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, sourceIdentity: `source-${index + 1}` }));
  const build = vi.fn(() => [...current]);
  const read = vi.fn((ids: number[]) => current.filter(item => ids.includes(item.id)));
  const input = { database, key: 'random-42', limit: 3, build, read };
  return { page, input, build, read, replace: (next: typeof current) => { current = next; }, rows: () => current };
}

describe('reel queue cursor', () => {
  it('sorts once, skips removed videos without shifting subsequent pages and excludes additions until refresh', () => {
    const f = fixture();
    const first = f.page(f.input);
    expect(first.items.map(item => item.id)).toEqual([1, 2, 3]);
    f.replace([...f.rows().filter(item => ![1, 4, 5].includes(item.id)).reverse(), { id: 99, sourceIdentity: 'new' }]);
    const second = f.page({ ...f.input, cursor: first.nextCursor! });
    const third = f.page({ ...f.input, cursor: second.nextCursor! });
    const last = f.page({ ...f.input, cursor: third.nextCursor! });
    expect(second.items.map(item => item.id)).toEqual([6, 7, 8]);
    expect(third.items.map(item => item.id)).toEqual([9, 10, 11]);
    expect(last.items.map(item => item.id)).toEqual([12]);
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeNull();
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(f.page(f.input).items[0]?.id).toBe(12);
    expect(f.build).toHaveBeenCalledTimes(2);
  });

  it('checks source identity and current visibility on repeated cursor requests', () => {
    const f = fixture();
    const first = f.page(f.input);
    const next = { ...f.input, cursor: first.nextCursor! };
    expect(f.page(next).items.map(item => item.id)).toEqual([4, 5, 6]);
    expect(f.page(next).items.map(item => item.id)).toEqual([4, 5, 6]);
    f.replace(f.rows().filter(item => item.id !== 5).map(item => item.id === 4 ? { ...item, sourceIdentity: 'reused-id' } : item));
    expect(f.page(next).items.map(item => item.id)).toEqual([6, 7, 8]);
    expect(f.build).toHaveBeenCalledTimes(1);
  });

  it('rejects expired, wrong-connection, wrong-scope and malformed cursors without rebuilding', () => {
    let time = 0;
    const f = fixture({ now: () => time, ttlMs: 100 });
    const cursor = f.page(f.input).nextCursor!;
    for (const change of [{ key: 'another-seed' }, { database: {} }, { cursor: 'invalid' }]) {
      expect(() => f.page({ ...f.input, cursor, ...change })).toThrow(ReelQueueExpiredError);
    }
    time = 100;
    expect(() => f.page({ ...f.input, cursor })).toThrow(ReelQueueExpiredError);
    expect(f.build).toHaveBeenCalledTimes(1);
  });

  it('bounds retained snapshots and makes evicted queues explicitly expire', () => {
    const f = fixture({ maxQueues: 2 });
    const first = f.page(f.input);
    const second = f.page(f.input);
    f.page(f.input);
    expect(() => f.page({ ...f.input, cursor: first.nextCursor! })).toThrow(ReelQueueExpiredError);
    expect(f.page({ ...f.input, cursor: second.nextCursor! }).items.map(item => item.id)).toEqual([4, 5, 6]);
  });

  it('finishes an emptied remaining queue and does not leak cached rows', () => {
    const f = fixture();
    const first = f.page(f.input);
    f.replace([]);
    expect(f.page({ ...f.input, cursor: first.nextCursor! })).toMatchObject({ items: [], hasMore: false, nextCursor: null });
  });
});
