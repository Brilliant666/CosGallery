import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeWorkRemoval,
  previewWorkRemoval,
  type WorkRemovalPreview,
} from '../api/work-removal';
import { RequestError } from '../api/http';
import WorkRemovalDialog from './WorkRemovalDialog.vue';
vi.mock('../api/work-removal', () => ({
  executeWorkRemoval: vi.fn(),
  previewWorkRemoval: vi.fn(),
}));
const preview: WorkRemovalPreview = {
  previewToken: 'frozen',
  work: { id: 22, creatorId: 1, title: 'Album' },
  mode: 'trash',
  localCopies: [1, 2].map((id) => ({
    id,
    postId: 30 + id,
    directoryName: `copy${id}`,
    path: `/library/copy${id}`,
    imageCount: 2,
    videoCount: 1,
    fileCount: 3,
    bytes: 100,
  })),
  fileCount: 6,
  totalBytes: 200,
  blockers: [],
  canExecute: true,
};
describe('whole-work removal confirmation', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(previewWorkRemoval).mockResolvedValue(preview);
  });
  it('shows all copies and submits only the bound preview token', async () => {
    vi.mocked(executeWorkRemoval).mockResolvedValue({
      operationId: 1,
      workId: 22,
      mode: 'trash',
      state: 'completed',
      filesRemoved: false,
      cleanupPending: false,
    });
    const wrapper = mount(WorkRemovalDialog, {
      props: {
        workId: 22,
        creatorId: 1,
        mode: 'trash',
        revision: 'r-global',
        revisionScope: 'all',
      },
    });
    await flushPromises();
    expect(previewWorkRemoval).toHaveBeenCalledWith(
      22,
      'trash',
      'r-global',
      'all',
    );
    expect(wrapper.text()).toContain('/library/copy1');
    expect(wrapper.text()).toContain('/library/copy2');
    await wrapper.get('[data-test="confirm-work-removal"]').trigger('click');
    await flushPromises();
    expect(executeWorkRemoval).toHaveBeenCalledExactlyOnceWith(22, 'frozen');
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });
  it('blocks execution for foreign identity or blockers', async () => {
    vi.mocked(previewWorkRemoval).mockResolvedValue({
      ...preview,
      work: { ...preview.work, creatorId: 2 },
    });
    const wrapper = mount(WorkRemovalDialog, {
      props: { workId: 22, creatorId: 1, mode: 'trash' },
    });
    await flushPromises();
    expect(wrapper.get('[data-test="confirm-work-removal"]').attributes('disabled')).toBeDefined();
    expect(executeWorkRemoval).not.toHaveBeenCalled();
  });
  it('invalidates a stale execution token and never repeats the mutation', async () => {
    vi.mocked(executeWorkRemoval).mockRejectedValue(
      new RequestError('scope changed', 409),
    );
    const wrapper = mount(WorkRemovalDialog, {
      props: { workId: 22, creatorId: 1, mode: 'trash' },
    });
    await flushPromises();
    await wrapper.get('[data-test="confirm-work-removal"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="confirm-work-removal"]').attributes('disabled')).toBeDefined();
    expect(wrapper.emitted('stale')).toHaveLength(1);
    expect(executeWorkRemoval).toHaveBeenCalledTimes(1);
  });
  it('keeps focus in the confirmation and does not dismiss an executing request', async () => {
    let finish!: (value: Awaited<ReturnType<typeof executeWorkRemoval>>) => void;
    vi.mocked(executeWorkRemoval).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = mount(WorkRemovalDialog, {
      attachTo: document.body,
      props: { workId: 22, creatorId: 1, mode: 'trash' },
    });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[role=dialog]').element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(wrapper.get('button').element);
    await wrapper.get('[data-test="confirm-work-removal"]').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wrapper.trigger('click');
    expect(wrapper.emitted('close')).toBeUndefined();
    finish({ operationId: 1, workId: 22, mode: 'trash', state: 'completed', filesRemoved: false, cleanupPending: false });
    await flushPromises();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(executeWorkRemoval).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
