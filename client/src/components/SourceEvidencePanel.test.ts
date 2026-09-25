import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SourceEvidencePanel from './SourceEvidencePanel.vue';
import * as api from '../api/source-evidence';
import { RequestError } from '../api/http';
import type { SourceEvidenceObservation, SourceEvidenceLink } from '../api/source-evidence';

vi.mock('../api/source-evidence', async importOriginal => ({ ...await importOriginal<typeof import('../api/source-evidence')>(), fetchSourceEvidence: vi.fn(), fetchSourceEvidenceDetail: vi.fn(), saveSourceEvidence: vi.fn(), confirmSourceEvidenceIdentity: vi.fn(), linkSourceEvidenceWork: vi.fn(), mapSourceEvidenceEntry: vi.fn() }));
const record = (id = 45, creatorId = 17): SourceEvidenceObservation => ({
  id, platform: 'costuan', pageKey: 'synthetic-page', pageUrl: 'https://example.test/page', pageTitle: 'Synthetic evidence', method: 'plugin', observedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', candidateCreatorId: creatorId, creatorId: null, identityState: 'candidate', identityRevision: 1, identityReason: '待核对具体页面',
  rawDirectoryText: 'NO.001 Normal\nNO.018-NO.026 Collection\nUnknown appendix <img src=x onerror=alert(1)>', notes: '手工获取后准备接纳', resourceEntries: [{ url: 'javascript:alert(1)', label: '<b>Raw entry</b>' }], diagnostics: ['不完整，不能自动精确补缺'], completeness: 'partial',
  parsedEntries: [{ key: 'line-1', lineNumber: 1, raw: 'NO.001 Normal', state: 'candidate', title: 'Normal', sourceOrder: 'NO.001', diagnostics: [] }, { key: 'line-2', lineNumber: 2, raw: 'NO.018-NO.026 Collection', state: 'range', title: 'Collection', sourceOrder: 'NO.018-NO.026', range: { first: 18, last: 26, count: 9 }, diagnostics: ['不展开为作品或文件名'] }, { key: 'line-3', lineNumber: 3, raw: '<img src=x onerror=alert(1)>', state: 'unknown', title: 'Unknown', diagnostics: ['原文保留'] }], links: [], entryMappings: []
});
const confirmed = () => ({ ...record(), identityState: 'confirmed' as const, creatorId: 17 });
const link = (kind: 'batch' | 'exact' = 'batch'): SourceEvidenceLink => ({ id: 3, observationId: 45, creatorId: 17, workId: 90, localWorkId: 12, planId: 'synthetic-admission', itemKey: 'first', key: 'fixed', reason: '用户确认', entryKey: kind === 'exact' ? 'line-1' : null, createdAt: '2026-01-01', kind, sourceWorkId: kind === 'exact' ? 61 : null, identityDecisionId: null });
const button = (wrapper: ReturnType<typeof mount>, text: string) => wrapper.findAll('button').find(item => item.text() === text)!;
async function expand(wrapper: ReturnType<typeof mount>) { (wrapper.get('details.source-evidence').element as HTMLDetailsElement).open = true; await wrapper.get('details.source-evidence').trigger('toggle'); await flushPromises(); }
async function openDetail(value = record()) { vi.mocked(api.fetchSourceEvidenceDetail).mockResolvedValue(value); const wrapper = mount(SourceEvidencePanel, { props: { creator: { id: 17, name: 'Synthetic creator' } } }); await expand(wrapper); await wrapper.get('.evidence-list button').trigger('click'); await flushPromises(); return wrapper; }
async function fillManual(wrapper: ReturnType<typeof mount>) { await button(wrapper, '手工登记来源资料').trigger('click'); const form = wrapper.get('form[aria-label="手工登记来源资料"]'); const inputs = form.findAll('input'); await inputs[0]!.setValue('sndiary'); await inputs[1]!.setValue('https://example.test/manual'); await inputs[2]!.setValue('Manual evidence'); const textareas = form.findAll('textarea'); await textareas[0]!.setValue('无编号但保留的目录'); await textareas[2]!.setValue('已手工解压，未移动'); return form; }

describe('compact creator-scoped source evidence panel', () => {
  enableAutoUnmount(afterEach);
  beforeEach(() => {
    vi.clearAllMocks(); sessionStorage.clear();
    vi.mocked(api.fetchSourceEvidence).mockResolvedValue({ items: [record()], total: 1, page: 1, limit: 20 });
    vi.mocked(api.fetchSourceEvidenceDetail).mockResolvedValue(record());
    vi.mocked(api.saveSourceEvidence).mockResolvedValue({ ok: true, recorded: true, observation: record() });
    vi.mocked(api.confirmSourceEvidenceIdentity).mockResolvedValue({ ok: true, observation: confirmed() });
    vi.mocked(api.linkSourceEvidenceWork).mockResolvedValue({ ok: true, link: link() });
    vi.mocked(api.mapSourceEvidenceEntry).mockResolvedValue({ ok: true, mapping: link('exact') });
  });
  it('does not query until expanded, scopes every read, and renders untrusted evidence only as text', async () => {
    const wrapper = mount(SourceEvidencePanel, { props: { creator: { id: 17, name: 'Synthetic creator' } } });
    expect(api.fetchSourceEvidence).not.toHaveBeenCalled();
    await expand(wrapper); expect(api.fetchSourceEvidence).toHaveBeenCalledExactlyOnceWith(17, 1);
    await wrapper.get('.evidence-list button').trigger('click'); await flushPromises();
    expect(api.fetchSourceEvidenceDetail).toHaveBeenCalledWith(45);
    expect(wrapper.text()).toContain('18～26（9 个编号，不等于独立作品）');
    expect(wrapper.text()).toContain('部分资料 · 非完整核验');
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
    expect(wrapper.findAll('a,img,script,iframe')).toHaveLength(0);
    expect(api.saveSourceEvidence).not.toHaveBeenCalled();
  });
  it('saves a manual observation without inventing a Work, mapping, or task', async () => {
    const wrapper = await openDetail(); const form = await fillManual(wrapper); await form.trigger('submit'); await flushPromises();
    expect(api.saveSourceEvidence).toHaveBeenCalledExactlyOnceWith({ creatorId: 17, requestId: expect.any(String), record: { platform: 'sndiary', pageUrl: 'https://example.test/manual', pageTitle: 'Manual evidence', method: 'manual', rawDirectoryText: '无编号但保留的目录', notes: '已手工解压，未移动', resourceEntries: [], completeness: 'partial' } });
    expect(wrapper.text()).toContain('来源资料已保存');
    expect(api.confirmSourceEvidenceIdentity).not.toHaveBeenCalled(); expect(api.linkSourceEvidenceWork).not.toHaveBeenCalled();
  });
  it('blocks input Enter implicit saves while preserving IME, multiline entry and explicit button submission', async () => {
    const wrapper = await openDetail(); const form = await fillManual(wrapper);
    const enter = (target: Element, options: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
      target.dispatchEvent(event); return event.defaultPrevented;
    };
    for (const input of form.findAll('input')) expect(enter(input.element)).toBe(true);
    expect(enter(form.get('input').element, { isComposing: true })).toBe(false);
    expect(enter(form.get('input').element, { keyCode: 229 })).toBe(false);
    for (const textarea of form.findAll('textarea')) expect(enter(textarea.element)).toBe(false);
    expect(enter(form.get('button[type=submit]').element)).toBe(false);
    expect(api.saveSourceEvidence).not.toHaveBeenCalled();
    form.element.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.get('button[type=submit]').element as HTMLButtonElement })); await flushPromises();
    expect(api.saveSourceEvidence).toHaveBeenCalledTimes(1);
  });
  it('preserves unknown save receipt across return and retransmits the exact original request', async () => {
    const wrapper = await openDetail(); const form = await fillManual(wrapper);
    vi.mocked(api.saveSourceEvidence).mockRejectedValueOnce(new Error('Response lost'));
    await form.trigger('submit'); await flushPromises();
    const original = JSON.parse(JSON.stringify(vi.mocked(api.saveSourceEvidence).mock.calls[0]![0]));
    expect(form.get('fieldset').attributes('disabled')).toBeDefined();
    wrapper.unmount();
    const returned = mount(SourceEvidencePanel, { props: { creator: { id: 17, name: 'Synthetic creator' } } }); await expand(returned);
    expect(returned.text()).toContain('保存回执尚未确认');
    expect((returned.get('form[aria-label="手工登记来源资料"] input').element as HTMLInputElement).value).toBe('sndiary');
    await returned.get('form[aria-label="手工登记来源资料"]').trigger('submit'); await flushPromises();
    expect(vi.mocked(api.saveSourceEvidence).mock.calls[1]![0]).toEqual(original);
    expect(sessionStorage.getItem('cosgallery:source-evidence:pending:17')).toBeNull();
  });
  it('rejects a credential paste before storage or network submission, including an unsafe old pending draft', async () => {
    const wrapper = await openDetail(); const form = await fillManual(wrapper);
    await form.findAll('textarea')[0]!.setValue('Cookie: synthetic-private-value'); await form.trigger('submit'); await flushPromises();
    expect(api.saveSourceEvidence).not.toHaveBeenCalled(); expect(sessionStorage.getItem('cosgallery:source-evidence:pending:17')).toBeNull();
    expect(wrapper.get('[role=alert]').text()).toContain('疑似会话凭据');
    wrapper.unmount();
    sessionStorage.setItem('cosgallery:source-evidence:pending:17', JSON.stringify({ save: { creatorId: 17, requestId: 'old', record: { platform: 'manual', method: 'manual', pageUrl: 'https://example.test/?pwd=synthetic', pageTitle: 'Page', rawDirectoryText: '', notes: '', resourceEntries: [] } } }));
    const returned = mount(SourceEvidencePanel, { props: { creator: { id: 17, name: 'Synthetic creator' } } });
    expect(sessionStorage.getItem('cosgallery:source-evidence:pending:17')).not.toContain('synthetic');
    await expand(returned); expect(api.saveSourceEvidence).not.toHaveBeenCalled();
  });
  it('separates explicit page identity confirmation from Work identity and refuses conflict override', async () => {
    const wrapper = await openDetail(); const form = wrapper.get('form[aria-label="确认具体页面归属"]');
    await form.trigger('submit'); expect(api.confirmSourceEvidenceIdentity).not.toHaveBeenCalled();
    await form.get('textarea').setValue('核对本页资料与规范博主'); await form.get('input[type=checkbox]').setValue(true); await form.trigger('submit'); await flushPromises();
    expect(api.confirmSourceEvidenceIdentity).toHaveBeenCalledWith(45, { creatorId: 17, requestId: expect.any(String), expectedRevision: 1, reason: '核对本页资料与规范博主' });
    expect(wrapper.text()).toContain('仅确认当前来源证据的博主归属');
    wrapper.unmount(); const conflict = await openDetail({ ...record(), identityState: 'conflict', identityReason: '页面已绑定另一博主' });
    expect(conflict.find('form[aria-label="确认具体页面归属"]').exists()).toBe(false);
    expect(conflict.find('form[aria-label="准备本地接纳预览"]').exists()).toBe(false);
    expect(conflict.text()).toContain('不允许在这里强制改绑');
  });
  it('keeps saved evidence visible when a refresh fails instead of claiming an empty list', async () => {
    const wrapper = await openDetail(); vi.mocked(api.fetchSourceEvidence).mockRejectedValueOnce(new Error('Read failed'));
    await button(wrapper, '刷新资料').trigger('click'); await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toBe('Read failed');
    expect(wrapper.find('.evidence-detail').exists()).toBe(true); expect(wrapper.findAll('.evidence-list li')).toHaveLength(1);
  });
  it('does not let a late list replace the newly selected creator and does not fetch all evidence', async () => {
    const wrapper = mount(SourceEvidencePanel, { props: { creator: { id: 17, name: 'First creator' } } });
    let resolveList!: (value: Awaited<ReturnType<typeof api.fetchSourceEvidence>>) => void;
    vi.mocked(api.fetchSourceEvidence).mockReturnValueOnce(new Promise(resolve => { resolveList = resolve; }));
    await expand(wrapper);
    vi.mocked(api.fetchSourceEvidence).mockResolvedValue({ items: [{ ...record(46, 18), pageTitle: 'Current creator evidence' }], total: 1, page: 1, limit: 20 });
    await wrapper.setProps({ creator: { id: 18, name: 'Second creator' } }); await flushPromises();
    resolveList({ items: [{ ...record(), pageTitle: 'Late first creator evidence' }], total: 1, page: 1, limit: 20 }); await flushPromises();
    expect(wrapper.text()).toContain('Current creator evidence'); expect(wrapper.text()).not.toContain('Late first creator evidence');
    expect(vi.mocked(api.fetchSourceEvidence).mock.calls.map(call => call[0])).toEqual([17, 18]);
  });
  it('isolates late list, detail, and mutation responses when the creator changes', async () => {
    const wrapper = await openDetail(); let resolveDetail!: (value: SourceEvidenceObservation) => void;
    vi.mocked(api.fetchSourceEvidenceDetail).mockReturnValueOnce(new Promise(resolve => { resolveDetail = resolve; }));
    await wrapper.get('.evidence-list button').trigger('click');
    vi.mocked(api.fetchSourceEvidence).mockResolvedValue({ items: [record(46, 18)], total: 1, page: 1, limit: 20 });
    await wrapper.setProps({ creator: { id: 18, name: 'Other creator' } }); await flushPromises();
    resolveDetail({ ...record(), pageTitle: 'Late old detail' }); await flushPromises();
    expect(wrapper.text()).not.toContain('Late old detail'); expect(wrapper.text()).toContain('#18 Other creator');
    const form = await fillManual(wrapper); let resolveSave!: (value: Awaited<ReturnType<typeof api.saveSourceEvidence>>) => void;
    vi.mocked(api.saveSourceEvidence).mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve; }));
    await form.trigger('submit'); await flushPromises();
    vi.mocked(api.fetchSourceEvidence).mockResolvedValue({ items: [record(47, 19)], total: 1, page: 1, limit: 20 });
    await wrapper.setProps({ creator: { id: 19, name: 'Third creator' } }); await flushPromises();
    resolveSave({ ok: true, recorded: true, observation: { ...record(46, 18), pageTitle: 'Late old save' } }); await flushPromises();
    expect(wrapper.text()).not.toContain('Late old save'); expect(wrapper.text()).not.toContain('来源资料已保存');
  });
  it('exports a usable unconfirmed scope with default acceptance false and no per-item JSON entry', async () => {
    const wrapper = await openDetail(confirmed()); const blobs: Blob[] = [];
    vi.stubGlobal('URL', class extends URL { static createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:scope'; } static revokeObjectURL() {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const form = wrapper.get('form[aria-label="准备本地接纳预览"]');
    await form.get('input:not([type=checkbox])').setValue('C:\\isolated\\prepared'); await form.get('textarea').setValue('First album\nSecond album');
    expect((form.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false);
    await form.trigger('submit'); await flushPromises();
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blobs[0]!); });
    expect(JSON.parse(text)).toEqual({ creatorId: 17, sourceEvidenceId: 45, inputRoot: 'C:\\isolated\\prepared', directories: ['First album', 'Second album'], localOnly: false, acceptExistingVersion: false, confirmed: false });
    expect(click).toHaveBeenCalledTimes(1); expect(api.linkSourceEvidenceWork).not.toHaveBeenCalled();
    click.mockRestore(); vi.unstubAllGlobals();
  });
  it('links an existing Work as batch provenance without pretending to satisfy a source or changing a plan', async () => {
    const wrapper = await openDetail(confirmed()); const form = wrapper.get('form[aria-label="后补已有作品批次来源"]');
    const inputs = form.findAll('input'); await inputs[0]!.setValue(90); await inputs[1]!.setValue(12); await form.get('textarea').setValue('本批来自该页面'); await form.get('input[type=checkbox]').setValue(true);
    vi.mocked(api.fetchSourceEvidenceDetail).mockResolvedValue({ ...confirmed(), links: [link()] });
    await form.trigger('submit'); await flushPromises();
    expect(api.linkSourceEvidenceWork).toHaveBeenCalledWith(45, { creatorId: 17, workId: 90, localWorkId: 12, key: expect.any(String), reason: '本批来自该页面' });
    expect(wrapper.text()).toContain('Work #90'); expect(wrapper.text()).toContain('未修改原计划、移动文件或满足任务');
  });
  it('maps a particular parsed entry to the existing Work and distinct SourceWork IDs only after explicit review', async () => {
    const wrapper = await openDetail(confirmed()); const form = wrapper.get('form[aria-label="确认已有作品条目对应"]');
    await form.get('select').setValue('line-1'); const inputs = form.findAll('input'); await inputs[0]!.setValue(90); await inputs[1]!.setValue(61); await form.get('textarea').setValue('已核对具体内容');
    await form.trigger('submit'); expect(api.mapSourceEvidenceEntry).not.toHaveBeenCalled();
    await form.get('input[type=checkbox]').setValue(true); vi.mocked(api.fetchSourceEvidenceDetail).mockResolvedValue({ ...confirmed(), entryMappings: [link('exact')] });
    await form.trigger('submit'); await flushPromises();
    expect(api.mapSourceEvidenceEntry).toHaveBeenCalledWith(45, { creatorId: 17, entryKey: 'line-1', workId: 90, sourceWorkId: 61, key: expect.any(String), reason: '已核对具体内容' });
    expect(wrapper.text()).toContain('SourceWork #61'); expect(wrapper.text()).toContain('未接受来源版本');
  });
  it('shows authoritative conflict errors without reporting a successful identity change', async () => {
    const wrapper = await openDetail(); const form = wrapper.get('form[aria-label="确认具体页面归属"]'); await form.get('textarea').setValue('Review'); await form.get('input[type=checkbox]').setValue(true);
    vi.mocked(api.confirmSourceEvidenceIdentity).mockRejectedValueOnce(new RequestError('证据版本已变化，请刷新', 409));
    await form.trigger('submit'); await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('证据版本已变化'); expect(wrapper.text()).not.toContain('仅确认当前来源证据的博主归属；');
    expect(wrapper.find('form[aria-label="准备本地接纳预览"]').exists()).toBe(false);
  });
});
