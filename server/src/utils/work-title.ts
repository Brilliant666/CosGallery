/** Conservative display normalization, never a permanent work identity or a fuzzy match. */
export function extractWorkDisplayTitle(name: string, creatorNames: readonly string[] = []): string {
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

/** The same conservative normalization is shared by local and source title comparison. */
export function normalizeWorkTitle(name: string, creatorNames: readonly string[] = []): string {
  return extractWorkDisplayTitle(name, creatorNames);
}
