import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { installRouteLoadRecovery, isRouteChunkError } from './route-load-recovery';

describe('lazy route recovery', () => {
  afterEach(() => vi.restoreAllMocks());
  function fixture(options: { online?: boolean; changed?: boolean; unavailable?: boolean } = {}) {
    let fails = true;
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/Settings-old.js');
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/creator-admission/local', component: { template: '<input />' } },
      { path: '/settings', component: () => fails ? Promise.reject(error) : Promise.resolve({ template: '<div />' }) }
    ] });
    const reload = vi.fn();
    const fetchHtml = vi.fn(async () => {
      if (options.unavailable) throw new TypeError('network failed');
      return `<script type="module" src="/assets/index-${options.changed ? 'new' : 'old'}.js"></script>`;
    });
    const recovery = installRouteLoadRecovery(router, {
      online: () => options.online !== false,
      currentEntry: '/assets/index-old.js', fetchHtml, reload
    });
    return { router, recovery, reload, fetchHtml, succeed: () => { fails = false; } };
  }
  it('only recognizes chunk imports, not ordinary business errors', () => {
    expect(isRouteChunkError(new Error('permission denied'))).toBe(false);
    expect(isRouteChunkError(new Error('Unable to preload CSS for /assets/settings.css'))).toBe(true);
  });
  it('proves a changed entry, preserves exact target, and never silently reloads', async () => {
    const f = fixture({ changed: true });
    await f.router.push('/creator-admission/local?collection=draft#review');
    await f.router.push('/settings?section=tools#password').catch(() => {});
    await flushPromises();
    expect(f.recovery.state.value).toMatchObject({ reason: 'version', target: '/settings?section=tools#password' });
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.router.currentRoute.value.fullPath).toBe('/creator-admission/local?collection=draft#review');
    f.recovery.reload();
    expect(f.reload).toHaveBeenCalledExactlyOnceWith('/settings?section=tools#password');
    f.recovery.dispose();
  });
  it.each([{ online: false, reason: 'offline' }, { unavailable: true, reason: 'network' }, { reason: 'unknown' }])('classifies without claiming every error is a release: $reason', async options => {
    const f = fixture(options);
    await f.router.push('/');
    await f.router.push('/settings').catch(() => {}); await flushPromises();
    expect(f.recovery.state.value?.reason).toBe(options.reason);
    if (options.online === false) expect(f.fetchHtml).not.toHaveBeenCalled();
    f.recovery.cancel();
    expect(f.recovery.state.value).toBeNull(); expect(f.reload).not.toHaveBeenCalled();
    f.recovery.dispose();
  });
  it('explicit retry recovers, without automatic writes or reloading the document', async () => {
    const f = fixture(); await f.router.push('/');
    await f.router.push('/settings?q=one#two').catch(() => {}); await flushPromises();
    f.succeed(); await f.recovery.retry();
    expect(f.router.currentRoute.value.fullPath).toBe('/settings?q=one#two');
    expect(f.recovery.state.value).toBeNull(); expect(f.reload).not.toHaveBeenCalled();
    f.recovery.dispose();
  });
  it('late diagnosis cannot reopen a dismissed prompt or override a successful navigation', async () => {
    const f = fixture(); await f.router.push('/');
    await f.router.push('/settings').catch(() => {});
    f.recovery.cancel(); await flushPromises();
    expect(f.recovery.state.value).toBeNull();
    await f.router.push('/creator-admission/local'); await flushPromises();
    expect(f.recovery.state.value).toBeNull(); f.recovery.dispose();
  });
  it('deduplicates repeated errors for one target without loops', async () => {
    const f = fixture(); await f.router.push('/');
    await f.router.push('/settings').catch(() => {}); await flushPromises();
    await f.router.push('/settings').catch(() => {}); await flushPromises();
    expect(f.fetchHtml).toHaveBeenCalledOnce();
    expect(f.recovery.state.value?.target).toBe('/settings');
    expect(f.reload).not.toHaveBeenCalled(); f.recovery.dispose();
  });
});
