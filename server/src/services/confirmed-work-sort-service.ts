import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ResourceCatalogBuilder } from './resource-catalog-builder.js';

const timestamp = z.number().finite().positive().max(8640000000000000);
const decisionSchema = z.object({
  decisionKey: z.string().trim().min(1).max(200),
  creatorId: z.number().int().positive(),
  workId: z.number().int().positive(),
  primaryLocalWorkId: z.number().int().positive(),
  primaryPostId: z.number().int().positive(),
  originalTimestamp: timestamp,
  adoptedTimestamp: timestamp,
  evidence: z.record(z.unknown()).refine(value => Object.keys(value).length > 0, 'Evidence is required'),
  confirmationSource: z.string().trim().min(1).max(500),
}).strict();
export const confirmedWorkSortPlanSchema = z.object({
  confirmed: z.literal(true),
  decisions: z.array(decisionSchema).min(1).max(1000),
}).strict();
export type ConfirmedWorkSortPlan = z.infer<typeof confirmedWorkSortPlanSchema>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ':' + stableJson(entry)).join(',') + '}';
  return JSON.stringify(value);
}

// Applies only the explicit work-level confirmation. No file access, scanner,
// source mutation, media timestamp rewrite or acquisition operation is involved.
export class ConfirmedWorkSortService {
  constructor(private readonly db: DatabaseSync) {}

  apply(input: unknown): { applied: string[]; unchanged: string[] } {
    const plan = confirmedWorkSortPlanSchema.parse(input);
    const result = { applied: [] as string[], unchanged: [] as string[] };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const decision of plan.decisions) {
        const evidence = stableJson({ creatorId: decision.creatorId, evidence: decision.evidence });
        const prior = this.db.prepare('SELECT * FROM archive_catalog_work_sort_confirmations WHERE decision_key=?').get(decision.decisionKey);
        if (prior) {
          if (prior.state !== 'confirmed' || prior.work_id !== decision.workId ||
              prior.primary_local_work_id !== decision.primaryLocalWorkId || prior.primary_post_id !== decision.primaryPostId ||
              prior.original_timestamp !== decision.originalTimestamp || prior.adopted_timestamp !== decision.adoptedTimestamp ||
              prior.evidence_json !== evidence || prior.confirmation_source !== decision.confirmationSource)
            throw new Error('Decision key already exists with different content or state');
          result.unchanged.push(decision.decisionKey);
          continue;
        }
        if (this.db.prepare("SELECT 1 FROM archive_catalog_work_sort_confirmations WHERE work_id=? AND state='confirmed'").get(decision.workId))
          throw new Error('Work already has a confirmed sort timestamp; revoke explicitly before replacing');
        const snapshot = new ResourceCatalogBuilder(this.db).generate(decision.creatorId);
        const row = snapshot.page.items.find(item => item.workId === decision.workId);
        if (!row || row.primaryLocalWorkId !== decision.primaryLocalWorkId || row.primaryPostId !== decision.primaryPostId ||
            row.localState !== 'indexed' || row.sortTimestamp !== decision.originalTimestamp)
          throw new Error('Work identity, primary copy or original timestamp changed; regenerate the confirmation evidence');
        const post = this.db.prepare('SELECT sort_timestamp FROM posts WHERE id=?').get(decision.primaryPostId);
        if (post?.sort_timestamp !== decision.originalTimestamp) throw new Error('Original Post evidence changed');
        const ownership = this.db.prepare(`SELECT COUNT(DISTINCT l.work_id) AS count
          FROM posts p JOIN archive_catalog_local_creator_folders f ON f.gallery_folder_id=p.folder_id
          JOIN archive_catalog_local_works l ON l.local_creator_folder_id=f.id
          WHERE p.id=? AND l.work_id IS NOT NULL AND
            (l.post_id=p.id OR (l.post_id IS NULL AND p.source_path=
              rtrim(replace(f.relative_path,char(92),'/'),'/') || '/' || ltrim(replace(l.relative_path,char(92),'/'),'/')))`)
          .get(decision.primaryPostId);
        if (ownership?.count !== 1) throw new Error('Primary Post has ambiguous Work ownership');
        this.db.prepare(`INSERT INTO archive_catalog_work_sort_confirmations
          (decision_key,work_id,primary_local_work_id,primary_post_id,original_timestamp,adopted_timestamp,evidence_json,confirmation_source)
          VALUES (?,?,?,?,?,?,?,?)`).run(decision.decisionKey,decision.workId,decision.primaryLocalWorkId,decision.primaryPostId,
          decision.originalTimestamp,decision.adoptedTimestamp,evidence,decision.confirmationSource);
        result.applied.push(decision.decisionKey);
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
