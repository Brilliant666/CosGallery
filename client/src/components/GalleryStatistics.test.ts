import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import GalleryStatistics from './GalleryStatistics.vue';
import { useAppStore } from '../stores/app';
import { i18n } from '../locales';
import type { AppStatus } from '../types/api';

enableAutoUnmount(afterEach);

function setup(status: Partial<AppStatus> | null) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const app = useAppStore();
  app.stats = status ? { storage: { available: true, reason: null }, ...status } as AppStatus : null;
  i18n.global.locale.value = 'zh';
  return { app, wrapper: mount(GalleryStatistics, { global: { plugins: [pinia] } }) };
}

describe('canonical gallery statistics', () => {
  it('never relabels legacy folder/post/media totals as creators, works or photos', async () => {
    const { wrapper, app } = setup({ folders: 999, indexedImages: 888, indexedMediaAssets: 777 });
    expect(wrapper.findAll('dd').map(row => row.text())).toEqual(['—', '—', '—']);
    app.stats!.galleryStatistics = { creators: 217, works: 11297, photos: 345801 };
    await nextTick();
    expect(wrapper.findAll('dd').map(row => row.text())).toEqual(['217', '11.3K', '345.8K']);
    expect(wrapper.get('[data-stat="photos"] dd').attributes('title')).toBe('照片: 345,801');
  });

  it('distinguishes a real empty gallery from unavailable storage or failed loading', async () => {
    const { wrapper, app } = setup({ galleryStatistics: { creators: 0, works: 0, photos: 0 } });
    expect(wrapper.findAll('dd').map(row => row.text())).toEqual(['0', '0', '0']);
    app.stats!.storage = { available: false, reason: 'Offline' };
    await nextTick();
    expect(wrapper.findAll('dd').map(row => row.text())).toEqual(['—', '—', '—']);
    expect(wrapper.text()).toContain('统计暂不可用');
    app.stats!.storage.available = true;
    app.error = 'Request failed';
    await nextTick();
    expect(wrapper.get('[data-stat="creators"] dd').text()).toBe('—');
  });
});
