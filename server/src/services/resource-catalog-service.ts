import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { databaseManager } from '../db/database.js';
import { FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY } from '../constants/app-setting-keys.js';
import { ResourceCatalogError } from './resource-catalog-builder.js';
import { RESOURCE_CATALOG_RULE_VERSION } from './resource-catalog-read-model.js';
import { estimateNote, estimateDescription } from './work-sort-estimate.js';
import type { ResourceCatalogCopy, ResourceCatalogDetail, ResourceCatalogFilter, ResourceCatalogPage, ResourceCatalogReadStatus, ResourceCatalogRow } from '../types/resource-catalog.js';
export { ResourceCatalogError, resourceCatalogText, safeResourceSourceUrl } from './resource-catalog-builder.js';

type State = { creator_id: number; generation: number; built_generation: number; rule_version: number;
  revision: string | null; generated_at: string | null; creator_name: string;
  summary_json: string | null; gaps_json: string; last_error: string | null };
const emptySummary = () => ({ totalWorks: 0, numberedWorks: 0, unarrangedWorks: 0, multipleCopyWorks: 0,
  unavailableWorks: 0, sourceOnlyWorks: 0, legacyPosts: 0, excludedDeletedWorks: 0 });
const plain = (text: string) => text.replace(/[\r\n\t\u0000-\u001f]/g, ' ');
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Browsing reads published rows. No build, media aggregate or directory content hash here. */
export class ResourceCatalogService {
  constructor(private readonly getDatabase: () => DatabaseSync = () => databaseManager.connection) {}
  searchCreators(q = '') {
    const db = this.getDatabase(), query = `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`;
    const where = `canonical_name LIKE ? ESCAPE '\\' OR CAST(id AS TEXT)=? OR EXISTS
      (SELECT 1 FROM archive_catalog_creator_aliases a WHERE a.creator_id=c.id AND a.alias LIKE ? ESCAPE '\\')`;
    const items = db.prepare(`SELECT id,canonical_name AS canonicalName,preference,is_active AS enabled
      FROM archive_catalog_creators c WHERE ${where} ORDER BY is_active DESC,canonical_name COLLATE NOCASE,id LIMIT 100`).all(query, q.trim(), query);
    const total = Number(db.prepare(`SELECT COUNT(*) n FROM archive_catalog_creators c WHERE ${where}`).get(query, q.trim(), query)?.n ?? 0);
    return { items: items.map(item => ({ ...item, enabled: Boolean(item.enabled) })), total };
  }
  private read<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.getDatabase(); db.exec('SAVEPOINT resource_catalog_published_read');
    try { return fn(db); } finally { db.exec('RELEASE resource_catalog_published_read'); }
  }
  private context(db: DatabaseSync, creatorId: number | null, order?: 'oldest' | 'newest') {
    // O(creators) state summary; never loops over generators or media.
    const states = db.prepare(`SELECT s.* FROM resource_catalog_state s JOIN archive_catalog_creators c ON c.id=s.creator_id
      ${creatorId === null ? '' : 'WHERE s.creator_id=?'} ORDER BY s.creator_id`).all(...(creatorId === null ? [] : [creatorId])) as unknown as State[];
    if (creatorId !== null && !states.length) throw new ResourceCatalogError(404, 'CREATOR_NOT_FOUND', '博主不存在。');
    if (states.some(state => state.rule_version > RESOURCE_CATALOG_RULE_VERSION)) {
      throw new ResourceCatalogError(503, 'CATALOG_READER_OUTDATED', '目录已由较新版本生成，请使用配套的新版服务。');
    }
    const storedOrder = db.prepare('SELECT value FROM app_settings WHERE key=?').get(FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY)?.value;
    const sortOrder: 'oldest' | 'newest' = order ?? (storedOrder === 'oldest' ? 'oldest' : 'newest');
    const pending = states.filter(s => s.built_generation !== s.generation || s.rule_version !== RESOURCE_CATALOG_RULE_VERSION);
    const initialized = states.filter(s => s.revision !== null), failed = pending.filter(s => s.last_error !== null);
    const readModel: ResourceCatalogReadStatus = {
      status: failed.length ? 'failed' : pending.length ? (initialized.length ? 'updating' : 'uninitialized') : 'ready',
      complete: !pending.length, pendingCreators: pending.length, failedCreators: failed.length,
      initializedCreators: initialized.length, totalCreators: states.length,
      updatedAt: initialized.map(s => s.generated_at!).filter(Boolean).sort().at(-1) ?? null,
    };
    const publication = Number(db.prepare('SELECT publication FROM resource_catalog_meta WHERE id=1').get()?.publication ?? 0);
    // Only a few version tokens are hashed, not directory contents. Direction is not identity.
    const revision = createHash('sha256').update(JSON.stringify([RESOURCE_CATALOG_RULE_VERSION, storedOrder ?? 'newest',
      creatorId === null ? ['all', publication, states.map(s => [s.creator_id, s.generation, s.built_generation, s.rule_version])]
        : [creatorId, states[0]!.generation, states[0]!.built_generation, states[0]!.revision]])).digest('hex');
    const summary = emptySummary();
    for (const state of initialized) { const part = JSON.parse(state.summary_json!) as typeof summary;
      for (const key of Object.keys(summary) as Array<keyof typeof summary>) summary[key] += part[key]; }
    const legacyGaps = initialized.flatMap(s => (JSON.parse(s.gaps_json) as ResourceCatalogPage['legacyGaps'])
      .map(gap => ({ ...gap, creatorId: s.creator_id, creatorName: s.creator_name })));
    return { creator: creatorId === null ? null : { id: creatorId, canonicalName: states[0]!.creator_name || String(db.prepare(
      'SELECT canonical_name FROM archive_catalog_creators WHERE id=?').get(creatorId)!.canonical_name) },
      readModel, revision, generatedAt: readModel.updatedAt ?? new Date().toISOString(), sortOrder, summary, legacyGaps };
  }
  private checkRevision(actual: string, expected?: string) {
    if (expected && actual !== expected) throw new ResourceCatalogError(409, 'RESOURCE_CATALOG_CHANGED', '作品数据已更新，请刷新资源目录。');
  }
  private selection(creatorId: number | null, filter: ResourceCatalogFilter) {
    const conditions = ['s.revision IS NOT NULL', 'EXISTS (SELECT 1 FROM archive_catalog_creators c WHERE c.id=r.creator_id)',
      'EXISTS (SELECT 1 FROM archive_catalog_works w WHERE w.id=r.work_id AND w.creator_id=r.creator_id)',
      '(r.primary_post_id IS NULL OR EXISTS (SELECT 1 FROM posts p WHERE p.id=r.primary_post_id AND p.is_deleted=0 AND p.is_trashed=0))'];
    const args: SQLInputValue[] = [];
    if (creatorId !== null) { conditions.push('r.creator_id=?'); args.push(creatorId); }
    if (filter.q?.trim()) { conditions.push('(instr(r.search_text,?)>0 OR instr(s.aliases_text,?)>0)');
      const q = filter.q.trim().toLocaleLowerCase(); args.push(q, q); }
    if (filter.localState === 'exception') conditions.push("r.local_state IN ('unavailable','unarranged')");
    else if (filter.localState && filter.localState !== 'all') { conditions.push('r.local_state=?'); args.push(filter.localState); }
    if (filter.source && filter.source !== 'all') { conditions.push('r.has_source=?'); args.push(Number(filter.source === 'linked')); }
    return { sql: `FROM resource_catalog_rows r JOIN resource_catalog_state s ON r.creator_id=s.creator_id WHERE ${conditions.join(' AND ')}`, args };
  }
  private ordering(order: 'oldest' | 'newest') {
    const direction = order === 'oldest' ? 'ASC' : 'DESC';
    return `ORDER BY (r.no_number IS NULL),r.sort_timestamp ${direction},
      CASE WHEN r.no_number IS NOT NULL THEN r.primary_post_id END ${direction},r.work_id ASC`;
  }
  list(creatorId: number | null, filter: ResourceCatalogFilter = {}): ResourceCatalogPage {
    return this.read(db => {
      const context = this.context(db, creatorId, filter.order); this.checkRevision(context.revision, filter.revision);
      // Aggregate only the published lightweight rows, in the same read snapshot as
      // the page. Counts describe the whole scope, not the current filter or page.
      const full = this.selection(creatorId, {});
      const sources = db.prepare(`SELECT COALESCE(SUM(r.has_source=1),0) linkedWorks,
        COALESCE(SUM(r.has_source=0),0) unlinkedWorks ${full.sql}`).get(...full.args)!;
      const { sql, args } = this.selection(creatorId, filter);
      const total = Number(db.prepare(`SELECT COUNT(*) n ${sql}`).get(...args)!.n);
      const page = Math.max(1, filter.page ?? 1), pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 50));
      const items = db.prepare(`SELECT r.row_json ${sql} ${this.ordering(context.sortOrder)} LIMIT ? OFFSET ?`)
        .all(...args, pageSize, (page - 1) * pageSize).map(row => JSON.parse(String(row.row_json)) as ResourceCatalogRow);
      return { ...context, summary: { ...context.summary, linkedWorks: Number(sources.linkedWorks),
        unlinkedWorks: Number(sources.unlinkedWorks) }, items, total, page, pageSize };
    });
  }
  detail(creatorId: number, workId: number, revision?: string, revisionScope: 'all' | 'creator' = 'creator'): ResourceCatalogDetail {
    return this.read(db => {
      const context = this.context(db, revisionScope === 'all' ? null : creatorId); this.checkRevision(context.revision, revision);
      const { sql, args } = this.selection(creatorId, {});
      const row = db.prepare(`SELECT r.row_json,r.copies_json ${sql} AND r.work_id=?`).get(...args, workId);
      if (!row) throw new ResourceCatalogError(404, 'WORK_NOT_FOUND', '该作品不在当前本地目录中。');
      const copies = JSON.parse(String(row.copies_json)) as ResourceCatalogCopy[];
      // Completed metadata may briefly outlive a deletion while the worker updates.
      // Recheck only this Work's copy links, never its media or the creator snapshot.
      const visible = new Set(db.prepare(`SELECT p.id FROM posts p
        JOIN json_each(?) copy ON p.id=json_extract(copy.value,'$.postId')
        WHERE p.is_deleted=0 AND p.is_trashed=0`).all(String(row.copies_json)).map(post => Number(post.id)));
      const item = JSON.parse(String(row.row_json)) as ResourceCatalogRow;
      return { revision: context.revision, item,
        copies: copies.map(copy => copy.postId !== null && !visible.has(copy.postId)
          ? { ...copy, postId: null, indexedAvailable: false } : copy),
        readModel: context.readModel, notes: ['本地统计仅包含有效已索引媒体；来源声明独立保留，不代表文件逐字节一致。',
          '其他附件及保留原件不计入媒体容量；本次未检查磁盘。', ...(item.sortEstimate ? [estimateDescription(item.sortEstimate)] : [])] };
    });
  }
  exportBundle(creatorId: number | null, format: 'txt' | 'csv', scope: 'all' | 'filtered', filter: ResourceCatalogFilter = {}) {
    return this.read(db => {
      const context = this.context(db, creatorId, filter.order); this.checkRevision(context.revision, filter.revision);
      if (!context.readModel.complete) throw new ResourceCatalogError(409, 'CATALOG_NOT_READY', '目录尚未完成更新，暂不能导出完整版本。');
      const { sql, args } = this.selection(creatorId, scope === 'all' ? {} : filter);
      const rows = db.prepare(`SELECT r.row_json ${sql} ${this.ordering(context.sortOrder)}`).all(...args)
        .map(row => JSON.parse(String(row.row_json)) as ResourceCatalogRow);
      const metadata = { revision: context.revision, generatedAt: new Date().toISOString(), numberingOrder: 'oldest',
        estimatedSortTimeNote: estimateNote,
        displayOrder: context.sortOrder, scope, creatorId, creatorName: context.creator?.canonicalName ?? null,
        filters: scope === 'filtered' ? { q: filter.q ?? '', localState: filter.localState ?? 'all', source: filter.source ?? 'all' } : null,
        rowCount: rows.length, dynamicNumberingNote: 'NO属于各自博主，按已有排序时间从早到晚编号；新增作品可使NO重排，不改变稳定Work ID或本地文件名。' };
      if (format === 'txt') return { metadata, body: ['CosGallery资源目录',
        `博主：${plain(context.creator?.canonicalName ?? '全部博主')}`, `生成时间：${metadata.generatedAt}`, `版本：${metadata.revision}`,
        '编目顺序：按已有排序时间从早到晚编号', `展示顺序：${context.sortOrder === 'oldest' ? '最早优先' : '最新优先'}`,
        `导出范围：${scope === 'all' ? '完整目录' : '当前筛选结果'}`, metadata.dynamicNumberingNote, '',
        ...rows.map(row => `${creatorId === null ? `[${plain(row.creatorName)} / #${row.creatorId}] ` : ''}${row.text} (Work #${row.workId})${row.sortEstimate ? ` [${estimateDescription(row.sortEstimate)}]` : ''}`)].join('\r\n') };
      const headers = ['creatorId', 'workId', 'no', 'title', 'sortTimestamp', 'primaryPostId', 'primaryLocalWorkId',
        'imageCount', 'videoCount', 'mediaBytes', 'originalDirectory', 'localState', 'statisticsBasis', 'sources', 'creatorName', 'sortEstimate'];
      return { metadata, body: '\uFEFF' + [headers.map(csvCell).join(','), ...rows.map(row => [row.creatorId, row.workId, row.no,
        row.title, row.sortTimestamp, row.primaryPostId, row.primaryLocalWorkId, row.imageCount, row.videoCount, row.mediaBytes,
        row.originalDirectory, row.localState, row.statisticsBasis, JSON.stringify(row.sources), row.creatorName, row.sortEstimate ? JSON.stringify(row.sortEstimate) : ''].map(csvCell).join(','))].join('\r\n') };
    });
  }
  export(creatorId: number | null, format: 'txt' | 'csv', scope: 'all' | 'filtered', filter: ResourceCatalogFilter = {}) {
    return this.exportBundle(creatorId, format, scope, filter).body;
  }
}
