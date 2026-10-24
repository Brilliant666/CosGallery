import { defineComponent, ref } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import ConfirmDialog from './ConfirmDialog.vue';

enableAutoUnmount(afterEach);
afterEach(() => { document.body.innerHTML = ''; });

describe('confirmation keyboard recovery', () => {
  function openDialog() {
    return mount(defineComponent({
      components: { ConfirmDialog },
      setup: () => ({ open: ref(false), loading: ref(false), confirmed: ref(0) }),
      template: `<button data-open @click="open=true">Remove</button>
        <ConfirmDialog v-if="open" title="Move to trash?" message="The original can be restored."
          :loading="loading" @cancel="open=false" @confirm="confirmed++" />
        <button data-outside>Outside</button>`,
    }), { attachTo: document.body });
  }

  it('focuses the description, traps Tab, dismisses with Escape and returns to its opener without confirming', async () => {
    const wrapper = openDialog();
    const opener = wrapper.get('[data-open]');
    (opener.element as HTMLElement).focus();
    await opener.trigger('click'); await flushPromises();
    const dialog = wrapper.get('[role=dialog]');
    const [cancel, confirm] = dialog.findAll('button');
    expect(document.activeElement).toBe(dialog.element);
    expect(document.getElementById(dialog.attributes('aria-describedby'))?.textContent).toContain('restored');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(cancel.element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(confirm.element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(cancel.element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener.element);
    expect(wrapper.vm.confirmed).toBe(0);
  });

  it('keeps a pending operation visible for Escape, backdrop and cancel, then permits recovery', async () => {
    const wrapper = openDialog();
    await wrapper.get('[data-open]').trigger('click'); await flushPromises();
    wrapper.vm.loading = true; await flushPromises();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wrapper.getComponent(ConfirmDialog).trigger('click');
    await wrapper.get('[role=dialog] button').trigger('click');
    expect(wrapper.find('[role=dialog]').exists()).toBe(true);
    expect(wrapper.findAll('[role=dialog] button:disabled')).toHaveLength(2);
    (wrapper.get('[data-outside]').element as HTMLElement).focus();
    expect(document.activeElement).toBe(wrapper.get('[role=dialog]').element);
    wrapper.vm.loading = false; await flushPromises();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(true);
    await wrapper.get('[role=dialog] button').trigger('click');
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  });
});
