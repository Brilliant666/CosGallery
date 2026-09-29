import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeCreatorIdentity } from '../utils/creator-identity.js';
import { LOCAL_ADMISSION_LOCK_KEY } from './local-admission-lock.js';

export interface CreatorDeletionBlocker { code: string; label: string; count: number }
export interface CreatorDeletionPreview {
  creatorId: number; name: string; eligible: boolean; blockers: CreatorDeletionBlocker[];
  confirmationToken: string; removableAliases: number;
  removalScope: Array<{ kind: string; label: string; count: number }>;
}
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const derived = new Set(['resource_catalog_state', 'resource_catalog_rows', 'resource_catalog_meta']);
const labels: Record<string, string> = {
  archive_catalog_creator_sources: '来源身份', archive_catalog_collections: '来源合集',
  archive_catalog_source_works: '其他来源合集仍关联的作品', archive_catalog_local_works: '本地副本（包括停用及回收站内副本）',
  archive_catalog_deliveries: '来源交付或转存历史', archive_catalog_download_tasks: '下载任务（包括历史任务）',
  work_removals: '作品回收或永久删除记录', removal_operations: '回收、恢复或删除操作记录',
  work_removal_paths: '作品恢复路径记录',
  archive_catalog_works: '作品（包括历史作品）', archive_catalog_local_creator_folders: '本地目录关系（包括停用关系）',
  archive_catalog_metadata_tasks: '来源检查任务（包括历史任务）', local_ingest_jobs: '本地入库任务（包括历史任务）',
  local_ingest_file_observations: '待入库文件观察记录', archive_local_admission_plans: '原接纳计划',
  archive_catalog_work_decisions: '作品决定/恢复历史', local_admission_web_batches: '网页入库批次',
  local_admission_web_collections: '集中入库记录', local_review_web_sessions: '网页审核记录',
  source_evidence_pages: '来源资料页面', source_evidence_observations: '来源资料观察记录',
  source_evidence_identity_decisions: '来源归属决定', source_evidence_admission_links: '来源接纳关联'
};
const normalizedKey = (key: string) => key.replaceAll('_', '').toLowerCase();

type Row = Record<string, unknown>;
/** This whitelist is also the complete audit snapshot. No generic cascade is used. */
export function creatorDeletionRows(db: DatabaseSync, id: number): Record<string, Row[]> {
  return {
    archive_catalog_creators: db.prepare('SELECT * FROM archive_catalog_creators WHERE id=?').all(id),
    archive_catalog_creator_aliases: db.prepare('SELECT * FROM archive_catalog_creator_aliases WHERE creator_id=? ORDER BY source,normalized_alias').all(id),
    archive_catalog_creator_sources: db.prepare('SELECT * FROM archive_catalog_creator_sources WHERE creator_id=? ORDER BY source,source_creator_id').all(id),
    archive_catalog_collections: db.prepare('SELECT * FROM archive_catalog_collections WHERE creator_id=? ORDER BY id').all(id),
    archive_catalog_works: db.prepare('SELECT * FROM archive_catalog_works WHERE creator_id=? ORDER BY id').all(id),
    archive_catalog_source_works: db.prepare(`SELECT sw.* FROM archive_catalog_source_works sw
      JOIN archive_catalog_collections c ON c.id=sw.collection_id WHERE c.creator_id=? ORDER BY sw.id`).all(id)
  };
}

function referencesRemovedEntities(value: unknown, entities: Map<string, Set<string>>, key = '', depth = 0): boolean {
  if (depth > 64) throw new Error('Uninspectable nested evidence');
  const field = normalizedKey(key);
  for (const [kind, ids] of entities) {
    if (field === `${kind}id` || field === `${kind}ids` || field === `target${kind}id`) {
      const values = Array.isArray(value) ? value : [value];
      if (values.some(v => (typeof v === 'number' || typeof v === 'string') && ids.has(String(v)))) return true;
    }
    if ([kind, `${kind}s`].includes(field) && value && typeof value === 'object' && !Array.isArray(value)
      && ids.has(String((value as Row).id))) return true;
  }
  if (typeof value === 'string' && /^\s*[\[{]/u.test(value)) {
    let decoded: unknown;
    try { decoded = JSON.parse(value); }
    catch { if (field.endsWith('json')) throw new Error('Uninspectable serialized evidence'); return false; }
    return referencesRemovedEntities(decoded, entities, key, depth + 1);
  }
  if (Array.isArray(value)) return value.some(v => referencesRemovedEntities(v, entities, key, depth + 1));
  return !!value && typeof value === 'object'
    && Object.entries(value).some(([k, v]) => referencesRemovedEntities(v, entities, k, depth + 1));
}

/** Inspect structured identities, not arbitrary numeric IDs, titles or substrings. */
function references(value: unknown, id: number, names: Set<string>, key = '', depth = 0): boolean {
  if (depth > 64) throw new Error('Uninspectable nested identity evidence');
  const field = normalizedKey(key);
  if ((field.endsWith('creatorid') || field.endsWith('creatorids'))
    && !['sourcecreatorid', 'seedsourcecreatorid'].includes(field)) {
    if (Array.isArray(value)) return value.some(v => references(v, id, names, key, depth + 1));
    if ((typeof value === 'number' || typeof value === 'string') && String(value) === String(id)) return true;
  }
  if (typeof value === 'string') {
    if ((field.endsWith('creatorname') || field.endsWith('creatornames') || field === 'canonicalname'
      || ['unmatchedcreators', 'unmatchedcreatorfolders', 'ambiguouscreatorfolders'].includes(field))
      && names.has(normalizeCreatorIdentity(value))) return true;
    // Historical decisions can embed the original serialized payload as a string.
    if (/^\s*[\[{]/u.test(value)) {
      let decoded: unknown;
      try { decoded = JSON.parse(value); }
      catch {
        if (field.endsWith('json')) throw new Error('Uninspectable serialized identity evidence');
        return false; // A title such as [Studio] Album is not serialized evidence.
      }
      return references(decoded, id, names, key, depth + 1);
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(v => references(v, id, names, key, depth + 1));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (['creator', 'creators', 'candidatecreator', 'selectedcreator'].includes(field)) {
      if (String(object.id) === String(id)) return true;
      if (typeof object.name === 'string' && names.has(normalizeCreatorIdentity(object.name))) return true;
    }
    return Object.entries(object).some(([childKey, child]) => references(child, id, names, childKey, depth + 1));
  }
  return false;
}

/** Read-only, deliberately on-demand. No filesystem reads or business repair.
 * The caller must repeat this inside its reserved writer transaction before DELETE.
 * FK discovery prevents silent CASCADE/SET NULL; JSON covers non-FK historical evidence.
 */
export function inspectCreatorDeletion(db: DatabaseSync, id: number): CreatorDeletionPreview | null {
  const creator = db.prepare('SELECT * FROM archive_catalog_creators WHERE id=?').get(id);
  if (!creator) return null;
  const rows = creatorDeletionRows(db, id);
  const aliases = rows.archive_catalog_creator_aliases;
  const works = rows.archive_catalog_works, sourceWorks = rows.archive_catalog_source_works;
  const workIds = new Set(works.map(row => String(row.id)));
  const sourcedWorkIds = new Set(sourceWorks.map(row => String(row.work_id)));
  const collectionIds = new Set(rows.archive_catalog_collections.map(row => String(row.id)));
  const entities = new Map([
    ['work', workIds], ['collection', collectionIds],
    ['sourcework', new Set(sourceWorks.map(row => String(row.id)))]
  ]);
  const names = new Set([String(creator.canonical_name), ...aliases.map(row => String(row.alias))].map(normalizeCreatorIdentity));
  const blockers: CreatorDeletionBlocker[] = [];
  const add = (code: string, label: string, count = 1) => {
    if (!count) return;
    const existing = blockers.find(item => item.code === code);
    if (existing) existing.count += count;
    else blockers.push({ code, label, count });
  };
  if (creator.is_active !== 0) add('ACTIVE', '请先停用博主；停用不会删除任何资料');
  if (creator.preferred_local_creator_folder_id !== null) add('PREFERRED_FOLDER', '已设置入库目标目录');
  add('UNCLASSIFIED_WORK', '缺少来源记录的独立作品，不能证明为纯来源资料',
    works.filter(work => !sourcedWorkIds.has(String(work.id))).length);
  add('SHARED_SOURCE_WORK', '来源作品指向其他博主的独立作品', sourceWorks.filter(sw => !workIds.has(String(sw.work_id))).length);

  // These predicates describe exactly the same whitelist as creatorDeletionRows.
  // SQL subqueries keep FK checks indexed and avoid materializing unrelated tables.
  const owned: Record<string, string> = {
    archive_catalog_creators: 'id=?',
    archive_catalog_creator_aliases: 'creator_id=?',
    archive_catalog_creator_sources: 'creator_id=?',
    archive_catalog_collections: 'creator_id=?',
    archive_catalog_works: 'creator_id=?',
    archive_catalog_source_works: 'collection_id IN (SELECT id FROM archive_catalog_collections WHERE creator_id=?)'
  };
  const softTargets: Record<string, string> = {
    workid: 'archive_catalog_works', targetworkid: 'archive_catalog_works',
    collectionid: 'archive_catalog_collections', targetcollectionid: 'archive_catalog_collections',
    sourceworkid: 'archive_catalog_source_works', targetsourceworkid: 'archive_catalog_source_works'
  };
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name: rawTable } of tables) {
    const table = String(rawTable);
    // Audits are detached evidence, not live references or name reservations.
    if (derived.has(table) || table === 'creator_deletion_audits') continue;
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all();
    const conditions = new Set<string>();
    for (const fk of foreignKeys) {
      const target = String(fk.table);
      if (!owned[target]) continue;
      const targetColumn = fk.to == null
        ? String(db.prepare(`PRAGMA table_info(${quote(target)})`).all()
          .filter(col => Number(col.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk))[Number(fk.seq)]?.name)
        : String(fk.to);
      conditions.add(`${quote(String(fk.from))} IN (SELECT ${quote(targetColumn)} FROM ${quote(target)} WHERE ${owned[target]})`);
    }
    for (const col of columns) {
      const column = String(col.name), key = normalizedKey(column);
      if (/(?:^|_)creator_id$/u.test(column) && !['source_creator_id', 'seed_source_creator_id'].includes(column))
        conditions.add(`${quote(column)}=?`);
      // These two columns carry external upstream IDs despite sharing the
      // spelling used by task tables for internal SourceWork primary keys.
      const externalSourceId = column === 'source_work_id'
        && ['archive_catalog_source_works', 'archive_catalog_source_bindings'].includes(table);
      const target = externalSourceId ? undefined : softTargets[key];
      if (target) conditions.add(`${quote(column)} IN (SELECT id FROM ${quote(target)} WHERE ${owned[target]})`);
    }
    if (table === 'removal_operations')
      conditions.add("kind='work' AND target_id IN (SELECT id FROM archive_catalog_works WHERE creator_id=?)");
    const exclusion = owned[table] ? `NOT (${owned[table]}) AND ` : '';
    if (conditions.size) {
      const args = [...(owned[table] ? [id] : []), ...[...conditions].map(() => id)];
      const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${exclusion}(${[...conditions].map(c => `(${c})`).join(' OR ')})`).get(...args)?.n);
      add(`REFERENCE:${table}`, labels[table] ?? `业务引用：${table}`, count);
    }
    for (const col of columns) {
      const column = String(col.name);
      if (!column.endsWith('_json')) continue;
      let count = 0, invalid = 0;
      const sql = `SELECT ${quote(column)} AS value FROM ${quote(table)} WHERE ${exclusion}${quote(column)} IS NOT NULL`;
      for (const row of db.prepare(sql).iterate(...(owned[table] ? [id] : []))) {
        try {
          const value: unknown = JSON.parse(String(row.value));
          if (references(value, id, names) || referencesRemovedEntities(value, entities)) count++;
        } catch { invalid++; }
      }
      add(`EVIDENCE:${table}.${column}`, `${labels[table] ?? table}：历史资料引用`, count);
      add(`UNVERIFIED:${table}.${column}`, `${labels[table] ?? table}：资料格式无法完整核对，暂不能证明无引用`, invalid);
    }
  }
  // Settings are not *_json columns. Never return their values (may contain secrets).
  for (const row of db.prepare('SELECT key,value FROM app_settings').iterate()) {
    const key = String(row.key), raw = String(row.value);
    if (key === `archive.costuan-directory-review.${id}`) {
      add('DIRECTORY_REVIEW', '保留的 Costuan 来源目录核对记录');
      continue;
    }
    if (key === 'managed_creators.migration_000016') {
      try {
        const metadata = JSON.parse(raw) as { conflicts?: unknown };
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid migration history');
        if (Array.isArray(metadata.conflicts) && metadata.conflicts.some(value => String(value) === String(id)))
          add('MIGRATION_HISTORY', '博主身份迁移冲突历史');
      } catch { add('UNVERIFIED_MIGRATION', '博主身份迁移历史无法核对'); }
    }
    if (key.startsWith('archive.metadata-check.request.') || key.startsWith('archive.metadata-task.context.')) {
      try {
        const receipt: unknown = JSON.parse(raw);
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Invalid historical receipt');
        if (references(receipt, id, names) || referencesRemovedEntities(receipt, entities)) add('SETTING_REFERENCE', '来源检查设置或历史执行记录仍引用该博主');
      } catch { add('UNVERIFIED_SETTING', '来源检查历史执行记录无法完整核对'); }
      continue;
    }
    if (key === LOCAL_ADMISSION_LOCK_KEY) {
      add('ADMISSION_LOCK', '存在本地接纳/索引执行锁，请在操作结束后重新核对');
      continue;
    }
    if (key === 'local_ingest.allowlist') {
      try {
        const list: unknown = JSON.parse(raw);
        if (!Array.isArray(list) || list.some(v => typeof v !== 'string')) throw new Error('Invalid allowlist');
        if (list.some(v => names.has(normalizeCreatorIdentity(v)))) add('ALLOWLIST', '博主仍在 Costuan 允许处理名单中，请先移除');
      } catch { add('UNVERIFIED_ALLOWLIST', '允许处理名单无法核对'); }
    } else if (/^\s*[\[{]/u.test(raw)) {
      try {
        const value: unknown = JSON.parse(raw);
        if (references(value, id, names) || referencesRemovedEntities(value, entities)) add('SETTING_REFERENCE', '设置或执行记录仍引用该博主');
      }
      catch {
        if (/^(archive[._]|local[._]|managed_creators\.)/u.test(key))
          add('UNVERIFIED_SETTING', '结构化设置或执行记录无法完整核对');
      }
    }
  }
  return {
    creatorId: id, name: String(creator.canonical_name), eligible: blockers.length === 0, blockers,
    removableAliases: aliases.length,
    removalScope: [
      { kind: 'aliases', label: '名称与别名', count: aliases.length },
      { kind: 'sources', label: '来源身份', count: rows.archive_catalog_creator_sources.length },
      { kind: 'collections', label: '来源合集', count: rows.archive_catalog_collections.length },
      { kind: 'sourceWorks', label: '来源作品记录', count: sourceWorks.length },
      { kind: 'works', label: '纯来源独立作品', count: works.length }
    ],
    confirmationToken: createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  };
}
