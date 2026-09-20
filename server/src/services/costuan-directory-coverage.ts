import { parseCostuanDirectoryText, parseCostuanNumbering } from './costuan-numbering-service.js';
import { parseCostuanNumberRange } from './costuan-numbering-range.js';

/** Check every representation; raw text must not conceal a range in works. */
export function analyzeCostuanRangeInput(text: string | undefined,
  works: Array<{sourceOrder:string;sourceOrderRaw?:string;rawTitle?:string;label:string}>, declaredCount: number | null) {
  const rawLines=(text ?? '').split(/\r?\n/u);
  const rawHasRange=rawLines.map(line=>parseCostuanNumberRange(line)).some(Boolean);
  const entryLines=works.map(work=>{
    const orderRange=parseCostuanNumberRange(work.sourceOrder);
    const titleRange=parseCostuanNumberRange(work.rawTitle ?? '');
    const rawOrderRange=parseCostuanNumberRange(work.sourceOrderRaw ?? '');
    return orderRange ? `${work.sourceOrder} ${work.label}` : titleRange ? work.rawTitle!
      : rawOrderRange ? `${work.sourceOrderRaw} ${work.label}` : `${work.sourceOrder} ${work.label}`;
  });
  const entriesHaveRange=entryLines.map(line=>parseCostuanNumberRange(line)).some(Boolean);
  if(!rawHasRange && !entriesHaveRange) return null;
  return analyzeCostuanDirectoryCoverage(rawHasRange ? text! : entryLines.join('\n'),declaredCount);
}

/** Read-only source evidence. Coverage never implies Work or archive identities. */
export function analyzeCostuanDirectoryCoverage(text: string, declaredCount: number | null) {
  const entries = text.split(/\r?\n/u).flatMap(line => parseCostuanDirectoryText(line));
  const numbered = entries.filter(entry => entry.range || entry.order !== undefined);
  const occupied = new Map<number, string[]>();
  const schemes = new Set<string>();
  for (const entry of numbered) {
    const numbering = parseCostuanNumbering(entry.sourceOrder)!;
    schemes.add(numbering.scheme);
    const first = entry.range?.first ?? entry.order!;
    const last = entry.range?.last ?? entry.order!;
    for (let number = first; number <= last; number++) {
      occupied.set(number, [...(occupied.get(number) ?? []), entry.sourceOrder]);
    }
  }
  const overlaps = [...occupied].filter(([, owners]) => owners.length > 1).map(([number, owners]) => ({ number, owners }));
  const missingNumbers = declaredCount !== null && Number.isInteger(declaredCount) && declaredCount > 0 && declaredCount <= 9999
    ? Array.from({ length: declaredCount }, (_, i) => i + 1).filter(number => !occupied.has(number)) : [];
  const outsideNumbers = [...occupied.keys()].filter(number => number < 1 || (declaredCount !== null && number > declaredCount));
  return {
    rawEntryCount: entries.length,
    numberedEntryCount: numbered.length,
    singleEntryCount: numbered.filter(entry => !entry.range).length,
    rangeEntryCount: numbered.filter(entry => entry.range).length,
    uniqueNumberCount: occupied.size,
    declaredCount,
    overlaps, missingNumbers, outsideNumbers,
    mixedSchemes: schemes.size > 1,
    numberingComplete: declaredCount !== null && declaredCount > 0 && declaredCount <= 9999
      && occupied.size === declaredCount && !overlaps.length && !missingNumbers.length && !outsideNumbers.length && schemes.size === 1,
    ranges: numbered.filter(entry => entry.range).map(entry => ({
      sourceOrder: entry.sourceOrder, rawTitle: entry.rawTitle, label: entry.label,
      first: entry.range!.first, last: entry.range!.last, count: entry.range!.count,
      mediaSummary: entry.mediaSummary,
      declaredImageCount: entry.declaredImageCount, declaredVideoCount: entry.declaredVideoCount,
      declaredSize: entry.declaredSize
    }))
  };
}

export class CostuanRangeDirectoryReviewRequired extends Error {
  readonly code = 'COSTUAN_RANGE_DIRECTORY_REVIEW_REQUIRED';
  constructor(readonly coverage: ReturnType<typeof analyzeCostuanDirectoryCoverage>) {
    super(`来源目录校验未通过：已识别 ${coverage.rangeEntryCount} 条范围声明，编号覆盖 ${coverage.uniqueNumberCount} 个；范围原文及合计声明已保留，尚未确认独立作品边界，未生成作品或文件计划。`);
  }
}
