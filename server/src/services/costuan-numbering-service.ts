export type CostuanNumberingScheme = 'NO' | 'VOL' | 'SPECIAL';

export type ParsedCostuanNumbering = {
  scheme: CostuanNumberingScheme;
  order: number | null;
  key: string;
  canonicalLabel: string;
  rawLabel: string;
  qualifier: string | null;
  start: number;
  end: number;
  style: 'explicit' | 'implicit' | 'leading' | 'special';
};

export type ParsedCostuanDirectoryWork = {
  order?: number;
  sourceOrder: string;
  sourceOrderRaw: string;
  sourceOrderScheme: CostuanNumberingScheme;
  sourceOrderKey: string;
  label: string;
  rawTitle: string;
  mediaSummary: string;
  declaredImageCount: number | null;
  declaredVideoCount: number | null;
  declaredSize: string | null;
};

type ExistingCostuanWork = {
  order?: number;
  sourceOrder: string;
  sourceOrderRaw?: string;
  sourceOrderScheme?: CostuanNumberingScheme;
  sourceOrderKey?: string;
  label: string;
  rawTitle?: string;
  mediaSummary?: string;
  declaredImageCount?: number | null;
  declaredVideoCount?: number | null;
  declaredSize?: string | null;
  [key: string]: unknown;
};

function padOrder(order: number): string {
  return String(order).padStart(3, '0');
}

function stableSpecialKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s_.\-–—:：·・]+/gu, '');
}

function explicitMatch(value: string): ParsedCostuanNumbering | null {
  const match = /(?:^|[^A-Za-z0-9])((NO|VOL)[\s._\-–—]*(\d{1,4}))(?!\d)/iu.exec(value);
  if (!match) return null;

  const order = Number(match[3]);
  if (!Number.isInteger(order) || order < 0) return null;
  let start = (match.index ?? 0) + match[0].indexOf(match[1]);
  if (start > 0 && /[_\-–—]/u.test(value[start - 1])) start -= 1;
  let end = start + match[1].length;
  if (start < (match.index ?? 0) + match[0].indexOf(match[1])) end += 1;
  let rawLabel = value.slice(start, end);
  let qualifier: string | null = null;
  const qualifierMatch = /^[\s._\-–—]*(增刊)(?![\p{L}\p{N}])/u.exec(value.slice(end));
  if (qualifierMatch) {
    qualifier = qualifierMatch[1];
    end += qualifierMatch[0].length;
    rawLabel = value.slice(start, end).trim();
  }

  const scheme = match[2].toLocaleUpperCase() as 'NO' | 'VOL';
  const canonicalBase = `${scheme}.${padOrder(order)}`;
  return {
    scheme,
    order,
    key: qualifier ? `${scheme}:${padOrder(order)}:${stableSpecialKey(qualifier)}` : `${scheme}:${padOrder(order)}`,
    canonicalLabel: qualifier ? `${canonicalBase} ${qualifier}` : canonicalBase,
    rawLabel,
    qualifier,
    start,
    end,
    style: 'explicit'
  };
}

function specialMatch(value: string): ParsedCostuanNumbering | null {
  const match = /(?:^|[^A-Za-z0-9])((?:NO|VOL)\s*增刊\s*[A-Za-z]*\s*\d*)/iu.exec(value);
  if (!match) return null;
  const rawLabel = match[1].trim();
  const stable = stableSpecialKey(rawLabel);
  if (!stable) return null;
  const start = (match.index ?? 0) + match[0].indexOf(match[1]);
  return {
    scheme: 'SPECIAL',
    order: null,
    key: `SPECIAL:${stable}`,
    canonicalLabel: rawLabel.normalize('NFKC').replace(/\s+/gu, ''),
    rawLabel,
    qualifier: null,
    start,
    end: start + match[1].length,
    style: 'special'
  };
}

function legacyNumericMatch(value: string): ParsedCostuanNumbering | null {
  const leading = /^(\d{3,4})(?=[^\d.\/-])/u.exec(value);
  const implicit = /(?:^|[\s_\-–—])(\d{3,4})(?=\s|[《【\[(])/u.exec(value);
  const match = leading ?? implicit;
  if (!match) return null;
  const order = Number(match[1]);
  if (!Number.isInteger(order) || order < 0) return null;
  const start = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
  return {
    scheme: 'NO',
    order,
    key: `NO:${padOrder(order)}`,
    canonicalLabel: `NO.${padOrder(order)}`,
    rawLabel: match[1],
    qualifier: null,
    start,
    end: start + match[1].length,
    style: leading ? 'leading' : 'implicit'
  };
}

export function parseCostuanNumbering(value: string): ParsedCostuanNumbering | null {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ');
  return explicitMatch(normalized) ?? specialMatch(normalized) ?? legacyNumericMatch(normalized);
}

function parseMediaDeclaration(rawTitle: string, mediaSummary: string): {
  declaredImageCount: number | null;
  declaredVideoCount: number | null;
  declaredSize: string | null;
} {
  const declaration = mediaSummary || rawTitle;
  const imageMatch = /(\d+)\s*P(?![\p{L}\p{N}])/iu.exec(declaration);
  const videoMatch = /(\d+)\s*V(?![\p{L}\p{N}])/iu.exec(declaration);
  const sizeMatches = [...declaration.matchAll(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|K|M|G|T)(?![\p{L}\p{N}])/giu)];
  const sizeMatch = sizeMatches.at(-1);
  return {
    declaredImageCount: imageMatch ? Number(imageMatch[1]) : null,
    declaredVideoCount: videoMatch ? Number(videoMatch[1]) : null,
    declaredSize: sizeMatch ? `${sizeMatch[1]}${sizeMatch[2].toLocaleUpperCase()}` : null
  };
}

export function parseCostuanDirectoryText(text: string): ParsedCostuanDirectoryWork[] {
  const normalized = String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u00a0/gu, ' ');
  const byKey = new Map<string, ParsedCostuanDirectoryWork>();

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim().replace(/\s+/gu, ' ');
    if (!line) continue;
    const rawTitle = line.replace(/^\d{4}[./-]\d{1,2}[./-]\d{1,2}更新[:：]?\s*/u, '').trim();
    if (!rawTitle) continue;
    const mediaMatch = /([\[【][^\]】]+[\]】])\s*$/u.exec(rawTitle);
    const mediaSummary = mediaMatch?.[1] ?? '';
    let numbering = parseCostuanNumbering(rawTitle);
    if (!numbering) {
      // A media declaration distinguishes an unnumbered work from collection
      // headings and prose. Its normalized title becomes a stable SPECIAL key.
      if (!mediaSummary || !/\d+\s*[PV](?![\p{L}\p{N}])/iu.test(mediaSummary)) continue;
      const unnumberedTitle = rawTitle.slice(0, mediaMatch?.index ?? rawTitle.length).trim();
      const stable = stableSpecialKey(unnumberedTitle);
      if (!stable) continue;
      numbering = {
        scheme: 'SPECIAL',
        order: null,
        key: `SPECIAL:${stable}`,
        canonicalLabel: `SPECIAL:${stable}`,
        rawLabel: '',
        qualifier: null,
        start: 0,
        end: 0,
        style: 'special'
      };
    }
    let label = rawTitle
      .slice(numbering.end || 0)
      .replace(/^[\s_\-–—:：]+/u, '')
      .replace(/\s*[\[【][^\]】]+[\]】]\s*$/u, '')
      .trim();
    if (numbering.style === 'leading') {
      label = label.replace(/^\S+\s+/u, '').trim();
    }
    if (!label && numbering.scheme === 'SPECIAL') {
      label = rawTitle.replace(/\s*[\[【][^\]】]+[\]】]\s*$/u, '').trim();
    }
    if (!label) continue;

    const media = parseMediaDeclaration(rawTitle, mediaSummary);
    const work: ParsedCostuanDirectoryWork = {
      sourceOrder: numbering.canonicalLabel,
      sourceOrderRaw: numbering.rawLabel,
      sourceOrderScheme: numbering.scheme,
      sourceOrderKey: numbering.key,
      label,
      rawTitle,
      mediaSummary,
      ...media
    };
    if (numbering.order !== null) work.order = numbering.order;
    // Costuan sometimes repeats an identifier in a later update. The last entry is authoritative.
    byKey.set(numbering.key, work);
  }

  return [...byKey.values()];
}

function canonicalizeExistingWork(work: ExistingCostuanWork): ExistingCostuanWork {
  const numbering = parseCostuanNumbering(work.sourceOrder)
    ?? (work.rawTitle ? parseCostuanNumbering(work.rawTitle) : null);
  if (!numbering) return work;
  const mediaSummary = work.mediaSummary ?? '';
  const media = parseMediaDeclaration(work.rawTitle ?? work.label, mediaSummary);
  return {
    ...work,
    ...(numbering.order === null ? {} : { order: numbering.order }),
    sourceOrder: numbering.canonicalLabel,
    sourceOrderRaw: work.sourceOrderRaw ?? numbering.rawLabel,
    sourceOrderScheme: numbering.scheme,
    sourceOrderKey: numbering.key,
    mediaSummary,
    declaredImageCount: work.declaredImageCount ?? media.declaredImageCount,
    declaredVideoCount: work.declaredVideoCount ?? media.declaredVideoCount,
    declaredSize: work.declaredSize ?? media.declaredSize
  };
}

export function mergeCostuanDirectoryWorks(
  works: ExistingCostuanWork[],
  resourceDirectoryText: string | null | undefined
): ExistingCostuanWork[] {
  const existingByKey = new Map<string, ExistingCostuanWork>();
  for (const work of works.map(canonicalizeExistingWork)) {
    const key = work.sourceOrderKey
      ?? parseCostuanNumbering(work.sourceOrder)?.key
      ?? `SPECIAL:${stableSpecialKey(work.sourceOrder || work.label)}`;
    existingByKey.set(key, work);
  }

  const parsed = parseCostuanDirectoryText(resourceDirectoryText ?? '');
  if (parsed.length === 0) return [...existingByKey.values()];
  const merged = new Map<string, ExistingCostuanWork>();
  for (const work of parsed) {
    merged.set(work.sourceOrderKey, {
      ...(existingByKey.get(work.sourceOrderKey) ?? {}),
      ...work
    });
  }
  for (const [key, work] of existingByKey) {
    if (!merged.has(key)) merged.set(key, work);
  }
  return [...merged.values()];
}

export type PendingCostuanSupplement = ParsedCostuanDirectoryWork & {status:'awaiting_review'};

/** Split only an explicitly advertised, unnumbered appendix; never relax numbered validation. */
export function splitCostuanCheckDirectory(title:string, works:ExistingCostuanWork[], text:string|undefined) {
  const merged=mergeCostuanDirectoryWorks(works,text);
  const supplementalContents:PendingCostuanSupplement[]=[];
  const numbered=merged.filter(work=>{
    const numbering=parseCostuanNumbering(work.sourceOrder);
    return numbering && numbering.order!==null;
  });
  const extras=merged.filter(work=>!numbered.includes(work));
  const declaration=title.normalize('NFKC').match(/\[\d+\s*套\s*\+\s*微博图\s*\]/u);
  if (!extras.length && !declaration) return {works:merged,supplementalContents};
  const creator=title.split(/\s*COS/iu)[0];
  const lines=String(text??'').split(/\r?\n/u).flatMap(line=>parseCostuanDirectoryText(line));
  const keys=lines.map(work=>work.sourceOrderKey);
  // The ordinary merge retains historical last-entry behavior. The new appendix
  // exception requires complete, unique raw evidence instead of trusting that merge.
  if (!declaration || extras.length!==1 || new Set(keys).size!==keys.length || lines.length!==merged.length
    || works.length!==numbered.length || works.some(work=>{
      const key=parseCostuanNumbering(work.sourceOrder)?.key;
      return !key || !numbered.some(item=>item.sourceOrderKey===key);
    })) {
    throw new Error('来源附加内容或编号目录尚未明确核验；保留原来源，需人工检查。');
  }
  const extra=extras[0];
  const raw=lines.find(work=>work.sourceOrderKey===extra.sourceOrderKey);
  if (!raw || raw.order!==undefined || normalizeCostuanTitle(raw.label)!==normalizeCostuanTitle(`${creator} 微博图`)
    || !raw.mediaSummary || numbered.some(work=>!keys.includes(work.sourceOrderKey!))) {
    throw new Error('来源附加内容身份不明确；未覆盖历史来源。');
  }
  supplementalContents.push({...raw,status:'awaiting_review'});
  return {works:numbered,supplementalContents};
}

export function normalizeCostuanTitle(value: string): string {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ')
    // Costuan has used both spellings for the same hosiery title. This is a
    // deterministic glyph normalization, not creator-specific fuzzy matching.
    .replace(/咝/gu, '丝')
    // Preserve the raw title separately while correcting a known literal
    // platform typo for exact title verification.
    .replace(/自怕/gu, '自拍')
    .replace(/\s*[\[【][^\]】]+[\]】]\s*$/u, '')
    .trim();
  const numbering = parseCostuanNumbering(normalized);
  const title = numbering ? normalized.slice(numbering.end) : normalized;
  return title
    .toLocaleLowerCase()
    .replace(/^[\s_\-–—:：]+/u, '')
    .replace(/[\s_\-–—:：·・.《》【】[\]()（）?!？!]+/gu, '');
}

function stripCreatorPrefix(value: string, creatorNames: string[]): string {
  const names = creatorNames
    .map(normalizeCostuanTitle)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const name of names) {
    if (value.startsWith(name)) return value.slice(name.length);
  }
  return value;
}

export function areCostuanTitlesCompatible(
  localTitle: string,
  remoteTitle: string,
  creatorNames: string[] = []
): boolean {
  const local = stripCreatorPrefix(normalizeCostuanTitle(localTitle), creatorNames);
  const remote = stripCreatorPrefix(normalizeCostuanTitle(remoteTitle), creatorNames);
  if (!local || !remote) return false;
  return local === remote || local.includes(remote) || remote.includes(local);
}
