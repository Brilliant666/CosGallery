/** User-confirmed ecytt02 image advertisements. Exact basenames, not a JPG wildcard.
 * Recognition never deletes files or rewrites an already confirmed admission plan.
 */
const knownImageNames = new Set(['492.jpg', '009-01.jpg']);

export function isKnownAdvertisementImage(relativePath: string): boolean {
  return knownImageNames.has(relativePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? '');
}

export function isAdmissionAdvertisementCandidate(entry: {relativePath:string;kind:string}): boolean {
  return entry.kind === 'other' && /\.(txt|url)$/i.test(entry.relativePath)
    || entry.kind === 'image' && isKnownAdvertisementImage(entry.relativePath);
}
