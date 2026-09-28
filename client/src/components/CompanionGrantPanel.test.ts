import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanionGrantPanel from './CompanionGrantPanel.vue';
import { useAuthStore } from '../stores/auth';
import { createCompanionGrant, fetchCompanionGrants, revokeCompanionGrant, type CompanionGrant, type CompanionGrants } from '../api/companion-grants';

vi.mock('../api/companion-grants', async importOriginal => ({
  ...await importOriginal<typeof import('../api/companion-grants')>(),
  createCompanionGrant: vi.fn(), fetchCompanionGrants: vi.fn(), revokeCompanionGrant: vi.fn()
}));
const extensionId = 'a'.repeat(32);
const grant = (): CompanionGrant => ({ id: 'synthetic-grant', label: '我的 Companion', extensionOrigin: `chrome-extension://${extensionId}`, scopes: ['identity:read', 'summary:read'], createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null });
const listing = (): CompanionGrants => ({ instanceId: 'synthetic-instance', label: 'CosGallery', grants: [] });
const wrappers: ReturnType<typeof mount>[] = [];
const render = () => { const w = mount(CompanionGrantPanel); wrappers.push(w); return w; };
const button = (w: ReturnType<typeof mount>, text: string) => w.findAll('button').find(item => item.text().includes(text))!;
async function fill(w: ReturnType<typeof mount>) {
  await w.get('[data-testid="grant-label"]').setValue('我的 Companion');
  await w.get('[data-testid="grant-origin"]').setValue(extensionId);
}
beforeEach(() => {
  setActivePinia(createPinia()); vi.resetAllMocks();
  vi.mocked(fetchCompanionGrants).mockResolvedValue(listing());
  vi.mocked(createCompanionGrant).mockResolvedValue({ ...listing(), instanceId: 'synthetic-instance', grant: grant(), token: 'synthetic-one-time-token' });
});
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.restoreAllMocks(); });

describe('Companion read-only grant settings', () => {
  it('opening and refreshing only reads metadata, never creates a grant', async () => {
    const w = render(); await flushPromises();
    expect(w.text()).toContain('尚无 Companion 授权');
    await button(w, '刷新授权').trigger('click'); await flushPromises();
    expect(fetchCompanionGrants).toHaveBeenCalledTimes(2);
    expect(createCompanionGrant).not.toHaveBeenCalled(); expect(revokeCompanionGrant).not.toHaveBeenCalled();
  });
  it('creates a dedicated scoped grant and only keeps the token until refresh', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const w = render(); await flushPromises(); await fill(w);
    await w.get('form').trigger('submit'); await flushPromises();
    expect(createCompanionGrant).toHaveBeenCalledWith({ label: '我的 Companion', extensionOrigin: `chrome-extension://${extensionId}`, expiresInDays: 30, scopes: ['identity:read', 'summary:read', 'library:link', 'catalog:link'] });
    expect(w.get('input[readonly]').element).toHaveProperty('value', 'synthetic-one-time-token');
    expect(storage).not.toHaveBeenCalled();
    await w.get('form').trigger('submit'); expect(createCompanionGrant).toHaveBeenCalledTimes(1);
    await button(w, '刷新授权').trigger('click'); await flushPromises(); expect(w.find('input[readonly]').exists()).toBe(false);
  });
  it('allows identity-only access and explains that it does not grant counts', async () => {
    const w = render(); await flushPromises(); await fill(w);
    for (const checkbox of w.findAll('input[type="checkbox"]:not([disabled])')) await checkbox.setValue(false);
    await w.get('form').trigger('submit'); await flushPromises();
    expect(createCompanionGrant).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['identity:read'] }));
    expect(w.text()).toContain('插件不能读取收录数量');
  });
  it('rejects website URLs and invalid extension IDs without a write', async () => {
    const w = render(); await flushPromises(); await fill(w);
    await w.get('[data-testid="grant-origin"]').setValue('https://example.test');
    await w.get('form').trigger('submit'); await flushPromises();
    expect(createCompanionGrant).not.toHaveBeenCalled(); expect(w.get('[role="alert"]').text()).toContain('有效的 32 位');
  });
  it('revokes once and reads the authoritative result without exposing the old token', async () => {
    const w = render(); await flushPromises(); await fill(w); await w.get('form').trigger('submit'); await flushPromises();
    vi.mocked(fetchCompanionGrants).mockResolvedValue({ ...listing(), grants: [{ ...grant(), revokedAt: '2026-01-02T00:00:00Z' }] });
    await button(w, '撤销 我的 Companion').trigger('click'); await flushPromises();
    expect(revokeCompanionGrant).toHaveBeenCalledExactlyOnceWith('synthetic-grant');
    expect(w.text()).toContain('已撤销'); expect(w.find('input[readonly]').exists()).toBe(false);
  });
  it('does not retry failed creation', async () => {
    vi.mocked(createCompanionGrant).mockRejectedValue(new Error('创建请求失败'));
    const w = render(); await flushPromises(); await fill(w); await w.get('form').trigger('submit'); await flushPromises();
    expect(createCompanionGrant).toHaveBeenCalledTimes(1); expect(w.text()).toContain('创建请求失败');
  });
  it('does not request for a viewer and hides late creation responses after access loss', async () => {
    useAuthStore().capabilities.canAccessSettings = false;
    const denied = render(); await flushPromises(); expect(fetchCompanionGrants).not.toHaveBeenCalled(); expect(denied.find('form').exists()).toBe(false);
    useAuthStore().capabilities.canAccessSettings = true; await flushPromises();
    let resolve!: (value: Awaited<ReturnType<typeof createCompanionGrant>>) => void;
    vi.mocked(createCompanionGrant).mockReturnValue(new Promise(r => { resolve = r; }));
    await fill(denied); await denied.get('form').trigger('submit');
    useAuthStore().capabilities.canAccessSettings = false; await flushPromises();
    resolve({ instanceId: 'secret-instance', label: 'CosGallery', grant: grant(), token: 'late-token' }); await flushPromises();
    expect(denied.find('input').exists()).toBe(false); expect(denied.text()).not.toContain('late-token');
  });
});
