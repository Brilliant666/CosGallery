import { z } from 'zod';
const anchor = z.object({ workId: z.number().int().positive(), sourceOrder: z.number().int().positive(), timestamp: z.number().finite().positive() });
export const sortEstimateSchema = z.object({
  method: z.literal('source-order-interpolation'),
  sourceOrder: z.number().int().positive(),
  lower: anchor,
  upper: anchor,
  originalTimestamp: z.number().finite().positive(),
});
export type SortEstimate = z.infer<typeof sortEstimateSchema>;
// Never expose private evidence JSON: select only these public sorting facts.
export function publicSortEstimate(json: string): SortEstimate | undefined {
  try { const result = sortEstimateSchema.safeParse(JSON.parse(json).evidence); return result.success ? result.data : undefined; }
  catch { return undefined; }
}
export const estimateNote = '估算仅用于作品排序，依据同一来源合集的可靠前后作品；不是发布日期或拍摄时间。';
export function estimateDescription(value: SortEstimate): string {
  return `估算：来源序号 ${value.sourceOrder}；前 Work #${value.lower.workId} / 来源 ${value.lower.sourceOrder} / ${new Date(value.lower.timestamp).toISOString()}；后 Work #${value.upper.workId} / 来源 ${value.upper.sourceOrder} / ${new Date(value.upper.timestamp).toISOString()}。${estimateNote}`;
}
