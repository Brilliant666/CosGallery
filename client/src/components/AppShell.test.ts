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
    SidebarNav: { props: ['expanded'], emits: ['toggle'], template: '<button data-test="sidebar-toggle" :aria-expanded="expanded" @click="$emit(\'toggle\')">Toggle</button>' }
  } } });
  await flushPromises();
  return { wrapper, router, toggle: () => wrapper.get('[data-test="sidebar-toggle"]') };
}

describe('explicit sidebar preference', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('starts collapsed, remembers both choices and retains the chosen state across routes', async () => {
    const { router, toggle } = await setup();
    expect(toggle().attributes('aria-expanded')).toBe('false');
    await toggle().trigger('mouseenter');
    await toggle().trigger('focus');
    expect(toggle().attributes('aria-expanded')).toBe('false');
    await toggle().trigger('click');
    expect(toggle().attributes('aria-expanded')).toBe('true');
    expect(localStorage.getItem(storageKey)).toBe('true');
    await router.push('/library');
    expect(toggle().attributes('aria-expanded')).toBe('true');
    await toggle().trigger('click');
    expect(localStorage.getItem(storageKey)).toBe('false');
  });

  it.each([['true', 'true'], ['false', 'false'], ['broken-value', 'false']])('loads stored %s as expanded=%s on mount', async (stored, expected) => {
    localStorage.setItem(storageKey, stored);
    const { toggle } = await setup();
    expect(toggle().attributes('aria-expanded')).toBe(expected);
  });

  it('allows in-memory toggling when preference reads and writes throw', async () => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function(key) { if (key === storageKey) throw new DOMException('Blocked', 'SecurityError'); return get.call(this, key); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(key, value) { if (key === storageKey) throw new DOMException('Blocked', 'SecurityError'); return set.call(this, key, value); });
    const { toggle } = await setup();
    expect(toggle().attributes('aria-expanded')).toBe('false');
    await toggle().trigger('click');
    expect(toggle().attributes('aria-expanded')).toBe('true');
    await toggle().trigger('click');
    expect(toggle().attributes('aria-expanded')).toBe('false');
  });
});
