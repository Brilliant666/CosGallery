import { describe, it, expect } from 'vitest';
import { extractWorkDisplayTitle, normalizeWorkTitle } from '../src/utils/work-title.js';

describe('conservative shared work titles', () => {
  it('strips only known creator, outer numbering and media packaging', () => {
    expect(extractWorkDisplayTitle('Synthetic NO.032 Blue Theme 2 (Night) [31P-80MB]', ['Synthetic'])).toBe('Blue Theme 2 (Night)');
    expect(normalizeWorkTitle('Ｓｙｎｔｈｅｔｉｃ　ＶＯＬ．０２　Blue\tTheme 2 (Night) ［31P-80MB］', ['Synthetic'])).toBe('Blue Theme 2 (Night)');
  });
  it('preserves semantic subtitles, inner numbers, punctuation and unknown prefixes', () => {
    for (const title of ['Theme 2', 'Theme (Night)', 'Theme: Night', 'Theme-Night', 'Theme [Part 2]', 'Theme Vol.30', 'SyntheticOther Theme']) {
      expect(normalizeWorkTitle(title, ['Synthetic'])).toBe(title);
    }
    expect(normalizeWorkTitle('Unknown NO.032 Theme', ['Synthetic'])).toBe('Unknown NO.032 Theme');
    expect(normalizeWorkTitle('NO.032Theme')).toBe('NO.032Theme');
    expect(normalizeWorkTitle('Theme 2')).not.toBe(normalizeWorkTitle('Theme'));
    expect(normalizeWorkTitle('Theme (Night)')).not.toBe(normalizeWorkTitle('Theme'));
  });
});
