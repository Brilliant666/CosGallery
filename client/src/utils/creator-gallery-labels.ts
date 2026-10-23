import type { LocationQuery } from 'vue-router';
import type { CreatorGalleryLabel } from '../types/api';

export const creatorGalleryLabelOptions = [
  { value: 'cosplay', label: 'Cosplay' },
  { value: 'portrait', label: '写真' },
  { value: 'selfie', label: '自拍' },
  { value: 'fuliji', label: '福利姬' }
] as const;

export function parseCreatorGalleryLabel(value: unknown): CreatorGalleryLabel | undefined {
  return creatorGalleryLabelOptions.find(option => option.value === value)?.value;
}

// Apply the same public navigation contract to list, creator and viewer URLs.
export function sanitizedGalleryQuery(query: LocationQuery, allowPreference: boolean): LocationQuery {
  const result = { ...query };
  const label = parseCreatorGalleryLabel(query.label);
  if (query.label !== undefined && !label) delete result.label;
  if (label) delete result.rating;
  if (!allowPreference) delete result.preference;
  if (typeof result.returnTo === 'string' && /^\/library(?:\?|$)/u.test(result.returnTo)) {
    const legacy = new URL(result.returnTo, 'http://library.invalid');
    if (!allowPreference) legacy.searchParams.delete('preference');
    if (label || parseCreatorGalleryLabel(legacy.searchParams.get('label'))) legacy.searchParams.delete('rating');
    result.returnTo = legacy.pathname + legacy.search;
  }
  return result;
}

export function isGalleryReadingRoute(name: unknown): boolean {
  return name === 'library' || name === 'canonical-creator' || name === 'canonical-work-gallery';
}
