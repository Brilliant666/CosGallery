import { normalizeWorkTitle } from './work-title.js';

/** A lossy search key ONLY for review suggestions, never for identity/reuse.
 * External ordinal prefixes and presentation variants must not make a local
 * candidate disappear, but removing them cannot prove two works are the same.
 */
export function workTitleCandidateKey(title: string, creatorNames: readonly string[]): string {
  let value = title.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const names = creatorNames.map(name => name.normalize('NFKC').replace(/\s+/gu, ''))
    .filter(Boolean).sort((a, b) => b.length - a.length);
  // Match only an entire name token, allowing formatting spaces within a known
  // name. Do not learn an alias, strip unknown people, or touch names in words.
  for (const name of names) {
    const pattern = [...name].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    value = value.replace(new RegExp(`(^|[\\s\\[\\]()])${pattern}(?=$|[\\s\\[\\]()])`, 'giu'), '$1');
  }
  value = value.replace(/\(\s*\)/gu, '').trim();
  value = value.replace(/^(?:(?:NO\.?|VOL\.?)\s*\d+|\d+)\s*(?:[-:：.、]\s*|\s+)/iu, '');
  value = value.replace(/\s*\[(?=[^\]]*\d)(?:\d+(?:\.\d+)?\s*(?:P|V|KB|MB|GB|TB|K|M|G|T)[\s+\-/]*)+\]\s*$/iu, '');
  // Punctuation/case differences are suggestions too, not an exact match.
  return value.replace(/[\s\p{P}]/gu, '').toLocaleLowerCase('en-US');
}

export function isWorkTitleCandidate(left: string, right: string, creatorNames: readonly string[]): boolean {
  const a = workTitleCandidateKey(left, creatorNames), b = workTitleCandidateKey(right, creatorNames);
  if (a && a === b) return true;
  // Keep the previous conservative subtitle/format suggestion boundary.
  const first = normalizeWorkTitle(left, creatorNames), second = normalizeWorkTitle(right, creatorNames);
  if ((first.match(/\d+/g) ?? []).join() !== (second.match(/\d+/g) ?? []).join()) return false;
  return first.replace(/[\s\p{P}]/gu, '') === second.replace(/[\s\p{P}]/gu, '') ||
    (Math.min(first.length, second.length) >= 4 && Math.min(first.length, second.length) / Math.max(first.length, second.length) >= 0.7 &&
      (first.includes(second) || second.includes(first)));
}
