import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import html from '../index.html?raw';

const script = html.match(/<script id="fg-initial-theme">([\s\S]*?)<\/script>/)![1];

describe('theme before application startup', () => {
  it.each([
    ['light', true, 'light'], ['dark', false, 'dark'],
    [null, true, 'dark'], [null, false, 'light'],
    ['invalid', true, 'dark'], ['invalid', false, 'light']
  ])('saved %s / system dark %s resolves to %s', (saved, dark, expected) => {
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    const setItem = vi.fn();
    runInNewContext(script, { document, window: {
      localStorage: { getItem: (key: string) => { expect(key).toBe('foldergram-theme'); return saved; }, setItem },
      matchMedia: () => ({ matches: dark })
    } });
    expect(document.documentElement.dataset.theme).toBe(expected);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('falls back to system appearance when storage access is denied', () => {
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    runInNewContext(script, { document, window: {
      get localStorage() { throw new Error('Storage denied'); },
      matchMedia: () => ({ matches: false })
    } });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('sets the theme ahead of render-blocking styles and the splash markup', () => {
    expect(html.indexOf('id="fg-initial-theme"')).toBeLessThan(html.indexOf('rel="stylesheet"'));
    expect(html.indexOf('id="fg-initial-theme"')).toBeLessThan(html.indexOf('id="fg-splash"'));
  });
});
