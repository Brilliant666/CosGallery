import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  events: [] as string[],
  listen: vi.fn(),
  handleStartup: vi.fn(),
  localStartup: vi.fn(),
  startWorker: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  recoverDeletion: vi.fn(),
}));

vi.mock('node:http', () => ({ createServer: () => ({
  on: vi.fn(), listen: deps.listen, close: vi.fn(),
}) }));
vi.mock('../src/config/env.js', () => ({ appConfig: {
  isDevelopment: false, nodeEnv: 'production', host: '127.0.0.1', port: 4141,
  localIngestStartupScan: false,
} }));
vi.mock('../src/app.js', () => ({ createApp: vi.fn(() => ({})) }));
vi.mock('../src/db/repositories.js', () => ({ collectionRepository: {
  ensureDefaultCollection: vi.fn(), repairDefaultMemberships: vi.fn(() => 0),
} }));
vi.mock('../src/services/log-service.js', () => ({ log: {
  info: deps.info, error: deps.error, table: vi.fn(),
} }));
vi.mock('../src/services/local-ingest-service.js', () => ({ localIngestService: {
  recoverInterruptedJobs: vi.fn(), scanInbox: vi.fn(),
} }));
vi.mock('../src/services/local-ingest-settings-service.js', () => ({
  localIngestSettingsService: { get: vi.fn(() => ({ allowlist: [] })) },
}));
vi.mock('../src/services/local-ingest-startup.js', () => ({ runLocalIngestStartup: deps.localStartup }));
vi.mock('../src/services/permanent-deletion-service.js', () => ({
  permanentDeletionService: { recoverPendingDeletions: deps.recoverDeletion },
}));
vi.mock('../src/services/scanner-service.js', () => ({ scannerService: { handleStartup: deps.handleStartup } }));
vi.mock('../src/services/watcher-service.js', () => ({ watcherService: { stop: vi.fn() } }));
vi.mock('../src/services/resource-catalog-updater.js', () => ({
  startResourceCatalogUpdater: deps.startWorker, stopResourceCatalogUpdater: vi.fn(),
}));

let originalExitCode: typeof process.exitCode;
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  originalExitCode = process.exitCode;
  // Import the real entry point without registering signals in the test runner.
  vi.spyOn(process, 'on').mockImplementation(() => process);
  deps.events.length = 0;
  deps.recoverDeletion.mockResolvedValue(undefined);
  deps.handleStartup.mockImplementation(() => { deps.events.push('scanner'); return 'idle'; });
  deps.listen.mockImplementation((_port, _host, ready: () => void) => {
    deps.events.push('listen'); ready();
  });
  deps.localStartup.mockImplementation(async () => { deps.events.push('local'); });
  deps.startWorker.mockImplementation(() => { deps.events.push('worker'); });
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('actual HTTP entry catalog startup ordering', () => {
  it('routes synchronous scanner/settings failure to bootstrap and never listens or starts a worker', async () => {
    const failure = new Error('database is locked');
    deps.handleStartup.mockImplementation(() => { throw failure; });
    await import('../src/index.js');
    await settle();
    expect(deps.error).toHaveBeenCalledWith('Server startup failed', failure);
    expect(process.exitCode).toBe(1);
    expect(deps.listen).not.toHaveBeenCalled();
    expect(deps.localStartup).not.toHaveBeenCalled();
    expect(deps.startWorker).not.toHaveBeenCalled();
  });

  it('listens after scanner writes, but waits for local startup to settle before starting the independent writer', async () => {
    let finish!: () => void;
    deps.localStartup.mockImplementation(() => {
      deps.events.push('local');
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    await import('../src/index.js');
    await settle();
    expect(deps.events).toEqual(['scanner', 'listen', 'local']);
    expect(deps.info).toHaveBeenCalledWith('HTTP server listening on http://127.0.0.1:4141');
    expect(deps.localStartup).toHaveBeenCalledWith(expect.objectContaining({ scanEnabled: false }));
    expect(deps.startWorker).not.toHaveBeenCalled();
    finish();
    await settle();
    expect(deps.events).toEqual(['scanner', 'listen', 'local', 'worker']);
    expect(deps.startWorker).toHaveBeenCalledOnce();
  });

  it('preserves handled local recovery failure and then starts the catalog worker', async () => {
    deps.localStartup.mockRejectedValue(new Error('local recovery failed'));
    await import('../src/index.js');
    await settle();
    expect(deps.info).toHaveBeenCalledWith(
      'Local ingest startup recovery or compensation scan could not complete', 'local recovery failed',
    );
    expect(deps.startWorker).toHaveBeenCalledOnce();
    expect(deps.error).not.toHaveBeenCalled();
  });

  it('still starts database-only catalog updates when gallery startup is blocked, without running local startup', async () => {
    deps.handleStartup.mockReturnValue('blocked');
    await import('../src/index.js');
    await settle();
    expect(deps.listen).toHaveBeenCalledOnce();
    expect(deps.localStartup).not.toHaveBeenCalled();
    expect(deps.startWorker).toHaveBeenCalledOnce();
  });

  it.each(['idle', 'blocked'])('handles worker construction failure on %s path without escaping startup', async (action) => {
    deps.handleStartup.mockReturnValue(action);
    const failure = new Error('worker creation failed');
    deps.startWorker.mockImplementation(() => { throw failure; });
    await import('../src/index.js');
    await settle();
    expect(deps.listen).toHaveBeenCalledOnce();
    expect(deps.error).toHaveBeenCalledWith(
      'Resource catalog updater could not start; pending generations retained', failure,
    );
    expect(deps.error).not.toHaveBeenCalledWith('Server startup failed', expect.anything());
    expect(process.exitCode).toBe(originalExitCode);
  });
});
