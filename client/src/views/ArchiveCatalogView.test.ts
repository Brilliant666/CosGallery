vi.mock('../components/ManagedCreatorRoster.vue', () => ({default:{name:'ManagedCreatorRoster',template:'<div data-test="managed-roster-slot" />'}}));
vi.mock('../components/FirstCollectionSelector.vue', () => ({default:{template:'<button data-test="first-collection-slot" @click="$emit(\'planned\', [123])">从博主库选择</button>',emits:['planned']}}));
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
enableAutoUnmount(afterEach);

import ArchiveCatalogView from './ArchiveCatalogView.vue';
import CostuanWorkspace from './CostuanWorkspace.vue';
async function mountCostuan(workspace: 'source' | 'staging' | 'ingest' = 'ingest') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/creator-admission/costuan', name: 'costuan-admission', component: CostuanWorkspace }] });
  await router.push({ name: 'costuan-admission', query: { workspace } });
  await router.isReady();
  return mount(CostuanWorkspace, { global: { plugins: [router] } });
}
import { fetchDownloadCreators, fetchDownloadTaskPage, fetchMetadataCreators } from '../api/creator-sync';
import type { CreatorSyncRow, MetadataCreatorPage } from '../api/creator-sync';
vi.mock('../api/creator-sync', () => ({ fetchDownloadCreators: vi.fn(), fetchDownloadTaskPage: vi.fn(), fetchMetadataCreators: vi.fn() }));
import type { LocalIngestJob } from '../types/api';
import { RequestError } from '../api/http';
import {
  fetchArchiveBridgeStatus,
  fetchArchiveCatalog,
  fetchArchiveCatalogCreator,
  fetchArchiveDownloadTasks,
  fetchLocalIngestInboxCreators,
  fetchLocalIngestJobs,
  fetchLocalIngestOperation,
  fetchLocalIngestSettings,
  fetchLocalIngestArchivePassword,
  planArchiveDownloadTasks,
  planArchiveMetadataTasks,
  retryLocalIngestCleanup,
  rotateArchiveBridgeToken,
  runLocalIngestBatch,
  runLocalIngestJob,
  saveLocalIngestSettings,
  saveLocalIngestAllowlist,
  scanLocalIngestInbox,
  smokeTestLocalIngestRecycleBin,
  validateLocalIngestSettings
} from '../api/gallery';

vi.mock('../api/gallery', () => ({
  fetchArchiveCatalog: vi.fn(),
  fetchArchiveCatalogCreator: vi.fn(),
  fetchArchiveDownloadTasks: vi.fn(),
  planArchiveDownloadTasks: vi.fn(),
  planArchiveMetadataTasks: vi.fn(),
  fetchArchiveBridgeStatus: vi.fn(),
  rotateArchiveBridgeToken: vi.fn(),
  fetchLocalIngestInboxCreators: vi.fn(),
  fetchLocalIngestJobs: vi.fn(),
  fetchLocalIngestOperation: vi.fn(),
  fetchLocalIngestSettings: vi.fn(),
  fetchLocalIngestArchivePassword: vi.fn(),
  retryLocalIngestCleanup: vi.fn(),
  runLocalIngestBatch: vi.fn(),
  runLocalIngestJob: vi.fn(),
  saveLocalIngestSettings: vi.fn(),
  saveLocalIngestAllowlist: vi.fn(),
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

function metadataRow(overrides: Partial<CreatorSyncRow> = {}): CreatorSyncRow {
  return { creatorId: 115, creatorName: 'Historical source', aliases: [], isActive: true,
    preference: 'liked', rating: 'R18', localWorks: 13, sourceWorks: 17, missingWorks: 4,
    sourceCollections: 1, latestSourceAt: '2026-08-31T00:00:00.000Z',
    sourceState: { metadataAccepted: true, deliveryReady: true, deliveryEvidence: 'historical', missing: [] },
    metadataTask: null, ...overrides };
}

function metadataPage(items: CreatorSyncRow[], overrides: Partial<MetadataCreatorPage> = {}): MetadataCreatorPage {
  return { items, total: items.length, page: 1, limit: 20, hasMore: false, readAt: '2026-09-09T00:00:00.000Z',
    summary: { sourceCreators: 2, sourceCollections: 2, taskTotal: 2,
      tasks: { total: 2, pending: 0, claimed: 0, completed: 0, failed: 1, not_found: 1, cancelled: 0 } },
    ...overrides };
}

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
    vi.mocked(fetchMetadataCreators).mockReset();
    vi.mocked(planArchiveDownloadTasks).mockReset();
    vi.mocked(planArchiveMetadataTasks).mockReset();
    vi.mocked(fetchArchiveBridgeStatus).mockReset();
    vi.mocked(rotateArchiveBridgeToken).mockReset();
    vi.mocked(fetchLocalIngestInboxCreators).mockReset();
    vi.mocked(fetchLocalIngestJobs).mockReset();
    vi.mocked(fetchLocalIngestOperation).mockReset();
    vi.mocked(fetchLocalIngestSettings).mockReset();
    vi.mocked(fetchLocalIngestArchivePassword).mockReset();
    vi.mocked(retryLocalIngestCleanup).mockReset();
    vi.mocked(runLocalIngestBatch).mockReset();
    vi.mocked(runLocalIngestJob).mockReset();
    vi.mocked(saveLocalIngestSettings).mockReset();
    vi.mocked(saveLocalIngestAllowlist).mockReset();
    vi.mocked(saveLocalIngestAllowlist).mockImplementation(async allowlist => ({ ...localIngestSettings, allowlist }));
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
    vi.mocked(fetchLocalIngestArchivePassword).mockResolvedValue({ archivePassword: 'fixture-password' });
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
    vi.mocked(fetchMetadataCreators).mockResolvedValue({
      items: [], total: 0, page: 1, limit: 20, hasMore: false, readAt: '',
      summary: { sourceCreators: 0, sourceCollections: 0, taskTotal: 0,
        tasks: { total: 0, pending: 0, claimed: 0, completed: 0, failed: 0, not_found: 0, cancelled: 0 } }
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

  beforeEach(() => {
    // Shared read model fixtures retain the existing view-level refresh assertions.
    vi.mocked(fetchDownloadCreators).mockReset();
    vi.mocked(fetchDownloadTaskPage).mockReset();
    vi.mocked(fetchDownloadCreators).mockImplementation(async () => {
      const old = await fetchArchiveDownloadTasks();
      const groups = new Map<number, typeof old.items>();
      for (const task of old.items) groups.set(task.creatorId, [...(groups.get(task.creatorId) ?? []), task]);
      return { summary: old.summary, taskTotal: old.total, total: groups.size, page: 1, limit: 20, hasMore: false, readAt: 'now',
        items: [...groups.entries()].map(([creatorId, tasks]) => ({ creatorId, creatorName: tasks[0]!.creatorName, preference: tasks[0]!.preference, rating: tasks[0]!.rating, isActive: true, total: tasks.length,
          summary: { total: tasks.length, pending: tasks.filter(t=>t.status==='pending').length, claimed:0, staged:tasks.filter(t=>t.status==='staged').length, downloading:0, downloaded:tasks.filter(t=>t.status==='downloaded').length, ingested:tasks.filter(t=>t.status==='ingested').length, failed:0, cancelled:0 }
        }))
      };
    });
    vi.mocked(fetchDownloadTaskPage).mockImplementation(async ({ creatorId }) => {
      const old = await fetchArchiveDownloadTasks();
      const items = old.items.filter(task => task.creatorId === creatorId);
      return { items, total: items.length, page: 1, limit: 50, hasMore: false, readAt: 'now', summary: old.summary };
    });
  });

  it('keeps the ledger limited to its roster and resource workspaces without Costuan initialization', async () => {
    const wrapper=mount(ArchiveCatalogView); await flushPromises();
    expect(wrapper.find('[aria-label="账本工作区"] a[href="/local-admission"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="catalog-creator"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-test="managed-roster-slot"]')).toHaveLength(1);
    for(const name of ['source','staging','ingest']) expect(wrapper.find('[data-test="workspace-'+name+'"]').exists()).toBe(false);
    expect(fetchMetadataCreators).not.toHaveBeenCalled();
    expect(fetchDownloadCreators).not.toHaveBeenCalled();
    expect(fetchLocalIngestOperation).not.toHaveBeenCalled();
    expect(fetchLocalIngestSettings).not.toHaveBeenCalled();
    expect(planArchiveDownloadTasks).not.toHaveBeenCalled();
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
    expect(runLocalIngestBatch).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="ingest-settings"]').exists()).toBe(false);
  });

  it('shares resource entry with durable query navigation and keeps the roster instance on return', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/archive-catalog', component: ArchiveCatalogView }] });
    await router.push('/archive-catalog');
    await router.isReady();
    const wrapper = mount(ArchiveCatalogView, { global: { plugins: [router], stubs: { ResourceCatalog: { props: ['creatorId'], template: '<section data-test="resource-stub">{{ creatorId }}</section>' } } } });
    await flushPromises();
    expect(wrapper.find('[data-test="resource-stub"]').exists()).toBe(false);
    const roster = wrapper.findComponent({ name: 'ManagedCreatorRoster' });
    const rosterElement = wrapper.get('[data-test="managed-roster-slot"]').element;
    // The existing roster remains mounted; its internal filter/page state is not discarded.
    const instance = roster.exists() ? roster : wrapper.findAllComponents({}).find(c => c.find('[data-test="managed-roster-slot"]').exists())!;
    instance.vm.$emit('resource-catalog', 35);
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({ workspace: 'resources', creatorId: '35' });
    expect(wrapper.get('[data-test="resource-stub"]').text()).toBe('35');
    await wrapper.get('[data-test="workspace-roster"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="managed-roster-slot"]').element).toBe(rosterElement);
    expect(wrapper.find('[data-test="resource-stub"]').exists()).toBe(false);
    router.back();
    await new Promise(resolve => setTimeout(resolve, 10));
    await flushPromises();
    expect(wrapper.get('[data-test="resource-stub"]').text()).toBe('35');
    wrapper.unmount();
    const refreshed = mount(ArchiveCatalogView, { global: { plugins: [router], stubs: { ResourceCatalog: { props: ['creatorId'], template: '<section data-test="resource-stub">{{ creatorId }}</section>' } } } });
    await flushPromises();
    expect(refreshed.get('[data-test="resource-stub"]').text()).toBe('35');
  });

  it('requires an explicit all scope and never turns invalid creator links into global scope', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/archive-catalog', component: ArchiveCatalogView }] });
    await router.push('/archive-catalog?workspace=resources');
    await router.isReady();
    const wrapper = mount(ArchiveCatalogView, { global: { plugins: [router], stubs: { ResourceCatalog: { name: 'ResourceCatalogTestStub', props: ['creatorId', 'globalScope'], template: '<section data-test="resource-stub" :data-global="globalScope">{{ creatorId }}</section>' } } } });
    await flushPromises();
    expect(wrapper.get('[data-test="resource-stub"]').attributes('data-global')).toBe('false');
    await router.push('/archive-catalog?workspace=resources&scope=all');
    await flushPromises();
    expect(wrapper.get('[data-test="resource-stub"]').attributes('data-global')).toBe('true');
    for (const invalid of ['invalid', '0', '-2', '1.5', '']) {
      await router.push(`/archive-catalog?workspace=resources&scope=all&creatorId=${invalid}`);
      await flushPromises();
      expect(wrapper.get('[data-test="resource-stub"]').attributes('data-global')).toBe('false');
      expect(wrapper.get('[data-test="resource-stub"]').text()).toBe('');
    }
    await router.push('/archive-catalog?workspace=resources&creatorId=35');
    await flushPromises();
    const catalog = wrapper.findComponent({ name: 'ResourceCatalogTestStub' });
    catalog.vm.$emit('all');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ workspace: 'resources', scope: 'all' });
    catalog.vm.$emit('select', null);
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ workspace: 'resources' });
  });

  it('generates per-creator download tasks under the isolated inbox root', async () => {
    const wrapper = await mountCostuan('staging');
    await flushPromises();

    await wrapper.get('[data-test="plan-downloads"]').trigger('click');
    await flushPromises();

    expect(planArchiveDownloadTasks).toHaveBeenCalledWith('G:\\cos待入库', undefined);
    expect(wrapper.get('[data-test="download-notice"]').text()).toContain('已新增 1 条任务');
    await wrapper.get('[data-test="toggle-stage2-creator"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('rua阮阮\\014.7z');
  });

  it('retires the unscoped metadata planner while retaining the explicit selector and read-only refresh', async () => {
    const wrapper = await mountCostuan('source'); await flushPromises();
    expect(wrapper.text()).toContain('来源检查');
    expect(wrapper.find('[data-test="plan-metadata"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="first-collection-slot"]').exists()).toBe(true);
    await wrapper.get('[data-test="refresh-stage1"]').trigger('click'); await flushPromises();
    expect(planArchiveMetadataTasks).not.toHaveBeenCalled();
  });

  it('shows source evidence independently from absent, not-found, and failed check tasks', async () => {
    const task = { id: 42, status: 'not_found' as const, attemptCount: 1, claimedBy: null,
      claimedAt: null, completedAt: null, lastError: null, updatedAt: '2026-09-08T12:00:00.000Z' };
    vi.mocked(fetchMetadataCreators).mockResolvedValue(metadataPage([
      metadataRow(),
      metadataRow({ creatorId: 116, creatorName: 'Task only', sourceCollections: 0, latestSourceAt: null,
        sourceState: { metadataAccepted: false, deliveryReady: false, deliveryEvidence: 'missing', missing: [] }, metadataTask: task }),
      metadataRow({ creatorId: 117, creatorName: 'Source and failed task', metadataTask: { ...task, id: 43, status: 'failed', lastError: 'fixture source check failed' } })
    ]));
    const wrapper = await mountCostuan('source'); await flushPromises();
    const rows = wrapper.get('[data-test="metadata-creators"]').findAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('已记录 Costuan 来源');
    expect(rows[0]!.text()).toContain('网盘状态待重新核验');
    expect(rows[0]!.text()).toContain('来源记录时间：');
    expect(rows[0]!.text()).not.toContain('2026-08-31T');
    expect(rows[0]!.text()).toContain('无检查记录');
    expect(rows[0]!.text()).not.toMatch(/任务 #|更新：|2026-09-09/);
    expect(rows[1]!.text()).toContain('尚未取得有效来源');
    expect(rows[1]!.text()).toContain('上次检查未找到合集');
    expect(rows[1]!.text()).toContain('任务 #42');
    expect(rows[1]!.text()).not.toContain('来源记录：');
    expect(rows[2]!.text()).toContain('已记录 Costuan 来源');
    expect(rows[2]!.text()).toContain('失败待重试');
    expect(rows[2]!.text()).toContain('fixture source check failed');
    expect(rows[2]!.findAll('details').every(detail => detail.attributes('open') === undefined)).toBe(true);
    expect(wrapper.get('[data-test="metadata-creators"]').text()).toContain('最近检查');
    expect(planArchiveMetadataTasks).not.toHaveBeenCalled();
  });

  it('labels completed checks independently of verified delivery and does not invent a verification time', async () => {
    vi.mocked(fetchMetadataCreators).mockResolvedValue(metadataPage([metadataRow({
      pendingSupplementalTitles: ['微博图'],
      metadataTask: { id: 32, status: 'completed', attemptCount: 1, claimedBy: null, claimedAt: null, completedAt: null, lastError: null, updatedAt: '2026-09-08T12:00:00.000Z' },
      sourceState: { metadataAccepted: true, deliveryReady: true, deliveryEvidence: 'verified', missing: [] }
    })]));
    const wrapper = await mountCostuan('source'); await flushPromises();
    const row = wrapper.get('[data-test="metadata-creators"] tbody tr');
    expect(row.text()).toContain('检查已完成');
    expect(row.text()).toContain('网盘来源已核验');
    expect(row.text()).toContain('微博图：附加内容待人工处理，不参与自动下载/入库');
    expect(row.text()).toContain('编号作品网盘来源已核验');
    expect(row.text()).not.toContain('核验时间');
    expect(row.text()).not.toContain('元数据已接入');
  });

  it('fetches Stage 1 page two from the server and retains all enabled states', async () => {
    vi.mocked(fetchMetadataCreators).mockResolvedValueOnce(metadataPage([metadataRow()], { total: 21, hasMore: true }))
      .mockResolvedValueOnce(metadataPage([metadataRow({ creatorId: 116, creatorName: 'Page two', isActive: false })], { total: 21, page: 2 }));
    const wrapper = await mountCostuan('source'); await flushPromises();
    expect(wrapper.get('[data-test="metadata-next"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-test="metadata-next"]').trigger('click'); await flushPromises();
    expect(fetchMetadataCreators).toHaveBeenLastCalledWith({ page: 2, limit: 20, enabled: 'all' });
    expect(wrapper.get('[data-test="metadata-creators"]').text()).toContain('Page two');
    expect(wrapper.get('[data-test="metadata-creators"]').text()).not.toContain('Historical source');
    expect(wrapper.get('[data-test="metadata-pagination"]').text()).toContain('第 2 / 2 页');
    expect(wrapper.get('[data-test="metadata-next"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="metadata-prev"]').attributes('disabled')).toBeUndefined();
  });

  it('shows a Stage 1 read error instead of an empty successful result', async () => {
    vi.mocked(fetchMetadataCreators).mockRejectedValueOnce(new Error('来源账本读取失败'));
    const wrapper = await mountCostuan('source'); await flushPromises();
    const stage1 = wrapper.get('[aria-label="博主元数据采集队列"]');
    expect(stage1.get('[role="alert"]').text()).toContain('来源账本读取失败');
    expect(stage1.text()).not.toContain('暂无有效 Costuan 来源或来源检查任务');
    expect(stage1.find('[data-test="metadata-pagination"]').exists()).toBe(false);
    await wrapper.get('[data-test="refresh-stage1"]').trigger('click'); await flushPromises();
    expect(stage1.find('[role="alert"]').exists()).toBe(false);
    expect(stage1.text()).toContain('暂无有效 Costuan 来源或来源检查任务');
  });

  it.each(['old-first', 'new-first', 'old-error'] as const)('protects Stage 1 refresh rows and loading from late pagination (%s)', async (order) => {
    let resolveOld!: (value: MetadataCreatorPage) => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: MetadataCreatorPage) => void;
    vi.mocked(fetchMetadataCreators).mockResolvedValueOnce(metadataPage([metadataRow()], { total: 21, hasMore: true }))
      .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const wrapper = await mountCostuan('source'); await flushPromises();
    await wrapper.get('[data-test="metadata-next"]').trigger('click');
    await wrapper.get('[data-test="refresh-stage1"]').trigger('click');
    expect(fetchMetadataCreators).toHaveBeenLastCalledWith({ page: 1, limit: 20, enabled: 'all' });
    const oldPage = metadataPage([metadataRow({ creatorName: 'Stale page two' })], { page: 2, total: 21 });
    const stage1 = wrapper.get('[aria-label="博主元数据采集队列"]');
    if (order === 'old-first') {
      resolveOld(oldPage); await flushPromises();
      expect(stage1.get('[role="status"]').text()).toContain('正在读取');
      expect(wrapper.get('[data-test="metadata-next"]').attributes('disabled')).toBeDefined();
    }
    resolveNew(metadataPage([metadataRow({ creatorName: 'Latest refresh' })])); await flushPromises();
    if (order === 'new-first') resolveOld(oldPage);
    if (order === 'old-error') rejectOld(new Error('stale pagination error'));
    await flushPromises();
    expect(stage1.text()).toContain('Latest refresh');
    expect(stage1.text()).not.toMatch(/Stale page two|stale pagination error/);
    expect(stage1.find('[role="status"]').exists()).toBe(false);
    expect(stage1.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="metadata-pagination"]').text()).toContain('第 1 / 1 页');
  });

  it('shows a redacted full ingest preview and can run the allowlisted batch', async () => {
    const wrapper = await mountCostuan('ingest');
    await flushPromises();

    expect(wrapper.text()).toContain('Costuan入库');
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    expect(wrapper.text()).toContain('解压密码：已配置');
    expect(wrapper.text()).toContain('V1 正式图库根目录由 GALLERY_ROOT 启动配置决定');
    expect(wrapper.text()).not.toContain('隔离目录');
    const libraryInput = wrapper.findAll('input').find((input) => input.element.value === localIngestSettings.libraryRoot);
    expect(libraryInput?.attributes()).toHaveProperty('readonly');
    await wrapper.get('[data-test="cancel-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
    await flushPromises();
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
    const wrapper = await mountCostuan('ingest');
    await flushPromises();

    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="run-local-ingest-creator"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test="run-local-ingest-creator"]').text()).toContain('（1）');
    expect(runLocalIngestBatch).toHaveBeenCalledWith({ creatorIds: [reconcilingJob.creatorId] });
    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain(`${reconcilingJob.creatorName}：本批选中 1`);
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
    const wrapper = await mountCostuan('ingest');
    await flushPromises();

    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
    await flushPromises();
    const evidence = wrapper.get('[data-test="local-ingest-review-evidence"]');
    expect(evidence.text()).toContain('portrait.jfif');
    expect(evidence.text()).toContain(reviewJob.processingPath!);
    expect(evidence.text()).toContain('正式目录：尚未提交');
    expect(evidence.text()).toContain(`计划路径：${reviewJob.targetPath}`);
    expect(wrapper.find('[data-test="run-local-ingest-job"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="run-local-ingest-creator"]').exists()).toBe(false);
  });

  it('shows retained unsupported originals separately from indexed media', async () => {
    const job: LocalIngestJob = { ...localIngestJob, validationStatus: 'warning', cleanupStatus: 'not_ready',
      summary: { ...localIngestJob.summary, retainedOriginalCount: 2,
        retainedOriginalDirectory: 'G:/gallery/work/_未支持格式原件' } };
    vi.mocked(fetchLocalIngestJobs).mockResolvedValue(localIngestDashboard(job));
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
    await flushPromises();
    const evidence = wrapper.get('[data-test="retained-originals-summary"]');
    expect(evidence.text()).toContain('另保留 2 张原件，暂不支持展示');
    expect(evidence.text()).toContain('G:/gallery/work/_未支持格式原件');
    expect(wrapper.text()).toContain('图片 24');
  });

  it('reads inbox creators without saving and explicitly appends and saves unique canonical names', async () => {
    const wrapper = await mountCostuan('ingest');
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
    await flushPromises();

    expect((allowlist.element as HTMLTextAreaElement).value).toBe('火龙果羊\n女主K\n新博主');
    expect(saveLocalIngestAllowlist).toHaveBeenCalledExactlyOnceWith(['火龙果羊', '女主K', '新博主']);
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="scan-local-ingest"]').attributes()).not.toHaveProperty('disabled');
    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain('名单已保存');
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
    expect(runLocalIngestBatch).not.toHaveBeenCalled();
  });

  it('replaces only the allowlist, not discarded settings edits, without running tasks', async () => {
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="local-ingest-stable-seconds"]').setValue(60);
    await wrapper.get('[data-test="cancel-ingest-settings"]').trigger('click');

    await wrapper.get('[data-test="discover-inbox-creators"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="replace-inbox-creators"]').trigger('click');
    await flushPromises();

    expect((wrapper.get('[data-test="local-ingest-allowlist"]').element as HTMLTextAreaElement).value).toBe('女主K\n新博主');
    expect(saveLocalIngestAllowlist).toHaveBeenCalledExactlyOnceWith(['女主K', '新博主']);
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    expect((wrapper.get('[data-test="local-ingest-stable-seconds"]').element as HTMLInputElement).value).toBe(String(localIngestSettings.fileStableSeconds));
    await wrapper.get('[data-test="cancel-ingest-settings"]').trigger('click');
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
    expect(runLocalIngestBatch).not.toHaveBeenCalled();

    await wrapper.get('[data-test="cancel-inbox-creators"]').trigger('click');
    expect(wrapper.find('[data-test="inbox-creators-result"]').exists()).toBe(false);
  });

  it('locks append and replace during saving and keeps a failed list draft available for retry', async () => {
    let rejectSave!: (reason: Error) => void;
    vi.mocked(saveLocalIngestAllowlist).mockReturnValueOnce(new Promise((_, reject) => { rejectSave = reject; }));
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="discover-inbox-creators"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="append-inbox-creators"]').trigger('click');
    for (const action of ['append-inbox-creators', 'replace-inbox-creators', 'discover-inbox-creators', 'local-ingest-allowlist', 'scan-local-ingest']) {
      expect(wrapper.get(`[data-test="${action}"]`).attributes()).toHaveProperty('disabled');
    }
    await wrapper.get('[data-test="append-inbox-creators"]').trigger('click');
    expect(saveLocalIngestAllowlist).toHaveBeenCalledTimes(1);
    rejectSave(new Error('配置未保存，请重试'));
    await flushPromises();

    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain('配置未保存，请重试');
    expect(wrapper.get('[data-test="save-ingest-allowlist"]').attributes()).not.toHaveProperty('disabled');
    expect(wrapper.get('[data-test="scan-local-ingest"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('[data-test="run-local-ingest-batch"]').attributes()).toHaveProperty('disabled');
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
    expect(runLocalIngestBatch).not.toHaveBeenCalled();
    await wrapper.get('[data-test="save-ingest-allowlist"]').trigger('click');
    await flushPromises();
    expect(saveLocalIngestAllowlist).toHaveBeenLastCalledWith(['火龙果羊', '女主K', '新博主']);
    expect(wrapper.find('[data-test="save-ingest-allowlist"]').exists()).toBe(false);
  });

  it('edits the list inline with save and cancel only when dirty and persists only names', async () => {
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    expect(wrapper.find('[data-test="save-local-ingest"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="save-ingest-allowlist"]').exists()).toBe(false);
    await wrapper.get('[data-test="local-ingest-allowlist"]').setValue('不保存');
    await wrapper.get('[data-test="cancel-ingest-allowlist"]').trigger('click');
    expect(saveLocalIngestAllowlist).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="cancel-ingest-allowlist"]').exists()).toBe(false);
    expect((wrapper.get('[data-test="local-ingest-allowlist"]').element as HTMLTextAreaElement).value).toBe(localIngestSettings.allowlist.join('\n'));
    await wrapper.get('[data-test="local-ingest-allowlist"]').setValue('新博主\n新博主\n另一位');
    await wrapper.get('[data-test="save-ingest-allowlist"]').trigger('click');
    await flushPromises();
    expect(saveLocalIngestAllowlist).toHaveBeenCalledExactlyOnceWith(['新博主', '另一位']);
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="ingest-allowlist-dialog"]').exists()).toBe(false);
  });

  it('keeps settings drafts isolated and clears secret input on cancel and stage exit', async () => {
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="local-ingest-inbox-root"]').setValue('D:/draft');
    await wrapper.get('[data-test="local-ingest-password"]').setValue('unsaved-secret');
    expect(wrapper.get('[data-test="local-ingest-password"]').attributes('type')).toBe('text');
    await wrapper.get('[data-test="cancel-ingest-settings"]').trigger('click');
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    expect((wrapper.get('[data-test="local-ingest-inbox-root"]').element as HTMLInputElement).value).toBe(localIngestSettings.inboxRoot);
    expect((wrapper.get('[data-test="local-ingest-password"]').element as HTMLInputElement).value).toBe('fixture-password');
    await wrapper.get('[data-test="local-ingest-password"]').setValue('another-secret');
    await wrapper.get('[data-test="workspace-source"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="ingest-settings-dialog"]').exists()).toBe(false);
    await wrapper.get('[data-test="workspace-ingest"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    expect((wrapper.get('[data-test="local-ingest-password"]').element as HTMLInputElement).value).toBe('fixture-password');
  });

  it('reads the current password only when settings open and ignores responses for a closed dialog', async () => {
    let resolveOld!: (value: { archivePassword: string }) => void;
    vi.mocked(fetchLocalIngestArchivePassword).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    expect(fetchLocalIngestArchivePassword).not.toHaveBeenCalled();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    expect(wrapper.get('[data-test="save-local-ingest"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('[data-test="local-ingest-password"]').attributes()).toHaveProperty('disabled');
    await wrapper.get('[data-test="cancel-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await flushPromises();
    expect((wrapper.get('[data-test="local-ingest-password"]').element as HTMLInputElement).value).toBe('fixture-password');
    resolveOld({ archivePassword: 'stale-value' });
    await flushPromises();
    expect((wrapper.get('[data-test="local-ingest-password"]').element as HTMLInputElement).value).toBe('fixture-password');
    expect(wrapper.get('[data-test="ingest-password-status"]').text()).toBe('解压密码：已配置');
    expect(wrapper.get('[data-test="save-local-ingest"]').attributes()).not.toHaveProperty('disabled');
  });

  it('keeps save disabled after a password read failure and allows retry without clearing the saved password', async () => {
    vi.mocked(fetchLocalIngestArchivePassword).mockRejectedValueOnce(new Error('private failure detail'));
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="save-local-ingest"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('[role="alert"]').text()).toContain('当前解压密码读取失败');
    expect(wrapper.text()).not.toContain('private failure detail');
    await wrapper.get('[data-test="save-local-ingest"]').trigger('click');
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    await wrapper.get('[data-test="retry-ingest-password"]').trigger('click');
    await flushPromises();
    expect((wrapper.get('[data-test="local-ingest-password"]').element as HTMLInputElement).value).toBe('fixture-password');
    expect(wrapper.get('[data-test="save-local-ingest"]').attributes()).not.toHaveProperty('disabled');
  });

  it('omits untouched passwords and only explicitly sends replacement or clear decisions', async () => {
    const { allowlist: _allowlist, archivePasswordConfigured: _configured, ...editableSettings } = localIngestSettings;
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="save-local-ingest"]').trigger('click');
    await flushPromises();
    expect(saveLocalIngestSettings).toHaveBeenLastCalledWith(editableSettings);
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="local-ingest-password"]').setValue('test-new-password');
    await wrapper.get('[data-test="validate-local-ingest"]').trigger('click');
    await flushPromises();
    expect(validateLocalIngestSettings).toHaveBeenLastCalledWith(editableSettings);
    await wrapper.get('[data-test="save-local-ingest"]').trigger('click');
    await flushPromises();
    expect(saveLocalIngestSettings).toHaveBeenLastCalledWith({ ...editableSettings, archivePassword: 'test-new-password' });
    expect(wrapper.text()).not.toContain('test-new-password');
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="local-ingest-password"]').setValue('');
    await wrapper.get('[data-test="save-local-ingest"]').trigger('click');
    await flushPromises();
    expect(saveLocalIngestSettings).toHaveBeenLastCalledWith({ ...editableSettings, clearArchivePassword: true });
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
    expect(runLocalIngestBatch).not.toHaveBeenCalled();
  });

  it.each([true, false])('reloads saved settings after leaving during a pending save (return before completion: %s)', async returnEarly => {
    let resolveSave!: (value: typeof localIngestSettings) => void;
    vi.mocked(saveLocalIngestSettings).mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve; }));
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="local-ingest-inbox-root"]').setValue('D:/saved');
    await wrapper.get('[data-test="save-local-ingest"]').trigger('click');
    await wrapper.get('[data-test="workspace-source"]').trigger('click');
    await flushPromises();
    if (returnEarly) {
      await wrapper.get('[data-test="workspace-ingest"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-test="open-ingest-settings"]').attributes()).toHaveProperty('disabled');
    }
    vi.mocked(fetchLocalIngestSettings).mockResolvedValue({ ...localIngestSettings, inboxRoot: 'D:/saved', archivePasswordConfigured: false, allowlist: ['服务端最新名单'] });
    vi.mocked(fetchLocalIngestArchivePassword).mockResolvedValue({ archivePassword: '' });
    resolveSave({ ...localIngestSettings, inboxRoot: 'D:/saved' });
    await flushPromises();
    if (!returnEarly) {
      await wrapper.get('[data-test="workspace-ingest"]').trigger('click');
      await flushPromises();
    }
    expect((wrapper.get('[data-test="local-ingest-allowlist"]').element as HTMLTextAreaElement).value).toBe('服务端最新名单');
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    expect((wrapper.get('[data-test="local-ingest-inbox-root"]').element as HTMLInputElement).value).toBe('D:/saved');
    expect(wrapper.get('[data-test="ingest-settings-dialog"]').text()).toContain('解压密码：未配置');
    expect((wrapper.get('[data-test="local-ingest-password"]').element as HTMLInputElement).value).toBe('');
  });

  it('does not expose a password echoed by a settings save failure', async () => {
    vi.mocked(saveLocalIngestSettings).mockRejectedValueOnce(new Error('failure echoed test-private-password'));
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="local-ingest-password"]').setValue('test-private-password');
    await wrapper.get('[data-test="save-local-ingest"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('test-private-password');
    expect(wrapper.get('[data-test="ingest-settings-dialog"]').text()).toContain('无法保存入库设置');
    await wrapper.get('[data-test="cancel-ingest-settings"]').trigger('click');
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
    expect((wrapper.get('[data-test="local-ingest-password"]').element as HTMLInputElement).value).toBe('fixture-password');
  });

  it('labels a stale recovered job as resumable', async () => {
    vi.mocked(fetchLocalIngestJobs).mockResolvedValue(localIngestDashboard({
      ...localIngestJob,
      status: 'failed',
      phase: 'extracting_outer',
      errorCode: 'INTERRUPTED_PROCESS',
      errorDetail: 'internal English fallback'
    }));
    const wrapper = await mountCostuan('ingest');
    await flushPromises();

    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
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
    const wrapper = await mountCostuan('ingest');
    await flushPromises();

    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="open-ingest-settings"]').trigger('click');
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
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="discover-inbox-creators"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test="stage3-operation-card"]').text()).toContain('正在扫描');
    expect(wrapper.get('[data-test="scan-local-ingest"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('[data-test="local-ingest-allowlist"]').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain('页面已恢复服务端操作状态');
    wrapper.unmount();
  });

  it('keeps scanning explicit and defers hidden Stage 2 refresh until entry', async () => {
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
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    const stage1Reads = vi.mocked(fetchMetadataCreators).mock.calls.length;
    const stage2Reads = vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;

    await wrapper.get('[data-test="scan-local-ingest"]').trigger('click');
    await flushPromises();

    expect(scanLocalIngestInbox).toHaveBeenCalledWith();
    expect(saveLocalIngestSettings).not.toHaveBeenCalled();
    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads);
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1Reads);
    expect(wrapper.get('[data-test="local-ingest-notice"]').text()).toContain('已确认 6 个本地下载');
    wrapper.unmount();
  });

  it('refreshes only Stage 2 when its manual refresh button is clicked', async () => {
    const wrapper = await mountCostuan('staging');
    await flushPromises();
    const stage2Reads = vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;
    const stage1Reads = vi.mocked(fetchMetadataCreators).mock.calls.length;
    const stage3Reads = vi.mocked(fetchLocalIngestJobs).mock.calls.length;
    const catalogReads = vi.mocked(fetchArchiveCatalog).mock.calls.length;

    await wrapper.get('[data-test="refresh-stage2"]').trigger('click');
    await flushPromises();

    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads + 1);
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1Reads);
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(stage3Reads);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads);
    expect(wrapper.get('[data-test="download-notice"]').text()).toContain('未执行任务规划或本地扫描');
    expect(wrapper.get('[data-test="staging-refresh-tools"]').find('[data-test="refresh-stage2"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="staging-refresh-tools"]').find('[data-test="download-notice"][role="status"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('百度客户端完成下载 →');
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

    const wrapper = await mountCostuan('staging');
    await flushPromises();
    const stage2 = wrapper.get('[aria-label="缺失作品下载队列"]');

    await stage2.get('[data-test="toggle-stage2-creator"]').trigger('click');
    await flushPromises();
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
    const wrapper = await mountCostuan('ingest');
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

    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads);
    wrapper.unmount();
  });

  it('polls only lightweight Stage 3 state every ten seconds, pauses while hidden, and refreshes only the visible ingest view on completion', async () => {
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
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    const stage1Reads = vi.mocked(fetchMetadataCreators).mock.calls.length;
    const stage2Reads = vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;
    const catalogReads = vi.mocked(fetchArchiveCatalog).mock.calls.length;
    const initialOperationReads = vi.mocked(fetchLocalIngestOperation).mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(initialOperationReads + 1);
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1Reads);
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
    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads);
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1Reads);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(initialOperationReads + 2);
    wrapper.unmount();
  });

  it.each(['poll', 'manual'] as const)('refreshes collapsed Stage 3 totals and creators through %s without expanding rows', async (refresh) => {
    vi.useFakeTimers();
    vi.mocked(fetchLocalIngestOperation).mockResolvedValue({
      ...idleLocalIngestOperation,
      state: 'running',
      kind: 'batch'
    });
    let job: LocalIngestJob = { ...localIngestJob, status: 'queued' };
    vi.mocked(fetchLocalIngestJobs).mockImplementation(async (options = {}) => ({
      ...localIngestDashboard(job),
      items: options.creatorId ? [job] : [],
      total: options.creatorId ? 1 : 0
    }));
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="local-ingest-creators"] button').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-test="local-ingest-creators"]').text()).toContain('0 / 1');
    const jobReads = vi.mocked(fetchLocalIngestJobs).mock.calls.length;
    const stage1Reads = vi.mocked(fetchMetadataCreators).mock.calls.length;
    const stage2Reads = vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;
    const catalogReads = vi.mocked(fetchArchiveCatalog).mock.calls.length;
    job = localIngestJob;

    if (refresh === 'poll') await vi.advanceTimersByTimeAsync(10_000);
    else await wrapper.get('[data-test="refresh-stage3"]').trigger('click');
    await flushPromises();

    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(jobReads + 1);
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith({ page: 1, limit: 50 });
    expect(wrapper.get('[data-test="local-ingest-creators"]').text()).toContain('1 / 1');
    const totals = wrapper.get('[data-test="local-ingest-creators"]').element.previousElementSibling!.textContent!.replace(/\s/g, '');
    expect(totals).toContain('0待处理');
    expect(totals).toContain('1已入库');
    expect(wrapper.get('[data-test="local-ingest-creators"] button').attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[data-test="run-local-ingest-job"]').exists()).toBe(false);
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1Reads);
    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2Reads);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalogReads);
    expect(runLocalIngestBatch).not.toHaveBeenCalled();
    expect(runLocalIngestJob).not.toHaveBeenCalled();
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('initially reads Stage 3 summaries without selecting a creator or exposing job rows', async () => {
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(1);
    expect(fetchLocalIngestJobs).toHaveBeenCalledWith({ page: 1, limit: 50 });
    expect(wrapper.get('[data-test="local-ingest-creators"] button').attributes('aria-expanded')).toBe('false');
    expect(wrapper.text()).not.toContain(localIngestJob.sourceArchiveSha256);
    expect(wrapper.find('[data-test="local-ingest-status-filter"]').exists()).toBe(false);
    expect(runLocalIngestBatch).not.toHaveBeenCalled();
    expect(runLocalIngestJob).not.toHaveBeenCalled();
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
  });

  it('collapses all Stage 3 creators when the expanded creator disappears instead of selecting the first remaining creator', async () => {
    const remainingJob: LocalIngestJob = { ...localIngestJob, id: 2, creatorId: 193, creatorName: 'Remaining creator', sourceArchiveName: 'remaining-only.7z' };
    const original = { ...localIngestDashboard(), creators: [...localIngestDashboard().creators, ...localIngestDashboard(remainingJob).creators] };
    vi.mocked(fetchLocalIngestJobs).mockResolvedValueOnce(original).mockResolvedValueOnce(original)
      .mockResolvedValueOnce(localIngestDashboard(remainingJob));
    const wrapper = await mountCostuan('ingest'); await flushPromises();
    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="local-ingest-creators"] button').attributes('aria-expanded')).toBe('true');
    const reads = vi.mocked(fetchLocalIngestJobs).mock.calls.length;
    await wrapper.get('[data-test="refresh-stage3"]').trigger('click'); await flushPromises();
    const toggles = wrapper.findAll('[data-test="local-ingest-creators"] button[aria-expanded]');
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.text()).toContain('Remaining creator');
    expect(toggles[0]!.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[data-test="local-ingest-status-filter"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('remaining-only.7z');
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(reads + 1);
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith(expect.objectContaining({ creatorId: localIngestJob.creatorId }));
    expect(runLocalIngestJob).not.toHaveBeenCalled();
  });

  it.each(['collapse', 'switch'] as const)('ignores a late creator detail response after a Stage 3 %s', async (action) => {
    const secondJob: LocalIngestJob = { ...localIngestJob, id: 2, creatorId: 193, creatorName: 'Second', sourceArchiveName: 'second-only.7z' };
    const firstJob: LocalIngestJob = { ...localIngestJob, sourceArchiveName: 'stale-only.7z' };
    const creators = [...localIngestDashboard(firstJob).creators, ...localIngestDashboard(secondJob).creators];
    const dashboard = (job: LocalIngestJob) => ({ ...localIngestDashboard(job), creators });
    let resolveFirst!: (value: ReturnType<typeof dashboard>) => void;
    vi.mocked(fetchLocalIngestJobs).mockImplementation(async (options = {}) => {
      if (options.creatorId === firstJob.creatorId) return new Promise(resolve => { resolveFirst = resolve; });
      return dashboard(secondJob);
    });
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    const toggles = () => wrapper.findAll('[data-test="local-ingest-creators"] button[aria-expanded]');
    await toggles()[0]!.trigger('click');
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith(expect.objectContaining({ creatorId: firstJob.creatorId, page: 1 }));
    await toggles()[action === 'collapse' ? 0 : 1]!.trigger('click');
    await flushPromises();
    resolveFirst(dashboard(firstJob));
    await flushPromises();
    expect(wrapper.text()).not.toContain('stale-only.7z');
    expect(toggles()[0]!.attributes('aria-expanded')).toBe('false');
    expect(toggles()[1]!.attributes('aria-expanded')).toBe(action === 'switch' ? 'true' : 'false');
    if (action === 'switch') expect(wrapper.text()).toContain('second-only.7z');
    else expect(wrapper.find('[data-test="local-ingest-status-filter"]').exists()).toBe(false);
    expect(runLocalIngestJob).not.toHaveBeenCalled();
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
  });

  it('does not poll while idle', async () => {
    vi.useFakeTimers();
    const wrapper = await mountCostuan('ingest');
    await flushPromises();
    const reads = vi.mocked(fetchLocalIngestOperation).mock.calls.length;
    const jobReads = vi.mocked(fetchLocalIngestJobs).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(reads);
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(jobReads);
    wrapper.unmount();
  });

  it('refreshes only visible Stage 1 on selected submission, visible return and confirmed plugin state events without automation or polling',async()=>{
    vi.useFakeTimers();
    const wrapper=await mountCostuan('source');await flushPromises();
    const stage1=vi.mocked(fetchMetadataCreators).mock.calls.length;
    const stage2=vi.mocked(fetchArchiveDownloadTasks).mock.calls.length;
    const catalog=vi.mocked(fetchArchiveCatalog).mock.calls.length;
    await wrapper.get('[data-test=first-collection-slot]').trigger('click');await flushPromises();
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1+1);
    expect(fetchArchiveDownloadTasks).toHaveBeenCalledTimes(stage2);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalog);
    window.dispatchEvent(new MessageEvent('message',{source:window,origin:window.location.origin,data:{source:'costuan-archive-manager',type:'cosgallery:archive-state-changed'}}));
    await flushPromises();
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1+2);
    window.dispatchEvent(new MessageEvent('message',{source:window,origin:'https://untrusted.invalid',data:{source:'costuan-archive-manager',type:'cosgallery:archive-state-changed'}}));
    await flushPromises();
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1+2);
    Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));await flushPromises();
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1+3);
    await vi.advanceTimersByTimeAsync(30_000);await flushPromises();
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(stage1+3);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(catalog);
    expect(planArchiveMetadataTasks).not.toHaveBeenCalled();expect(planArchiveDownloadTasks).not.toHaveBeenCalled();expect(scanLocalIngestInbox).not.toHaveBeenCalled();expect(runLocalIngestBatch).not.toHaveBeenCalled();
  });

  it('renders no more than one creator page while all 558 jobs remain pageable', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchLocalIngestOperation).mockResolvedValue({
      ...idleLocalIngestOperation,
      state: 'running',
      kind: 'batch'
    });
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
    const wrapper = await mountCostuan('ingest');
    await flushPromises();

    expect(wrapper.findAll('[data-test="run-local-ingest-job"]')).toHaveLength(0);
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith({ page: 1, limit: 50 });
    await wrapper.get('[data-test="local-ingest-creators"] button').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-test="run-local-ingest-job"]')).toHaveLength(50);
    expect(wrapper.text()).toContain('0 / 558');
    expect(wrapper.get('[data-test="local-ingest-creators"]').text()).toContain('558待处理');
    await wrapper.get('[data-test="local-ingest-next"]').trigger('click');
    await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith(expect.objectContaining({ creatorId: 192, page: 2, limit: 50 }));
    expect(wrapper.findAll('[data-test="run-local-ingest-job"]')).toHaveLength(50);
    const jobReads = vi.mocked(fetchLocalIngestJobs).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(jobReads + 1);
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith(expect.objectContaining({ creatorId: 192, page: 2, limit: 50 }));
    expect(wrapper.get('[data-test="local-ingest-creators"] button').attributes('aria-expanded')).toBe('true');
    expect(wrapper.findAll('[data-test="run-local-ingest-job"]')).toHaveLength(50);
    wrapper.unmount();
  });

  it('reads only the current Costuan stage and preserves Stage 1 pagination plus Stage 2 expansion across switches', async () => {
    vi.mocked(fetchMetadataCreators).mockImplementation(async options => metadataPage([metadataRow({ creatorName: `Page ${options?.page ?? 1}` })], { page: options?.page ?? 1, total: 21, hasMore: (options?.page ?? 1) === 1 }));
    const wrapper = await mountCostuan('source'); await flushPromises();
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(1);
    expect(fetchDownloadCreators).not.toHaveBeenCalled();
    expect(fetchLocalIngestOperation).not.toHaveBeenCalled();
    await wrapper.get('[data-test="metadata-next"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="workspace-staging"]').trigger('click'); await flushPromises();
    expect(fetchDownloadCreators).toHaveBeenCalledTimes(1);
    expect(fetchMetadataCreators).toHaveBeenCalledTimes(2);
    expect(fetchLocalIngestJobs).not.toHaveBeenCalled();
    await wrapper.get('[data-test="toggle-stage2-creator"]').trigger('click'); await flushPromises();
    const stage2Element = wrapper.get('[data-test="toggle-stage2-creator"]').element;
    await wrapper.get('[data-test="workspace-source"]').trigger('click'); await flushPromises();
    expect(fetchMetadataCreators).toHaveBeenLastCalledWith({ page: 2, limit: 20, enabled: 'all' });
    expect(wrapper.get('[data-test="metadata-pagination"]').text()).toContain('第 2 / 2 页');
    await wrapper.get('[data-test="workspace-staging"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="toggle-stage2-creator"]').element).toBe(stage2Element);
    expect(wrapper.get('[data-test="toggle-stage2-creator"]').attributes('aria-expanded')).toBe('true');
    expect(planArchiveDownloadTasks).not.toHaveBeenCalled();
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
  });

  it('ignores a Stage 1 response that arrives after leaving and returning to the stage', async () => {
    let resolveOld!: (value: MetadataCreatorPage) => void;
    vi.mocked(fetchMetadataCreators).mockResolvedValueOnce(metadataPage([metadataRow()], { total: 21, hasMore: true }))
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(metadataPage([metadataRow({ creatorName: 'Fresh return' })]));
    const wrapper = await mountCostuan('source'); await flushPromises();
    await wrapper.get('[data-test="metadata-next"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="workspace-staging"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="workspace-source"]').trigger('click'); await flushPromises();
    resolveOld(metadataPage([metadataRow({ creatorName: 'Stale return' })], { page: 2, total: 21 })); await flushPromises();
    expect(wrapper.get('[data-test="metadata-creators"]').text()).toContain('Fresh return');
    expect(wrapper.get('[data-test="metadata-creators"]').text()).not.toContain('Stale return');
  });

  it('stops Stage 3 polling and plugin-event reads while kept alive outside Costuan, then restores the selected creator', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchLocalIngestOperation).mockResolvedValue({ ...idleLocalIngestOperation, state: 'running', kind: 'batch' });
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/creator-admission/costuan', component: CostuanWorkspace },
      { path: '/creator-admission/local', component: { template: '<p>Local module</p>' } }
    ] });
    await router.push('/creator-admission/costuan?workspace=ingest'); await router.isReady();
    const root = mount(defineComponent({ template: '<RouterView v-slot="{ Component }"><KeepAlive><component :is="Component" /></KeepAlive></RouterView>' }), { global: { plugins: [router] } });
    await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(1);
    await root.get('[data-test="local-ingest-creators"] button').trigger('click'); await flushPromises();
    await router.push('/creator-admission/local'); await flushPromises();
    const reads = vi.mocked(fetchLocalIngestOperation).mock.calls.length;
    const jobs = vi.mocked(fetchLocalIngestJobs).mock.calls.length;
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: window.location.origin, data: { source: 'costuan-archive-manager', type: 'cosgallery:archive-state-changed' } }));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30_000); await flushPromises();
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(reads);
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(jobs);
    expect(fetchMetadataCreators).not.toHaveBeenCalled();
    expect(fetchDownloadCreators).not.toHaveBeenCalled();
    await router.push('/creator-admission/costuan?workspace=ingest'); await flushPromises();
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(reads + 1);
    expect(root.get('[data-test="local-ingest-creators"] button').attributes('aria-expanded')).toBe('true');
    expect(runLocalIngestBatch).not.toHaveBeenCalled();
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
  });

  it('keeps the explicit roster plan operation single and navigates to Stage 2 without replay on navigation', async () => {
    vi.mocked(fetchLocalIngestSettings).mockResolvedValue({ ...localIngestSettings, inboxRoot: 'X:\\isolated-inbox' });
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/archive-catalog', component: ArchiveCatalogView },
      { path: '/creator-admission/costuan', name: 'costuan-admission', component: CostuanWorkspace }
    ] });
    await router.push('/archive-catalog'); await router.isReady();
    const root = mount(defineComponent({ template: '<RouterView />' }), { global: { plugins: [router] } }); await flushPromises();
    const roster = root.findComponent({ name: 'ManagedCreatorRoster' });
    roster.vm.$emit('plan-downloads', 35); await flushPromises();
    expect(planArchiveDownloadTasks).toHaveBeenCalledExactlyOnceWith('X:\\isolated-inbox', [35]);
    expect(router.currentRoute.value.path).toBe('/creator-admission/costuan');
    expect(router.currentRoute.value.query.workspace).toBe('staging');
    await router.push('/archive-catalog'); await flushPromises();
    await router.push('/creator-admission/costuan?workspace=staging'); await flushPromises();
    expect(planArchiveDownloadTasks).toHaveBeenCalledTimes(1);
  });

  it('locates a review return Job only within its explicit creator and retains that page on subsequent refresh', async () => {
    vi.mocked(fetchLocalIngestJobs).mockImplementation(async (options = {}) => ({
      summary: { total: 51, pending: 0, running: 0, ingested: 50, awaitingReview: 1, failed: 0 },
      creators: [{ creatorId: 192, creatorName: '火龙果羊', total: 51, pending: 0, running: 0, ingested: 50, awaitingReview: 1, failed: 0, progressPercent: 98, isCurrent: false }],
      items: options.page === 2 ? [{ ...localIngestJob, id: 51, status: 'awaiting_review', phase: 'validating' }] : [{ ...localIngestJob, id: 1 }],
      total: 51, page: options.page ?? 1, limit: 50, hasMore: options.page !== 2
    }));
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/creator-admission/costuan', component: CostuanWorkspace }] });
    await router.push('/creator-admission/costuan?workspace=ingest&creatorId=192&jobId=51#costuan-job-51'); await router.isReady();
    const wrapper = mount(CostuanWorkspace, { global: { plugins: [router] } }); await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(2);
    for (const [query] of vi.mocked(fetchLocalIngestJobs).mock.calls) expect(query?.creatorId).toBe(192);
    expect(wrapper.get('[data-job-id="51"]').classes()).toContain('bg-blue-50');
    expect(wrapper.get('[data-test="local-ingest-creators"] button').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-test="local-ingest-prev"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-test="refresh-stage3"]').trigger('click'); await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(3);
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith(expect.objectContaining({ creatorId: 192, page: 2 }));
    expect(router.currentRoute.value.query.jobId).toBe('51');
    expect(router.currentRoute.value.hash).toBe('#costuan-job-51');
    expect(runLocalIngestJob).not.toHaveBeenCalled();
  });

  it.each(['source', 'staging'] as const)('reads Stage 3 jobs once when switching from %s using its stage tab', async initial => {
    const wrapper = await mountCostuan(initial); await flushPromises();
    expect(fetchLocalIngestJobs).not.toHaveBeenCalled();
    await wrapper.get('[data-test="workspace-ingest"]').trigger('click'); await flushPromises();
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(1);
    expect(fetchLocalIngestJobs).toHaveBeenCalledExactlyOnceWith({ page: 1, limit: 50 });
    expect(scanLocalIngestInbox).not.toHaveBeenCalled();
    expect(runLocalIngestBatch).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous workspace and Job context changes but reads a later same-stage creator change', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/creator-admission/costuan', component: CostuanWorkspace }] });
    await router.push('/creator-admission/costuan?workspace=source'); await router.isReady();
    const wrapper = mount(CostuanWorkspace, { global: { plugins: [router] } }); await flushPromises();
    await router.push('/creator-admission/costuan?workspace=ingest&creatorId=192&jobId=1'); await flushPromises();
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(1);
    expect(fetchLocalIngestJobs).toHaveBeenCalledExactlyOnceWith({ creatorId: 192, status: undefined, page: 1, limit: 50 });
    expect(wrapper.get('[data-job-id="1"]').classes()).toContain('bg-blue-50');
    await router.push('/creator-admission/costuan?workspace=ingest&creatorId=193'); await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(2);
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith({ creatorId: 193, status: undefined, page: 1, limit: 50 });
    await router.push('/creator-admission/costuan?workspace=source&creatorId=194'); await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(2);
  });

  it('reads the explicit Job once when a cached Costuan stage is activated with a new context', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/creator-admission/costuan', component: CostuanWorkspace },
      { path: '/creator-admission/local', component: { template: '<p>Local module</p>' } }
    ] });
    await router.push('/creator-admission/costuan?workspace=ingest'); await router.isReady();
    const root = mount(defineComponent({ template: '<RouterView v-slot="{ Component }"><KeepAlive><component :is="Component" /></KeepAlive></RouterView>' }), { global: { plugins: [router] } }); await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(1);
    await router.push('/creator-admission/local'); await flushPromises();
    await router.push('/creator-admission/costuan?workspace=ingest&creatorId=192&jobId=1'); await flushPromises();
    expect(fetchLocalIngestJobs).toHaveBeenCalledTimes(2);
    expect(fetchLocalIngestOperation).toHaveBeenCalledTimes(2);
    expect(fetchLocalIngestJobs).toHaveBeenLastCalledWith({ creatorId: 192, status: undefined, page: 1, limit: 50 });
    expect(root.get('[data-job-id="1"]').classes()).toContain('bg-blue-50');
  });
});
