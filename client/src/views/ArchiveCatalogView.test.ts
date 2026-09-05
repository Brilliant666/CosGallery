vi.mock('../components/ManagedCreatorRoster.vue', () => ({default:{template:'<div data-test="managed-roster-slot" />'}}));
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ArchiveCatalogView from './ArchiveCatalogView.vue';
import type { LocalIngestJob } from '../types/api';
import { RequestError } from '../api/http';
import {
  fetchArchiveBridgeStatus,
  fetchArchiveCatalog,
  fetchArchiveCatalogCreator,
  fetchArchiveDownloadTasks,
  fetchArchiveMetadataTasks,
  fetchLocalIngestInboxCreators,
  fetchLocalIngestJobs,
  fetchLocalIngestOperation,
  fetchLocalIngestSettings,
  planArchiveDownloadTasks,
  planArchiveMetadataTasks,
  retryLocalIngestCleanup,
  rotateArchiveBridgeToken,
  runLocalIngestBatch,
  runLocalIngestJob,
  saveLocalIngestSettings,
  scanLocalIngestInbox,
  smokeTestLocalIngestRecycleBin,
  validateLocalIngestSettings
} from '../api/gallery';

vi.mock('../api/gallery', () => ({
  fetchArchiveCatalog: vi.fn(),
  fetchArchiveCatalogCreator: vi.fn(),
  fetchArchiveDownloadTasks: vi.fn(),
  fetchArchiveMetadataTasks: vi.fn(),
  planArchiveDownloadTasks: vi.fn(),
  planArchiveMetadataTasks: vi.fn(),
  fetchArchiveBridgeStatus: vi.fn(),
  rotateArchiveBridgeToken: vi.fn(),
  fetchLocalIngestInboxCreators: vi.fn(),
  fetchLocalIngestJobs: vi.fn(),
  fetchLocalIngestOperation: vi.fn(),
  fetchLocalIngestSettings: vi.fn(),
  retryLocalIngestCleanup: vi.fn(),
  runLocalIngestBatch: vi.fn(),
  runLocalIngestJob: vi.fn(),
  saveLocalIngestSettings: vi.fn(),
  scanLocalIngestInbox: vi.fn(),
  smokeTestLocalIngestRecycleBin: vi.fn(),
  validateLocalIngestSettings: vi.fn()
}));

const summary = {
  creators: 593,
  liked: 201,
  kept: 392,
  r15: 259,
  r18: 334,
  creatorsWithSources: 18,
  creatorsWithLocalWorks: 12,
  sourceCollections: 18,
  remoteWorks: 1184,
  localWorks: 96,
  matchedWorks: 96,
  missingWorks: 1088,
  unresolvedCreatorFolders: 0,
  unresolvedLocalWorks: 0
};

const creator = {
  id: 115,
  name: 'rua阮阮',
  preference: 'liked' as const,
  rating: 'R18' as const,
  sourceCollections: 1,
  remoteWorks: 17,
  localWorks: 13,
  matchedWorks: 13,
  missingWorks: 4,
  unresolvedLocalWorks: 0,
  latestSourceObservation: '2026-08-31T00:00:00.000Z'
};

const localIngestSettings = {
  libraryRoot: 'G:\\cos图集',
  inboxRoot: 'G:\\cos待入库',
  processingRoot: 'G:\\cos处理中',
  sevenZipPath: 'C:\\Program Files\\7-Zip\\7z.exe',
  fileStableSeconds: 5,
  recycleAfterIngest: true,
  maxExtractionDepth: 2 as const,
  allowlist: ['火龙果羊', '女主K'],
  archivePasswordConfigured: true
};

const localIngestJob = {
  id: 1,
  archiveDownloadTaskId: 1068,
  sourceWorkId: 485,
  creatorId: 192,
  creatorName: '火龙果羊',
  sourceArchivePath: 'G:\\cos待入库\\火龙果羊\\007.7z',
  sourceArchiveName: '007.7z',
  sourceArchiveSize: 79_924_226,
  sourceArchiveMtime: Date.now(),
  sourceArchiveSha256: '17A57441040E338D3380DEFC8B0EF4EAD37CA97E951B5F03E9AA09E513691E58',
  status: 'ingested' as const,
  phase: 'done',
  validationStatus: 'passed' as const,
  cleanupStatus: 'recycled' as const,
  processingPath: 'G:\\cos处理中\\1',
  targetPath: 'G:\\cos图集\\火龙果羊\\火龙果羊 NO.007 日系死库水[24P-76M]',
  attemptCount: 1,
  errorCode: null,
  errorDetail: null,
  summary: {
    rawTitle: '火龙果羊 NO.007 日系死库水[24P-76M]',
    outerFormat: '7z',
    levelOneOutput: ['007.7z'],
    innerOriginalName: '007.7zz',
    innerWorkingName: '007.7z',
    imageCount: 24,
    videoCount: 0,
    advertisementFileCount: 0,
    unknownFiles: [],
    warnings: [],
    plannedTargetPath: 'G:\\cos图集\\火龙果羊\\火龙果羊 NO.007 日系死库水[24P-76M]'
  },
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:05:00.000Z',
  completedAt: '2026-09-02T00:05:00.000Z'
};

const idleLocalIngestOperation = {
  state: 'idle' as const,
  kind: null,
  startedAt: null,
  updatedAt: null,
  elapsedMs: 0,
  message: null,
  run: null,
  lastCompleted: null
};

function localIngestDashboard(job: LocalIngestJob = localIngestJob) {
  const counts = {
    total: 1,
    pending: job.status === 'queued' || job.status === 'reconciling' ? 1 : 0,
    running: job.status === 'running' ? 1 : 0,
    ingested: job.status === 'ingested' ? 1 : 0,
    awaitingReview: job.status === 'awaiting_review' ? 1 : 0,
    failed: job.status === 'failed' ? 1 : 0
  };
  return {
    summary: counts,
    creators: [{
      creatorId: job.creatorId,
      creatorName: job.creatorName,
      ...counts,
      progressPercent: job.status === 'ingested' ? 100 : 0,
      isCurrent: false
    }],
    items: [job],
    total: 1,
    page: 1,
    limit: 50,
    hasMore: false
  };
}

const inboxCreatorsResult = {
  inboxRoot: 'G:\\cos待入库',
  detected: [{
    folderName: '女主K',
    folderNames: ['女主K'],
    creatorId: 2,
    canonicalName: '女主K',
    mappingStatus: 'matched' as const,
    mappingReason: '已唯一映射到规范博主',
    archiveCount: 2,
    queuedJobCount: 1,
    failedJobCount: 0,
    awaitingReviewJobCount: 0
  }, {
    folderName: '新博主别名',
    folderNames: ['新博主别名'],
    creatorId: 3,
    canonicalName: '新博主',
    mappingStatus: 'matched' as const,
    mappingReason: '已唯一映射到规范博主',
    archiveCount: 3,
    queuedJobCount: 0,
    failedJobCount: 1,
    awaitingReviewJobCount: 0
  }],
  unmapped: [{
    folderName: '未知目录',
    folderNames: ['未知目录'],
    creatorId: null,
    canonicalName: null,
    mappingStatus: 'unmatched' as const,
    mappingReason: '未找到匹配的博主或别名',
    archiveCount: 4,
    queuedJobCount: 0,
    failedJobCount: 0,
    awaitingReviewJobCount: 0
  }],
  summary: {
    directoryCount: 3,
    matchedDirectoryCount: 2,
    matchedCreatorCount: 2,
    unmappedDirectoryCount: 1,
    ambiguousDirectoryCount: 0,
    archiveCount: 9,
    queuedJobCount: 1,
    failedJobCount: 1,
    awaitingReviewJobCount: 0
  }
};

describe('ArchiveCatalogView', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  beforeEach(() => {
    vi.mocked(fetchArchiveCatalog).mockReset();
    vi.mocked(fetchArchiveCatalogCreator).mockReset();
    vi.mocked(fetchArchiveDownloadTasks).mockReset();
    vi.mocked(fetchArchiveMetadataTasks).mockReset();
    vi.mocked(planArchiveDownloadTasks).mockReset();
    vi.mocked(planArchiveMetadataTasks).mockReset();
    vi.mocked(fetchArchiveBridgeStatus).mockReset();
    vi.mocked(rotateArchiveBridgeToken).mockReset();
    vi.mocked(fetchLocalIngestInboxCreators).mockReset();
    vi.mocked(fetchLocalIngestJobs).mockReset();
    vi.mocked(fetchLocalIngestOperation).mockReset();
    vi.mocked(fetchLocalIngestSettings).mockReset();
    vi.mocked(retryLocalIngestCleanup).mockReset();
    vi.mocked(runLocalIngestBatch).mockReset();
    vi.mocked(runLocalIngestJob).mockReset();
    vi.mocked(saveLocalIngestSettings).mockReset();
    vi.mocked(scanLocalIngestInbox).mockReset();
    vi.mocked(smokeTestLocalIngestRecycleBin).mockReset();
    vi.mocked(validateLocalIngestSettings).mockReset();
    vi.mocked(fetchArchiveCatalog).mockResolvedValue({
      summary,
      items: [creator],
      page: 1,
      limit: 50,
      total: 1,
      hasMore: false
    });
    vi.mocked(fetchArchiveCatalogCreator).mockResolvedValue({
      ...creator,
      aliases: [{ alias: 'rua阮阮', source: 'hentaiclub' }],
      sources: [],
      collections: [{
        id: 1,
        source: 'costuan',
        sourceCollectionId: '10049',
        title: 'rua阮阮COSPLAY写真图片包合集[17套][持续更新]',
        url: 'https://www.costuan.com/10049.html',
        declaredWorkCount: 17,
        observedAt: '2026-08-31T00:00:00.000Z',
        deliveries: [{
          provider: 'baidu',
          type: 'share-folder',
          status: 'saved',
          sourceFolderName: '360',
          destinationPath: '我的网盘/cos图集',
          transferredAt: null
        }]
      }],
      missing: [{
        workId: 14,
        source: 'costuan',
        sourceCollectionId: '10049',
        sourceOrder: 14,
        sourceOrderLabel: 'NO.014',
        title: '课间的阳光'
      }],
      unresolved: []
    });
    vi.mocked(fetchArchiveDownloadTasks).mockResolvedValue({
      summary: {
        total: 1,
        pending: 1,
        claimed: 0,
        staged: 0,
        downloading: 0,
        downloaded: 0,
        ingested: 0,
        failed: 0,
        cancelled: 0
      },
      items: [{
        id: 1,
        creatorId: 115,
        creatorName: 'rua阮阮',
        preference: 'liked',
        rating: 'R18',
        workId: 14,
        sourceWorkId: 14,
        collectionId: 1,
        source: 'costuan',
        sourceCollectionId: '10049',
        sourceOrder: 14,
        sourceOrderLabel: 'NO.014',
        title: '课间的阳光',
        provider: 'baidu',
        sourceFolderName: '360',
        destinationPath: '我的网盘/cos图集',
        targetRoot: 'G:\\cos待入库',
        targetRelativeDirectory: 'rua阮阮',
        targetFilename: '014.7z',
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        downloadId: null,
        attemptCount: 0,
        lastError: null,
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z'
      }],
      total: 1
    });
    vi.mocked(fetchArchiveBridgeStatus).mockResolvedValue({ configured: false });
    vi.mocked(fetchLocalIngestInboxCreators).mockResolvedValue(inboxCreatorsResult);
    vi.mocked(fetchLocalIngestSettings).mockResolvedValue({ ...localIngestSettings, allowlist: [...localIngestSettings.allowlist] });
    vi.mocked(fetchLocalIngestJobs).mockResolvedValue(localIngestDashboard());
    vi.mocked(fetchLocalIngestOperation).mockResolvedValue(idleLocalIngestOperation);
    vi.mocked(saveLocalIngestSettings).mockResolvedValue({ ...localIngestSettings, allowlist: [...localIngestSettings.allowlist] });
    vi.mocked(scanLocalIngestInbox).mockResolvedValue({
      discoveredCreators: 0,
      discoveredArchives: 0,
      createdJobs: 0,
      existingJobs: 0,
      waitingStable: 0,
      awaitingReview: 0,
      reconciledDownloadedTasks: 0,
      ignoredFiles: 0
    });
    vi.mocked(runLocalIngestBatch).mockResolvedValue({
      total: 0,
      examined: 0,
      settled: 0,
      ingested: 0,
      failed: 0,
      awaitingReview: 0,
      reconciling: 0,
      claimUnavailable: 0,
      unchanged: 0
    });
    vi.mocked(runLocalIngestJob).mockResolvedValue(localIngestJob);
    vi.mocked(retryLocalIngestCleanup).mockResolvedValue(localIngestJob);
    vi.mocked(smokeTestLocalIngestRecycleBin).mockResolvedValue({ targetPath: 'G:\\cos处理中\\sentinel', recycled: true });
    vi.mocked(validateLocalIngestSettings).mockResolvedValue({
      valid: true,
      passwordConfigured: true,
      sevenZip: { valid: true, version: '7-Zip 22.01', error: null },
      paths: {
        libraryRoot: { path: localIngestSettings.libraryRoot, exists: true, readable: true, writable: true, freeBytes: 1, volume: 'g:\\', error: null },
        inboxRoot: { path: localIngestSettings.inboxRoot, exists: true, readable: true, writable: true, freeBytes: 1, volume: 'g:\\', error: null },
        processingRoot: { path: localIngestSettings.processingRoot, exists: true, readable: true, writable: true, freeBytes: 1, volume: 'g:\\', error: null }
      },
      sameVolume: true,
      errors: []
    });
    vi.mocked(fetchArchiveMetadataTasks).mockResolvedValue({
      summary: {
        total: 1,
        actionable: 1,
        pending: 1,
        claimed: 0,
        completed: 0,
        not_found: 0,
        failed: 0,
        cancelled: 0
      },
      items: [{
        id: 7,
        creatorId: 115,
        creatorName: 'rua阮阮',
        preference: 'liked',
        rating: 'R18',
        source: 'costuan',
        localWorks: 13,
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        completedAt: null,
        attemptCount: 0,
        lastError: null,
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z'
      }],
      total: 1
    });
    vi.mocked(planArchiveMetadataTasks).mockResolvedValue({
      source: 'costuan',
      candidates: 17,
      created: 17,
      requeued: 0,
      reconciled: 0,
      summary: {
        total: 17,
        actionable: 17,
        pending: 17,
        claimed: 0,
        completed: 0,
        not_found: 0,
        failed: 0,
        cancelled: 0
      }
    });
    vi.mocked(planArchiveDownloadTasks).mockResolvedValue({
      created: 1,
      existing: 0,
      removedOutOfScope: 0,
      reconciledLocal: 0,
      skippedWithoutOrder: 0,
      skippedWithoutDelivery: 0,
      targetRoot: 'G:\\cos待入库'
    });
    vi.mocked(rotateArchiveBridgeToken).mockResolvedValue({ token: 'test-token' });
  });

  it('shows ledger totals and loads missing works when a creator is expanded', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    expect(wrapper.text()).toContain('图库账本');
    expect(wrapper.text()).toContain('1,088');
    expect(wrapper.get('[data-test="catalog-creator"]').text()).toContain('rua阮阮');
    expect(wrapper.get('[data-test="catalog-creator"]').text()).toContain('有 4 套待收录');

    await wrapper.get('[data-test="catalog-creator"] button[aria-expanded="false"]').trigger('click');
    await flushPromises();

    expect(fetchArchiveCatalogCreator).toHaveBeenCalledWith(115);
    expect(wrapper.get('[data-test="catalog-detail"]').text()).toContain('NO.014');
    expect(wrapper.get('[data-test="catalog-detail"]').text()).toContain('课间的阳光');
    expect(wrapper.get('[data-test="catalog-detail"]').text()).toContain('百度网盘：saved');
  });

  it('passes preference and rating filters to the API', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    const selects = wrapper.get('form').findAll('select');
    await selects[0].setValue('liked');
    await flushPromises();
    await selects[1].setValue('R18');
    await flushPromises();

    expect(fetchArchiveCatalog).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      preference: 'liked',
      rating: 'R18'
    }));
  });

  it('generates per-creator download tasks under the isolated inbox root', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    await wrapper.get('[data-test="plan-downloads"]').trigger('click');
    await flushPromises();

    expect(planArchiveDownloadTasks).toHaveBeenCalledWith('G:\\cos待入库', undefined);
    expect(wrapper.get('[data-test="download-notice"]').text()).toContain('已新增 1 条任务');
    expect(wrapper.text()).toContain('rua阮阮\\014.7z');
  });

  it('generates Costuan metadata tasks for creators that only exist locally', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    expect(wrapper.text()).toContain('本地博主来源关联');
    await wrapper.get('[data-test="plan-metadata"]').trigger('click');
    await flushPromises();

    expect(planArchiveMetadataTasks).toHaveBeenCalledWith(false);
    expect(wrapper.get('[data-test="metadata-notice"]').text()).toContain('检测到 17 位本地待关联博主');
  });

  it('shows a redacted full ingest preview and can run the allowlisted batch', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    expect(wrapper.text()).toContain('本地入库闭环');
    expect(wrapper.text()).toContain('解压密码：已配置');
    expect(wrapper.text()).toContain('V1 正式图库根目录由 GALLERY_ROOT 启动配置决定');
    expect(wrapper.text()).not.toContain('隔离目录');
    const libraryInput = wrapper.findAll('input').find((input) => input.element.value === localIngestSettings.libraryRoot);
    expect(libraryInput?.attributes()).toHaveProperty('readonly');
    expect(wrapper.text()).toContain('007.7zz');
    expect(wrapper.text()).toContain(localIngestJob.sourceArchiveSha256);
    expect(wrapper.text()).not.toContain('fixture-password');

    await wrapper.get('[data-test="run-local-ingest-batch"]').trigger('click');
    await flushPromises();

    expect(runLocalIngestBatch).toHaveBeenCalledWith({});
    expect(wrapper.text()).toContain('当前没有可运行任务');
  });

  it('continues the selected creator across the complete server-side task set and reports non-terminal outcomes', async () => {
    const reconcilingJob: LocalIngestJob = {
      ...localIngestJob,
      status: 'reconciling',
      phase: 'reconciling',
      cleanupStatus: 'pending',
      errorCode: 'RECONCILIATION_INCOMPLETE',
      errorDetail: 'fixture reconciliation evidence'
    };
    vi.mocked(fetchLocalIngestJobs).mockResolvedValue(localIngestDashboard(reconcilingJob));
    vi.mocked(runLocalIngestBatch).mockResolvedValue({
      total: 1,
      examined: 1,
      settled: 0,
      ingested: 0,
      failed: 0,
      awaitingReview: 0,
      reconciling: 1,
      claimUnavailable: 0,
      unchanged: 0
    });
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    await wrapper.get('[data-test="run-local-ingest-creator"]').trigger('click');
    await flushPromises();

    expect(runLocalIngestBatch).toHaveBeenCalledWith({ creatorIds: [reconcilingJob.creatorId] });
    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain('仍待对账 1');
    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain('执行权被占用 0');
  });

  it('shows concrete evidence for an awaiting-review job without offering a bulk or single run action', async () => {
    const reviewJob: LocalIngestJob = {
      ...localIngestJob,
      status: 'awaiting_review',
      phase: 'validating',
      validationStatus: 'failed',
      cleanupStatus: 'not_ready',
      targetPath: 'G:\\gallery\\lunana\\planned-work',
      errorCode: 'UNKNOWN_FILE_TYPE',
      errorDetail: 'Unknown files require review: portrait.jfif',
      summary: {
        ...localIngestJob.summary,
        unknownFiles: ['portrait.jfif']
      }
    };
    vi.mocked(fetchLocalIngestJobs).mockResolvedValue(localIngestDashboard(reviewJob));
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    const evidence = wrapper.get('[data-test="local-ingest-review-evidence"]');
    expect(evidence.text()).toContain('portrait.jfif');
    expect(evidence.text()).toContain(reviewJob.processingPath!);
    expect(evidence.text()).toContain('正式目录：尚未提交');
    expect(evidence.text()).toContain(`计划路径：${reviewJob.targetPath}`);
    expect(wrapper.find('[data-test="run-local-ingest-job"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="run-local-ingest-creator"]').exists()).toBe(false);
  });

  it('reads inbox creators without saving and appends unique canonical names to the draft', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();
    const allowlist = wrapper.get('[data-test="local-ingest-allowlist"]');
    const original = (allowlist.element as HTMLTextAreaElement).value;

    await wrapper.get('[data-test="discover-inbox-creators"]').trigger('click');
    await flushPromises();

    expect(fetchLocalIngestInboxCreators).toHaveBeenCalledTimes(1);
    expect((allowlist.element as HTMLTextAreaElement).value).toBe(original);
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="inbox-creators-result"]').text()).toContain('2 位博主 / 9 个压缩包 / 2 个已有任务');
    expect(wrapper.get('[data-test="inbox-creators-result"]').text()).toContain('未知目录');

    await wrapper.get('[data-test="append-inbox-creators"]').trigger('click');

    expect((allowlist.element as HTMLTextAreaElement).value).toBe('火龙果羊\n女主K\n新博主');
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="scan-local-ingest"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.text()).toContain('请确认后点击“保存配置”');
  });

  it('replaces only the unsaved allowlist draft after explicit confirmation', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    await wrapper.get('[data-test="discover-inbox-creators"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="replace-inbox-creators"]').trigger('click');

    expect((wrapper.get('[data-test="local-ingest-allowlist"]').element as HTMLTextAreaElement).value)
      .toBe('女主K\n新博主');
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();

    await wrapper.get('[data-test="cancel-inbox-creators"]').trigger('click');
    expect(wrapper.find('[data-test="inbox-creators-result"]').exists()).toBe(false);
  });

  it('labels a stale recovered job as resumable', async () => {
    vi.mocked(fetchLocalIngestJobs).mockResolvedValue(localIngestDashboard({
      ...localIngestJob,
      status: 'failed',
      phase: 'extracting_outer',
      errorCode: 'INTERRUPTED_PROCESS',
      errorDetail: 'internal English fallback'
    }));
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    expect(wrapper.text()).toContain('上次进程中断，可继续');
    expect(wrapper.text()).not.toContain('internal English fallback');
  });

  it.each([
    {
      state: 'scanning' as const,
      kind: 'scan' as const,
      message: '正在扫描待入库目录',
      run: null
    },
    {
      state: 'running' as const,
      kind: 'batch' as const,
      message: '正在运行批次',
      run: {
        total: 10,
        examined: 3,
        settled: 3,
        ingested: 2,
        failed: 1,
        awaitingReview: 0,
        reconciling: 0,
        claimUnavailable: 0,
        unchanged: 0,
        remaining: 7,
        currentJob: {
          id: 1,
          creatorId: localIngestJob.creatorId,
          creatorName: localIngestJob.creatorName,
          archiveName: localIngestJob.sourceArchiveName,
          status: 'running',
          phase: 'extracting_inner'
        }
      }
    }
  ])('locks every Stage 3 input and write action while $state', async (active) => {
    const failedJob: LocalIngestJob = {
      ...localIngestJob,
      status: 'failed',
      phase: 'extracting_outer',
      errorCode: 'ARCHIVE_CORRUPT',
      errorDetail: 'fixture'
    };
    vi.mocked(fetchLocalIngestJobs).mockResolvedValue(localIngestDashboard(failedJob));
    vi.mocked(fetchLocalIngestOperation).mockResolvedValue({
      ...idleLocalIngestOperation,
      ...active,
      startedAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z'
    });
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    for (const selector of [
      '[data-test="local-ingest-inbox-root"]',
      '[data-test="local-ingest-processing-root"]',
      '[data-test="local-ingest-sevenzip"]',
      '[data-test="local-ingest-allowlist"]',
      '[data-test="local-ingest-stable-seconds"]',
      '[data-test="local-ingest-recycle"]',
      '[data-test="discover-inbox-creators"]',
      '[data-test="save-local-ingest"]',
      '[data-test="validate-local-ingest"]',
      '[data-test="smoke-local-ingest-recycle"]',
      '[data-test="scan-local-ingest"]',
      '[data-test="run-local-ingest-batch"]',
      '[data-test="run-local-ingest-job"]'
    ]) {
      expect(wrapper.get(selector).attributes()).toHaveProperty('disabled');
    }
    expect(wrapper.get('[data-test="refresh-stage3"]').attributes()).not.toHaveProperty('disabled');
    expect(wrapper.get('[data-test="local-ingest-creators"] button').attributes()).not.toHaveProperty('disabled');
    expect(wrapper.get('[data-test="stage3-operation-card"]').text()).toContain(active.state === 'scanning' ? '正在扫描' : '正在运行');
    wrapper.unmount();
  });

  it('adopts the server operation from a 409 response and keeps Stage 3 locked', async () => {
    const activeOperation = {
      ...idleLocalIngestOperation,
      state: 'scanning' as const,
      kind: 'scan' as const,
      startedAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z',
      message: '另一个标签页正在扫描'
    };
    vi.mocked(fetchLocalIngestInboxCreators).mockRejectedValueOnce(new RequestError(
      'Stage 3 当前已有操作正在执行',
      409,
      { code: 'LOCAL_INGEST_OPERATION_ACTIVE', message: 'Stage 3 当前已有操作正在执行', operation: activeOperation }
    ));
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();
    await wrapper.get('[data-test="discover-inbox-creators"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test="stage3-operation-card"]').text()).toContain('正在扫描');
    expect(wrapper.get('[data-test="scan-local-ingest"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('[data-test="local-ingest-allowlist"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain('页面已恢复服务端操作状态');
    wrapper.unmount();
  });

  it('keeps scanning explicit, does not save a draft, and refreshes Stage 2 only after scan completion', async () => {
    vi.mocked(scanLocalIngestInbox).mockResolvedValueOnce({
      discoveredCreators: 2,
      discoveredArchives: 7,
      createdJobs: 4,
      existingJobs: 2,
      waitingStable: 1,
      awaitingReview: 0,
      reconciledDownloadedTasks: 6,
      ignoredFiles: 3
    });
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();
    const stage1Reads = vi.mocked(fetchArchiveMetadataTasks).mock.calls.length;
    const stage2Reads = vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;

    await wrapper.get('[data-test="scan-local-ingest"]').trigger('click');
    await flushPromises();

    expect(scanLocalIngestInbox).toHaveBeenCalledWith();
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads + 1);
    expect(fetchArchiveMetadataTasks).toHaveBeenCalledTimes(stage1Reads);
    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain('已确认 6 个本地下载');
    wrapper.unmount();
  });

  it('refreshes only Stage 2 when its manual refresh button is clicked', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();
    const stage2Reads = vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;
    const stage1Reads = vi.mocked(fetchArchiveMetadataTasks).mock.calls.length;
    const stage3Reads = vi.mocked(fetchLocalIngestJobs).mock.calls.length;
    const catalogReads = vi.mocked(fetchArchiveCatalog).mock.calls.length;

    await wrapper.get('[data-test="refresh-stage2"]').trigger('click');
    await flushPromises();

    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads + 1);
    expect(fetchArchiveMetadataTasks).toHaveBeenCalledTimes(stage1Reads);
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(stage3Reads);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads);
    expect(wrapper.get('[data-test="download-notice"]').text()).toContain('未执行任务规划或本地扫描');
    wrapper.unmount();
  });

  it('distinguishes Stage 2 cloud staging, local download, and completed ingest states', async () => {
    const initial = await fetchArchiveDownloadTasks();
    vi.mocked(fetchArchiveDownloadTasks).mockClear();
    const base = initial.items[0];
    vi.mocked(fetchArchiveDownloadTasks).mockResolvedValue({
      summary: {
        total: 3,
        pending: 0,
        claimed: 0,
        staged: 1,
        downloading: 0,
        downloaded: 1,
        ingested: 1,
        failed: 0,
        cancelled: 0
      },
      items: [
        { ...base, id: 1, status: 'staged' },
        { ...base, id: 2, status: 'downloaded' },
        { ...base, id: 3, status: 'ingested' }
      ],
      total: 3
    });

    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();
    const stage2 = wrapper.get('[aria-label="缺失作品下载队列"]');

    expect(stage2.text()).toContain('网盘已暂存，待本地确认');
    expect(stage2.text()).toContain('本地已下载，待入库');
    expect(stage2.text()).toContain('已入库');
    expect(stage2.text()).toContain('网盘已暂存');
    expect(stage2.text()).toContain('本地待入库');
    expect(stage2.text()).not.toContain('网盘待下载');
    wrapper.unmount();
  });

  it('does not poll operation, jobs, Stage 2, or the catalog while a same-page scan request is pending', async () => {
    vi.useFakeTimers();
    let resolveScan!: (value: Awaited<ReturnType<typeof scanLocalIngestInbox>>) => void;
    vi.mocked(scanLocalIngestInbox).mockReturnValueOnce(new Promise((resolve) => { resolveScan = resolve; }));
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();
    const operationReads = vi.mocked(fetchLocalIngestOperation).mock.calls.length;
    const jobReads = vi.mocked(fetchLocalIngestJobs).mock.calls.length;
    const stage2Reads = vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;
    const catalogReads = vi.mocked(fetchArchiveCatalog).mock.calls.length;

    void wrapper.get('[data-test="scan-local-ingest"]').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(operationReads);
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(jobReads);
    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads);

    resolveScan({
      discoveredCreators: 1,
      discoveredArchives: 1,
      createdJobs: 1,
      existingJobs: 0,
      waitingStable: 0,
      awaitingReview: 0,
      reconciledDownloadedTasks: 1,
      ignoredFiles: 0
    });
    await flushPromises();
    await flushPromises();

    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads + 1);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads);
    wrapper.unmount();
  });

  it('polls only lightweight Stage 3 state every ten seconds, pauses while hidden, and refreshes dependent views immediately on completion', async () => {
    vi.useFakeTimers();
    const runningOperation = {
      ...idleLocalIngestOperation,
      state: 'running' as const,
      kind: 'batch' as const,
      startedAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z',
      message: '正在运行批次',
      run: {
        total: 10,
        examined: 3,
        settled: 3,
        ingested: 3,
        failed: 0,
        awaitingReview: 0,
        reconciling: 0,
        claimUnavailable: 0,
        unchanged: 0,
        remaining: 7,
        currentJob: null
      }
    };
    vi.mocked(fetchLocalIngestOperation)
      .mockResolvedValueOnce(runningOperation)
      .mockResolvedValueOnce({ ...runningOperation, run: { ...runningOperation.run, examined: 4, settled: 4, ingested: 4, remaining: 6 } })
      .mockResolvedValueOnce({
        ...idleLocalIngestOperation,
        lastCompleted: {
          kind: 'batch',
          state: 'running',
          startedAt: runningOperation.startedAt,
          finishedAt: '2026-09-03T00:01:00.000Z',
          succeeded: true,
          summary: { total: 10 }
        }
      });
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();
    const stage1Reads = vi.mocked(fetchArchiveMetadataTasks).mock.calls.length;
    const stage2Reads = vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;
    const catalogReads = vi.mocked(fetchArchiveCatalog).mock.calls.length;
    const initialOperationReads = vi.mocked(fetchLocalIngestOperation).mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(initialOperationReads + 1);
    expect(fetchArchiveMetadataTasks).toHaveBeenCalledTimes(stage1Reads);
    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads);

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(initialOperationReads + 1);

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(initialOperationReads + 2);
    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads + 1);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads + 1);
    expect(fetchArchiveMetadataTasks).toHaveBeenCalledTimes(stage1Reads);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(initialOperationReads + 2);
    wrapper.unmount();
  });

  it('does not poll while idle', async () => {
    vi.useFakeTimers();
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();
    const reads = vi.mocked(fetchLocalIngestOperation).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(reads);
    wrapper.unmount();
  });

  it('renders no more than one creator page while all 558 jobs remain pageable', async () => {
    const jobs = Array.from({ length: 50 }, (_, index): LocalIngestJob => ({
      ...localIngestJob,
      id: index + 1,
      sourceArchiveName: `${String(index + 1).padStart(3, '0')}.7z`,
      sourceArchivePath: `G:\\cos待入库\\火龙果羊\\${String(index + 1).padStart(3, '0')}.7z`,
      sourceArchiveSha256: `hash-${index + 1}`,
      status: 'queued',
      phase: 'discovered',
      cleanupStatus: 'not_ready',
      attemptCount: 0,
      summary: null,
      completedAt: null
    }));
    vi.mocked(fetchLocalIngestJobs).mockImplementation(async (options = {}) => ({
      summary: { total: 558, pending: 558, running: 0, ingested: 0, awaitingReview: 0, failed: 0 },
      creators: [{ creatorId: 192, creatorName: '火龙果羊', total: 558, pending: 558, running: 0, ingested: 0, awaitingReview: 0, failed: 0, progressPercent: 0, isCurrent: false }],
      items: options.creatorId ? jobs.map((job) => ({ ...job, id: job.id + ((options.page ?? 1) - 1) * 50 })) : [],
      total: options.creatorId ? 558 : 0,
      page: options.page ?? 1,
      limit: 50,
      hasMore: Boolean(options.creatorId && (options.page ?? 1) < 12)
    }));
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    expect(wrapper.findAll('[data-test="run-local-ingest-job"]')).toHaveLength(50);
    expect(wrapper.text()).toContain('0 / 558');
    expect(wrapper.get('[data-test="local-ingest-creators"]').text()).toContain('558待处理');
    await wrapper.get('[data-test="local-ingest-next"]').trigger('click');
    await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith(expect.objectContaining({ creatorId: 192, page: 2, limit: 50 }));
    expect(wrapper.findAll('[data-test="run-local-ingest-job"]')).toHaveLength(50);
    wrapper.unmount();
  });
});
