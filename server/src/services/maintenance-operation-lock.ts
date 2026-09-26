import { AsyncResource } from 'node:async_hooks';

export const PERMANENT_DELETION_QUARANTINE_DIRECTORY_NAME = '.foldergram-delete-quarantine';

export class MaintenanceOperationLock {
  private activeGenerations = 0;
  private exclusive = false;
  private queue: Array<{ generation: boolean; start: () => void }> = [];

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(false, operation);
  }

  // These are writing leases, NOT general database read locks. Independent
  // outputs may be generated together, but scans/deletion/rebuild remain exclusive.
  runGeneration<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(true, operation);
  }

  private enqueue<T>(generation: boolean, operation: () => Promise<T>): Promise<T> {
    // A preceding writer drains this queue in its own async context. Preserve
    // each caller's context so scoped indexing retains its admission owner,
    // while unrelated jobs never inherit the preceding writer's ownership.
    const runOperation = AsyncResource.bind(operation);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ generation, start: () => {
        if (generation) this.activeGenerations += 1;
        else this.exclusive = true;
        Promise.resolve().then(runOperation).then(resolve, reject).finally(() => {
          if (generation) this.activeGenerations -= 1;
          else this.exclusive = false;
          this.drain();
        });
      } });
      this.drain();
    });
  }

  private drain(): void {
    if (this.exclusive) return;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      // FIFO prevents a stream of cold requests starving queued maintenance.
      if (!next.generation && this.activeGenerations > 0) return;
      this.queue.shift();
      next.start();
      if (!next.generation) return;
    }
  }
}

export const maintenanceOperationLock = new MaintenanceOperationLock();
