import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CreatorGalleryLabelsDialog from './CreatorGalleryLabelsDialog.vue';
import { fetchCreatorGalleryLabels, updateCreatorGalleryLabels } from '../api/gallery';
import { RequestError } from '../api/http';
import { useCreatorReadingStore } from '../stores/creator-reading';
import { useAuthStore } from '../stores/auth';
import type { CosGalleryCreator } from '../types/api';

vi.mock('../api/gallery', () => ({ fetchCreatorGalleryLabels: vi.fn(), updateCreatorGalleryLabels: vi.fn() }));
enableAutoUnmount(afterEach);
const creator = { id: 12, name: 'Sample creator', identityType: 'creator', galleryLabels: ['portrait'] } as CosGalleryCreator;
async function setup() {
  const wrapper = mount(CreatorGalleryLabelsDialog, { props: { creator }, attachTo: document.body, global: { stubs: { Teleport: true } } });
  await flushPromises();
  return wrapper;
}
describe('creator gallery labels editor', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchCreatorGalleryLabels).mockReset().mockResolvedValue({ galleryLabels: ['portrait'], revision: 'revision-a' });
    vi.mocked(updateCreatorGalleryLabels).mockReset().mockResolvedValue({ galleryLabels: ['cosplay', 'portrait'], revision: 'revision-b' });
  });

  it('reads authoritative multi-label state and saves selected labels with its revision', async () => {
    const wrapper = await setup();
    expect(fetchCreatorGalleryLabels).toHaveBeenCalledExactlyOnceWith(12);
    expect(wrapper.findAll('input[type="checkbox"]').map(input => input.attributes('value'))).toEqual(['cosplay', 'portrait', 'selfie', 'fuliji']);
    expect((wrapper.get('input[value="portrait"]').element as HTMLInputElement).checked).toBe(true);
    await wrapper.get('input[value="cosplay"]').setValue(true);
    useCreatorReadingStore().libraryPages['old'] = { items: [], total: 2, scrollY: 100 };
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(updateCreatorGalleryLabels).toHaveBeenCalledExactlyOnceWith(12, ['cosplay', 'portrait'], 'revision-a');
    expect(useCreatorReadingStore().libraryPages).toEqual({});
    expect(wrapper.emitted('saved')).toEqual([[['cosplay', 'portrait']]]);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('supports clearing all labels, but cancel does not write the cleared draft', async () => {
    const wrapper = await setup();
    const button = (text: string) => wrapper.findAll('button').find(item => item.text() === text)!;
    await button('清空分类').trigger('click');
    expect(wrapper.findAll('input:checked')).toHaveLength(0);
    expect(wrapper.text()).toContain('未分类 · 仍在全部图库显示');
    await button('取消').trigger('click');
    expect(updateCreatorGalleryLabels).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toHaveLength(1);
    // Saving an empty choice is an intentional supported state.
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(updateCreatorGalleryLabels).toHaveBeenCalledWith(12, [], 'revision-a');
  });

  it('keeps the draft on conflict and requires a deliberate reload before another save', async () => {
    vi.mocked(updateCreatorGalleryLabels).mockRejectedValueOnce(new RequestError('changed', 409, { code: 'GALLERY_LABELS_CHANGED' }));
    const wrapper = await setup();
    await wrapper.get('input[value="selfie"]').setValue(true);
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('分类已被其他操作修改');
    expect((wrapper.get('input[value="selfie"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    expect(updateCreatorGalleryLabels).toHaveBeenCalledTimes(1);
    vi.mocked(fetchCreatorGalleryLabels).mockResolvedValueOnce({ galleryLabels: ['fuliji'], revision: 'revision-current' });
    await wrapper.findAll('button').find(button => button.text() === '重新读取分类')!.trigger('click'); await flushPromises();
    expect(wrapper.findAll('input:checked').map(input => input.attributes('value'))).toEqual(['fuliji']);
    await wrapper.get('input[value="cosplay"]').setValue(true);
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(updateCreatorGalleryLabels).toHaveBeenLastCalledWith(12, ['cosplay', 'fuliji'], 'revision-current');
  });

  it('closes after losing administrator capability and never submits the pending draft', async () => {
    const wrapper = await setup();
    useAuthStore().capabilities.canAccessSettings = false;
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.get('form').trigger('submit');
    expect(updateCreatorGalleryLabels).not.toHaveBeenCalled();
  });
});
