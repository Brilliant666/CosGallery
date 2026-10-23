import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeReviewPath } from './local-ingest-review-inventory.js';

const id = z.number().int().positive();
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const relative = z.string().min(1).transform(value => normalizeReviewPath(value));
const sha256 = z.string().regex(/^[\da-f]{64}$/i).transform(value => value.toUpperCase());
export const reviewRequestSchema = z.object({
  jobId: id,
  removedFiles: z.array(z.object({ relativePath: relative, size }).strict()).max(1000),
  retainedFiles: z.array(z.object({ relativePath: relative, reason: z.enum(['pixel_limit', 'decode_failed', 'attachment']) }).strict()).max(1000),
  note: z.string().trim().min(1).max(2000)
}).strict();
export const reviewFileSchema = z.object({ relativePath: relative, size, sha256, crc32: z.string().regex(/^[\dA-F]{8}$/) }).strict();
export const reviewPlanSchema = z.object({
  version: z.literal(1), planId: z.string().uuid(), confirmed: z.boolean(),
  request: reviewRequestSchema,
  creatorId: id, sourceWorkId: id, downloadTaskId: id, workId: id,
  targetPath: z.string().min(1), processingPath: z.string().min(1), targetPlanHash: sha256,
  sourceArchive: z.object({ path: z.string().min(1), size, mtimeMs: z.number().nonnegative(), sha256 }).strict(),
  innerArchive: z.object({ relativePath: relative, size, sha256 }).strict(),
  extractionMarkers: z.array(sha256).length(2),
  originalFailure: z.object({ code: z.string(), detail: z.string(), phase: z.literal('validating'), attemptCount: id }).strict(),
  files: z.array(reviewFileSchema).min(1),
  removedFiles: z.array(z.object({ relativePath: relative, size, crc32: z.string().regex(/^[\dA-F]{8}$/) }).strict()),
  archiveInventoryHash: sha256
}).strict();
export type LocalIngestReviewRequest = z.input<typeof reviewRequestSchema>;
export type LocalIngestReviewPlan = z.infer<typeof reviewPlanSchema>;
export function reviewHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').toUpperCase();
}
export function reviewPlanHash(plan: LocalIngestReviewPlan): string {
  return reviewHash({ ...reviewPlanSchema.parse(plan), confirmed: false });
}
export function readReviewRecovery(summary: Record<string, unknown> | null): { plan: LocalIngestReviewPlan; hash: string } | null {
  if (!summary?.reviewRecovery) return null;
  const value = z.object({ plan: reviewPlanSchema, hash: sha256, acceptedAt: z.string() }).strict().parse(summary.reviewRecovery);
  if (value.hash !== reviewPlanHash(value.plan)) throw new Error('Stored review recovery payload changed');
  return value;
}
