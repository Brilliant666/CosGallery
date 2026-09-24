import { describe, expect, it } from 'vitest';
import { MaintenanceOperationLock } from '../src/services/maintenance-operation-lock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('generation leases and exclusive maintenance', () => {
  it('runs different generation writers together but waits before exclusive maintenance', async () => {
    const lock = new MaintenanceOperationLock();
    const hold = deferred();
    const events: string[] = [];
    const a = lock.runGeneration(async () => { events.push('a'); await hold.promise; });
    const b = lock.runGeneration(async () => { events.push('b'); await hold.promise; });
    const maintenance = lock.runExclusive(async () => { events.push('maintenance'); });
    const c = lock.runGeneration(async () => { events.push('c'); });
    await Promise.resolve();
    expect(events).toEqual(['a', 'b']);
    hold.resolve();
    await Promise.all([a, b, maintenance, c]);
    expect(events).toEqual(['a', 'b', 'maintenance', 'c']);
  });

  it('releases failed leases and does not starve an already queued maintenance writer', async () => {
    const lock = new MaintenanceOperationLock();
    const hold = deferred();
    const entered = deferred();
    const events: string[] = [];
    const first = lock.runGeneration(async () => { entered.resolve(); await hold.promise; throw new Error('fixture'); });
    const failed = expect(first).rejects.toThrow('fixture');
    await entered.promise;
    const maintenance = lock.runExclusive(async () => { events.push('maintenance'); throw new Error('maintenance fixture'); });
    const maintenanceFailed = expect(maintenance).rejects.toThrow('maintenance fixture');
    const later = Array.from({ length: 8 }, (_, i) => lock.runGeneration(async () => { events.push(String(i)); }));
    hold.resolve();
    await Promise.all([failed, maintenanceFailed, ...later]);
    expect(events[0]).toBe('maintenance');
    expect(events).toHaveLength(9);
  });
});
