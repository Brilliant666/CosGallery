import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ArchiveCatalogView from './ArchiveCatalogView.vue';
import ManagedCreatorRoster from '../components/ManagedCreatorRoster.vue';
import * as gallery from '../api/gallery';
import * as managed from '../api/managed-creators';
import type { ArchiveCatalogCreatorDetail } from '../types/api';

vi.mock('../components/FirstCollectionSelector.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/Stage2CreatorQueue.vue', () => ({ default: { template: '<div />', methods: { refresh: async () => {} } } }));
vi.mock('../api/creator-sync', () => ({ fetchMetadataCreators: vi.fn(async () => ({
  items: [], total: 0, page: 1, limit: 20, hasMore: false,
  summary: { sourceCreators: 0, sourceCollections: 0, taskTotal: 0, tasks: {} }
})) }));
vi.mock('../api/gallery', async (original) => ({ ...await original<typeof gallery>(),
  fetchArchiveCatalog: vi.fn(), fetchArchiveCatalogCreator: vi.fn(), runLocalIngestBatch: vi.fn(),
  fetchArchiveBridgeStatus: vi.fn(async () => ({ configured: true })),
  fetchLocalIngestOperation: vi.fn(async () => ({ state: 'idle', kind: null, run: null, lastCompleted: null })),
  fetchLocalIngestJobs: vi.fn(async () => ({ summary: {}, creators: [], items: [], total: 0, page: 1, limit: 20 })),
  fetchLocalIngestSettings: vi.fn(async () => ({ allowlist: ['Alpha'], archivePasswordConfigured: true })),
  planArchiveDownloadTasks: vi.fn(), scanLocalIngestInbox: vi.fn()
}));
vi.mock('../api/managed-creators', async (original) => ({ ...await original<typeof managed>(),
  fetchIngestDestination: vi.fn(async () => ({ preferredLocalCreatorFolderId: null, candidates: [] })),
  updateManagedCreator: vi.fn()
}));
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});

it('refreshes the real roster after Stage3 while retaining its page, filters and unsaved draft', async () => {
  let completed = false;
  const creator: ArchiveCatalogCreatorDetail = { id: 1, name: 'Alpha', isActive: true, preference: 'liked', rating: 'R18',
    seedSource: 'manual', seedSourceCreatorId: '1', createdAt: '2026-09-01', updatedAt: '2026-09-01',
    deactivatedAt: null, aliasCount: 0, sourceCount: 1, localFolderCount: 0, latestSourceObservation: null,
    sourceCollections: 1, remoteWorks: 2, localWorks: 0, matchedWorks: 0, missingWorks: 2,
    unresolvedLocalWorks: 0, aliases: [], sources: [], collections: [], missing: [], unresolved: [],
    localFolders: [], unlinkedLocalFolders: [], impact: { sources: 1, collections: 1, remoteWorks: 2,
      localWorks: 0, unfinishedDownloadTasks: 2, localFolders: 0 } };
  vi.mocked(gallery.fetchArchiveCatalog).mockImplementation(async (params) => ({
    summary: { creators: 60, localWorks: completed ? 2 : 0, activeCreators: 60, inactiveCreators: 0,
      unsetPreference: 0, unclassified: 0, creatorsWithoutLocalWorks: completed ? 59 : 60,
      unlinkedLocalFolders: 0, liked: 60, kept: 0, r15: 0, r18: 60, creatorsWithSources: 1,
      creatorsWithLocalWorks: completed ? 1 : 0, sourceCollections: 1, remoteWorks: 2,
      matchedWorks: completed ? 2 : 0, missingWorks: completed ? 0 : 2,
      unresolvedCreatorFolders: 0, unresolvedLocalWorks: 0 },
    items: [{ ...creator, localWorks: completed ? 2 : 0, matchedWorks: completed ? 2 : 0, missingWorks: completed ? 0 : 2 }],
    total: 60, page: params?.page ?? 1, limit: params?.limit ?? 50, hasMore: params?.page !== 2
  }));
  vi.mocked(gallery.fetchArchiveCatalogCreator).mockResolvedValue(creator);
  let finish!: (value: Awaited<ReturnType<typeof gallery.runLocalIngestBatch>>) => void;
  vi.mocked(gallery.runLocalIngestBatch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));

  const wrapper = mount(ArchiveCatalogView);
  await flushPromises();
  const roster = wrapper.getComponent(ManagedCreatorRoster);
  await roster.get('.roster-filters select').setValue('liked');
  await flushPromises();
  await roster.findAll('button').find(button => button.text() === '下一页')!.trigger('click');
  await flushPromises();
  expect(roster.get('.creator-card').text()).toContain('尚未入库');
  await wrapper.get('[data-test="workspace-ingest"]').trigger('click');
  await wrapper.get('[data-test="run-local-ingest-batch"]').trigger('click');
  await flushPromises();

  // Another workspace may be edited while the long-running request completes.
  await wrapper.get('[data-test="workspace-roster"]').trigger('click');
  await roster.get('button[aria-label="管理 Alpha"]').trigger('click');
  await flushPromises();
  await roster.get('.roster-edit input').setValue('Unsaved name');
  completed = true;
  finish({ total: 2, examined: 2, settled: 2, ingested: 2, failed: 0, awaitingReview: 0,
    reconciling: 0, claimUnavailable: 0, unchanged: 0 });
  await flushPromises();

  expect(wrapper.getComponent(ManagedCreatorRoster).element).toBe(roster.element);
  expect(roster.get('.creator-card').text()).toContain('已完整关联');
  expect(roster.findAll('.card-metric strong').map(item => item.text())).toEqual(['2', '2', '2', '0']);
  expect(gallery.fetchArchiveCatalog).toHaveBeenCalledWith(expect.objectContaining({ page: 2, preference: 'liked', limit: 50 }));
  const listRequests = vi.mocked(gallery.fetchArchiveCatalog).mock.calls.filter(([params]) => params?.limit === 50);
  expect(listRequests.at(-1)?.[0]).toMatchObject({ page: 2, preference: 'liked' });
  expect((roster.get('.roster-edit input').element as HTMLInputElement).value).toBe('Unsaved name');
  expect((roster.get('dialog').element as HTMLDialogElement).open).toBe(true);
  expect(gallery.fetchArchiveCatalogCreator).toHaveBeenCalledTimes(1);
  expect(managed.updateManagedCreator).not.toHaveBeenCalled();
  expect(gallery.scanLocalIngestInbox).not.toHaveBeenCalled();
  expect(gallery.planArchiveDownloadTasks).not.toHaveBeenCalled();
});
