import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompanionGrant, fetchCompanionGrants, normalizeCompanionOrigin, revokeCompanionGrant } from './companion-grants';
afterEach(() => vi.unstubAllGlobals());
describe('Companion grant API', () => {
  it('normalizes only an extension ID or exact extension origin', () => {
    const id = 'b'.repeat(32);
    expect(normalizeCompanionOrigin(id)).toBe(`chrome-extension://${id}`);
    expect(normalizeCompanionOrigin(`chrome-extension://${id}/`)).toBe(`chrome-extension://${id}`);
    for (const value of [`https://${id}`, `chrome-extension://${id}/options.html`, 'z'.repeat(32), '']) expect(normalizeCompanionOrigin(value)).toBeNull();
  });
  it('uses the ordinary same-origin admin request and CSRF intent, with no plugin credentials', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); vi.stubGlobal('fetch', fetch);
    await fetchCompanionGrants();
    await createCompanionGrant({ label: 'synthetic', extensionOrigin: `chrome-extension://${'a'.repeat(32)}`, expiresInDays: 7, scopes: ['identity:read'] });
    await revokeCompanionGrant('id');
    expect(fetch.mock.calls[0][0]).toBe('/api/admin/companion/grants');
    expect(fetch.mock.calls[1][1].credentials).toBe('same-origin');
    expect(fetch.mock.calls[1][1].headers.get('x-foldergram-intent')).toBe('1');
    expect(fetch.mock.calls[1][1].headers.has('authorization')).toBe(false);
    expect(fetch.mock.calls[2][0]).toBe('/api/admin/companion/grants/id');
    expect(fetch.mock.calls[2][1].method).toBe('DELETE');
  });
});
