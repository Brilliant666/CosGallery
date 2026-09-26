import { requestJson } from './http';

export type CompanionScope = 'identity:read' | 'summary:read' | 'library:link' | 'catalog:link';
export interface CompanionGrant {
  id: string;
  label: string;
  extensionOrigin: string;
  scopes: CompanionScope[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface CompanionGrants {
  instanceId: string | null;
  label: string;
  grants: CompanionGrant[];
}
export interface CreateCompanionGrant {
  label: string;
  extensionOrigin: string;
  expiresInDays: number;
  scopes: CompanionScope[];
}
const endpoint = '/api/admin/companion/grants';
export const fetchCompanionGrants = () => requestJson<CompanionGrants>(endpoint);
export const createCompanionGrant = (input: CreateCompanionGrant) =>
  requestJson<{ token: string; grant: CompanionGrant; instanceId: string; label: string }>(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
  });
export const revokeCompanionGrant = (id: string) =>
  requestJson<{ ok: true }>(`${endpoint}/${encodeURIComponent(id)}`, { method: 'DELETE' });

export function normalizeCompanionOrigin(value: string): string | null {
  const id = value.trim().replace(/^chrome-extension:\/\//, '').replace(/\/$/, '');
  return /^[a-p]{32}$/.test(id) ? `chrome-extension://${id}` : null;
}
