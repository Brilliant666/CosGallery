import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { scanCosCreatorsMock } = vi.hoisted(() => ({
  scanCosCreatorsMock: vi.fn()
}));

vi.mock('../src/services/scanner-service.js', () => ({
  scannerService: { scanCosCreators: scanCosCreatorsMock }
}));

import { ArchiveCatalogPipelineService } from '../src/services/archive-catalog-pipeline-service.js';
import { runCreatorScopedLocalIngestReconciliation } from '../src/services/local-ingest-service.js';

describe('LocalIngest creator-scoped reconciliation boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    scanCosCreatorsMock.mockReset();
  });

  it('limits a newly committed work to the same scanner and ledger scope', async () => {
    const database = new DatabaseSync(':memory:');
    scanCosCreatorsMock.mockResolvedValue({ id: 43, status: 'completed', error_text: null });
    const refresh = vi.spyOn(ArchiveCatalogPipelineService.prototype, 'refreshAfterCreatorGalleryScan')
      .mockResolvedValue({} as never);
    try {
      await runCreatorScopedLocalIngestReconciliation(database, 'G:\\cos图集', 39, '五更百鬼', 'NO.001');
      expect(scanCosCreatorsMock).toHaveBeenCalledWith(['五更百鬼'], 'local-ingest', {
        repairUnchangedDerivatives: false, allowDerivativeMigration: false, workFolderName: 'NO.001'
      });
      expect(refresh).toHaveBeenCalledWith({
        galleryRoot: 'G:\\cos图集', creatorId: 39, creatorFolderName: '五更百鬼', workFolderName: 'NO.001'
      });
    } finally {
      database.close();
    }
  });

  it('uses the creator-scoped scanner and pipeline and never invokes the full ledger refresh', async () => {
    const database = new DatabaseSync(':memory:');
    scanCosCreatorsMock.mockResolvedValue({
      id: 42,
      status: 'completed',
      error_text: null
    });
    const scopedRefresh = vi.spyOn(
      ArchiveCatalogPipelineService.prototype,
      'refreshAfterCreatorGalleryScan'
    ).mockResolvedValue({} as never);
    const fullRefresh = vi.spyOn(
      ArchiveCatalogPipelineService.prototype,
      'refreshAfterGalleryScan'
    ).mockResolvedValue({} as never);

    try {
      await expect(runCreatorScopedLocalIngestReconciliation(
        database,
        'G:\\cos图集',
        39,
        '五更百鬼'
      )).resolves.toEqual({
        scanRunId: 42,
        scanStatus: 'completed',
        scanError: null
      });
      expect(scanCosCreatorsMock).toHaveBeenCalledWith(
        ['五更百鬼'],
        'local-ingest',
        { repairUnchangedDerivatives: false, allowDerivativeMigration: false }
      );
      expect(scopedRefresh).toHaveBeenCalledWith({
        galleryRoot: 'G:\\cos图集',
        creatorId: 39,
        creatorFolderName: '五更百鬼'
      });
      expect(fullRefresh).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
