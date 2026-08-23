import { describe, expect, it } from 'vitest';

import { resolveDisplayCaption } from './caption';

describe('caption display fallback', () => {
  it('uses the safe carousel title when sourcePath is redacted', () => {
    expect(resolveDisplayCaption({
      filename: 'cover.jpg',
      caption: null,
      postType: 'carousel',
      carouselTitle: 'summer_trip'
    })).toBe('summer trip');
  });

  it('keeps sourcePath as the authenticated carousel fallback', () => {
    expect(resolveDisplayCaption({
      filename: 'cover.jpg',
      caption: null,
      postType: 'carousel',
      sourcePath: 'album/carousels/summer-trip'
    })).toBe('summer trip');
  });
});
