import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { parseWorkTitle } from '../utils/work-title.js';

export type AdmissionMatchEvidence = { level: 'exact' | 'similar' | 'path'; reasons: string[] };
export type AdmissionPeerCandidate = { sourceRelativePath: string; reasons: string[] };
type IndexedTitle = { workId: number; kind: 'title' | 'directory'; volumeSignature?: string };
const volumeSignature=(title:string)=>[...title.normalize('NFKC').matchAll(/\bvol\.?\s*(\d+)/giu)].map(match=>String(Number(match[1]))).join(',');
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ONLY a manual-review recall key. Version suffix differences never establish
// Work identity. VOL suffix removal is confined to this lossy recall key;
// the original version/number and exact parser output remain untouched.
function reviewTitle(title:string,names:readonly string[]) {
  // Shared exact parsing intentionally preserves more information. Extra
  // presentation cleanup here is ONLY for explicit manual review suggestions.
  let normalized=title.normalize('NFKC').replace(/\s*\[(?=[^\]]*\d)(?:\d+(?:\.\d+)?\s*(?:P|V|KB|MB|GB|TB|K|M|G|T|B)[\s+\-/]*)+\]\s*$/iu,'').trim();
  const patterns=names.filter(Boolean).sort((a,b)=>b.length-a.length).map(name=>{
    const escaped=[...name.normalize('NFKC').replace(/\s+/gu,'')].map(char=>char.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')).join('\\s*');
    return new RegExp(`^(?:\\(\\s*${escaped}\\s*\\)|\\[\\s*${escaped}\\s*\\]|${escaped}(?=$|[\\s_]))[\\s_]*`,'iu');
  });
  // Prefixes may repeat as canonical name + parenthesized registered alias.
  // Only already registered names are removed; this never learns an alias.
  for(let n=0;n<names.length+1;n++){
    const next=patterns.reduce((value,pattern)=>value.replace(pattern,''),normalized).trim();
    if(next===normalized)break;normalized=next;
  }
  return parseWorkTitle(normalized,names).displayTitle.trim();
}

function versionSuggestionKey(title: string, names: readonly string[]) {
  let stripped=reviewTitle(title,names);
  const color='(?:red|blue|green|black|white|pink|purple|yellow|orange|gray|grey|silver|gold)';
  // Peel suffix wrappers/markers, not arbitrary middle title words/numbers.
  const suffix=new RegExp(`(?:[\\s_.+-]+|\\s*[([]\\s*)(?:\\+?\\s*video|v\\d+|${color}(?:[. _-]*ver\\.?)?(?:[ _-]+sp)?|[\\p{L}\\p{N}]+[. _-]+ver\\.?|vol\\.?\\s*\\d+)\\s*[)\\]]?\\s*$`,'iu');
  for(let n=0;n<4;n++){const next=stripped.replace(suffix,'').trim();if(next===stripped)break;stripped=next;}
  return parseWorkTitle(stripped, names).candidateKey;
}

function studioSeriesKey(title:string,names:readonly string[]) {
  const value=reviewTitle(title,names);
  // Both an explicit studio token AND structured alphabetic series-number
  // are required. A bare NO, equal file counts or byte sizes is never evidence.
  const match=/^(?:\[([\p{L}\p{N} .&_\-]{2,40})\]|([A-Z][A-Z0-9_&]*(?:\s+[A-Z][A-Z0-9_&]*){0,4}))\s+([A-Z]{2,10})[ -]+(\d{2,6})(?=\s|$)/u.exec(value);
  if(!match||['NO','VOL','VER'].includes(match[3]!))return '';
  return `${(match[1]??match[2])!.replace(/\s+/gu,'').toLocaleLowerCase('en-US')}|${match[3]}|${Number(match[4])}`;
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

  /** Selected siblings only: indexed joins, capped output, no pairwise n² scan. */
  peers(paths:readonly string[]):Map<string,{items:AdmissionPeerCandidate[];truncated:boolean}> {
    const rows=[...new Set(paths)].sort().map(sourceRelativePath=>{
      const parsed=parseWorkTitle(sourceRelativePath,this.names),volume=volumeSignature(sourceRelativePath);
      const series=studioSeriesKey(sourceRelativePath,this.names);
      const numberedOnly=/^(?:(?:NO\.?|VOL\.?)\s*)?\d+$/iu.test(reviewTitle(sourceRelativePath,this.names));
      const keys=[
        ['exact',parsed.exactKey,'本批目录标题规范化后相同；是否同一作品仍需人工确认'],
        ['candidate',parsed.candidateKey,'本批目录标题忽略大小写、间距或标点后相似；仅供核对'],
        ['version',versionSuggestionKey(sourceRelativePath,this.names),'本批目录标题主体相似，可能有颜色、版本或视频内容差异；仅供核对'],
        ['series',series,'本批目录具有相同明确厂牌及系列编号；标题可能不同，不能仅凭编号认同作品'],
      ].filter(([,key])=>!!key&&!numberedOnly).map(([kind,key,reason])=>({key:JSON.stringify([kind,key,volume]),reason:reason!}));
      return {sourceRelativePath,keys};
    });
    const buckets=new Map<string,string[]>();
    for(const row of rows)for(const {key} of row.keys){const entries=buckets.get(key)??[];entries.push(row.sourceRelativePath);buckets.set(key,entries);}
    const result=new Map<string,{items:AdmissionPeerCandidate[];truncated:boolean}>();
    for(const row of rows){
      const matches=new Map<string,AdmissionPeerCandidate>();let truncated=false;
      for(const {key,reason} of row.keys){const bucket=buckets.get(key)!;
        if(bucket.length>51)truncated=true;
        // The extra slot covers self exclusion. Multiple keys add at most 4×51
        // candidates, independent of dense bucket size.
        for(const peer of bucket.slice(0,52))if(peer!==row.sourceRelativePath&&!matches.has(peer))matches.set(peer,{sourceRelativePath:peer,reasons:[reason]});
      }
      const items=[...matches.values()].sort((a,b)=>a.sourceRelativePath<b.sourceRelativePath?-1:a.sourceRelativePath>b.sourceRelativePath?1:0);
      result.set(row.sourceRelativePath,{items:items.slice(0,50),truncated:truncated||items.length>50});
    }
    return result;
  }
}
