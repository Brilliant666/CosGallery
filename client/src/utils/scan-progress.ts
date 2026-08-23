import type { ScanOperation, ScanProgress } from '../types/api';

export interface ScanBarState {
  indeterminate: boolean;
  percent: number;
}

export interface ScanStatCard {
  label: string;
  value: string;
}

const SCAN_OPERATION_LABELS: Record<ScanOperation, string> = {
  checking_derivatives: 'Checking derivatives',
  backfilling_asset_key: 'Backfilling asset key',
  moving_thumbnail: 'Moving thumbnail',
  moving_preview: 'Moving preview',
  repairing_thumbnail: 'Repairing thumbnail',
  repairing_preview: 'Repairing preview',
  regenerating_derivatives: 'Regenerating derivatives',
  discovering_media: 'Discovering folders and media',
  generating_thumbnail: 'Generating thumbnail',
  generating_preview: 'Generating preview',
  generating_thumbnail_and_preview: 'Generating thumbnail and preview'
};

function formatRatio(current: number, total: number, fallback = '?'): string {
  return `${current}/${total > 0 ? total : fallback}`;
}

function calculateDeterminatePercent(current: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

export function getScanPhaseLabel(scan: ScanProgress | null): string {
  if (!scan?.isScanning) {
    return 'Idle';
  }

  if (scan.phase === 'migration') {
    return 'Migration';
  }

  if (scan.phase === 'derivatives') {
    return 'Derivatives';
  }

  return 'Discovery';
}

export function getScanSummary(scan: ScanProgress | null): string {
  if (!scan) {
    return '';
  }

  if (scan.currentPhaseMessage) {
    return scan.currentPhaseMessage;
  }

  if (scan.phase === 'migration') {
    return 'Upgrading legacy thumbnails and previews before indexing starts.';
  }

  if (scan.phase === 'derivatives') {
    return scan.scanReason === 'rebuild-thumbnails'
      ? 'Generating feed thumbnails, profile thumbnails, and video posters.'
      : 'Generating thumbnails and previews for queued changes.';
  }

  return scan.scanReason === 'rebuild-thumbnails'
    ? 'Loading indexed media before thumbnail regeneration starts.'
    : 'Discovering folders and media...';
}

export function getScanOperationLabel(scan: ScanProgress | null): string | null {
  if (!scan?.currentOperation) {
    return null;
  }

  return SCAN_OPERATION_LABELS[scan.currentOperation] ?? null;
}

export function getScanLocation(scan: ScanProgress | null): string | null {
  if (!scan) {
    return null;
  }

  return scan.currentFile ?? scan.currentFolder ?? null;
}

export function getScanActionLine(scan: ScanProgress | null): string | null {
  const operationLabel = getScanOperationLabel(scan);
  const location = getScanLocation(scan);

  if (!operationLabel) {
    return location;
  }

  if (!location) {
    return operationLabel;
  }

  return `${operationLabel}: ${location}`;
}

export function getScanMetricLine(scan: ScanProgress | null): string {
  if (!scan) {
    return '';
  }

  if (scan.phase === 'migration') {
    return [
      `${formatRatio(scan.processedMigrationRows, scan.migrationTotalRows)} assets checked`,
      `${scan.migratedDerivativeFiles} moved`,
      `${scan.repairedDerivativeFiles} repaired`,
      `${scan.missingDerivativeFiles} missing`
    ].join(' | ');
  }

  if (scan.phase === 'derivatives') {
    return [
      `${formatRatio(scan.processedDerivativeJobs, scan.queuedDerivativeJobs, '0')} jobs complete`,
      `${scan.generatedThumbnails} thumbnails`,
      `${scan.generatedPreviews} previews`
    ].join(' | ');
  }

  return [
    `${formatRatio(scan.processedFolders, scan.discoveredFolders, '0')} folders processed`,
    `${formatRatio(scan.processedImages, scan.discoveredImages, '0')} posts indexed`
  ].join(' | ');
}

export function getScanBarState(scan: ScanProgress | null): ScanBarState {
  if (!scan?.isScanning) {
    return {
      indeterminate: false,
      percent: 0
    };
  }

  if (scan.phase === 'discovery') {
    return {
      indeterminate: true,
      percent: 0
    };
  }

  if (scan.phase === 'migration') {
    return {
      indeterminate: false,
      percent: calculateDeterminatePercent(scan.processedMigrationRows, scan.migrationTotalRows)
    };
  }

  return {
    indeterminate: false,
    percent: calculateDeterminatePercent(scan.processedDerivativeJobs, scan.queuedDerivativeJobs)
  };
}

export function getInitialScanStats(scan: ScanProgress | null): ScanStatCard[] {
  if (!scan) {
    return [
      { label: 'Folders', value: '0' },
      { label: 'Posts', value: '0' },
      { label: 'Thumbnails', value: '0' },
      { label: 'Previews', value: '0' }
    ];
  }

  if (scan.phase === 'migration') {
    return [
      {
        label: 'Assets checked',
        value: formatRatio(scan.processedMigrationRows, scan.migrationTotalRows, '0')
      },
      {
        label: 'Files moved',
        value: String(scan.migratedDerivativeFiles)
      },
      {
        label: 'Files repaired',
        value: String(scan.repairedDerivativeFiles)
      },
      {
        label: 'Missing files',
        value: String(scan.missingDerivativeFiles)
      }
    ];
  }

  if (scan.phase === 'derivatives') {
    return [
      {
        label: 'Jobs complete',
        value: formatRatio(scan.processedDerivativeJobs, scan.queuedDerivativeJobs, '0')
      },
      {
        label: 'Queued jobs',
        value: String(scan.queuedDerivativeJobs)
      },
      {
        label: 'Thumbnails',
        value: String(scan.generatedThumbnails)
      },
      {
        label: 'Previews',
        value: String(scan.generatedPreviews)
      }
    ];
  }

  return [
    {
      label: 'Folders found',
      value: String(scan.discoveredFolders)
    },
    {
      label: 'Folders processed',
      value: String(scan.processedFolders)
    },
    {
      label: 'Posts found',
      value: String(scan.discoveredImages)
    },
    {
      label: 'Posts indexed',
      value: String(scan.processedImages)
    }
  ];
}
