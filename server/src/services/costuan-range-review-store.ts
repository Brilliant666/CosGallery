import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {directShareMetadata} from './archive-baidu-delivery.js';
import {parseCostuanDirectoryText, parseCostuanNumbering} from './costuan-numbering-service.js';
import {applyCostuanRangeReview, costuanRangeReviewSchema} from './costuan-range-review.js';
import {RequestInputError} from '../utils/request-input-error.js';

const snapshot = (text: string) => text.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
const key = (creatorId: number, postId: string) => `archive.costuan-range-review.v1.${creatorId}.${createHash('sha256').update(postId).digest('hex')}`;
export type RangeReviewContext = {creatorId: number; postId: string; collectionTitle: string; rawDirectoryText: string;
  works: Array<{sourceOrder: string; rawTitle?: string; label: string}>};
const storedWorkSchema = z.object({sourceOrder: z.string(), label: z.string(), rawTitle: z.string(),
  mediaSummary: z.string().optional(), declaredImageCount: z.number().nullable().optional(),
  declaredVideoCount: z.number().nullable().optional(), declaredSize: z.string().nullable().optional()}).passthrough();

/** Server-owned approvals, not a flag supplied by the acquisition client. */
export class CostuanRangeReviewStore {
  constructor(private readonly db: DatabaseSync) {}

  save(input: unknown) {
    const parsed = costuanRangeReviewSchema.safeParse(input);
    if (!parsed.success) throw new RequestInputError('范围审核记录格式无效。', 'COSTUAN_RANGE_REVIEW_INVALID');
    const review = parsed.data;
    let validated;
    try {
      validated = applyCostuanRangeReview(review, {...review, works: parseCostuanDirectoryText(review.rawDirectoryText)});
    } catch {
      throw new RequestInputError('范围审核必须逐项对应完整原始目录及明确文件。', 'COSTUAN_RANGE_REVIEW_INVALID');
    }
    const savedKey = key(review.creatorId, review.postId);
    const old = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(savedKey) as {value: string} | undefined;
    if (old) {
      // Compare canonical approval identities, not incidental object key order.
      try {
        const prior = costuanRangeReviewSchema.parse(JSON.parse(old.value));
        const priorResult = applyCostuanRangeReview(prior, {...prior, works: parseCostuanDirectoryText(prior.rawDirectoryText)});
        if (priorResult.rangeReview.reviewId === validated.rangeReview.reviewId) return {replayed: true};
      } catch { /* Corrupt or different approvals must not be silently replaced. */ }
      throw new RequestInputError('已有不同范围审核，不允许隐式覆盖。', 'COSTUAN_RANGE_REVIEW_CONFLICT');
    }
    this.db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run(savedKey, JSON.stringify(review));
    return {replayed: false};
  }

  resolve(context: RangeReviewContext) {
    const saved = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key(context.creatorId, context.postId)) as {value: string} | undefined;
    if (saved) {
      try { return applyCostuanRangeReview(costuanRangeReviewSchema.parse(JSON.parse(saved.value)), context); }
      catch { return null; }
    }
    // Read-only compatibility from existing individual facts and prior share
    // evidence. Missing rows never authorize generating replacement identities.
    const collection = this.db.prepare("SELECT id,title,raw_directory_text,metadata_json FROM archive_catalog_collections WHERE creator_id=? AND source='costuan' AND source_collection_id=? AND is_active=1")
      .get(context.creatorId, context.postId) as {id: number; title: string; raw_directory_text: string | null; metadata_json: string | null} | undefined;
    if (!collection || snapshot(collection.title) !== snapshot(context.collectionTitle)
      || snapshot(collection.raw_directory_text ?? '') !== snapshot(context.rawDirectoryText)) return null;
    const delivery = this.db.prepare("SELECT metadata_json,status,source_folder_name FROM archive_catalog_deliveries WHERE collection_id=? AND provider='baidu' ORDER BY last_seen_at DESC,id DESC LIMIT 1")
      .get(collection.id) as {metadata_json: string | null; status: string | null; source_folder_name: string | null} | undefined;
    const proof = directShareMetadata(delivery?.metadata_json);
    if (!proof || delivery?.status !== 'share-verified' || delivery.source_folder_name !== proof.sourceFolderName) return null;
    const rows = this.db.prepare(`SELECT s.source_work_id,s.source_title,s.raw_title,s.metadata_json,s.media_summary,w.creator_id
      FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id
      WHERE s.collection_id=? AND s.source='costuan' AND s.is_active=1 ORDER BY s.source_order,s.id`).all(collection.id) as Array<{
        source_work_id: string; source_title: string; raw_title: string | null; metadata_json: string | null; media_summary: string | null; creator_id: number}>;
    try {
      const metadata = z.object({works: z.array(storedWorkSchema)}).parse(JSON.parse(collection.metadata_json ?? '{}'));
      if (metadata.works.length !== rows.length) return null;
      const originals = new Map<string, z.infer<typeof storedWorkSchema>>();
      for (const work of metadata.works) {
        if (originals.has(work.sourceOrder)) return null;
        originals.set(work.sourceOrder, work);
      }
      const entries = rows.map(row => {
        if (row.creator_id !== context.creatorId) return null;
        const number = parseCostuanNumbering(row.source_work_id);
        if (!number || number.order === null || number.range || !row.raw_title) return null;
        const original = originals.get(row.source_work_id);
        if (!original || original.label !== row.source_title || original.rawTitle !== row.raw_title) return null;
        const own = storedWorkSchema.parse(JSON.parse(row.metadata_json ?? '{}'));
        for (const field of ['sourceOrder', 'rawTitle', 'label', 'mediaSummary', 'declaredImageCount', 'declaredVideoCount', 'declaredSize'] as const) {
          if (own[field] !== original[field]) return null;
        }
        if ((own.mediaSummary ?? '') !== (row.media_summary ?? '')) return null;
        return {sourceOrder: row.source_work_id, rawTitle: row.raw_title, filename: `${String(number.order).padStart(3, '0')}.7z`};
      });
      if (entries.some(entry => entry === null)) return null;
      const review = costuanRangeReviewSchema.parse({version: 1, creatorId: context.creatorId, postId: context.postId,
        collectionTitle: collection.title, rawDirectoryText: collection.raw_directory_text!, approvedAt: proof.verification.checkedAt,
        reason: '沿用已登记逐项来源及既有原分享文件核验；不新增作品身份', entries});
      // Both persisted canonical facts and current supplied representations must
      // agree. Historical proof is needed only for members hidden by ranges;
      // the current request will still need a fresh share proof for staging.
      const result = applyCostuanRangeReview(review, {...context, works: metadata.works});
      const fileCounts = new Map<string, number>();
      for (const file of proof.verification.files) {
        const filename = file.toLowerCase();
        fileCounts.set(filename, (fileCounts.get(filename) ?? 0) + 1);
      }
      if (result.rangeReview.requiredFilenames.some(filename => fileCounts.get(filename) !== 1)) return null;
      return applyCostuanRangeReview(review, context);
    } catch { return null; }
  }
}
