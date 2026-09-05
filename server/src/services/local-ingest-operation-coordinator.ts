import { randomUUID } from 'node:crypto';

export type LocalIngestOperationState = 'idle' | 'scanning' | 'running';

export type LocalIngestOperationKind =
  | 'scan'
  | 'batch'
  | 'single-job'
  | 'cleanup'
  | 'discover-creators'
  | 'save-settings'
  | 'validation'
  | 'recycle-test';

export type LocalIngestOperationCurrentJob = {
  id: number;
  creatorId: number;
  creatorName: string;
  archiveName: string;
  status: string;
  phase: string;
};

export type LocalIngestOperationRun = {
  total: number;
  examined: number;
  settled: number;
  ingested: number;
  failed: number;
  awaitingReview: number;
  reconciling: number;
  claimUnavailable: number;
  unchanged: number;
  remaining: number;
  currentJob: LocalIngestOperationCurrentJob | null;
};

export type LocalIngestCompletedOperation = {
  kind: LocalIngestOperationKind;
  state: Exclude<LocalIngestOperationState, 'idle'>;
  startedAt: string;
  finishedAt: string;
  succeeded: boolean;
  summary: Record<string, unknown>;
};

export type LocalIngestOperationSnapshot = {
  state: LocalIngestOperationState;
  kind: LocalIngestOperationKind | null;
  startedAt: string | null;
  updatedAt: string | null;
  elapsedMs: number;
  message: string | null;
  run: LocalIngestOperationRun | null;
  lastCompleted: LocalIngestCompletedOperation | null;
};

type ActiveOperation = {
  token: string;
  state: Exclude<LocalIngestOperationState, 'idle'>;
  kind: LocalIngestOperationKind;
  startedAt: string;
  updatedAt: string;
  message: string;
  run: LocalIngestOperationRun | null;
};

export type LocalIngestOperationContext = {
  update: (patch: {
    message?: string;
    run?: Partial<Omit<LocalIngestOperationRun, 'currentJob'>> & {
      currentJob?: LocalIngestOperationCurrentJob | null;
    };
  }) => void;
};

export class LocalIngestOperationActiveError extends Error {
  readonly code = 'LOCAL_INGEST_OPERATION_ACTIVE';

  constructor(readonly operation: LocalIngestOperationSnapshot) {
    super('Stage 3 当前已有操作正在执行');
    this.name = 'LocalIngestOperationActiveError';
  }
}

export class LocalIngestOperationCoordinator {
  private active: ActiveOperation | null = null;
  private lastCompleted: LocalIngestCompletedOperation | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  snapshot(): LocalIngestOperationSnapshot {
    if (!this.active) {
      return {
        state: 'idle',
        kind: null,
        startedAt: null,
        updatedAt: null,
        elapsedMs: 0,
        message: null,
        run: null,
        lastCompleted: this.lastCompleted ? structuredClone(this.lastCompleted) : null
      };
    }
    const startedMs = Date.parse(this.active.startedAt);
    return {
      state: this.active.state,
      kind: this.active.kind,
      startedAt: this.active.startedAt,
      updatedAt: this.active.updatedAt,
      elapsedMs: Math.max(0, this.now().getTime() - startedMs),
      message: this.active.message,
      run: this.active.run ? structuredClone(this.active.run) : null,
      lastCompleted: this.lastCompleted ? structuredClone(this.lastCompleted) : null
    };
  }

  async run<T>(
    descriptor: {
      state: Exclude<LocalIngestOperationState, 'idle'>;
      kind: LocalIngestOperationKind;
      message: string;
      run?: LocalIngestOperationRun | null;
    },
    action: (context: LocalIngestOperationContext) => Promise<T> | T,
    summarize: (result: T) => Record<string, unknown> = () => ({})
  ): Promise<T> {
    if (this.active) throw new LocalIngestOperationActiveError(this.snapshot());

    const timestamp = this.now().toISOString();
    const token = randomUUID();
    this.active = {
      token,
      state: descriptor.state,
      kind: descriptor.kind,
      startedAt: timestamp,
      updatedAt: timestamp,
      message: descriptor.message,
      run: descriptor.run ? structuredClone(descriptor.run) : null
    };

    let succeeded = false;
    let summary: Record<string, unknown> = {};
    try {
      const result = await action({
        update: (patch) => this.update(token, patch)
      });
      succeeded = true;
      summary = summarize(result);
      return result;
    } catch (error) {
      summary = {
        error: error instanceof Error ? error.message : 'Stage 3 operation failed'
      };
      throw error;
    } finally {
      const active = this.active?.token === token ? this.active : null;
      if (active) {
        this.lastCompleted = {
          kind: active.kind,
          state: active.state,
          startedAt: active.startedAt,
          finishedAt: this.now().toISOString(),
          succeeded,
          summary
        };
        this.active = null;
      }
    }
  }

  private update(
    token: string,
    patch: {
      message?: string;
      run?: Partial<Omit<LocalIngestOperationRun, 'currentJob'>> & {
        currentJob?: LocalIngestOperationCurrentJob | null;
      };
    }
  ): void {
    if (!this.active || this.active.token !== token) return;
    if (patch.message !== undefined) this.active.message = patch.message;
    if (patch.run) {
      const current = this.active.run ?? {
        total: 0,
        examined: 0,
        settled: 0,
        ingested: 0,
        failed: 0,
        awaitingReview: 0,
        reconciling: 0,
        claimUnavailable: 0,
        unchanged: 0,
        remaining: 0,
        currentJob: null
      };
      this.active.run = { ...current, ...patch.run };
    }
    this.active.updatedAt = this.now().toISOString();
  }
}

export const localIngestOperationCoordinator = new LocalIngestOperationCoordinator();
