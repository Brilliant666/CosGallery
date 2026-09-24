import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import ApplicationRecoveryPanel from './ApplicationRecoveryPanel.vue';
import { useAuthStore } from '../stores/auth';
import { createApplicationRecoveryPoint, fetchApplicationRecoveryStatus, type ApplicationRecoveryStatus } from '../api/application-recovery';
vi.mock('../api/application-recovery', () => ({ createApplicationRecoveryPoint: vi.fn(), fetchApplicationRecoveryStatus: vi.fn() }));
const status = (): ApplicationRecoveryStatus => ({ backupRoot: 'C:/isolated/data_backup', automatic: { enabled: false, intervalHours: 24, retainDaily: 7, retainWeekly: 4 }, active: null, latestSuccess: null, lastFailure: null, points: [] });
const wrappers: ReturnType<typeof mount>[] = [];
function render() { const w = mount(ApplicationRecoveryPanel); wrappers.push(w); return w; }
function button(w: ReturnType<typeof mount>, text: string) { return w.findAll('button').find(b => b.text().includes(text))!; }
beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); vi.mocked(fetchApplicationRecoveryStatus).mockResolvedValue(status()); });
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.useRealTimers(); });

describe('application recovery settings', () => {
  it('loads metadata only and never creates on opening or refresh', async () => {
    const w = render(); await flushPromises();
    expect(w.text()).toContain('C:/isolated/data_backup'); expect(w.text()).toContain('未启用');
    await button(w, '刷新状态').trigger('click'); await flushPromises();
    expect(fetchApplicationRecoveryStatus).toHaveBeenCalledTimes(2); expect(createApplicationRecoveryPoint).not.toHaveBeenCalled();
    expect(w.find('a[download]').exists()).toBe(false);
  });
  it('creates once, keeps running after leaving, and resumes status on return without replay', async () => {
    vi.useFakeTimers();
    const active = { ...status(), active: { id: 'run', startedAt: new Date().toISOString(), reason: 'manual' } };
    vi.mocked(createApplicationRecoveryPoint).mockResolvedValue(active);
    const w = render(); await flushPromises(); await button(w, '立即创建恢复点').trigger('click'); await flushPromises();
    expect(w.text()).toContain('后台创建中'); expect(button(w, '正在创建').attributes('disabled')).toBeDefined();
    w.unmount(); vi.mocked(fetchApplicationRecoveryStatus).mockResolvedValue(active);
    const returned = render(); await flushPromises(); expect(returned.text()).toContain('后台创建中');
    vi.mocked(fetchApplicationRecoveryStatus).mockResolvedValue(status()); await vi.advanceTimersByTimeAsync(2100); await flushPromises();
    expect(returned.text()).not.toContain('后台创建中'); expect(createApplicationRecoveryPoint).toHaveBeenCalledTimes(1);
  });
  it('does not retry failed creation and preserves the previous successful point', async () => {
    const point = { id:'one', status:'success' as const, reason:'manual', startedAt:'2026-01-01T00:00:00Z', completedAt:'2026-01-01T00:00:01Z', schemaVersions:['000027'], codeVersion:'abc', instanceId:'isolated', files:[], configuration:{complete:false,gaps:['missing_run_config']},validation:{integrity:'ok' as const,foreignKeys:0,tables:50},timings:{backupMs:1,validationMs:2,totalMs:3},bytes:1024 };
    vi.mocked(fetchApplicationRecoveryStatus).mockResolvedValue({...status(),latestSuccess:point,points:[point]});
    vi.mocked(createApplicationRecoveryPoint).mockRejectedValue(new Error('空间不足'));
    const w=render(); await flushPromises(); await button(w,'立即创建恢复点').trigger('click'); await flushPromises();
    expect(w.text()).toContain('空间不足'); expect(w.text()).toContain('one'); expect(w.text()).toContain('missing_run_config');
    expect(createApplicationRecoveryPoint).toHaveBeenCalledTimes(1);
  });
  it('ignores late reads after access loss and does not expose protected metadata', async () => {
    let resolve!: (v:ApplicationRecoveryStatus)=>void;
    vi.mocked(fetchApplicationRecoveryStatus).mockReturnValue(new Promise(r=>{resolve=r;}));
    const w=render(); await flushPromises(); useAuthStore().capabilities.canAccessSettings=false; await flushPromises();
    resolve(status()); await flushPromises(); expect(w.text()).not.toContain('C:/isolated'); expect(w.find('button').exists()).toBe(false);
  });
  it('does not request or create recovery points for a viewer', async () => {
    useAuthStore().capabilities.canAccessSettings=false; render(); await flushPromises();
    expect(fetchApplicationRecoveryStatus).not.toHaveBeenCalled(); expect(createApplicationRecoveryPoint).not.toHaveBeenCalled();
  });
});
