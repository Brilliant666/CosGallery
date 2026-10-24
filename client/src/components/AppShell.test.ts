import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AppShell from './AppShell.vue';

enableAutoUnmount(afterEach);
const storageKey = 'cosgallery.sidebar-expanded.v1';
async function setup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<p>Home</p>' } },
    { path: '/library', component: { template: '<p>Library</p>' } }
  ] });
  await router.push('/');
  await router.isReady();
  const wrapper = mount(AppShell, { global: { plugins: [createPinia(), router], stubs: {
    TopNav: true,
    SidebarNav: { props: ['expanded'], emits: ['expanded-change'], template: '<button data-test="sidebar-intent" :aria-expanded="expanded" @click="$emit(\'expanded-change\', !expanded)">Change interaction intent</button>' }
  } } });
  await flushPromises();
  return { wrapper, router, toggle: () => wrapper.get('[data-test="sidebar-intent"]') };
}

describe('sidebar interaction state', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('shares expansion intent with the shell width and retains it across route rendering', async () => {
    const { wrapper, router, toggle } = await setup();
    expect(toggle().attributes('aria-expanded')).toBe('false');
    await toggle().trigger('click');
    expect(toggle().attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.app-shell').classes()).toContain('app-shell--sidebar-expanded');
    await router.push('/library');
    expect(toggle().attributes('aria-expanded')).toBe('true');
    await toggle().trigger('click');
    expect(wrapper.get('.app-shell').classes()).not.toContain('app-shell--sidebar-expanded');
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it.each(['true', 'false', 'broken-value'])('ignores old stored %s without changing or deleting it', async stored => {
    localStorage.setItem(storageKey, stored);
    const { toggle } = await setup();
    expect(toggle().attributes('aria-expanded')).toBe('false');
    await toggle().trigger('click');
    await toggle().trigger('click');
    expect(localStorage.getItem(storageKey)).toBe(stored);
  });

  it('never accesses the retired storage preference even when storage would throw', async () => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function(key) { if (key === storageKey) throw new DOMException('Blocked', 'SecurityError'); return get.call(this, key); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(key, value) { if (key === storageKey) throw new DOMException('Blocked', 'SecurityError'); return set.call(this, key, value); });
    const { toggle } = await setup();
    expect(toggle().attributes('aria-expanded')).toBe('false');
    await toggle().trigger('click');
    expect(toggle().attributes('aria-expanded')).toBe('true');
    await toggle().trigger('click');
    expect(toggle().attributes('aria-expanded')).toBe('false');
    expect(vi.mocked(Storage.prototype.getItem).mock.calls.some(([key]) => key === storageKey)).toBe(false);
    expect(vi.mocked(Storage.prototype.setItem).mock.calls.some(([key]) => key === storageKey)).toBe(false);
  });
});
