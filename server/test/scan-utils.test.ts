import { describe, expect, it } from 'vitest';

import {
  createFolderScanSignature,
  resolveFullScanOptions,
  shouldQueueDerivativeJobForStatus,
  shouldRefreshUnchangedImage,
  shouldSkipFolderBySignature
} from '../src/utils/scan-utils.js';

describe('full scan options', () => {
  it('repairs unchanged derivatives by default for non-startup full scans', () => {
    expect(resolveFullScanOptions()).toEqual({
      repairUnchangedDerivatives: true,
      forceNewFileDerivatives: true,
      allowDerivativeMigration: true
    });
    expect(shouldQueueDerivativeJobForStatus('unchanged', resolveFullScanOptions())).toBe(true);
  });

  it('skips unchanged derivative verification when startup disables repair', () => {
    const startupOptions = resolveFullScanOptions({
      repairUnchangedDerivatives: false
    });

    expect(shouldQueueDerivativeJobForStatus('unchanged', startupOptions)).toBe(false);
  });

  it('always queues derivatives for new and updated files', () => {
    const startupOptions = resolveFullScanOptions({
      repairUnchangedDerivatives: false
    });

    expect(shouldQueueDerivativeJobForStatus('new', startupOptions)).toBe(true);
    expect(shouldQueueDerivativeJobForStatus('updated', startupOptions)).toBe(true);
  });
});

describe('folder scan signatures', () => {
  it('creates stable signatures independent of discovery order', () => {
    const first = createFolderScanSignature([
      { relativePath: 'cats/z.png', fileSize: 30, mtimeMs: 100.2 },
      { relativePath: 'cats/a.png', fileSize: 10, mtimeMs: 50.8 }
    ]);
    const second = createFolderScanSignature([
      { relativePath: 'cats/a.png', fileSize: 10, mtimeMs: 50.8 },
      { relativePath: 'cats/z.png', fileSize: 30, mtimeMs: 100.2 }
    ]);

    expect(first.signature).toBe(second.signature);
    expect(first.fileCount).toBe(2);
    expect(first.totalSize).toBe(40);
    expect(first.maxMtimeMs).toBe(100);
  });
});

describe('folder shortcut decisions', () => {
  it('only skips full folder processing when the stored signature matches on stable startup scans', () => {
    expect(
      shouldSkipFolderBySignature({
        currentSignature: 'abc',
        galleryRootChanged: false,
        hasStoredGalleryRoot: true,
        hasMatchingIndexedFiles: true,
        repairUnchangedDerivatives: false,
        storedSignature: 'abc'
      })
    ).toBe(true);

    expect(
      shouldSkipFolderBySignature({
        currentSignature: 'abc',
        galleryRootChanged: true,
        hasStoredGalleryRoot: true,
        hasMatchingIndexedFiles: true,
        repairUnchangedDerivatives: false,
        storedSignature: 'abc'
      })
    ).toBe(false);

    expect(
      shouldSkipFolderBySignature({
        currentSignature: 'abc',
        galleryRootChanged: false,
        hasStoredGalleryRoot: true,
        hasMatchingIndexedFiles: true,
        repairUnchangedDerivatives: true,
        storedSignature: 'abc'
      })
    ).toBe(false);
  });

  it('does not shortcut when the active indexed rows are missing or stale', () => {
    expect(
      shouldSkipFolderBySignature({
        currentSignature: 'abc',
        galleryRootChanged: false,
        hasStoredGalleryRoot: true,
        hasMatchingIndexedFiles: false,
        repairUnchangedDerivatives: false,
        storedSignature: 'abc'
      })
    ).toBe(false);
  });
});

describe('unchanged image refresh decisions', () => {
  it('refreshes unchanged rows when reactivation or path migration safety requires it', () => {
    expect(
      shouldRefreshUnchangedImage({
        absolutePathChanged: false,
        galleryRootChanged: false,
        hasStoredGalleryRoot: false,
        isDeleted: false
      })
    ).toBe(true);

    expect(
      shouldRefreshUnchangedImage({
        absolutePathChanged: false,
        galleryRootChanged: false,
        hasStoredGalleryRoot: true,
        isDeleted: true
      })
    ).toBe(true);

    expect(
      shouldRefreshUnchangedImage({
        absolutePathChanged: true,
        galleryRootChanged: true,
        hasStoredGalleryRoot: true,
        isDeleted: false
      })
    ).toBe(true);
  });

  it('skips unchanged row refreshes when the gallery root is stable and the row is already active', () => {
    expect(
      shouldRefreshUnchangedImage({
        absolutePathChanged: false,
        galleryRootChanged: false,
        hasStoredGalleryRoot: true,
        isDeleted: false
      })
    ).toBe(false);
  });
});

describe('compareNaturalFilename (Issue 12)', () => {
  it('correctly sorts numeric numbers naturally', async () => {
    const { compareNaturalFilename } = await import('../src/utils/scan-utils.js');
    const files = ['file10.jpg', 'file2.jpg', 'file1.jpg', 'file20.jpg'];
    files.sort(compareNaturalFilename);
    expect(files).toEqual(['file1.jpg', 'file2.jpg', 'file10.jpg', 'file20.jpg']);
  });

  it('deterministically breaks ties for case variants across permutations', async () => {
    const { compareNaturalFilename } = await import('../src/utils/scan-utils.js');
    const list1 = ['a.jpg', 'A.jpg', 'b.jpg', 'B.jpg'];
    const list2 = ['B.jpg', 'b.jpg', 'A.jpg', 'a.jpg'];
    list1.sort(compareNaturalFilename);
    list2.sort(compareNaturalFilename);
    expect(list1).toEqual(list2);
  });

  it('deterministically sorts composed and decomposed unicode accents', async () => {
    const { compareNaturalFilename } = await import('../src/utils/scan-utils.js');
    const composed = 'r\u00e9sum\u00e9.jpg';
    const decomposed = 're\u0301sume\u0301.jpg';
    const list = [decomposed, composed, 'resume.jpg'];
    list.sort(compareNaturalFilename);
    expect(list[0]).toBe('resume.jpg');
    const sorted1 = [decomposed, composed].sort(compareNaturalFilename);
    const sorted2 = [composed, decomposed].sort(compareNaturalFilename);
    expect(sorted1).toEqual(sorted2);
  });

  it('deterministically handles numeric zero-padding variants', async () => {
    const { compareNaturalFilename } = await import('../src/utils/scan-utils.js');
    const list1 = ['01.jpg', '1.jpg', '001.jpg'];
    const list2 = ['1.jpg', '001.jpg', '01.jpg'];
    list1.sort(compareNaturalFilename);
    list2.sort(compareNaturalFilename);
    expect(list1).toEqual(list2);
  });
});
