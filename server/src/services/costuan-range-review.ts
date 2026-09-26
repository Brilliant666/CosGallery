import {createHash} from 'node:crypto';
import {z} from 'zod';
import {analyzeCostuanRangeInput} from './costuan-directory-coverage.js';
import {parseCostuanNumberRange, type CostuanNumberRange} from './costuan-numbering-range.js';
import {parseCostuanDirectoryText, parseCostuanNumbering, type ParsedCostuanDirectoryWork} from './costuan-numbering-service.js';

/** Server-owned, explicitly reviewed source evidence. Never accept this as a client approval flag. */
export const costuanRangeReviewSchema = z.object({
  version: z.literal(1),
  creatorId: z.number().int().positive(),
  postId: z.string().regex(/^\d+$/u),
  collectionTitle: z.string().min(1),
  rawDirectoryText: z.string().min(1),
  approvedAt: z.string().datetime({offset: true}),
  reason: z.string().trim().min(1),
  entries: z.array(z.object({
    sourceOrder: z.string().min(1),
    rawTitle: z.string().min(1),
    filename: z.string().min(1)
  }).strict()).min(1).max(9999)
}).strict();

export type CostuanRangeReview = z.infer<typeof costuanRangeReviewSchema>;
type IncomingWork = Pick<ParsedCostuanDirectoryWork, 'sourceOrder' | 'label'> & Omit<Partial<ParsedCostuanDirectoryWork>, 'range'> & {
  range?: Pick<CostuanNumberRange, 'first' | 'last' | 'count'> & Partial<CostuanNumberRange>;
};
export type CostuanRangeReviewContext = {
  creatorId: number;
  postId: string;
  collectionTitle: string;
  rawDirectoryText: string;
  works?: IncomingWork[];
};

const normalized = (value: string) => value.normalize('NFKC').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
// Preserve line boundaries: merging two declarations must invalidate the approval.
const snapshot = (value: string) => value.replace(/\r\n?/gu, '\n').split('\n').map(normalized).filter(Boolean).join('\n');
const fail = (): never => { throw new Error('来源范围与已确认的人工审核记录不一致；保留原文，需重新人工确认。'); };

function singleNumber(value: string) {
  const number = parseCostuanNumbering(value);
  if (!number || number.range || number.qualifier || number.order === null || number.order < 1 || number.scheme === 'SPECIAL') return fail();
  return number;
}

function matchesInput(input: IncomingWork[], expected: ParsedCostuanDirectoryWork[]): boolean {
  if (input.length !== expected.length) return false;
  const byKey = new Map(expected.map(work => [work.sourceOrderKey, work]));
  const seen = new Set<string>();
  for (const work of input) {
    const number = parseCostuanNumbering(work.sourceOrder);
    if (!number || seen.has(number.key)) return false;
    seen.add(number.key);
    const target = byKey.get(number.key);
    if (!target || normalized(work.label) !== normalized(target.label)) return false;
    if (work.rawTitle !== undefined && normalized(work.rawTitle) !== normalized(target.rawTitle)) return false;
    if (work.sourceOrderRaw !== undefined && parseCostuanNumbering(work.sourceOrderRaw)?.key !== number.key) return false;
    for (const field of ['order', 'sourceOrderKey', 'sourceOrderScheme', 'mediaSummary',
      'declaredImageCount', 'declaredVideoCount', 'declaredSize'] as const) {
      if (work[field] !== undefined && work[field] !== target[field]) return false;
    }
    if (work.range !== undefined) {
      // The acquisition client carries only first/last/count. Parser offsets
      // and other server fields are optional evidence, not a wire requirement.
      if (!target.range || work.range.first !== target.range.first || work.range.last !== target.range.last
        || work.range.count !== target.range.count) return false;
      for (const field of ['scheme', 'key', 'canonicalLabel', 'rawLabel', 'start', 'end'] as const) {
        if (work.range[field] !== undefined && work.range[field] !== target.range[field]) return false;
      }
    }
  }
  return true;
}

/**
 * Coverage validates declarations only. Independent titles and filenames are
 * supplied by the reviewed entries, never generated from a range or its totals.
 * This v1 contract supports one canonical numbered .7z per explicitly reviewed
 * entry. Range members cannot inherit aggregate media declarations. Supporting
 * grouped archives or per-member media evidence requires a separate contract.
 */
export function applyCostuanRangeReview(value: CostuanRangeReview, context: CostuanRangeReviewContext) {
  const decoded = costuanRangeReviewSchema.safeParse(value);
  if (!decoded.success) return fail();
  const review = decoded.data;
  if (review.creatorId !== context.creatorId || review.postId !== context.postId
    || normalized(review.collectionTitle) !== normalized(context.collectionTitle)
    || snapshot(review.rawDirectoryText) !== snapshot(context.rawDirectoryText)) return fail();
  const declaredCount = Number(normalized(context.collectionTitle).match(/[\[【](\d+)\s*套/u)?.[1]);
  if (!Number.isInteger(declaredCount) || declaredCount < 1 || declaredCount > 9999) return fail();

  const rawWorks: ParsedCostuanDirectoryWork[] = [];
  for (const line of snapshot(context.rawDirectoryText).split('\n')) {
    if (/^\d{4}[./-]\d{1,2}[./-]\d{1,2}更新\s*[:：]?$/u.test(line)) continue;
    const parsed = parseCostuanDirectoryText(line);
    if (parsed.length !== 1 || (!parsed[0].range && parsed[0].order === undefined)) return fail();
    rawWorks.push(parsed[0]);
  }
  const coverage = analyzeCostuanRangeInput(context.rawDirectoryText, rawWorks, declaredCount);
  if (!coverage?.numberingComplete || !coverage.rangeEntryCount || coverage.numberedEntryCount !== rawWorks.length) return fail();

  const expectedKeys = new Set<string>();
  const rangeKeys = new Set<string>();
  const singles = new Map<string, ParsedCostuanDirectoryWork>();
  for (const work of rawWorks) {
    const range = parseCostuanNumberRange(work.sourceOrder);
    if (range) {
      for (let order = range.first; order <= range.last; order++) {
        const key = `${range.scheme}:${String(order).padStart(3, '0')}`;
        expectedKeys.add(key);
        rangeKeys.add(key);
      }
    } else {
      const number = singleNumber(work.sourceOrder);
      expectedKeys.add(number.key);
      singles.set(number.key, work);
    }
  }
  if (review.entries.length !== expectedKeys.size) return fail();
  const seen = new Set<string>();
  const filenames = new Set<string>();
  const works: ParsedCostuanDirectoryWork[] = [];
  const requiredFilenames: string[] = [];
  for (const entry of review.entries) {
    const number = singleNumber(entry.sourceOrder);
    if (normalized(entry.sourceOrder) !== number.canonicalLabel || !expectedKeys.has(number.key) || seen.has(number.key)) return fail();
    const parsed = parseCostuanDirectoryText(entry.rawTitle);
    if (parsed.length !== 1 || parsed[0].range || singleNumber(parsed[0].sourceOrder).key !== number.key
      || /[\r\n]/u.test(entry.rawTitle)) return fail();
    const work = parsed[0];
    if (entry.filename !== `${String(number.order).padStart(3, '0')}.7z` || filenames.has(entry.filename)) return fail();
    const single = singles.get(number.key);
    if (single && normalized(single.rawTitle) !== normalized(work.rawTitle)) return fail();
    if (rangeKeys.has(number.key)) {
      if (work.mediaSummary || work.declaredImageCount !== null || work.declaredVideoCount !== null || work.declaredSize !== null) return fail();
      requiredFilenames.push(entry.filename);
    }
    seen.add(number.key);
    filenames.add(entry.filename);
    works.push(work);
  }
  if (context.works && !matchesInput(context.works, rawWorks) && !matchesInput(context.works, works)) return fail();
  works.sort((left, right) => left.order! - right.order!);
  requiredFilenames.sort();
  const reviewId = createHash('sha256').update(JSON.stringify({
    ...review, collectionTitle: normalized(review.collectionTitle), rawDirectoryText: snapshot(review.rawDirectoryText),
    entries: [...review.entries].sort((a, b) => a.sourceOrder.localeCompare(b.sourceOrder))
  })).digest('hex');
  return {
    works, supplementalContents: [], acceptedDirectoryRevisions: [],
    rangeReview: {policy: 'explicit-range-v1' as const, reviewId, creatorId: review.creatorId, postId: review.postId,
      sourceOrders: works.filter(work => rangeKeys.has(work.sourceOrderKey)).map(work => work.sourceOrder), requiredFilenames}
  };
}
