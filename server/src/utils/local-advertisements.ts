/** User-confirmed image advertisements. Exact basenames, not an image wildcard.
 * Recognition never deletes files or rewrites an already confirmed admission plan.
 */
const knownImageNames = new Set(['492.jpg', '009-01.jpg', '252.jpg', '252.png', '101.1.jpg', '扫码获取更多列表网红COS作品写真.png'].map(name => name.toLowerCase()));

export function isKnownAdvertisementImage(relativePath: string): boolean {
  return knownImageNames.has(relativePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? '');
}

export function isAdmissionAdvertisementCandidate(entry: {relativePath:string;kind:string}): boolean {
  return entry.kind === 'other' && /\.(txt|url)$/i.test(entry.relativePath)
    || entry.kind === 'image' && isKnownAdvertisementImage(entry.relativePath);
}
