import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeCreatorIdentity } from '../utils/creator-identity.js';
import { LOCAL_ADMISSION_LOCK_KEY } from './local-admission-lock.js';

export interface CreatorDeletionBlocker { code: string; label: string; count: number }
export interface CreatorDeletionPreview {
  creatorId: number; name: string; eligible: boolean; blockers: CreatorDeletionBlocker[];
  confirmationToken: string; removableAliases: number;
}
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const derived = new Set(['resource_catalog_state', 'resource_catalog_rows', 'resource_catalog_meta']);
const labels: Record<string, string> = {
  archive_catalog_creator_sources: '来源身份', archive_catalog_collections: '来源合集',
  archive_catalog_works: '作品（包括历史作品）', archive_catalog_local_creator_folders: '本地目录关系（包括停用关系）',
  archive_catalog_metadata_tasks: '来源检查任务（包括历史任务）', local_ingest_jobs: '本地入库任务（包括历史任务）',
  local_ingest_file_observations: '待入库文件观察记录', archive_local_admission_plans: '原接纳计划',
  archive_catalog_work_decisions: '作品决定/恢复历史', local_admission_web_batches: '网页入库批次',
  local_admission_web_collections: '集中入库记录', local_review_web_sessions: '网页审核记录',
  source_evidence_pages: '来源资料页面', source_evidence_observations: '来源资料观察记录',
  source_evidence_identity_decisions: '来源归属决定', source_evidence_admission_links: '来源接纳关联'
};
const normalizedKey = (key: string) => key.replaceAll('_', '').toLowerCase();

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
  const aliases = db.prepare('SELECT * FROM archive_catalog_creator_aliases WHERE creator_id=? ORDER BY source,normalized_alias').all(id);
  const names = new Set([String(creator.canonical_name), ...aliases.map(row => String(row.alias))].map(normalizeCreatorIdentity));
  const blockers: CreatorDeletionBlocker[] = [];
  const add = (code: string, label: string, count = 1) => {
    if (!count) return;
    const existing = blockers.find(item => item.code === code);
    if (existing) existing.count += count;
    else blockers.push({ code, label, count });
  };
  if (creator.seed_source !== 'manual') add('NOT_MANUAL', '仅允许删除手工创建的误建博主');
  if (creator.is_active !== 0) add('ACTIVE', '请先停用博主；停用不会删除任何资料');
  if (creator.preferred_local_creator_folder_id !== null) add('PREFERRED_FOLDER', '已设置入库目标目录');
  const unsafeAliases = aliases.filter(row => !['manual', 'manual-history'].includes(String(row.source)));
  add('SOURCE_ALIASES', '来源别名不能随误建身份删除', unsafeAliases.length);

  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name: rawTable } of tables) {
    const table = String(rawTable);
    if (derived.has(table) || table === 'archive_catalog_creators' || table === 'archive_catalog_creator_aliases') continue;
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
    const keys = new Set(db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()
      .filter(fk => fk.table === 'archive_catalog_creators').map(fk => String(fk.from)));
    // Include soft scalar references even when a legacy table omitted its FK.
    for (const col of columns) if (/(?:^|_)creator_id$/u.test(String(col.name))
      && !['source_creator_id', 'seed_source_creator_id'].includes(String(col.name))) keys.add(String(col.name));
    if (keys.size) {
      const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${[...keys].map(key => `${quote(key)}=?`).join(' OR ')}`)
        .get(...[...keys].map(() => id))?.n);
      add(`REFERENCE:${table}`, labels[table] ?? `业务引用：${table}`, count);
    }
    for (const col of columns) {
      const column = String(col.name);
      if (!column.endsWith('_json')) continue;
      let count = 0, invalid = 0;
      for (const row of db.prepare(`SELECT ${quote(column)} AS value FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`).iterate()) {
        try { if (references(JSON.parse(String(row.value)), id, names)) count++; }
        catch { invalid++; }
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
        if (references(receipt, id, names)) add('SETTING_REFERENCE', '来源检查设置或历史执行记录仍引用该博主');
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
      try { if (references(JSON.parse(raw), id, names)) add('SETTING_REFERENCE', '设置或执行记录仍引用该博主'); }
      catch {
        if (/^(archive[._]|local[._]|managed_creators\.)/u.test(key))
          add('UNVERIFIED_SETTING', '结构化设置或执行记录无法完整核对');
      }
    }
  }
  return {
    creatorId: id, name: String(creator.canonical_name), eligible: blockers.length === 0, blockers,
    removableAliases: aliases.length - unsafeAliases.length,
    confirmationToken: createHash('sha256').update(JSON.stringify({ creator, aliases })).digest('hex')
  };
}
