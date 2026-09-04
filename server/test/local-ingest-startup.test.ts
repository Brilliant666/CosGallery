import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLocalIngestStartup } from '../src/services/local-ingest-startup.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('local ingest startup compensation switch', () => {
  function dependencies(scanEnabled = true) {
    return { scanEnabled, recoverInterruptedJobs: vi.fn(async () => 0),
      getAllowlist: vi.fn(() => ['synthetic-creator']), scanInbox: vi.fn(async () => ({})), logInfo: vi.fn() };
  }

  it('skips discovery and even reading path-backed settings when disabled', async () => {
    const deps = dependencies(false);
    deps.getAllowlist.mockImplementation(() => { throw new Error('must not read settings'); });
    await runLocalIngestStartup(deps);
    expect(deps.recoverInterruptedJobs).toHaveBeenCalledOnce();
    expect(deps.getAllowlist).not.toHaveBeenCalled();
    expect(deps.scanInbox).not.toHaveBeenCalled();
    expect(deps.logInfo).toHaveBeenCalledWith(expect.stringContaining('LOCAL_INGEST_STARTUP_SCAN=false'));
  });

  it('preserves enabled discovery with a nonempty allowlist', async () => {
    const deps = dependencies();
    deps.recoverInterruptedJobs.mockResolvedValue(2);
    await runLocalIngestStartup(deps);
    expect(deps.scanInbox).toHaveBeenCalledOnce();
    expect(deps.logInfo).toHaveBeenCalledWith(expect.stringContaining('2 interrupted'));
  });

  it('does not discover with an empty allowlist', async () => {
    const deps = dependencies(); deps.getAllowlist.mockReturnValue([]);
    await runLocalIngestStartup(deps);
    expect(deps.scanInbox).not.toHaveBeenCalled();
  });

  it('does not discover if recovery fails', async () => {
    const deps = dependencies(); deps.recoverInterruptedJobs.mockRejectedValue(new Error('recovery failed'));
    await expect(runLocalIngestStartup(deps)).rejects.toThrow('recovery failed');
    expect(deps.scanInbox).not.toHaveBeenCalled();
  });

  it.each([[undefined, true], ['true', true], ['1', true], ['false', false], ['0', false]] as const)(
    'parses %s as %s', async (value, expected) => {
      vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_INGEST_STARTUP_SCAN', value);
      const { appConfig } = await import('../src/config/env.js');
      expect(appConfig.localIngestStartupScan).toBe(expected);
    }
  );

  it('rejects invalid switch values', async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_INGEST_STARTUP_SCAN', 'flase');
    await expect(import('../src/config/env.js')).rejects.toThrow();
  });

  it('wires the switch into the actual server entry point', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('void runLocalIngestStartup({');
    expect(source).toContain('scanEnabled: appConfig.localIngestStartupScan');
    expect(source).not.toContain('if (localIngestSettingsService.get().allowlist.length > 0)');
  });
});
