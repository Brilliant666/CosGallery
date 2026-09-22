import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeSourceEvidenceInput, assertSafeSourceEvidenceText, confirmSourceEvidenceIdentity, createSourceEvidenceScope, fetchSourceEvidence, fetchSourceEvidenceDetail, linkSourceEvidenceWork, mapSourceEvidenceEntry, saveSourceEvidence } from './source-evidence';

describe('source evidence API and local preview scope', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('scopes reads and uses authenticated intent-protected writes with exact retry keys', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await fetchSourceEvidence(17, 2); await fetchSourceEvidenceDetail(45);
    const save = { creatorId: 17, requestId: 'fixed-observation', record: { platform: 'sndiary', pageUrl: 'https://example.test/page', pageTitle: 'Evidence', method: 'manual' as const, rawDirectoryText: '', notes: '', resourceEntries: [], completeness: 'unknown' as const } };
    await saveSourceEvidence(save);
    await confirmSourceEvidenceIdentity(45, { creatorId: 17, requestId: 'fixed-identity', expectedRevision: 3, reason: 'Verified page' });
    await linkSourceEvidenceWork(45, { creatorId: 17, workId: 90, key: 'fixed-link', reason: 'Existing files from page' });
    await mapSourceEvidenceEntry(45, { creatorId: 17, workId: 90, sourceWorkId: 23, entryKey: 'line-1', key: 'fixed-mapping', reason: 'Verified work' });
    expect(fetch.mock.calls[0]![0]).toBe('/api/admin/archive-catalog/source-evidence?creatorId=17&page=2&limit=20');
    expect(fetch.mock.calls[1]![0]).toBe('/api/admin/archive-catalog/source-evidence/45');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    for (const call of fetch.mock.calls.slice(2)) {
      expect(call[1]).toMatchObject({ credentials: 'same-origin', method: 'POST' });
      expect((call[1].headers as Headers).get('x-foldergram-intent')).toBe('1');
    }
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual(save);
    expect(JSON.parse(fetch.mock.calls[5]![1].body)).toMatchObject({ workId: 90, sourceWorkId: 23 });
    expect(() => fetchSourceEvidence(0)).toThrow('ID');
    expect(() => fetchSourceEvidence(17, 0)).toThrow('ID');
  });
  it('creates only explicit unconfirmed preview scope and never invents a Work identity', () => {
    const scope = createSourceEvidenceScope({ creatorId: 17, sourceEvidenceId: 45, inputRoot: 'C:\\isolated\\inbox', directoryLines: 'NO.001 A\r\nNO.002 B', acceptExistingVersion: true });
    expect(scope).toEqual({ creatorId: 17, sourceEvidenceId: 45, inputRoot: 'C:\\isolated\\inbox', directories: ['NO.001 A', 'NO.002 B'], localOnly: false, acceptExistingVersion: true, confirmed: false });
    expect(scope).not.toHaveProperty('items');
    expect(scope).not.toHaveProperty('identity');
    expect(createSourceEvidenceScope({ creatorId: 17, sourceEvidenceId: 45, inputRoot: 'C:\\isolated\\inbox', directoryLines: ' Leading space album', acceptExistingVersion: false }).directories).toEqual([' Leading space album']);
  });
  it.each(['A\nA', '../A', 'A/B', 'A\\B', '..', ''])('refuses invalid or duplicate directory lines %j without disk access', directoryLines => {
    expect(() => createSourceEvidenceScope({ creatorId: 17, sourceEvidenceId: 45, inputRoot: '/isolated/inbox', directoryLines, acceptExistingVersion: false })).toThrow();
  });
  it('refuses a relative root instead of pretending the browser verified files', () => {
    expect(() => createSourceEvidenceScope({ creatorId: 17, sourceEvidenceId: 45, inputRoot: 'relative', directoryLines: 'Album', acceptExistingVersion: false })).toThrow('绝对路径');
  });
  it.each(['Cookie: synthetic-secret', 'BDUSS=synthetic-secret', '提取码 abcd', '解压密码：abcd', 'https://example.test/share?pwd=abcd', 'https://example.test/#/share?access_token=synthetic-secret'])('refuses obvious credentials before they can enter retry storage: %s', text => {
    expect(() => assertSafeSourceEvidenceText(text)).toThrow();
  });
  it('refuses credentials in explicit URLs, while harmless source text and credential-free URLs remain valid', () => {
    const input = { creatorId: 17, requestId: 'fixed', record: { platform: 'manual', pageUrl: 'https://user:secret@example.test/', pageTitle: 'Page', method: 'manual' as const, rawDirectoryText: 'NO.018-NO.026 Set', notes: '', resourceEntries: [], completeness: 'partial' as const } };
    expect(() => assertSafeSourceEvidenceInput(input)).toThrow();
    input.record.pageUrl = 'https://example.test/page?id=1';
    expect(() => assertSafeSourceEvidenceInput(input)).not.toThrow();
    expect(() => assertSafeSourceEvidenceText('用户手工取得，原文中没有会话凭据')).not.toThrow();
  });
});
