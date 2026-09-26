/** Shared title evidence, not a work ID. A creator-scoped unique exact match
 * still needs the caller's identity, local-version and conflict checks. */
export type ParsedWorkTitle = {
  readonly raw: string;
  readonly displayTitle: string;
  readonly exactKey: string;
  /** Lossy review suggestion only. Never authorize reuse, binding or fulfillment. */
  readonly candidateKey: string;
};

function displayTitle(name: string, creatorNames: readonly string[]): string {
  const normalized = name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  let title = normalized;
  for (const prefix of creatorNames.map(n => n.normalize('NFKC').replace(/\s+/gu, ' ').trim()).filter(Boolean).sort((a,b) => b.length-a.length)) {
    // Require a boundary: a creator name embedded in another word is not a prefix.
    if (title.startsWith(prefix) && /^\s/u.test(title.slice(prefix.length))) {
      title = title.slice(prefix.length).trim();
      break;
    }
  }
  title = title.replace(/^(?:NO\.?|VOL\.?)\s*\d+\s+/iu, '');
  title = title.replace(/\s*\[(?=[^\]]*\d)(?:\d+(?:\.\d+)?\s*(?:P|V|KB|MB|GB|TB|K|M|G|T)[\s+-]*)+\]\s*$/iu, '').trim();
  // Internal numbers, punctuation, subtitles and case are intentionally significant.
  return title || normalized;
}

function candidateKey(title: string, creatorNames: readonly string[]): string {
  let value = title.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const names = creatorNames.map(name => name.normalize('NFKC').replace(/\s+/gu, ''))
    .filter(Boolean).sort((a, b) => b.length - a.length);
  // Known names only: presentation spacing does not create or learn aliases.
  for (const name of names) {
    const pattern = [...name].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    value = value.replace(new RegExp(`(^|[\\s\\[\\]()])${pattern}(?=$|[\\s\\[\\]()])`, 'giu'), '$1');
  }
  value = value.replace(/\(\s*\)/gu, '').trim();
  value = value.replace(/^(?:(?:NO\.?|VOL\.?)\s*\d+|\d+)\s*(?:[-:：.、]\s*|\s+)/iu, '');
  value = value.replace(/\s*\[(?=[^\]]*\d)(?:\d+(?:\.\d+)?\s*(?:P|V|KB|MB|GB|TB|K|M|G|T)[\s+\-/]*)+\]\s*$/iu, '');
  return value.replace(/[\s\p{P}]/gu, '').toLocaleLowerCase('en-US');
}

/** All local/source identity consumers parse through this source-neutral contract.
 * Source-specific typo correction and numbered-directory verification stay outside it. */
export function parseWorkTitle(name: string, creatorNames: readonly string[] = []): ParsedWorkTitle {
  const title = displayTitle(name, creatorNames);
  return { raw: name, displayTitle: title, exactKey: title, candidateKey: candidateKey(name, creatorNames) };
}

/** Compatibility wrapper for local-admission display consumers. */
export function extractWorkDisplayTitle(name: string, creatorNames: readonly string[] = []): string {
  return parseWorkTitle(name, creatorNames).displayTitle;
}

/** Compatibility wrapper for conservative local/source exact comparison. */
export function normalizeWorkTitle(name: string, creatorNames: readonly string[] = []): string {
  return parseWorkTitle(name, creatorNames).exactKey;
}
