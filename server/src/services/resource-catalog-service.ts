import { createHash } from 'node:crypto';
import { databaseManager } from '../db/database.js';
import { FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY } from '../constants/app-setting-keys.js';
import type {
  ResourceCatalogCopy,
  ResourceCatalogDetail,
  ResourceCatalogFilter,
  ResourceCatalogPage,
  ResourceCatalogRow,
  ResourceCatalogSource,
} from '../types/resource-catalog.js';
export class ResourceCatalogError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
type Work = {
  id: number;
  title: string;
  primaryId: number | null;
};
type Copy = {
  id: number;
  workId: number;
  postId: number | null;
  directoryName: string;
  active: number;
  folderActive: number;
  ownerId: number | null;
  matchStatus: string;
  localMatchStatus: string;
  folderRole: string | null;
  folderId: number | null;
  postFolderId: number | null;
  sortTimestamp: number | null;
  deleted: number | null;
  trashed: number | null;
  otherFileCount: number;
  explicitCover: number;
};
type Media = {
  localId: number;
  imageCount: number;
  videoCount: number;
  mediaBytes: number | null;
  memberCount: number;
};
type Snapshot = {
  page: ResourceCatalogPage;
  copies: Map<number, ResourceCatalogCopy[]>;
};
// Source metadata is deliberately not serialized. Even administrative exports must not carry credentials.
export function safeResourceSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    // Keep only ordinary document selectors, never arbitrary share/password/token parameters.
    for (const key of [...url.searchParams.keys()])
      if (!['id', 'p', 'page', 'post', 'article'].includes(key.toLowerCase()))
        url.searchParams.delete(key);
    return url.toString();
  } catch {
    return null;
  }
}
const nameOnly = (value: string) =>
  value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
const plain = (value: string) => value.replace(/[\r\n\t\u0000-\u001f]/g, ' ');
function capacity(bytes: number | null) {
  return bytes === null
    ? '容量未知'
    : bytes >= 1073741824
      ? `${(bytes / 1073741824).toFixed(2)}GiB`
      : `${(bytes / 1048576).toFixed(2)}MiB`;
}
export function resourceCatalogText(
  creator: string,
  item: ResourceCatalogRow,
): string {
  const media =
    item.imageCount === null || item.videoCount === null
      ? '媒体数量未知'
      : `${item.imageCount}P${item.videoCount ? `${item.videoCount}V` : ''}`;
  return `${plain(creator)} ${item.no ?? '未编排'} ${plain(item.title)} [${media}-${capacity(item.mediaBytes)}]${item.localState === 'unavailable' ? '（主副本不可用，按最后索引记录）' : ''}`;
}
function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export class ResourceCatalogService {
  searchCreators(q = '') {
    const db = databaseManager.connection;
    const query = `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`;
    const where = `canonical_name LIKE ? ESCAPE '\\' OR CAST(id AS TEXT)=? OR EXISTS
      (SELECT 1 FROM archive_catalog_creator_aliases a WHERE a.creator_id=c.id AND a.alias LIKE ? ESCAPE '\\')`;
    const items = db
      .prepare(
        `SELECT id,canonical_name AS canonicalName,preference,is_active AS enabled FROM archive_catalog_creators c
      WHERE ${where} ORDER BY is_active DESC,canonical_name COLLATE NOCASE,id LIMIT 100`,
      )
      .all(query, q.trim(), query);
    const total = Number(
      db
        .prepare(
          `SELECT COUNT(*) n FROM archive_catalog_creators c WHERE ${where}`,
        )
        .get(query, q.trim(), query)?.n ?? 0,
    );
    return { items: items.map(item => ({ ...item, enabled: Boolean(item.enabled) })), total };
  }
  private snapshot(creatorId: number): Snapshot {
    const db = databaseManager.connection;
    db.exec('SAVEPOINT resource_catalog_read');
    try {
      const creator = db
        .prepare(
          'SELECT id,canonical_name AS canonicalName FROM archive_catalog_creators WHERE id=?',
        )
        .get(creatorId) as
        | {
            id: number;
            canonicalName: string;
          }
        | undefined;
      if (!creator)
        throw new ResourceCatalogError(
          404,
          'CREATOR_NOT_FOUND',
          '博主不存在。',
        );
      const order = db
        .prepare('SELECT value FROM app_settings WHERE key=?')
        .get(FOLDER_IMAGE_DEFAULT_ORDER_SETTING_KEY)?.value;
      const sortOrder = order === 'oldest' ? 'oldest' : 'newest';
      const works = db
        .prepare(
          `SELECT id,display_title AS title,primary_local_work_id AS primaryId FROM archive_catalog_works WHERE creator_id=? ORDER BY id`,
        )
        .all(creatorId) as unknown as Work[];
      const locals = db
        .prepare(
          `SELECT l.id,l.work_id AS workId,p.id AS postId,l.folder_name AS directoryName,l.is_active AS active,
        f.is_active AS folderActive,f.creator_id AS ownerId,f.match_status AS matchStatus,l.match_status AS localMatchStatus,
        gallery_folder.role AS folderRole,f.gallery_folder_id AS folderId,
        p.folder_id AS postFolderId,p.sort_timestamp AS sortTimestamp,p.is_deleted AS deleted,p.is_trashed AS trashed,
        l.other_file_count AS otherFileCount,
        CASE WHEN first_image.folder_id=p.folder_id AND lower(first_image.filename) IN ('cover.jpg','cover.jpeg','cover.png','cover.webp','cover.avif','cover.gif') THEN 1 ELSE 0 END AS explicitCover
        FROM archive_catalog_works w JOIN archive_catalog_local_works l ON l.work_id=w.id
        JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id
        LEFT JOIN folders gallery_folder ON gallery_folder.id=f.gallery_folder_id
        LEFT JOIN posts p ON p.id=COALESCE(l.post_id,(SELECT legacy.id FROM posts legacy
          WHERE l.match_status='matched' AND legacy.folder_id=f.gallery_folder_id
          AND legacy.source_path=rtrim(replace(f.relative_path,char(92),'/'),'/') || '/' || ltrim(replace(l.relative_path,char(92),'/'),'/')))
        LEFT JOIN post_items first_item ON first_item.post_id=p.id AND first_item.position=1
        LEFT JOIN images first_image ON first_image.id=first_item.image_id
        WHERE w.creator_id=? ORDER BY l.id`,
        )
        .all(creatorId) as unknown as Copy[];
      // Drive this aggregate from creator-scoped copies, not from the global media visibility index.
      const media = db
        .prepare(
          `SELECT l.id AS localId,COUNT(CASE WHEN i.media_type='image' THEN 1 END) AS imageCount,
        COUNT(CASE WHEN i.media_type='video' THEN 1 END) AS videoCount,COUNT(i.id) AS memberCount,
        CASE WHEN COUNT(i.id)=0 OR SUM(CASE WHEN i.file_size<0 OR i.file_size IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(i.file_size) END AS mediaBytes
        FROM archive_catalog_works w JOIN archive_catalog_local_works l ON l.work_id=w.id
        JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id
        JOIN posts p ON p.id=COALESCE(l.post_id,(SELECT legacy.id FROM posts legacy
          WHERE l.match_status='matched' AND legacy.folder_id=f.gallery_folder_id
          AND legacy.source_path=rtrim(replace(f.relative_path,char(92),'/'),'/') || '/' || ltrim(replace(l.relative_path,char(92),'/'),'/')))
        CROSS JOIN post_items pi ON pi.post_id=p.id CROSS JOIN images i ON i.id=pi.image_id
        WHERE w.creator_id=? AND i.is_deleted=0 AND i.is_trashed=0 AND i.media_type IN ('image','video')
        AND instr(replace(i.relative_path,char(92),'/'),'/_未支持格式原件/')=0 GROUP BY l.id`,
        )
        .all(creatorId) as unknown as Media[];
      const sourceRows = db
        .prepare(
          `SELECT s.work_id AS workId,s.id AS sourceWorkId,s.source AS platform,s.source_order AS sourceOrder,
        s.source_order_label AS sourceOrderLabel,s.source_title AS title,s.media_summary AS mediaSummary,c.source_url AS url,s.is_active AS active
        FROM archive_catalog_works w JOIN archive_catalog_source_works s ON s.work_id=w.id
        JOIN archive_catalog_collections c ON c.id=s.collection_id WHERE w.creator_id=? ORDER BY s.id`,
        )
        .all(creatorId) as unknown as (ResourceCatalogSource & {
        workId: number;
      })[];
      const candidatePosts = db
        .prepare(
          `SELECT DISTINCT p.id AS postId,COALESCE(p.caption,'Post #' || p.id) AS title,p.folder_id AS folderId FROM posts p
        JOIN folders gf ON gf.id=p.folder_id AND gf.role='normal'
        WHERE p.is_deleted=0 AND p.is_trashed=0 AND EXISTS (SELECT 1 FROM post_items pi JOIN images i ON i.id=pi.image_id
          WHERE pi.post_id=p.id AND i.is_deleted=0 AND i.is_trashed=0) AND p.folder_id IN
        (SELECT gallery_folder_id FROM archive_catalog_local_creator_folders WHERE creator_id=? AND is_active=1 AND match_status='matched')
        AND NOT EXISTS (SELECT 1 FROM post_items pi JOIN images i ON i.id=pi.image_id WHERE pi.post_id=p.id AND pi.position=1
          AND i.folder_id=p.folder_id AND lower(i.filename) IN ('cover.jpg','cover.jpeg','cover.png','cover.webp','cover.avif','cover.gif'))
        ORDER BY p.id`,
        )
        .all(creatorId) as unknown as Array<{
        postId: number;
        title: string;
        folderId: number;
      }>;
      const owners = db
        .prepare(
          `SELECT f.gallery_folder_id AS folderId,COUNT(DISTINCT f.creator_id) AS ownerCount
        FROM archive_catalog_local_creator_folders f WHERE f.is_active=1 AND f.creator_id IS NOT NULL AND f.match_status='matched'
        AND f.gallery_folder_id IN (SELECT gallery_folder_id FROM archive_catalog_local_creator_folders WHERE creator_id=?)
        GROUP BY f.gallery_folder_id`,
        )
        .all(creatorId) as unknown as Array<{
        folderId: number;
        ownerCount: number;
      }>;
      const ownerCounts = new Map(
        owners.map((owner) => [owner.folderId, owner.ownerCount]),
      );
      const reliablyLinkedPosts = new Set(
        locals
          .filter(
            (copy) =>
              copy.postId !== null &&
              copy.ownerId === creatorId &&
              copy.matchStatus === 'matched' &&
              copy.localMatchStatus === 'matched' &&
              copy.folderId === copy.postFolderId,
          )
          .map((copy) => copy.postId),
      );
      const legacyGaps = candidatePosts
        .filter(
          (post) =>
            !reliablyLinkedPosts.has(post.postId) &&
            ownerCounts.get(post.folderId) === 1,
        )
        .map(({ postId, title }) => ({ postId, title }));
      const legacyPosts = legacyGaps.length;
      const retainedRows = db
        .prepare(
          `SELECT d.local_work_id AS localId,d.payload_json AS payload FROM archive_catalog_work_decisions d
        JOIN archive_catalog_works w ON w.id=d.work_id WHERE w.creator_id=? AND d.state='active' AND d.kind='admission_file_removal'`,
        )
        .all(creatorId) as unknown as Array<{
        localId: number;
        payload: string;
      }>;
      const retainedCounts = new Map<number, number>();
      for (const row of retainedRows) {
        try {
          const payload = JSON.parse(row.payload) as {
            retainOriginal?: boolean;
          };
          if (payload.retainOriginal)
            retainedCounts.set(
              row.localId,
              (retainedCounts.get(row.localId) ?? 0) + 1,
            );
        } catch {
          /* No invented count for malformed historical evidence. */
        }
      }
      const ingestRetention = db
        .prepare(
          `SELECT l.id AS localId,
        MIN(CAST(json_extract(j.summary_json,'$.retainedOriginalCount') AS INTEGER)) AS minCount,
        MAX(CAST(json_extract(j.summary_json,'$.retainedOriginalCount') AS INTEGER)) AS maxCount
        FROM archive_catalog_works w JOIN archive_catalog_local_works l ON l.work_id=w.id
        JOIN archive_catalog_source_works s ON s.work_id=w.id
        JOIN local_ingest_jobs j ON j.source_work_id=s.id AND j.creator_id=w.creator_id
        WHERE w.creator_id=? AND j.status='ingested'
        AND replace(j.target_path,char(92),'/')=replace(l.absolute_path,char(92),'/')
        AND json_valid(j.summary_json) AND json_type(j.summary_json,'$.retainedOriginalCount')='integer'
        AND json_extract(j.summary_json,'$.retainedOriginalCount')>=0
        GROUP BY l.id`,
        )
        .all(creatorId) as unknown as Array<{
        localId: number;
        minCount: number;
        maxCount: number;
      }>;
      const retainedByIngest = new Map(
        ingestRetention.map((row) => [
          row.localId,
          row.minCount === row.maxCount ? row.minCount : null,
        ]),
      );
      const retentionCount = (localId: number) => {
        const admission = retainedCounts.get(localId);
        const ingest = retainedByIngest.get(localId);
        if (ingest === undefined) return admission ?? null;
        if (admission === undefined) return ingest;
        return admission === ingest ? admission : null;
      };
      const byWork = new Map<number, Copy[]>();
      for (const copy of locals) {
        const list = byWork.get(copy.workId) ?? [];
        list.push(copy);
        byWork.set(copy.workId, list);
      }
      const mediaById = new Map(media.map((row) => [row.localId, row]));
      const sourcesByWork = new Map<number, ResourceCatalogSource[]>();
      for (const source of sourceRows) {
        const list = sourcesByWork.get(source.workId) ?? [];
        list.push({
          sourceWorkId: source.sourceWorkId,
          platform: source.platform,
          sourceOrder: source.sourceOrder,
          sourceOrderLabel: source.sourceOrderLabel,
          title: source.title,
          mediaSummary: source.mediaSummary,
          url: safeResourceSourceUrl(source.url),
          active: Boolean(source.active),
        });
        sourcesByWork.set(source.workId, list);
      }
      let sourceOnlyWorks = 0;
      let excludedDeletedWorks = 0;
      const rows: ResourceCatalogRow[] = [];
      const copies = new Map<number, ResourceCatalogCopy[]>();
      for (const work of works) {
        const all = byWork.get(work.id) ?? [];
        if (!all.length) {
          if (sourcesByWork.has(work.id)) sourceOnlyWorks += 1;
          continue;
        }
        const viable = all.filter((copy) => !copy.deleted && !copy.trashed);
        const primary =
          work.primaryId === null
            ? viable.length === 1
              ? viable[0]
              : undefined
            : all.find((copy) => copy.id === work.primaryId);
        if (
          primary?.deleted ||
          primary?.trashed ||
          (!viable.length && work.primaryId === null)
        ) {
          excludedDeletedWorks += 1;
          continue;
        }
        const owned =
          primary &&
          primary.ownerId === creatorId &&
          primary.matchStatus === 'matched' &&
          primary.localMatchStatus === 'matched' &&
          primary.folderRole === 'normal' &&
          !primary.explicitCover &&
          primary.folderId === primary.postFolderId &&
          (ownerCounts.get(primary.folderId!) ?? 0) <= 1;
        const sortable =
          owned &&
          primary.postId !== null &&
          primary.sortTimestamp !== null &&
          Number.isFinite(primary.sortTimestamp) &&
          primary.sortTimestamp > 0;
        const available = Boolean(
          owned &&
          primary.active &&
          primary.folderActive &&
          primary.deleted === 0 &&
          primary.trashed === 0,
        );
        const stats = owned ? mediaById.get(primary!.id) : undefined;
        const row: ResourceCatalogRow = {
          workId: work.id,
          no: null,
          title: work.title,
          sortTimestamp: sortable ? primary!.sortTimestamp : null,
          primaryPostId: owned ? primary!.postId : null,
          primaryLocalWorkId: primary?.id ?? null,
          imageCount: stats?.imageCount ?? null,
          videoCount: stats?.videoCount ?? null,
          mediaBytes: stats?.mediaBytes ?? null,
          originalDirectory: primary ? nameOnly(primary.directoryName) : null,
          localState: !sortable
            ? 'unarranged'
            : available
              ? 'indexed'
              : 'unavailable',
          reason: !primary
            ? '无法确定主副本'
            : !owned
              ? '主副本归属或索引关系待核对'
              : !sortable
                ? '缺少可靠排序时间或Post索引'
                : !available
                  ? '主副本不可用，按最后索引记录'
                  : null,
          statisticsBasis: !stats
            ? 'unknown'
            : available
              ? 'indexed'
              : 'last-indexed',
          copyCount: all.length,
          sources: sourcesByWork.get(work.id) ?? [],
          text: '',
        };
        rows.push(row);
        copies.set(
          work.id,
          all.map((copy) => {
            const m = mediaById.get(copy.id);
            return {
              localWorkId: copy.id,
              postId: copy.deleted || copy.trashed ? null : copy.postId,
              directoryName: nameOnly(copy.directoryName),
              primary: copy.id === primary?.id,
              indexedAvailable: Boolean(
                copy.active &&
                copy.folderActive &&
                copy.deleted === 0 &&
                copy.trashed === 0 &&
                copy.ownerId === creatorId &&
                copy.matchStatus === 'matched' &&
                copy.localMatchStatus === 'matched' &&
                copy.folderRole === 'normal' &&
                !copy.explicitCover &&
                copy.folderId === copy.postFolderId &&
                (ownerCounts.get(copy.folderId!) ?? 0) <= 1,
              ),
              imageCount: m?.imageCount ?? null,
              videoCount: m?.videoCount ?? null,
              mediaBytes: m?.mediaBytes ?? null,
              otherFileCount: copy.otherFileCount,
              retainedOriginalCount: retentionCount(copy.id),
            };
          }),
        );
      }
      rows.sort((a, b) => {
        if (a.sortTimestamp === null || b.sortTimestamp === null)
          return a.sortTimestamp === b.sortTimestamp
            ? a.workId - b.workId
            : a.sortTimestamp === null
              ? 1
              : -1;
        const sign = sortOrder === 'oldest' ? 1 : -1;
        return (
          sign *
            (a.sortTimestamp - b.sortTimestamp ||
              (a.primaryPostId ?? 0) - (b.primaryPostId ?? 0)) ||
          a.workId - b.workId
        );
      });
      let numberedWorks = 0;
      for (const row of rows) {
        if (row.sortTimestamp !== null)
          row.no = `NO.${String(++numberedWorks).padStart(3, '0')}`;
        row.text = resourceCatalogText(creator.canonicalName, row);
      }
      const summary = {
        totalWorks: rows.length,
        numberedWorks,
        unarrangedWorks: rows.length - numberedWorks,
        multipleCopyWorks: rows.filter((row) => row.copyCount > 1).length,
        unavailableWorks: rows.filter((row) => row.localState === 'unavailable')
          .length,
        sourceOnlyWorks,
        legacyPosts,
        excludedDeletedWorks,
      };
      const gaps = legacyGaps.map((gap) => ({
        ...gap,
        reason: '可浏览Post缺少可靠Work对应，本次未补建身份',
      }));
      const revision = createHash('sha256')
        .update(
          JSON.stringify({
            creator,
            sortOrder,
            summary,
            rows,
            copies: [...copies],
            gaps,
          }),
        )
        .digest('hex');
      return {
        page: {
          creator,
          revision,
          generatedAt: new Date().toISOString(),
          sortOrder,
          summary,
          items: rows,
          page: 1,
          pageSize: 50,
          total: rows.length,
          legacyGaps: gaps,
        },
        copies,
      };
    } finally {
      db.exec('RELEASE resource_catalog_read');
    }
  }
  private checkRevision(actual: string, expected?: string) {
    if (expected && expected !== actual)
      throw new ResourceCatalogError(
        409,
        'RESOURCE_CATALOG_CHANGED',
        '作品数据已更新，请刷新资源目录。',
      );
  }
  private filtered(snapshot: Snapshot, filter: ResourceCatalogFilter) {
    this.checkRevision(snapshot.page.revision, filter.revision);
    const q = filter.q?.trim().toLocaleLowerCase();
    return snapshot.page.items.filter(
      (item) =>
        (!q ||
          [
            item.title,
            item.no,
            ...(snapshot.copies.get(item.workId) ?? []).map(
              (copy) => copy.directoryName,
            ),
          ].some((value) => value?.toLocaleLowerCase().includes(q))) &&
        (!filter.localState ||
          filter.localState === 'all' ||
          item.localState === filter.localState) &&
        (!filter.source ||
          filter.source === 'all' ||
          (filter.source === 'linked'
            ? item.sources.length > 0
            : item.sources.length === 0)),
    );
  }
  list(
    creatorId: number,
    filter: ResourceCatalogFilter = {},
  ): ResourceCatalogPage {
    const snapshot = this.snapshot(creatorId);
    const items = this.filtered(snapshot, filter);
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 50));
    return {
      ...snapshot.page,
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: items.length,
      page,
      pageSize,
    };
  }
  detail(
    creatorId: number,
    workId: number,
    revision?: string,
  ): ResourceCatalogDetail {
    const snapshot = this.snapshot(creatorId);
    this.checkRevision(snapshot.page.revision, revision);
    const item = snapshot.page.items.find((row) => row.workId === workId);
    if (!item)
      throw new ResourceCatalogError(
        404,
        'WORK_NOT_FOUND',
        '该作品不在当前本地目录中。',
      );
    return {
      revision: snapshot.page.revision,
      item,
      copies: snapshot.copies.get(workId) ?? [],
      notes: [
        '本地统计仅包含有效已索引媒体；来源声明独立保留，不代表文件逐字节一致。',
        '其他附件及保留原件不计入媒体容量；本次未检查磁盘。',
      ],
    };
  }
  export(
    creatorId: number,
    format: 'txt' | 'csv',
    scope: 'all' | 'filtered',
    filter: ResourceCatalogFilter = {},
  ) {
    const snapshot = this.snapshot(creatorId);
    this.checkRevision(snapshot.page.revision, filter.revision);
    const rows =
      scope === 'all' ? snapshot.page.items : this.filtered(snapshot, filter);
    if (format === 'txt')
      return [
        'CosGallery资源目录',
        `博主：${plain(snapshot.page.creator.canonicalName)}`,
        `生成时间：${snapshot.page.generatedAt}`,
        `编目顺序：${snapshot.page.sortOrder === 'oldest' ? '最早优先' : '最新优先'}`,
        `导出范围：${scope === 'all' ? '完整目录' : '当前筛选结果'}`,
        'NO是该时点目录序号，本地文件名未修改。',
        '',
        ...rows.map((row) => row.text),
      ].join('\r\n');
    const headers = [
      'creatorId',
      'workId',
      'no',
      'title',
      'sortTimestamp',
      'primaryPostId',
      'primaryLocalWorkId',
      'imageCount',
      'videoCount',
      'mediaBytes',
      'originalDirectory',
      'localState',
      'statisticsBasis',
      'sources',
    ];
    return (
      '\uFEFF' +
      [
        headers.map(csvCell).join(','),
        ...rows.map((row) =>
          [
            creatorId,
            row.workId,
            row.no,
            row.title,
            row.sortTimestamp,
            row.primaryPostId,
            row.primaryLocalWorkId,
            row.imageCount,
            row.videoCount,
            row.mediaBytes,
            row.originalDirectory,
            row.localState,
            row.statisticsBasis,
            JSON.stringify(row.sources),
          ]
            .map(csvCell)
            .join(','),
        ),
      ].join('\r\n')
    );
  }
}
