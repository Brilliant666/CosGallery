import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import SidebarNav from './SidebarNav.vue';
import { usePlacesStore } from '../stores/places';
import { useFoldersStore } from '../stores/folders';
import { useAppStore } from '../stores/app';
import type { FolderSummary } from '../types/api';
import { i18n } from '../locales';

enableAutoUnmount(afterEach);

async function setup(folders: FolderSummary[] = [], recentHistory: string[] = []) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useFoldersStore().items = folders;
  useAppStore().recentOpenedCreatorKeys = recentHistory;
  vi.spyOn(usePlacesStore(), 'fetchPlaces').mockResolvedValue(undefined);
  const router = createRouter({ history: createMemoryHistory(), routes:
    ['home', 'library', 'reels', 'explore', 'places', 'likes', 'collections', 'trash', 'archive-catalog', 'creator-admission', 'settings', 'folder']
      .map(name => ({ name, path: name === 'home' ? '/' : `/${name}`, component: { template: '<p>Fixture</p>' } }))
      .concat([{ name: 'canonical-creator', path: '/library/:creatorId', component: { template: '<p>Fixture</p>' } }])
  });
  await router.push('/library');
  await router.isReady();
  const wrapper = mount({ components: { SidebarNav }, data: () => ({ expanded: false }),
    template: '<SidebarNav :expanded="expanded" @expanded-change="expanded = $event" />'
  }, { attachTo: document.body, global: { plugins: [pinia, router] } });
  await nextTick();
  const sidebar = wrapper.getComponent(SidebarNav);
  vi.spyOn(sidebar.element, 'getBoundingClientRect').mockImplementation(() => {
    const width = sidebar.classes().includes('sidebar--expanded') ? 240 : 77.6;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 900, width, height: 900, toJSON: () => ({}) };
  });
  return { wrapper, sidebar, router };
}

async function movePointerOutside(type = 'mouse') {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX: 600, clientY: 12 });
  Object.defineProperty(event, 'pointerType', { value: type });
  document.dispatchEvent(event);
  await nextTick();
}

describe('sidebar hover intent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 48rem)', addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('requires 100 ms dwell, delays exit by 120 ms and cancels pending collapse on reentry', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(99);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(119);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(119);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
  });

  it('cancels a brief pass and starts a fresh dwell when the pointer returns', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(45);
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(99);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).toContain('sidebar--expanded');
  });

  it('collapses after appearance menu removal when the next pointer move is outside and no sidebar pointerleave arrives', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(100);
    const more = sidebar.get('button[aria-haspopup="menu"]');
    for (const theme of ['dark', 'light']) {
      await more.trigger('click');
      expect(more.attributes('aria-expanded')).toBe('true');
      const appearance = sidebar.findAll('button').find(button => button.find('.i-fluent-weather-moon-20-regular, .i-fluent-weather-sunny-20-regular').exists())!;
      await appearance.trigger('pointermove', { pointerType: 'mouse', clientX: 144, clientY: 700 });
      await appearance.trigger('click');
      expect(useAppStore().theme).toBe(theme);
      expect(more.attributes('aria-expanded')).toBe('false');
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    // Removing the menu/backdrop can omit a leave event from the aside. The
    // real browser's subsequent main-content pointermove must correct the state.
    await movePointerOutside();
    await vi.advanceTimersByTimeAsync(119);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
  });

  it('keeps keyboard focus as an expansion hold when document pointer coordinates move outside', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const link = sidebar.get<HTMLAnchorElement>('a[href="/library"]');
    link.element.focus(); await nextTick();
    await movePointerOutside();
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    link.element.blur(); await nextTick();
    await vi.advanceTimersByTimeAsync(119);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
  });

  it('does not treat a descendant menu enter outside the physical rail as hover after menu removal', async () => {
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(100);
    await sidebar.get('button[aria-haspopup="menu"]').trigger('click');
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 280, clientY: 700 });
    await vi.advanceTimersByTimeAsync(200);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    await vi.advanceTimersByTimeAsync(120);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
  });

  it('preserves the explicit coarse-pointer toggle and ignores hover coordinates', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { sidebar } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'touch', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(200);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    const toggle = sidebar.get('[data-test="sidebar-toggle"]');
    await toggle.trigger('click');
    await movePointerOutside('touch'); await movePointerOutside('mouse');
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await toggle.trigger('click');
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
  });

  it.each(['cosplay', 'portrait', 'selfie', 'fuliji'])('collapses after leaving %s while preserving its open list and selected route', async label => {
    const { sidebar, router } = await setup();
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(100);
    const toggle = sidebar.get('button[aria-label="展开图库分类"]');
    await toggle.trigger('click');
    await sidebar.get(`.library-nav__menu a[href="/library?label=${label}"]`).trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ label });
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(119);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    await vi.advanceTimersByTimeAsync(1);
    expect(sidebar.classes()).not.toContain('sidebar--expanded');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(toggle.attributes('disabled')).toBeDefined();
    expect(sidebar.find('.library-nav__menu').exists()).toBe(false);
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(100);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    expect(sidebar.get(`.library-nav__menu a[href="/library?label=${label}"]`).attributes('aria-current')).toBe('page');
    expect(sidebar.findAll('.library-nav__menu a')).toHaveLength(4);
    await sidebar.trigger('pointerleave', { pointerType: 'mouse' });
    await vi.advanceTimersByTimeAsync(60);
    await sidebar.trigger('pointerenter', { pointerType: 'mouse', clientX: 18, clientY: 220 });
    await vi.advanceTimersByTimeAsync(500);
    expect(sidebar.classes()).toContain('sidebar--expanded');
    expect(router.currentRoute.value.query).toEqual({ label });
  });
});

describe('gallery statistics placement', () => {
  it('replaces recent creators without changing stored browsing history', async () => {
    i18n.global.locale.value = 'zh';
    const { sidebar, wrapper } = await setup([], ['creator:42']);
    expect(sidebar.text()).toContain('图库统计');
    expect(sidebar.text()).not.toContain('最近浏览');
    expect(sidebar.find('.sidebar__folder').exists()).toBe(false);
    expect(sidebar.get('.sidebar__statistics').attributes('aria-hidden')).toBe('true');
    await wrapper.setData({ expanded: true });
    expect(sidebar.get('.sidebar__statistics').attributes('aria-hidden')).toBe('false');
    expect(useAppStore().recentOpenedCreatorKeys).toEqual(['creator:42']);
  });
});
