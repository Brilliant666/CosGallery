import { parseWorkTitle } from './work-title.js';

/** A lossy search key ONLY for review suggestions, never for identity/reuse.
 * External ordinal prefixes and presentation variants must not make a local
 * candidate disappear, but removing them cannot prove two works are the same.
 */
export function workTitleCandidateKey(title: string, creatorNames: readonly string[]): string {
  return parseWorkTitle(title, creatorNames).candidateKey;
}

export function isWorkTitleCandidate(left: string, right: string, creatorNames: readonly string[]): boolean {
  const leftTitle = parseWorkTitle(left, creatorNames), rightTitle = parseWorkTitle(right, creatorNames);
  const a = leftTitle.candidateKey, b = rightTitle.candidateKey;
  if (a && a === b) return true;
  // Keep the previous conservative subtitle/format suggestion boundary.
  const first = leftTitle.exactKey, second = rightTitle.exactKey;
  if ((first.match(/\d+/g) ?? []).join() !== (second.match(/\d+/g) ?? []).join()) return false;
  return first.replace(/[\s\p{P}]/gu, '') === second.replace(/[\s\p{P}]/gu, '') ||
    (Math.min(first.length, second.length) >= 4 && Math.min(first.length, second.length) / Math.max(first.length, second.length) >= 0.7 &&
      (first.includes(second) || second.includes(first)));
}
