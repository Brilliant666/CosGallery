import type { ObjectDirective } from 'vue';

interface DialogControls { close: () => void; locked: boolean }
interface DialogState { controls: DialogControls; previous: HTMLElement | null; cleanup: () => void }
const dialogs = new WeakMap<HTMLElement, DialogState>();

function focusable(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')].filter(element => {
    if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false;
    for (let node: HTMLElement | null = element; node && node !== dialog; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (node instanceof HTMLDetailsElement && !node.open && !node.querySelector(':scope > summary')?.contains(element)) return false;
    }
    return true;
  });
}

// Local confirmation overlays retain their original business state; this directive
// only owns keyboard focus while the connected dialog is visible.
export const vAdmissionDialog: ObjectDirective<HTMLElement, DialogControls> = {
  mounted(element, binding) {
    element.tabIndex = -1;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const state: DialogState = { controls: binding.value, previous, cleanup: () => undefined };
    const active = () => element.isConnected && !element.closest('[hidden], [inert]');
    const onKey = (event: KeyboardEvent) => {
      if (!active()) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!state.controls.locked) state.controls.close();
      } else if (event.key === 'Tab') {
        const items = focusable(element), first = items[0], last = items[items.length - 1];
        if (!first) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === element || !element.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element || !element.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (active() && !element.contains(event.target as Node)) element.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    state.cleanup = () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
    };
    dialogs.set(element, state);
    queueMicrotask(() => { if (active() && dialogs.has(element)) element.focus({ preventScroll: true }); });
  },
  updated(element, binding) { const state = dialogs.get(element); if (state) state.controls = binding.value; },
  beforeUnmount(element) {
    const state = dialogs.get(element);
    state?.cleanup(); dialogs.delete(element);
    if (state?.previous?.isConnected && element.contains(document.activeElement)) state.previous.focus({ preventScroll: true });
  }
};
