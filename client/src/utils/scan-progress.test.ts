import { describe, expect, it } from 'vitest';

import type { ScanProgress } from '../types/api';
import {
  getInitialScanStats,
  getScanActionLine,
  getScanBarState,
  getScanMetricLine,
  getScanSummary
} from './scan-progress';

function createScanProgress(overrides: Partial<ScanProgress> = {}): ScanProgress {
  return {
    isScanning: true,
    scanReason: 'manual',
    phase: 'discovery',
    startedAt: '2026-04-03T12:00:00.000Z',
    runId: 1,
    migrationTotalRows: 0,
    processedMigrationRows: 0,
    migratedDerivativeFiles: 0,
    missingDerivativeFiles: 0,
    repairedDerivativeFiles: 0,
    backfilledAssetKeys: 0,
    discoveredFolders: 4,
    processedFolders: 2,
    discoveredImages: 24,
    processedImages: 12,
    queuedDerivativeJobs: 0,
    processedDerivativeJobs: 0,
    generatedThumbnails: 0,
    generatedPreviews: 0,
    currentOperation: 'discovering_media',
    currentFile: null,
    currentPhaseMessage: 'Discovering folders and media...',
    currentFolder: 'trips',
    lastCompletedScan: null,
    ...overrides
  };
}

describe('scan progress helpers', () => {
  it('keeps discovery progress indeterminate instead of inventing a percent', () => {
    expect(getScanBarState(createScanProgress())).toEqual({
      indeterminate: true,
      percent: 0
    });
  });

  it('formats migration actions and counters from the richer progress payload', () => {
    const progress = createScanProgress({
      phase: 'migration',
      migrationTotalRows: 20,
      processedMigrationRows: 7,
      migratedDerivativeFiles: 3,
      repairedDerivativeFiles: 2,
      missingDerivativeFiles: 1,
      currentOperation: 'moving_preview',
      currentFile: 'archive/photo.jpg',
      currentFolder: 'archive',
      currentPhaseMessage: 'Upgrading legacy thumbnails and previews before indexing starts.'
    });

    expect(getScanSummary(progress)).toBe('Upgrading legacy thumbnails and previews before indexing starts.');
    expect(getScanActionLine(progress)).toBe('Moving preview: archive/photo.jpg');
    expect(getScanMetricLine(progress)).toBe('7/20 assets checked | 3 moved | 2 repaired | 1 missing');
    expect(getInitialScanStats(progress)).toEqual([
      { label: 'Assets checked', value: '7/20' },
      { label: 'Files moved', value: '3' },
      { label: 'Files repaired', value: '2' },
      { label: 'Missing files', value: '1' }
    ]);
  });
});
