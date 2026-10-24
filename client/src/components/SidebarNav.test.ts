import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import SidebarNav from './SidebarNav.vue';
import { usePlacesStore } from '../stores/places';

enableAutoUnmount(afterEach);

async function setup() {
  const pinia = createPinia();
  setActivePinia(pinia);
  vi.spyOn(usePlacesStore(), 'fetchPlaces').mockResolvedValue(undefined);
  const router = createRouter({ history: createMemoryHistory(), routes:
    ['home', 'library', 'reels', 'explore', 'places', 'likes', 'collections', 'trash', 'archive-catalog', 'creator-admission', 'settings', 'folder']
      .map(name => ({ name, path: name === 'home' ? '/' : `/${name}`, component: { template: '<p>Fixture</p>' } }))
  });
  await router.push('/library');
  await router.isReady();
  const wrapper = mount({ components: { SidebarNav }, data: () => ({ expanded: false }),
    template: '<SidebarNav :expanded="expanded" @expanded-change="expanded = $event" />'
  }, { global: { plugins: [pinia, router] } });
  await nextTick();
  return { wrapper, sidebar: wrapper.getComponent(SidebarNav) };
}

describe('sidebar hover intent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 48rem)', addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('requires 100 ms dwell, delays exit by 220 ms and cancels pending collapse on reentry', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(99);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(219);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(220);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
  });

  it('cancels a brief pass and starts a fresh dwell when the pointer returns', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(45);
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await sidebar.trigger('pointerenter', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(99);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).toContain('sidebar--expanded');
  });
});
