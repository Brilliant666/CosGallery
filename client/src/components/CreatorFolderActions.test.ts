import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFolder, updateFolderProfile } from '../api/gallery';
import { useAuthStore } from '../stores/auth';
import type { FolderSummary } from '../types/api';
import CreatorFolderActions from './CreatorFolderActions.vue';
import FolderProfileModal from './FolderProfileModal.vue';
import FolderShareModal from './FolderShareModal.vue';

vi.mock('../api/gallery', () => ({ fetchFolder: vi.fn(), updateFolderProfile: vi.fn() }));
const folders = [
  { id: 1, slug: 'first', name: '第一目录', path: 'Photos/First', workCount: 12 },
  { id: 2, slug: 'second', name: '第二目录', path: 'Photos/Second', workCount: 8 }
];
function detail(index = 0): FolderSummary {
  const folder = folders[index]!;
  return { ...folder, folderPath: folder.path, description: '目录描述', breadcrumb: null, contentRating: 'R15', imageCount: 24, videoCount: 0, latestImageMtimeMs: null, avatarImageId: null, avatarUrl: null };
}
function render(count = 2) {
  return mount(CreatorFolderActions, { props: { folders: folders.slice(0, count) }, global: { stubs: { FolderShareModal: true } } });
}

describe('CreatorFolderActions', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchFolder).mockReset().mockImplementation(async slug => detail(slug === 'second' ? 1 : 0));
    vi.mocked(updateFolderProfile).mockReset().mockResolvedValue({ ...detail(1), name: '更新名称', description: '新描述' });
  });

  it.each([1, 2])('shows %i folder scopes without links or initial detail requests', count => {
    const wrapper = render(count);
    expect(wrapper.findAll('li')).toHaveLength(count);
    if (count > 1) expect(wrapper.text()).toContain('第一目录');
    else expect(wrapper.text()).not.toContain('第一目录');
    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('范围：');
    expect(wrapper.text()).not.toContain('12 套');
    expect(wrapper.find('a').exists()).toBe(false);
    expect(fetchFolder).not.toHaveBeenCalled();
  });

  it('loads only the chosen folder and cancels without mutation', async () => {
    const wrapper = render();
    await wrapper.get('button[aria-label="编辑目录资料：第二目录"]').trigger('click');
    await flushPromises();
    expect(fetchFolder).toHaveBeenCalledExactlyOnceWith('second');
    const modal = wrapper.getComponent(FolderProfileModal);
    expect(modal.props('initialName')).toBe('第二目录');
    expect(modal.text()).toContain('仅修改目录资料：Photos/Second');
    modal.vm.$emit('cancel');
    await flushPromises();
    expect(wrapper.findComponent(FolderProfileModal).exists()).toBe(false);
    expect(updateFolderProfile).not.toHaveBeenCalled();
  });

  it('saves the selected physical folder only and emits its returned metadata', async () => {
    const wrapper = render();
    await wrapper.get('button[aria-label="编辑目录资料：第二目录"]').trigger('click');
    await flushPromises();
    const modal = wrapper.getComponent(FolderProfileModal);
    await modal.get('input').setValue('更新名称');
    await modal.get('textarea').setValue('新描述');
    await modal.get('form').trigger('submit');
    await flushPromises();
    expect(updateFolderProfile).toHaveBeenCalledExactlyOnceWith('second', '更新名称', '新描述');
    expect(wrapper.emitted('updated')?.[0]?.[0]).toMatchObject({ id: 2, name: '更新名称' });
    expect(fetchFolder).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(FolderProfileModal).exists()).toBe(false);
  });

  it('opens the existing share dialog for the chosen folder and closes in place', async () => {
    const wrapper = render();
    await wrapper.get('button[aria-label="分享此目录：第一目录"]').trigger('click');
    await flushPromises();
    const modal = wrapper.getComponent(FolderShareModal);
    expect(modal.props('folder')).toMatchObject({ id: 1, slug: 'first' });
    modal.vm.$emit('cancel');
    await flushPromises();
    expect(wrapper.findComponent(FolderShareModal).exists()).toBe(false);
  });

  it('hides management from viewers and discards in-flight details after permission loss', async () => {
    let resolve!: (folder: FolderSummary) => void;
    vi.mocked(fetchFolder).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const wrapper = render();
    await wrapper.get('button').trigger('click');
    useAuthStore().capabilities.canManageLibrary = false;
    await flushPromises();
    resolve(detail());
    await flushPromises();
    expect(wrapper.find('[data-test="creator-folder-actions"]').exists()).toBe(false);
    expect(wrapper.findComponent(FolderProfileModal).exists()).toBe(false);
    expect(updateFolderProfile).not.toHaveBeenCalled();
  });

  it('keeps failed saves open for retry', async () => {
    vi.mocked(updateFolderProfile).mockRejectedValueOnce(new Error('保存失败'));
    const wrapper = render();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    await wrapper.getComponent(FolderProfileModal).get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.getComponent(FolderProfileModal).text()).toContain('保存失败');
    expect(wrapper.emitted('updated')).toBeUndefined();
  });
});
