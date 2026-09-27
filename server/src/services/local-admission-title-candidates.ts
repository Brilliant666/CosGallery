import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { parseWorkTitle } from '../utils/work-title.js';

export type AdmissionMatchEvidence = { level: 'exact' | 'similar' | 'path'; reasons: string[] };
type IndexedTitle = { workId: number; kind: 'title' | 'directory'; volumeSignature?: string };
const volumeSignature=(title:string)=>[...title.normalize('NFKC').matchAll(/\bvol\.?\s*(\d+)/giu)].map(match=>String(Number(match[1]))).join(',');
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ONLY a manual-review recall key. Version suffix differences never establish
// Work identity. VOL suffix removal is confined to this lossy recall key;
// the original version/number and exact parser output remain untouched.
function versionSuggestionKey(title: string, names: readonly string[]) {
  const parsed = parseWorkTitle(title, names);
  const stripped = parsed.displayTitle.replace(/\s*\+\s*video\s*$/iu, '')
    .replace(/\s+[\p{L}\p{N}]+[. _-]*ver\.?\s*$/iu, '')
    .replace(/\s+vol\.?\s*\d+\s*$/iu, '').trim();
  return parseWorkTitle(stripped, names).candidateKey;
}

/** One creator-scoped load per preview; no source requirement or per-directory library query. */
export class LocalAdmissionTitleCandidates {
  private readonly names: string[];
  private readonly exact = new Map<string, IndexedTitle[]>();
  private readonly similar = new Map<string, IndexedTitle[]>();
  private readonly versions = new Map<string, IndexedTitle[]>();
  readonly workIds: ReadonlySet<number>;
  private readonly initialFingerprint: string;

  constructor(private readonly db: DatabaseSync, private readonly creatorId: number) {
    const facts=this.readFacts();this.initialFingerprint=fingerprint(facts);
    this.names=facts.names.map(row=>String(row.name));
    this.workIds = new Set(facts.works.map(row => Number(row.id)));
    for (const row of facts.works) this.index(String(row.display_title), { workId: Number(row.id), kind: 'title' });
    for (const row of facts.directories) {
      this.index(String(row.folder_name), { workId: Number(row.work_id), kind: 'directory' });
    }
  }

  private readFacts() {
    // A short read snapshot; never hold it over asynchronous disk inventory.
    this.db.exec('SAVEPOINT admission_title_facts');
    try{return {
      names:this.db.prepare(`SELECT 'canonical' AS kind,id AS recordId,canonical_name AS name,is_active FROM archive_catalog_creators WHERE id=?
        UNION ALL SELECT 'alias',rowid,alias,1 FROM archive_catalog_creator_aliases WHERE creator_id=? ORDER BY kind,recordId,name COLLATE BINARY`).all(this.creatorId,this.creatorId),
      works:this.db.prepare('SELECT id,display_title FROM archive_catalog_works WHERE creator_id=? ORDER BY id').all(this.creatorId),
      directories:this.db.prepare(`SELECT l.id,l.work_id,l.folder_name FROM archive_catalog_local_works l
        JOIN archive_catalog_works w ON w.id=l.work_id WHERE w.creator_id=? ORDER BY l.id`).all(this.creatorId),
    };}finally{this.db.exec('RELEASE admission_title_facts');}
  }

  /** Called once under the draft-save transaction, after all asynchronous work. */
  unchanged() { return this.initialFingerprint===fingerprint(this.readFacts()); }

  private index(title: string, entry: IndexedTitle) {
    entry={...entry,volumeSignature:volumeSignature(title)};
    const parsed = parseWorkTitle(title, this.names);
    for (const [map, key] of [[this.exact, parsed.exactKey], [this.similar, parsed.candidateKey],
      [this.versions, versionSuggestionKey(title, this.names)]] as const) {
      if (key) map.set(key, [...(map.get(key) ?? []), entry]);
    }
  }

  find(title: string): Map<number, AdmissionMatchEvidence> {
    const parsed = parseWorkTitle(title, this.names);
    const matches = new Map<number, AdmissionMatchEvidence>();
    const add = (entries: IndexedTitle[] | undefined, level: AdmissionMatchEvidence['level'], reason: string) => {
      for (const entry of entries ?? []) {
        const previous = matches.get(entry.workId);
        if(previous&&level==='similar')continue;
        const versionMismatch=level==='exact'&&entry.volumeSignature!==volumeSignature(title);
        const actualLevel=versionMismatch?'similar':level;
        const description = `${entry.kind === 'directory' ? '已有本地目录名' : '已有作品标题'}${versionMismatch?'存在VOL版本差异；仅供人工核对':reason}`;
        const reasons = [...new Set([...(previous?.reasons ?? []), description])];
        matches.set(entry.workId, { level: previous?.level === 'exact' ? 'exact' : actualLevel, reasons });
      }
    };
    add(this.exact.get(parsed.exactKey), 'exact', '规范化后相同；仍需人工确认作品身份');
    add(this.similar.get(parsed.candidateKey), 'similar', '忽略大小写、间距或标点后相似；不是身份依据');
    add(this.versions.get(versionSuggestionKey(title, this.names)), 'similar', '标题主体相似，可能存在版本或视频内容差异；仅供人工核对');
    return matches;
  }

  sourceEvidence(title: string, sourceTitle: string): AdmissionMatchEvidence {
    const incoming=parseWorkTitle(title,this.names),source=parseWorkTitle(sourceTitle,this.names);
    const exact=!!incoming.exactKey&&incoming.exactKey===source.exactKey&&volumeSignature(title)===volumeSignature(sourceTitle);
    return {level:exact?'exact':'similar',
      reasons:[exact?'已有来源标题规范化后相同；仍需人工确认作品身份':'已有来源标题相关，可能存在版本差异；来源编号不作为作品身份']};
  }
}
