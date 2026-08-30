import { describe, expect, it } from 'vitest';

import { formatCosGalleryWorkLabel } from './cos-gallery-titles';

function work(overrides: Record<string, unknown> = {}) {
  return {
    postType: 'carousel' as const,
    folderName: 'rua阮阮',
    carouselTitle: 'rua阮阮 013 小狗爱神1.0[21P-42M]',
    sourcePath: 'rua阮阮/rua阮阮 013 小狗爱神1.0[21P-42M]',
    ...overrides
  };
}

describe('formatCosGalleryWorkLabel', () => {
  it('shows the creator id and a cleaned work title', () => {
    expect(formatCosGalleryWorkLabel(work())).toBe('rua阮阮 小狗爱神');
  });

  it('supports NO-prefixed work numbers and creator aliases', () => {
    expect(
      formatCosGalleryWorkLabel(
        work({
          folderName: '小小奶瓶儿',
          carouselTitle: '小小奶瓶儿@虎牙 - NO.003 生日限定仙女兔[23P-1V-176.5M]'
        })
      )
    ).toBe('小小奶瓶儿 生日限定仙女兔');
  });

  it('falls back to the source folder name', () => {
    expect(
      formatCosGalleryWorkLabel(
        work({
          folderName: 'lunananya',
          carouselTitle: null,
          sourcePath: 'lunananya/lunana NO.002 谷風天音 [36P-309MB]'
        })
      )
    ).toBe('lunananya 谷風天音');
  });

  it('does not label ordinary posts or unrelated carousels', () => {
    expect(formatCosGalleryWorkLabel(work({ postType: 'single' }))).toBeNull();
    expect(formatCosGalleryWorkLabel(work({ carouselTitle: 'Summer holiday' }))).toBeNull();
  });
});
