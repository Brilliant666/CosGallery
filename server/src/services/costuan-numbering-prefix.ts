/** Syntactic outer-number evidence only; this does not establish creator identity. */
export function matchNamedCostuanNumberPrefix(value: string, rangeGuard = false): {rawLabel:string;start:number;end:number} | null {
  const match = /^([\p{L}][\p{L}\p{N}_.·-]*(?:[\t\p{Zs}]+[\p{L}][\p{L}\p{N}_.·-]*)*)[\t\p{Zs}]+(\d{3,4})(?!\d)/u.exec(value);
  if (!match || match[1].length > 64) return null;
  // Range ambiguity detection also preserves the legacy attached-title boundary.
  // It must not lose an earlier number merely because no space precedes '['.
  const tail=value.slice(match[0].length);
  if (!/^[\t\p{Zs}]+\S/u.test(tail) && !(rangeGuard && /^[.\[【]/u.test(tail))) return null;
  const words = match[1].split(/[\t\p{Zs}]+/u);
  // NO/VOL tokens belong to explicit numbering, never to a multiword name.
  if (words.length > 8 || words.some(word => /^(?:NO|VOL)(?:[._·-]*\d|[._·-]*$)/iu.test(word))) return null;
  return {rawLabel:match[2],start:match[0].length-match[2].length,end:match[0].length};
}
