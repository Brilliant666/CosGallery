import { mount } from '@vue/test-utils';
import { shallowRef } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import RouteLoadRecoveryDialog from './RouteLoadRecoveryDialog.vue';
import type { RouteLoadFailure } from '../utils/route-load-recovery';

describe('route load recovery prompt', () => {
  it('warns about unsubmitted choices and requires an explicit refresh; cancel is safe', async () => {
    const state = shallowRef<RouteLoadFailure | null>({ target: '/settings#tools', reason: 'version', retrying: false });
    const recovery = { state, reload: vi.fn(), retry: vi.fn(), cancel: vi.fn(() => { state.value = null; }), dispose: vi.fn() };
    const wrapper = mount(RouteLoadRecoveryDialog, { props: { recovery } });
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('未保存的目录选择');
    expect(wrapper.text()).toContain('刷新不会自动提交');
    expect(recovery.reload).not.toHaveBeenCalled();
    expect(wrapper.findAll('button')).toHaveLength(2);
    await wrapper.get('button').trigger('click');
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(recovery.reload).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('offers explicit retry for offline and unknown failures without release claims', async () => {
    const state = shallowRef<RouteLoadFailure | null>({ target: '/settings', reason: 'offline', retrying: false });
    const recovery = { state, reload: vi.fn(), retry: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
    const wrapper = mount(RouteLoadRecoveryDialog, { props: { recovery } });
    expect(wrapper.get('h2').text()).toBe('当前网络已离线');
    await wrapper.findAll('button')[1].trigger('click');
    expect(recovery.retry).toHaveBeenCalledOnce();
    state.value = { ...state.value!, reason: 'unknown' }; await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('已确认服务器');
    await wrapper.findAll('button')[2].trigger('click');
    expect(recovery.reload).toHaveBeenCalledOnce(); wrapper.unmount();
  });
});
