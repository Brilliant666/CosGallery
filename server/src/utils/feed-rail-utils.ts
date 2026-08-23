export type FeedRailKind = 'moments' | 'highlights';

export const MIN_IMAGES_FOR_MOMENTS = 24;
export const MIN_EXIF_IMAGES_FOR_MOMENTS = 18;
export const MIN_EXIF_COVERAGE_FOR_MOMENTS = 0.3;

export function shouldPreferMomentRail(totalImages: number, exifImages: number): boolean {
  if (totalImages < MIN_IMAGES_FOR_MOMENTS) {
    return false;
  }

  if (exifImages < MIN_EXIF_IMAGES_FOR_MOMENTS) {
    return false;
  }

  return exifImages / totalImages >= MIN_EXIF_COVERAGE_FOR_MOMENTS;
}
