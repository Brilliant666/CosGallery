import { describe, expect, it, vi } from 'vitest';

const { connectionAccess } = vi.hoisted(() => ({
  connectionAccess: vi.fn()
}));

vi.mock('../src/db/database.js', () => ({
  databaseManager: {
    get connection() {
      connectionAccess();
      throw new Error('Import attempted to open the configured database');
    }
  }
}));

describe('LocalIngest import safety', () => {
  it('does not open or migrate the configured database merely by importing the singleton', async () => {
    const module = await import('../src/services/local-ingest-service.js');
    expect(module.localIngestService).toBeDefined();
    expect(connectionAccess).not.toHaveBeenCalled();
  });
});
