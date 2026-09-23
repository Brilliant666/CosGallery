import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { vAdmissionDialog } from './admission-dialog';

afterEach(() => { document.body.innerHTML = ''; });
describe('admission confirmation keyboard boundary', () => {
  it('contains Tab focus, closes with Escape, and returns to the originating action without submitting', async () => {
    const wrapper = mount(defineComponent({
      directives: { admissionDialog: vAdmissionDialog },
      setup() { return { open: ref(false), busy: ref(false), submitted: ref(0) }; },
      template: '<div><button data-open @click="open=true">确认页</button><section v-if="open" role="dialog" v-admission-dialog="{close:()=>open=false,locked:busy}"><button data-first @click="open=false">返回修改</button><button disabled>不可执行</button><button data-last @click="submitted++">执行</button></section><button>外部</button><span>{{submitted}}</span></div>'
    }), { attachTo: document.body });
    const opener = wrapper.get('[data-open]').element as HTMLElement; opener.focus();
    await wrapper.get('[data-open]').trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[role=dialog]').element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(wrapper.get('[data-first]').element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(wrapper.get('[data-last]').element);
    wrapper.vm.busy = true; await flushPromises();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(true);
    wrapper.vm.busy = false; await flushPromises();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(wrapper.get('span').text()).toBe('0'); wrapper.unmount();
  });
  it('does not dismiss a pending operation and ignores a detached cached dialog', async () => {
    const wrapper = mount(defineComponent({
      directives: { admissionDialog: vAdmissionDialog }, setup() { return { open: ref(true) }; },
      template: '<section v-if="open" role="dialog" v-admission-dialog="{close:()=>open=false,locked:true}">处理中</section>'
    }), { attachTo: document.body });
    await flushPromises(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(true);
    wrapper.element.remove();
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true }); document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); wrapper.unmount();
  });
});
