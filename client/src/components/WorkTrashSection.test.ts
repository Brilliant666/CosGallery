import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTrashedWorks,
  retryWorkRemoval,
  type PendingWorkRemoval,
} from '../api/work-removal';
import WorkTrashSection from './WorkTrashSection.vue';
import WorkRemovalDialog from './WorkRemovalDialog.vue';
import { i18n } from '../locales';
vi.mock('../api/work-removal', () => ({
  fetchTrashedWorks: vi.fn(),
  retryWorkRemoval: vi.fn(),
}));
vi.mock('../utils/refresh-library', () => ({
  refreshLibraryAfterRemoval: vi.fn().mockResolvedValue(undefined),
}));
describe('whole-work trash actions', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchTrashedWorks).mockResolvedValue({
      items: [
        {
          workId: 22,
          creatorId: 166,
          title: 'Two copies',
          localCopyCount: 2,
          trashedAt: '2026-09-29',
        },
      ],
    });
  });
  it('offers separate restore and permanent previews for the complete Work', async () => {
    const wrapper = mount(WorkTrashSection, {
      global: { stubs: { WorkRemovalDialog: true } },
    });
    await flushPromises();
    await wrapper.findAll('button')[0]!.trigger('click');
    expect(wrapper.getComponent(WorkRemovalDialog).props()).toMatchObject({
      workId: 22,
      creatorId: 166,
      mode: 'restore',
    });
    wrapper.getComponent(WorkRemovalDialog).vm.$emit('close');
    await flushPromises();
    await wrapper.findAll('button')[1]!.trigger('click');
    expect(wrapper.getComponent(WorkRemovalDialog).props()).toMatchObject({
      workId: 22,
      creatorId: 166,
      mode: 'permanent',
    });
  });
  it('reports pending disk cleanup separately from completed deletion', async () => {
    const wrapper = mount(WorkTrashSection, {
      global: { stubs: { WorkRemovalDialog: true } },
    });
    await flushPromises();
    await wrapper.findAll('button')[1]!.trigger('click');
    wrapper
      .getComponent(WorkRemovalDialog)
      .vm.$emit('changed', {
        operationId: 'op-1',
        workId: 22,
        mode: 'permanent',
        state: 'cleanup_pending',
        filesRemoved: false,
        cleanupPending: true,
      });
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain(
      'disk cleanup is pending',
    );
    expect(wrapper.get('[role="status"]').text()).toContain('op-1');
    expect(wrapper.findComponent(WorkRemovalDialog).exists()).toBe(false);
  });
  it('recovers an unfinished operation from the server list and retries only its operation ID', async () => {
    const operation: PendingWorkRemoval = {
      operationId: 'pending-1',
      workId: 22,
      title: 'Removed album',
      mode: 'permanent',
      state: 'cleanup_pending',
      filesRemoved: false,
      cleanupPending: true,
    };
    vi.mocked(fetchTrashedWorks)
      .mockResolvedValueOnce({ items: [], pendingOperations: [operation] })
      .mockResolvedValue({ items: [], pendingOperations: [] });
    vi.mocked(retryWorkRemoval).mockResolvedValue({
      ...operation,
      state: 'completed',
      cleanupPending: false,
      filesRemoved: true,
    });
    const wrapper = mount(WorkTrashSection, {
      global: { stubs: { WorkRemovalDialog: true } },
    });
    await flushPromises();
    expect(wrapper.get('[data-test="pending-operation"]').text()).toContain(
      'pending-1',
    );
    expect(wrapper.get('[data-test="pending-operation"]').text()).toContain(
      'Removed album',
    );
    await wrapper
      .get('[data-test="pending-operation"] button')
      .trigger('click');
    await flushPromises();
    expect(retryWorkRemoval).toHaveBeenCalledExactlyOnceWith('pending-1');
    expect(wrapper.find('[data-test="pending-operation"]').exists()).toBe(
      false,
    );
    expect(wrapper.get('[role="status"]').text()).toContain(
      'Operation completed',
    );
    expect(wrapper.findComponent(WorkRemovalDialog).exists()).toBe(false);
  });
  it('keeps recovery-pending distinct from success and reports a completed rollback as no deletion', async () => {
    const operation: PendingWorkRemoval = {
      operationId: 'rollback-1',
      workId: 22,
      title: 'Album',
      mode: 'permanent',
      state: 'recovery_pending',
      filesRemoved: false,
      cleanupPending: false,
      recoveryPending: true,
    };
    vi.mocked(fetchTrashedWorks)
      .mockResolvedValueOnce({ items: [], pendingOperations: [operation] })
      .mockResolvedValue({ items: [], pendingOperations: [] });
    vi.mocked(retryWorkRemoval).mockResolvedValue({
      ...operation,
      state: 'failed',
      recoveryPending: false,
    });
    const wrapper = mount(WorkTrashSection, {
      global: { stubs: { WorkRemovalDialog: true } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('file rollback is pending');
    expect(wrapper.text()).not.toContain('Operation completed');
    await wrapper
      .get('[data-test="pending-operation"] button')
      .trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain(
      'this deletion did not take effect',
    );
    expect(wrapper.text()).not.toContain('Operation completed');
  });
  it.each([
    ['en', 'Work files have been permanently deleted', 'finalization of this operation is still pending', 'Operation completed'],
    ['zh', '作品文件已永久删除', '操作收尾尚未完成', '操作已完成'],
  ] as const)('keeps completed file deletion pending until the same operation finishes its records (%s)', async (locale, removed, pending, completed) => {
    i18n.global.locale.value = locale;
    const operation: PendingWorkRemoval = {
      operationId: 'records-pending-1',
      workId: 22,
      title: 'Removed album',
      mode: 'permanent',
      state: 'cleanup_pending',
      filesRemoved: true,
      cleanupPending: true,
    };
    vi.mocked(fetchTrashedWorks)
      .mockResolvedValueOnce({ items: [], pendingOperations: [operation] })
      .mockResolvedValueOnce({ items: [], pendingOperations: [operation] })
      .mockResolvedValue({ items: [], pendingOperations: [] });
    vi.mocked(retryWorkRemoval)
      .mockResolvedValueOnce(operation)
      .mockResolvedValue({ ...operation, state: 'completed', cleanupPending: false });
    const wrapper = mount(WorkTrashSection, {
      global: { stubs: { WorkRemovalDialog: true } },
    });
    await flushPromises();
    const row = () => wrapper.get('[data-test="pending-operation"]');
    expect(row().text()).toContain(removed);
    expect(row().text()).toContain(pending);
    expect(wrapper.text()).not.toContain(completed);
    await row().get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain(pending);
    expect(row().text()).toContain(operation.operationId);
    expect(row().get('button').attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).not.toContain(completed);
    await row().get('button').trigger('click');
    await flushPromises();
    expect(retryWorkRemoval).toHaveBeenCalledTimes(2);
    expect(retryWorkRemoval).toHaveBeenNthCalledWith(1, operation.operationId);
    expect(retryWorkRemoval).toHaveBeenNthCalledWith(2, operation.operationId);
    expect(wrapper.find('[data-test="pending-operation"]').exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toContain(completed);
    expect(wrapper.findComponent(WorkRemovalDialog).exists()).toBe(false);
  });
  it('retains the unfinished operation after a retry error without repeating it', async () => {
    const operation: PendingWorkRemoval = {
      operationId: 'locked-1',
      workId: 22,
      title: 'Album',
      mode: 'permanent',
      state: 'cleanup_pending',
      filesRemoved: false,
      cleanupPending: true,
    };
    vi.mocked(fetchTrashedWorks).mockResolvedValue({
      items: [],
      pendingOperations: [operation],
    });
    vi.mocked(retryWorkRemoval).mockRejectedValue(new Error('File is locked'));
    const wrapper = mount(WorkTrashSection, {
      global: { stubs: { WorkRemovalDialog: true } },
    });
    await flushPromises();
    await wrapper
      .get('[data-test="pending-operation"] button')
      .trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('File is locked');
    expect(wrapper.get('[data-test="pending-operation"]').text()).toContain(
      'locked-1',
    );
    expect(retryWorkRemoval).toHaveBeenCalledTimes(1);
  });
});
