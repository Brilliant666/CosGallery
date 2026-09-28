import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { normalizeCreatorIdentity } from '../utils/creator-identity.js';
import { RESOURCE_CATALOG_RULE_VERSION } from './resource-catalog-read-model.js';

export const COUNT_POLICY_VERSION = 'independent-work-available-copy-v1';
const idSchema = z.number().int().positive().safe();
const nameSchema = z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f]/u.test(value));
export const companionResolveItemSchema = z.object({
  requestKey: z.string().min(1).max(80).regex(/^[\w.:-]+$/u),
  site: z.enum(['costuan.com', 'www.costuan.com', 'ecytt02.com', 'sndiary02.com']),
  pageType: z.enum(['creator', 'resource', 'publisher', 'organization', 'multi_person', 'unknown']),
  pageIdentifier: z.string().min(1).max(300).refine(value => value.startsWith('/') && !value.startsWith('//')
    && !/[?#\\\u0000-\u0020]/u.test(value) && !/%(?:2f|5c|00)/iu.test(value)
    && !value.split('/').some(part => part === '..' || part === '.'), '页面标识必须是规范相对路径。'),
  candidateNames: z.array(nameSchema).max(8),
}).strict();
export type CompanionResolveItem = z.infer<typeof companionResolveItemSchema>;
export class CompanionReadError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export interface CompanionIdentity { creatorId: number; canonicalName: string }
export type CompanionReadiness = 'ready' | 'uninitialized' | 'updating' | 'failed' | 'incomplete' | 'reader_outdated';
export interface CompanionSummary extends CompanionIdentity {
  collectedWorkCount: number | null;
  countPolicyVersion: string;
  readModel: { status: CompanionReadiness; complete: boolean };
  dataVersion: string;
  dataUpdatedAt: string | null;
  queriedAt: string;
}
type CatalogState = { generation: number; built_generation: number; rule_version: number; revision: string | null;
  generated_at: string | null; last_error: string | null; gaps_json: string };
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Pure database reader. No network/filesystem, settings writes, task services or lazy rebuilds. */
export class CompanionReadService {
  constructor(private readonly db: DatabaseSync) {}

  private read<T>(action: () => T): T {
    this.db.exec('SAVEPOINT companion_read');
    try { return action(); } finally { this.db.exec('RELEASE companion_read'); }
  }
  private identity(id: number): CompanionIdentity | undefined {
    return this.db.prepare('SELECT id AS creatorId,canonical_name AS canonicalName FROM archive_catalog_creators WHERE id=? AND is_active=1')
      .get(id) as CompanionIdentity | undefined;
  }
  private identityVersion(id: number) {
    return [this.identity(id), this.db.prepare('SELECT source,normalized_alias,alias FROM archive_catalog_creator_aliases WHERE creator_id=? ORDER BY source,normalized_alias').all(id),
      this.db.prepare('SELECT source,source_creator_id,source_url FROM archive_catalog_creator_sources WHERE creator_id=? ORDER BY source,source_creator_id').all(id),
      this.db.prepare('SELECT source,source_collection_id,source_url,is_active FROM archive_catalog_collections WHERE creator_id=? ORDER BY source,source_collection_id').all(id)];
  }
  summary(id: number): CompanionSummary {
    if (!idSchema.safeParse(id).success) throw new CompanionReadError(400, 'INVALID_CREATOR_ID', '博主编号无效。');
    return this.read(() => {
      const creator = this.identity(id);
      if (!creator) throw new CompanionReadError(404, 'CREATOR_NOT_FOUND', '博主不存在或已停用。');
      const state = this.db.prepare('SELECT generation,built_generation,rule_version,revision,generated_at,last_error,gaps_json FROM resource_catalog_state WHERE creator_id=?').get(id) as CatalogState | undefined;
      let status: CompanionReadiness = !state?.revision ? 'uninitialized' : state.rule_version > RESOURCE_CATALOG_RULE_VERSION ? 'reader_outdated'
        : state.generation !== state.built_generation || state.rule_version !== RESOURCE_CATALOG_RULE_VERSION
          ? state.last_error ? 'failed' : 'updating' : 'ready';
      // Legacy indexed posts without a reliable Work are not guessed to be independent works.
      if (status === 'ready') {
        try { if (!Array.isArray(JSON.parse(state!.gaps_json)) || JSON.parse(state!.gaps_json).length) status = 'incomplete'; }
        catch { status = 'incomplete'; }
      }
      const count = status === 'ready' ? this.availableWorkCount(id) : null;
      return { ...creator, collectedWorkCount: count, countPolicyVersion: COUNT_POLICY_VERSION,
        readModel: { status, complete: status === 'ready' },
        dataVersion: fingerprint([COUNT_POLICY_VERSION, this.identityVersion(id), state ?? null, count]),
        dataUpdatedAt: state?.generated_at ?? null, queriedAt: new Date().toISOString() };
    });
  }
  private availableWorkCount(id: number): number {
    // Same ownership/index/media eligibility as ResourceCatalogBuilder. Unlike its
    // presentation total, any usable secondary copy counts; NO/date/primary choice do not.
    // CROSS JOIN deliberately fixes the bounded traversal: creator Works -> local
    // copies -> one Post -> that Post's media. Otherwise SQLite can start with all
    // visible Posts and probe the global media visibility index once per Post,
    // blocking the HTTP event loop on a real library despite tiny fixtures passing.
    return Number(this.db.prepare(`SELECT COUNT(DISTINCT w.id) AS count FROM archive_catalog_works w
      CROSS JOIN archive_catalog_local_works l ON l.work_id=w.id
      CROSS JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id
      CROSS JOIN folders gf ON gf.id=f.gallery_folder_id AND gf.role='normal'
      CROSS JOIN posts p ON p.id=COALESCE(l.post_id,(SELECT legacy.id FROM posts legacy
        WHERE l.match_status='matched' AND legacy.folder_id=f.gallery_folder_id
        AND legacy.source_path=rtrim(replace(f.relative_path,char(92),'/'),'/') || '/' || ltrim(replace(l.relative_path,char(92),'/'),'/')))
      WHERE w.creator_id=? AND f.creator_id=w.creator_id AND f.is_active=1 AND l.is_active=1
      AND f.match_status='matched' AND l.match_status='matched' AND p.folder_id=f.gallery_folder_id
      AND p.is_deleted=0 AND p.is_trashed=0
      AND NOT EXISTS (SELECT 1 FROM archive_catalog_local_creator_folders other
        WHERE other.gallery_folder_id=f.gallery_folder_id AND other.is_active=1 AND other.match_status='matched'
        AND other.creator_id IS NOT NULL AND other.creator_id<>w.creator_id)
      AND NOT EXISTS (SELECT 1 FROM post_items pi CROSS JOIN images i ON i.id=pi.image_id
        WHERE pi.post_id=p.id AND pi.position=1 AND i.folder_id=p.folder_id
        AND lower(i.filename) IN ('cover.jpg','cover.jpeg','cover.png','cover.webp','cover.avif','cover.gif'))
      AND EXISTS (SELECT 1 FROM post_items pi CROSS JOIN images i ON i.id=pi.image_id WHERE pi.post_id=p.id
        AND i.is_deleted=0 AND i.is_trashed=0 AND i.media_type IN ('image','video')
        AND instr(replace(i.relative_path,char(92),'/'),'/_未支持格式原件/')=0)`).get(id)!.count);
  }
  search(query: string, limit = 20): { items: CompanionIdentity[]; truncated: boolean; dataVersion: string; queriedAt: string } {
    if (!nameSchema.safeParse(query).success || !Number.isInteger(limit) || limit < 1 || limit > 30)
      throw new CompanionReadError(400, 'INVALID_SEARCH', '请输入名称，结果上限为30。');
    const normalized = normalizeCreatorIdentity(query);
    if (!normalized) throw new CompanionReadError(400, 'INVALID_SEARCH', '请输入有效名称。');
    return this.read(() => {
      const rows = this.db.prepare(`SELECT c.id AS creatorId,c.canonical_name AS canonicalName FROM archive_catalog_creators c
        WHERE c.is_active=1 AND (instr(c.normalized_name,?)>0 OR EXISTS (SELECT 1 FROM archive_catalog_creator_aliases a WHERE a.creator_id=c.id AND instr(a.normalized_alias,?)>0))
        ORDER BY c.normalized_name,c.id LIMIT ?`).all(normalized, normalized, limit + 1) as unknown as CompanionIdentity[];
      const items = rows.slice(0, limit);
      return { items, truncated: rows.length > limit, dataVersion: fingerprint(items.map(row => this.identityVersion(row.creatorId))), queriedAt: new Date().toISOString() };
    });
  }
  private nameMatches(names: string[]): CompanionIdentity[] {
    const normalized = [...new Set(names.map(normalizeCreatorIdentity).filter(Boolean))];
    if (!normalized.length) return [];
    const marks = normalized.map(() => '?').join(',');
    return this.db.prepare(`SELECT c.id AS creatorId,c.canonical_name AS canonicalName FROM archive_catalog_creators c
      WHERE c.is_active=1 AND (c.normalized_name IN (${marks}) OR EXISTS (SELECT 1 FROM archive_catalog_creator_aliases a
        WHERE a.creator_id=c.id AND a.normalized_alias IN (${marks}))) ORDER BY c.id LIMIT 31`).all(...normalized, ...normalized) as unknown as CompanionIdentity[];
  }
  private sourceMatches(item: CompanionResolveItem): CompanionIdentity[] {
    // These are persisted creator/page ownership records, not raw evidence,
    // proposed evidence attachments or source-work title suggestions. Existing
    // imports establish a unique creator before writing them; conflicts with
    // another recorded owner or with current names remain explicit below.
    const site = item.site === 'www.costuan.com' ? 'costuan.com' : item.site;
    const page = item.pageIdentifier.replace(/\/$/u, '') || '/';
    const hosts = site === 'costuan.com' ? ['costuan.com', 'www.costuan.com'] : [site];
    const urls = hosts.flatMap(host => ['https:', 'http:'].flatMap(protocol => [`${protocol}//${host}${page}`, `${protocol}//${host}${page}/`]));
    const marks = urls.map(() => '?').join(',');
    const postId = site === 'costuan.com' && item.pageType === 'resource' ? /^\/(\d+)(?:\.html)?$/u.exec(page)?.[1] ?? null : null;
    return this.db.prepare(`SELECT c.id AS creatorId,c.canonical_name AS canonicalName FROM archive_catalog_creators c
      WHERE c.is_active=1 AND (EXISTS (SELECT 1 FROM archive_catalog_creator_sources s WHERE s.creator_id=c.id
        AND (s.source_url IN (${marks}) OR (? IS NOT NULL AND s.source='costuan' AND s.source_creator_id='collection:' || ?)))
      OR EXISTS (SELECT 1 FROM archive_catalog_collections s WHERE s.creator_id=c.id AND s.is_active=1
        AND (s.source_url IN (${marks}) OR (? IS NOT NULL AND s.source='costuan' AND s.source_collection_id=?))))
      ORDER BY c.id LIMIT 31`).all(...urls, postId, postId, ...urls, postId, postId) as unknown as CompanionIdentity[];
  }
  resolveBatch(items: unknown, options: { includeSummary?: boolean } = {}) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 50)
      throw new CompanionReadError(400, 'INVALID_BATCH_SIZE', '每批须包含1至50项。');
    const keys = items.map(item => typeof item === 'object' && item !== null ? (item as {requestKey?:unknown}).requestKey : undefined)
      .filter((key): key is string => typeof key === 'string');
    if (new Set(keys).size !== keys.length) throw new CompanionReadError(400, 'DUPLICATE_REQUEST_KEY', '批次中的请求标识不能重复。');
    // Only share within this synchronous read snapshot; never cache across requests,
    // grants or database changes. A card batch may repeat the same creator many times.
    const summaries = new Map<number, CompanionSummary>();
    return this.read(() => items.map((raw, index) => {
      const parsed = companionResolveItemSchema.safeParse(raw);
      const key = typeof raw === 'object' && raw !== null ? (raw as {requestKey?:unknown}).requestKey : null;
      if (!parsed.success) return { index, requestKey: typeof key === 'string' && /^[\w.:-]{1,80}$/u.test(key) ? key : null,
        error: { code: 'INVALID_RESOLVE_ITEM', status: 400, message: '查询项格式无效。' }, collectedWorkCount: null };
      const item = parsed.data;
      const names = this.nameMatches(item.candidateNames);
      const sources = ['creator', 'resource'].includes(item.pageType) ? this.sourceMatches(item) : [];
      const candidates = [...new Map([...sources, ...names].map(row => [row.creatorId, row])).values()];
      const needsConfirmation = !['creator', 'resource'].includes(item.pageType);
      const conflict = sources.length > 1 || sources.length === 1 && names.some(row => row.creatorId !== sources[0]!.creatorId);
      const matchStatus = needsConfirmation ? 'needs_confirmation' : conflict ? 'conflict' : sources.length === 1 ? 'matched'
        : names.length > 1 ? 'ambiguous' : names.length === 1 ? 'matched' : 'unresolved';
      const match = matchStatus === 'matched' ? (sources[0] ?? names[0])! : null;
      let summary: CompanionSummary | null = null;
      if (match && options.includeSummary !== false) {
        summary = summaries.get(match.creatorId) ?? this.summary(match.creatorId);
        summaries.set(match.creatorId, summary);
      }
      return { index, requestKey: item.requestKey, matchStatus,
        matchedBy: match ? sources.length ? 'source_relation' : 'canonical_or_registered_alias' : null,
        creator: match, candidates: candidates.slice(0, 30), candidatesTruncated: candidates.length > 30,
        collectedWorkCount: summary?.collectedWorkCount ?? null, countPolicyVersion: COUNT_POLICY_VERSION,
        readModel: summary?.readModel ?? { status: options.includeSummary === false ? 'permission_denied' : 'unresolved', complete: false },
        dataVersion: fingerprint([item, candidates.map(row => this.identityVersion(row.creatorId)), summary?.dataVersion ?? null]),
        dataUpdatedAt: summary?.dataUpdatedAt ?? null, queriedAt: new Date().toISOString() };
    }));
  }
}
