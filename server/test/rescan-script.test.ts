import { beforeEach, describe, expect, it, vi } from 'vitest';

const { migrateMock, scanAllMock } = vi.hoisted(() => ({
  migrateMock: vi.fn(),
  scanAllMock: vi.fn()
}));

describe.sequential('rescan script', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    migrateMock.mockReset();
    scanAllMock.mockReset();
  });

  it('runs migrations before scanning', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    migrateMock.mockResolvedValue(undefined);
    scanAllMock.mockResolvedValue({ status: 'completed' });

    vi.doMock('../src/scripts/migrate.js', () => ({
      main: migrateMock
    }));
    vi.doMock('../src/services/scanner-service.js', () => ({
      scannerService: {
        scanAll: scanAllMock
      }
    }));

    await import('../src/scripts/rescan.js');

    expect(migrateMock).toHaveBeenCalledTimes(1);
    expect(scanAllMock).toHaveBeenCalledWith('script');
    expect(migrateMock.mock.invocationCallOrder[0]).toBeLessThan(scanAllMock.mock.invocationCallOrder[0]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ status: 'completed' }, null, 2));
  });
});
