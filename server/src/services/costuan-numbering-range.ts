import { matchNamedCostuanNumberPrefix } from './costuan-numbering-prefix.js';

/** A directory range is a coverage declaration, not a list of Works or files. */
export type CostuanNumberRange = {
  scheme: 'NO' | 'VOL'; first: number; last: number; count: number;
  key: string; canonicalLabel: string; rawLabel: string; start: number; end: number;
};

const normalize = (value: string): string => String(value ?? '').normalize('NFKC').replace(/\u00a0/gu, ' ');
// A dash followed by ordinary title text is not a range (NO.001 - 女仆).
const rangeStart = /(?:^|[^A-Za-z0-9])((NO|VOL)[\s._]*(\d+)\s*[-–—~～至]\s*(?=\d|NO\b|VOL\b|$))/iu;

function findRange(text: string): RegExpExecArray | null {
  const found = rangeStart.exec(text);
  if (!found) return null;
  const prefix = text.slice(0, found.index);
  // An already selected collection number wins over publisher numbering inside
  // the title (e.g. Maruemon 001 [ARTGRAVIA] Vol.150-151).
  const hasPriorNumber = /(?:^|[^A-Za-z0-9])(?:NO|VOL)[\s._]*\d+/iu.test(prefix)
    || /^(?:[\p{L}][\p{L}\p{N}_.·-]*\s+)?\d{3,4}(?=\s|[.\[【])/u.test(prefix)
    || matchNamedCostuanNumberPrefix(text,true);
  if (hasPriorNumber) {
    // Only a recognized publisher label makes the later VOL content metadata.
    // Another collection NO (or an unlabeled VOL) must never vanish silently.
    if (found[2].toUpperCase() === 'VOL' && /\[(?:ARTGRAVIA|DJAWA)\]\s*$/iu.test(prefix)) return null;
    throw new Error('同一来源条目存在前置编号和后置范围，编号归属有歧义。');
  }
  return found;
}

export function hasCostuanNumberRangeSyntax(value: string): boolean {
  return findRange(normalize(value)) !== null;
}

/**
 * Offsets refer to the NFKC-normalized input, like parseCostuanNumbering.
 * Recognized but invalid ranges throw: callers must not fall back to first NO.
 */
export function parseCostuanNumberRange(value: string): CostuanNumberRange | null {
  const text = normalize(value);
  const beginning = findRange(text);
  if (!beginning) return null;
  const start = beginning.index + beginning[0].indexOf(beginning[1]);
  const rest = text.slice(start);
  const match = /^(NO|VOL)[\s._]*(\d+)\s*[-–—~～至]\s*(?:(NO|VOL)[\s._]*)?(\d+)(?![A-Za-z0-9])/iu.exec(rest);
  if (!match) throw new Error('来源编号范围残缺或格式无效；不能降级为起始编号。');
  const scheme = match[1].toUpperCase() as 'NO' | 'VOL';
  const first = Number(match[2]), last = Number(match[4]);
  if (match[3] && match[3].toUpperCase() !== scheme) throw new Error('来源编号范围不能跨 NO/VOL 编号体系。');
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last > 9999 || first >= last) {
    throw new Error('来源编号范围必须为 1～9999 内严格递增的两个端点。');
  }
  const tail = rest.slice(match[0].length);
  if (/^\s*[-–—~～至]\s*(?:\d|NO\b|VOL\b)/iu.test(tail) || rangeStart.test(tail)) {
    throw new Error('同一来源条目包含多个编号范围，需明确分组。');
  }
  const lower = String(first).padStart(3, '0'), upper = String(last).padStart(3, '0');
  return { scheme, first, last, count: last - first + 1,
    key: `RANGE:${scheme}:${lower}-${upper}`, canonicalLabel: `${scheme}.${lower}-${scheme}.${upper}`,
    rawLabel: match[0], start, end: start + match[0].length };
}
