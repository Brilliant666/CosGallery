import { describe, expect, it } from 'vitest';

import { formatCosGalleryWorkLabel } from './cos-gallery-titles';

function work(overrides: Record<string, unknown> = {}) {
  return {
    postType: 'carousel' as const,
    caption: 'rua阮阮 小狗爱神',
    ...overrides
  };
}

describe('formatCosGalleryWorkLabel', () => {
  it('shows the structured caption imported from archive metadata', () => {
    expect(formatCosGalleryWorkLabel(work())).toBe('rua阮阮 小狗爱神');
  });

  it('does not infer labels from ordinary posts or missing metadata', () => {
    expect(formatCosGalleryWorkLabel(work({ postType: 'single' }))).toBeNull();
    expect(formatCosGalleryWorkLabel(work({ caption: null }))).toBeNull();
  });
});
