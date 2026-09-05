import { describe, expect, it, vi } from 'vitest';

import {
  LocalIngestOperationActiveError,
  LocalIngestOperationCoordinator,
  type LocalIngestOperationKind
} from '../src/services/local-ingest-operation-coordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('LocalIngestOperationCoordinator', () => {
  it('rejects every competing Stage 3 operation immediately without queuing it', async () => {
    const kinds: LocalIngestOperationKind[] = [
      'scan',
      'batch',
      'single-job',
      'cleanup',
      'discover-creators',
      'save-settings',
      'validation',
      'recycle-test'
    ];
    const coordinator = new LocalIngestOperationCoordinator();
    const gate = deferred<string>();
    const first = coordinator.run(
      { state: 'scanning', kind: 'scan', message: 'scanning' },
      () => gate.promise
    );
    expect(coordinator.snapshot()).toMatchObject({ state: 'scanning', kind: 'scan' });

    for (const kind of kinds) {
      const competingAction = vi.fn(() => 'must not run');
      const attempt = coordinator.run(
        { state: 'running', kind, message: kind },
        competingAction
      );
      await expect(attempt).rejects.toMatchObject({
        code: 'LOCAL_INGEST_OPERATION_ACTIVE',
        operation: { state: 'scanning', kind: 'scan' }
      });
      expect(competingAction).not.toHaveBeenCalled();
    }

    gate.resolve('done');
    await expect(first).resolves.toBe('done');
    expect(coordinator.snapshot()).toMatchObject({
      state: 'idle',
      lastCompleted: { kind: 'scan', succeeded: true }
    });
  });

  it('releases the operation in finally after failures', async () => {
    const coordinator = new LocalIngestOperationCoordinator();
    await expect(coordinator.run(
      { state: 'running', kind: 'batch', message: 'running' },
      () => { throw new Error('synthetic failure'); }
    )).rejects.toThrow('synthetic failure');

    expect(coordinator.snapshot()).toMatchObject({
      state: 'idle',
      lastCompleted: {
        kind: 'batch',
        succeeded: false,
        summary: { error: 'synthetic failure' }
      }
    });
    await expect(coordinator.run(
      { state: 'running', kind: 'validation', message: 'validating' },
      () => 'available again'
    )).resolves.toBe('available again');
  });

  it('rejects every competing operation while a batch run is active', async () => {
    const kinds: LocalIngestOperationKind[] = [
      'scan',
      'batch',
      'single-job',
      'cleanup',
      'discover-creators',
      'save-settings',
      'validation',
      'recycle-test'
    ];
    const coordinator = new LocalIngestOperationCoordinator();
    const gate = deferred<void>();
    const first = coordinator.run(
      { state: 'running', kind: 'batch', message: 'running batch' },
      () => gate.promise
    );

    for (const kind of kinds) {
      const action = vi.fn();
      await expect(coordinator.run({ state: 'running', kind, message: kind }, action))
        .rejects.toMatchObject({
          code: 'LOCAL_INGEST_OPERATION_ACTIVE',
          operation: { state: 'running', kind: 'batch' }
        });
      expect(action).not.toHaveBeenCalled();
    }

    gate.resolve();
    await first;
  });

  it('publishes only the fixed batch set and current lightweight job progress', async () => {
    const coordinator = new LocalIngestOperationCoordinator();
    const gate = deferred<void>();
    const running = coordinator.run(
      {
        state: 'running',
        kind: 'batch',
        message: 'batch',
        run: {
          total: 2,
          examined: 0,
          settled: 0,
          ingested: 0,
          failed: 0,
          awaitingReview: 0,
          reconciling: 0,
          claimUnavailable: 0,
          unchanged: 0,
          remaining: 2,
          currentJob: null
        }
      },
      async ({ update }) => {
        update({
          run: {
            currentJob: {
              id: 7,
              creatorId: 3,
              creatorName: 'Creator Alpha',
              archiveName: '007.7z',
              status: 'running',
              phase: 'extracting_inner'
            }
          }
        });
        await gate.promise;
        return ['ok'];
      },
      (result) => ({ total: result.length })
    );

    expect(coordinator.snapshot()).toMatchObject({
      state: 'running',
      run: {
        total: 2,
        remaining: 2,
        currentJob: { id: 7, archiveName: '007.7z', phase: 'extracting_inner' }
      }
    });
    gate.resolve();
    await running;
  });

  it('exposes the active operation on the typed conflict error', async () => {
    const coordinator = new LocalIngestOperationCoordinator();
    const gate = deferred<void>();
    const first = coordinator.run({ state: 'running', kind: 'batch', message: 'batch' }, () => gate.promise);
    try {
      await coordinator.run({ state: 'scanning', kind: 'scan', message: 'scan' }, () => undefined);
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(LocalIngestOperationActiveError);
      expect((error as LocalIngestOperationActiveError).operation).toMatchObject({ state: 'running', kind: 'batch' });
    }
    gate.resolve();
    await first;
  });
});
