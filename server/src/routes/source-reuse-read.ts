import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const entrySchema = z.object({
  sourceOrder: z.string().or(z.number()), rawTitle: z.string(), normalizedTitle: z.string(),
  status: z.enum(['reuse', 'missing', 'review', 'existing']), reason: z.string(),
  workId: z.number().optional(), localWorkId: z.number().optional(),
  satisfied: z.boolean(), ruleVersion: z.string().or(z.number())
});
// Only publish the small explanation contract, never arbitrary collection metadata.
function publicText(value: string) {
  return /(?:[a-z]:[\\/]|\\\\|file:\/\/)/i.test(value) ? '内容包含本地路径，已隐藏' : value;
}
export function readSourceReuse(database: DatabaseSync, page: number, limit: number) {
  const rows = database.prepare(`SELECT c.id AS collectionId, c.creator_id AS creatorId,
    creators.canonical_name AS creatorName, c.metadata_json
    FROM archive_catalog_collections c JOIN archive_catalog_creators creators ON creators.id=c.creator_id
    WHERE c.metadata_json IS NOT NULL ORDER BY c.id DESC`).all();
  const items = [];
  for (const row of rows) {
    let entries: unknown;
    try { entries = JSON.parse(String(row.metadata_json)).localSourceReuse; } catch { continue; }
    if (!Array.isArray(entries)) continue;
    for (const value of entries) {
      const parsed = entrySchema.safeParse(value);
      if (!parsed.success) continue;
      const entry = parsed.data;
      if (entry.status !== 'review' && !(['reuse', 'existing'].includes(entry.status) && entry.satisfied)) continue;
      items.push({ creatorId: Number(row.creatorId), creatorName: publicText(String(row.creatorName)),
        collectionId: Number(row.collectionId), ...entry, rawTitle: publicText(entry.rawTitle),
        normalizedTitle: publicText(entry.normalizedTitle), reason: publicText(entry.reason) });
    }
  }
  const start = (page - 1) * limit;
  return { items: items.slice(start, start + limit), total: items.length, page, limit,
    hasMore: start + limit < items.length };
}
