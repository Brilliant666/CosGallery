import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ArchiveCatalogView from './ArchiveCatalogView.vue';
import {
  fetchArchiveBridgeStatus,
  fetchArchiveCatalog,
  fetchArchiveCatalogCreator,
  fetchArchiveDownloadTasks,
  planArchiveDownloadTasks,
  rotateArchiveBridgeToken
} from '../api/gallery';

vi.mock('../api/gallery', () => ({
  fetchArchiveCatalog: vi.fn(),
  fetchArchiveCatalogCreator: vi.fn(),
  fetchArchiveDownloadTasks: vi.fn(),
  planArchiveDownloadTasks: vi.fn(),
  fetchArchiveBridgeStatus: vi.fn(),
  rotateArchiveBridgeToken: vi.fn()
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

describe('ArchiveCatalogView', () => {
  beforeEach(() => {
    vi.mocked(fetchArchiveCatalog).mockReset();
    vi.mocked(fetchArchiveCatalogCreator).mockReset();
    vi.mocked(fetchArchiveDownloadTasks).mockReset();
    vi.mocked(planArchiveDownloadTasks).mockReset();
    vi.mocked(fetchArchiveBridgeStatus).mockReset();
    vi.mocked(rotateArchiveBridgeToken).mockReset();
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

    await wrapper.get('button[aria-expanded="false"]').trigger('click');
    await flushPromises();

    expect(fetchArchiveCatalogCreator).toHaveBeenCalledWith(115);
    expect(wrapper.get('[data-test="catalog-detail"]').text()).toContain('NO.014');
    expect(wrapper.get('[data-test="catalog-detail"]').text()).toContain('课间的阳光');
    expect(wrapper.get('[data-test="catalog-detail"]').text()).toContain('百度网盘：saved');
  });

  it('passes preference and rating filters to the API', async () => {
    const wrapper = mount(ArchiveCatalogView);
    await flushPromises();

    const selects = wrapper.findAll('select');
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
});
