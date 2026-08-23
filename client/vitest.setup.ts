import { config } from '@vue/test-utils';
import { afterEach } from 'vitest';

import { DEFAULT_LOCALE, i18n, syncDocumentLanguage } from './src/locales';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    }
  };
}

if (
  !window.localStorage ||
  typeof window.localStorage.clear !== 'function' ||
  typeof window.localStorage.getItem !== 'function'
) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createMemoryStorage()
  });
}

if (!globalThis.matchMedia) {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })
  });
}

if (!globalThis.ResizeObserver) {
  class MockResizeObserver {
    observe() {}

    unobserve() {}

    disconnect() {}
  }

  globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
}

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(Date.now()), 0);
}

if (!globalThis.cancelAnimationFrame) {
  globalThis.cancelAnimationFrame = (handle: number) => {
    window.clearTimeout(handle);
  };
}

Object.defineProperty(globalThis, 'scrollTo', {
  writable: true,
  value: () => {}
});

config.global.plugins = [...(config.global.plugins ?? []), i18n];

afterEach(() => {
  window.localStorage.clear();
  i18n.global.locale.value = DEFAULT_LOCALE;
  syncDocumentLanguage(DEFAULT_LOCALE);
});
