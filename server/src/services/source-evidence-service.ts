import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { databaseManager } from '../db/database.js';
import { normalizeCreatorIdentity } from '../utils/creator-identity.js';
import { parseCostuanCollectionCreator, parseCostuanNumbering } from './costuan-numbering-service.js';
import { costuanIdentityEvidenceSchema, checkedIdentityEvidence } from './costuan-identity-evidence.js';
import { WorkIdentityService } from './work-identity-service.js';

const id = z.number().int().positive();
const key = z.string().trim().min(1).max(240);
export const sourceEvidenceRecordSchema = z.object({
  platform: z.string().trim().min(1).max(60).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).transform(v => v.toLowerCase()),
  pageUrl: z.string().trim().min(1).max(2000),
  pageTitle: z.string().trim().max(1000),
  observedAt: z.string().datetime({ offset: true }).optional(),
  method: z.enum(['manual', 'plugin']),
  rawDirectoryText: z.string().max(200_000).default(''),
  notes: z.string().max(4000).default(''),
  resourceEntries: z.array(z.object({url:z.string().max(2000),label:z.string().max(255)}).strict()).max(20).default([]),
  diagnostics: z.array(z.string().max(1000)).max(30).default([]),
  identityEvidence: costuanIdentityEvidenceSchema.optional(),
  completeness: z.enum(['partial','unknown']).optional()
}).strict();
type RecordInput = z.infer<typeof sourceEvidenceRecordSchema>;
export type SourceEvidenceEntry = {
  key:string;lineNumber:number;raw:string;state:'candidate'|'range'|'unknown'|'conflict';title:string;
  sourceOrder?:string;range?:{first:number;last:number;count:number};diagnostics:string[];
};
export type SourceEvidenceLink = {
  id:number;observationId:number;creatorId:number;workId:number;localWorkId:number|null;
  planId:string|null;itemKey:string|null;entryKey:string|null;key:string;reason:string;createdAt:string;
  kind:'batch'|'exact';sourceWorkId:number|null;identityDecisionId:number|null;
};
export type SourceEvidenceObservation = Omit<RecordInput,'identityEvidence'|'completeness'|'observedAt'> & {
  id:number;pageKey:string;observedAt:string;createdAt:string;candidateCreatorId:number;creatorId:number|null;
  identityState:'confirmed'|'candidate'|'conflict';identityRevision:number;identityReason:string;
  completeness:'partial'|'unknown';parsedEntries:SourceEvidenceEntry[];
  links:SourceEvidenceLink[];entryMappings:SourceEvidenceLink[];
};
type ObservationRow = {
  id:number;page_id:number;page_key:string;creator_id:number|null;identity_revision:number;
  candidate_creator_id:number;identity_state:SourceEvidenceObservation['identityState'];identity_reason:string;
  page_reason:string;payload_json:string;parsed_json:string;completeness:'partial'|'unknown';created_at:string;
};
export class SourceEvidenceError extends Error {
  constructor(message:string,readonly status=400) { super(message); }
}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>[name,canonical(item)]));
  return value;
}
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const secretKey = /(?:^(?:pwd|passcode|passwd|auth|authorization|cookie|session|sessionid|bdstoken|bduss|stoken|sign|sekey|randsk|提取码|密码)$|token|password|secret|api[_-]?key)/i;
function publicUrl(value:string):string {
  let url:URL;
  try { url=new URL(value); } catch { throw new SourceEvidenceError('来源位置必须是完整 HTTP/HTTPS URL。'); }
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new SourceEvidenceError('来源位置只允许不含认证信息的 HTTP/HTTPS URL。');
  for (const name of [...url.searchParams.keys()]) if(secretKey.test(name)) url.searchParams.delete(name);
  url.hash=''; url.searchParams.sort();
  return url.toString();
}
function safeText(value:string):string {
  if (/<(?:!doctype|html|body|script|iframe)\b/i.test(value)) throw new SourceEvidenceError('仅接收业务纯文本，不接收完整 HTML、脚本或附件。');
  return value.replace(/^\s*(?:cookie|authorization)\s*[:=：].*$/gimu,'[已移除会话凭据行]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|bdstoken|bduss|stoken|passcode|api[_-]?key|secret|password|passwd|提取码|解压密码|密码)\s*[:=：]\s*)[^\s\n,;]+/giu,'$1[已移除凭据]')
    .replace(/https?:\/\/[^\s<>]+/giu,match => { try { return publicUrl(match); } catch { return '[已移除不安全URL]'; } });
}
function parseEntries(record:RecordInput):SourceEvidenceEntry[] {
  const lines=record.rawDirectoryText.split(/\r?\n/);
  if(lines.length>5000) throw new SourceEvidenceError('原始目录最多 5000 行。');
  const entries=lines.flatMap((raw,index):SourceEvidenceEntry[]=>{
    if(!raw.trim()) return [];
    const entry:SourceEvidenceEntry={key:`line-${index+1}`,lineNumber:index+1,raw,state:'unknown',title:raw.trim(),diagnostics:[]};
    // Other platforms retain their true text; Costuan numbering semantics are
    // never projected onto unknown websites.
    if(record.platform!=='costuan') return [entry];
    try {
      const number=parseCostuanNumbering(raw);
      if(number) {
        entry.sourceOrder=number.canonicalLabel;
        entry.title=raw.normalize('NFKC').slice(number.end).trim();
        entry.state=entry.title ? (number.range?'range':'candidate') : 'unknown';
        if(number.range) {
          entry.range={first:number.range.first,last:number.range.last,count:number.range.count};
          entry.diagnostics.push('范围只表示来源声明，未展开为作品或文件需求。');
        }
      } else entry.diagnostics.push('保留未解释文本，未推断作品身份。');
    } catch(error) {entry.state='conflict';entry.diagnostics.push(error instanceof Error?error.message:'编号不明确');}
    return [entry];
  });
  // Interval overlap does not expand ranges to fabricated Work/file identities.
  const bounds=(entry:SourceEvidenceEntry)=>entry.range??(entry.sourceOrder?.match(/^(?:NO|VOL)\.(\d+)$/i)?{first:Number(entry.sourceOrder.split('.')[1]),last:Number(entry.sourceOrder.split('.')[1])}:null);
  for(let i=0;i<entries.length;i++) {
    const a=bounds(entries[i]); if(!a) continue;
    for(let j=0;j<i;j++) {
      const b=bounds(entries[j]); if(!b || entries[i].sourceOrder?.split('.')[0]!==entries[j].sourceOrder?.split('.')[0])continue;
      if(a.first<=b.last && b.first<=a.last) for(const entry of [entries[i],entries[j]]) {
        entry.state='conflict';if(!entry.diagnostics.includes('来源编号重叠，需确认条目边界。'))entry.diagnostics.push('来源编号重叠，需确认条目边界。');
      }
    }
  }
  return entries;
}

/** Evidence is not SourceWork, an acquisition authorization or a completed task. */
export class SourceEvidenceService {
  constructor(private readonly database:DatabaseSync=databaseManager.connection) {}
  private atomic<T>(action:()=>T):T {
    const name=`evidence_${randomUUID().replaceAll('-','')}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try { const result=action();this.database.exec(`RELEASE ${name}`);return result; }
    catch(error){this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);throw error;}
  }
  private creator(creatorId:number) {
    id.parse(creatorId);
    if(!this.database.prepare('SELECT id FROM archive_catalog_creators WHERE id=? AND is_active=1').get(creatorId)) throw new SourceEvidenceError('规范博主不存在或已停用。',409);
  }
  private identity(record:RecordInput,pageKey:string,creatorId:number,pageCreator:number|null) {
    const owners=this.database.prepare(`SELECT creator_id FROM archive_catalog_collections WHERE source=? AND source_collection_id=?
      UNION SELECT creator_id FROM archive_catalog_creator_sources WHERE source=? AND source_creator_id=?`)
      .all(record.platform,pageKey,record.platform,`collection:${pageKey}`) as Array<{creator_id:number}>;
    const allOwners=new Set([...owners.map(v=>v.creator_id),...(pageCreator===null?[]:[pageCreator])]);
    if([...allOwners].some(value=>value!==creatorId)) return {state:'conflict' as const,reason:'此平台页面已有其他规范博主归属，不能改绑。'};
    const names:string[]=[];
    if(record.platform==='costuan') {
      const titleName=parseCostuanCollectionCreator(record.pageTitle);
      if(titleName) names.push(titleName,...titleName.split(/[/()（）]/).map(v=>v.trim()).filter(Boolean));
      for(const line of record.rawDirectoryText.split(/\r?\n/)) {
        try {
          const number=parseCostuanNumbering(line);
          if(number && number.start>0 && ['explicit','implicit'].includes(number.style))names.push(line.normalize('NFKC').slice(0,number.start).trim());
        } catch { /* Invalid directory numbering is retained below, not identity proof. */ }
      }
      // Bad/other-page tag evidence is retained as a diagnostic conflict, not
      // used to authenticate a creator selected by the client.
      if(record.identityEvidence) {
        try { names.push(...checkedIdentityEvidence(record.identityEvidence,pageKey).creatorTags.map(tag=>tag.name)); }
        catch {return {state:'conflict' as const,reason:'本篇身份标签证据与来源页面不一致。'};}
      }
    }
    const matches=(name:string)=>{
      const normalized=normalizeCreatorIdentity(name);
      return (this.database.prepare(`SELECT id FROM archive_catalog_creators WHERE normalized_name=?
        UNION SELECT creator_id AS id FROM archive_catalog_creator_aliases WHERE normalized_alias=?`).all(normalized,normalized) as Array<{id:number}>).map(row=>row.id);
    };
    for(const name of names) {
      const ids=matches(name);
      if(ids.length>1 || ids.some(value=>value!==creatorId)) return {state:'conflict' as const,reason:'页面明确名称或标签指向其他博主或存在歧义，保留未确认资料。'};
    }
    if(allOwners.has(creatorId)) return {state:'confirmed' as const,reason:'复用此平台页面已有的明确身份绑定。'};
    // A complete, exact title name plus a checked article-local tag is sufficient
    // for page identity, independently of directory completeness.
    if(record.platform==='costuan' && record.identityEvidence) {
      const titleName=parseCostuanCollectionCreator(record.pageTitle);
      if(titleName && matches(titleName).length===1 && matches(titleName)[0]===creatorId
        && record.identityEvidence.creatorTags.some(tag=>matches(tag.name).length===1 && matches(tag.name)[0]===creatorId)) {
        return {state:'confirmed' as const,reason:'完整规范名/已登记别名和本篇标签一致；仅确认页面归属，不证明目录完整。'};
      }
    }
    return {state:'candidate' as const,reason:'已保留候选博主；需要确认此具体页面的归属。'};
  }
  save(input:{creatorId:number;requestId:string;record:unknown},requestScope='manual') {
    this.creator(input.creatorId);key.parse(input.requestId);
    const original=sourceEvidenceRecordSchema.parse(input.record);
    const record:RecordInput={...original,pageUrl:publicUrl(original.pageUrl),pageTitle:safeText(original.pageTitle),
      rawDirectoryText:safeText(original.rawDirectoryText),notes:safeText(original.notes),
      diagnostics:original.diagnostics.map(safeText),resourceEntries:original.resourceEntries.map(entry=>({url:publicUrl(entry.url),label:safeText(entry.label)})),
      ...(original.identityEvidence?{identityEvidence:{...original.identityEvidence,pageUrl:publicUrl(original.identityEvidence.pageUrl),
        creatorTags:original.identityEvidence.creatorTags.map(tag=>({name:safeText(tag.name),url:publicUrl(tag.url)}))}}:{})};
    if(JSON.stringify(original)!==JSON.stringify(record)) record.diagnostics.push('资料中的明确凭据或URL认证参数已移除；分享密码仍须使用既有受保护存储。');
    const url=new URL(record.pageUrl);
    const pageKey=record.platform==='costuan'
      ? (['costuan.com','www.costuan.com'].includes(url.hostname) && /^\/(\d+)\.html$/.exec(url.pathname)?.[1]) : record.pageUrl;
    if(!pageKey) throw new SourceEvidenceError('Costuan 页面必须为该平台的具体合集 URL。');
    const requestKey=`${requestScope}:${input.requestId}`;
    const payloadHash=hash({creatorId:input.creatorId,record});
    return this.atomic(()=>{
      const old=this.database.prepare('SELECT id,payload_hash FROM source_evidence_observations WHERE request_key=?').get(requestKey) as {id:number;payload_hash:string}|undefined;
      if(old) {
        if(old.payload_hash!==payloadHash)throw new SourceEvidenceError('请求ID已用于不同资料；不能覆盖原始观察。',409);
        return this.get(old.id);
      }
      const now=new Date().toISOString();
      this.database.prepare('INSERT INTO source_evidence_pages(platform,page_key,created_at) VALUES(?,?,?) ON CONFLICT(platform,page_key) DO NOTHING').run(record.platform,pageKey,now);
      const page=this.database.prepare('SELECT id,creator_id FROM source_evidence_pages WHERE platform=? AND page_key=?').get(record.platform,pageKey) as {id:number;creator_id:number|null};
      const identity=this.identity(record,pageKey,input.creatorId,page.creator_id);
      const entries=parseEntries(record);
      const observedAt=record.observedAt??now;
      const observationId=Number(this.database.prepare(`INSERT INTO source_evidence_observations
        (page_id,candidate_creator_id,request_key,payload_hash,payload_json,identity_state,identity_reason,parsed_json,completeness,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(page.id,input.creatorId,requestKey,payloadHash,JSON.stringify({...record,observedAt}),identity.state,identity.reason,JSON.stringify(entries),entries.length?'partial':'unknown',now).lastInsertRowid);
      if(identity.state==='confirmed' && page.creator_id===null) this.database.prepare(`UPDATE source_evidence_pages SET creator_id=?,identity_revision=identity_revision+1,confirmed_observation_id=?,identity_reason=? WHERE id=? AND creator_id IS NULL`).run(input.creatorId,observationId,identity.reason,page.id);
      return this.get(observationId);
    });
  }
  get(observationId:number):SourceEvidenceObservation {
    id.parse(observationId);
    const row=this.database.prepare(`SELECT o.*,p.page_key,p.creator_id,p.identity_revision,p.identity_reason AS page_reason
      FROM source_evidence_observations o JOIN source_evidence_pages p ON p.id=o.page_id WHERE o.id=?`).get(observationId) as ObservationRow|undefined;
    if(!row)throw new SourceEvidenceError('来源资料不存在。',404);
    const payload=JSON.parse(row.payload_json) as RecordInput & {observedAt:string};
    const {identityEvidence:_privateEvidence,...fields}=payload;
    const identityState=row.identity_state==='conflict'?'conflict':row.creator_id===row.candidate_creator_id?'confirmed':'candidate';
    const links=this.database.prepare(`SELECT id,observation_id AS observationId,creator_id AS creatorId,work_id AS workId,
      local_work_id AS localWorkId,plan_id AS planId,item_key AS itemKey,entry_key AS entryKey,link_key AS key,
      reason,created_at AS createdAt,link_kind AS kind,source_work_id AS sourceWorkId,identity_decision_id AS identityDecisionId
      FROM source_evidence_admission_links WHERE observation_id=? ORDER BY id`).all(observationId) as SourceEvidenceLink[];
    return {...fields,id:row.id,pageKey:row.page_key,createdAt:row.created_at,candidateCreatorId:row.candidate_creator_id,
      creatorId:identityState==='confirmed'?row.creator_id:null,identityState,identityRevision:row.identity_revision,
      identityReason:identityState==='confirmed'?row.page_reason:row.identity_reason,
      completeness:row.completeness,parsedEntries:JSON.parse(row.parsed_json),links:links.filter(link=>link.kind==='batch'),entryMappings:links.filter(link=>link.kind==='exact')};
  }
  list(input:{creatorId:number;page?:number;limit?:number}) {
    this.creator(input.creatorId);
    const page=z.number().int().positive().parse(input.page??1),limit=z.number().int().min(1).max(100).parse(input.limit??20);
    const total=(this.database.prepare('SELECT count(*) n FROM source_evidence_observations WHERE candidate_creator_id=?').get(input.creatorId) as {n:number}).n;
    const rows=this.database.prepare('SELECT id FROM source_evidence_observations WHERE candidate_creator_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(input.creatorId,limit,(page-1)*limit) as {id:number}[];
    return {items:rows.map(row=>this.get(row.id)),total,page,limit};
  }
  confirmIdentity(observationId:number,input:{creatorId:number;requestId:string;reason:string;expectedRevision:number}) {
    this.creator(input.creatorId);key.parse(input.requestId);z.string().trim().min(1).max(2000).parse(input.reason);
    z.number().int().nonnegative().parse(input.expectedRevision);
    const reason=safeText(input.reason);
    return this.atomic(()=>{
      const observation=this.get(observationId);
      const old=this.database.prepare('SELECT * FROM source_evidence_identity_decisions WHERE request_key=?').get(input.requestId) as {observation_id:number;creator_id:number;reason:string;revision:number}|undefined;
      if(old) {
        if(old.observation_id!==observationId||old.creator_id!==input.creatorId||old.reason!==reason||old.revision!==input.expectedRevision+1)throw new SourceEvidenceError('确认请求ID已用于不同决定。',409);
        return observation;
      }
      if(observation.candidateCreatorId!==input.creatorId)throw new SourceEvidenceError('确认必须属于此观察的候选规范博主。',409);
      const row=this.database.prepare('SELECT p.id,p.creator_id FROM source_evidence_pages p JOIN source_evidence_observations o ON o.page_id=p.id WHERE o.id=?').get(observationId) as {id:number;creator_id:number|null};
      const payload=JSON.parse((this.database.prepare('SELECT payload_json FROM source_evidence_observations WHERE id=?').get(observationId) as {payload_json:string}).payload_json) as RecordInput;
      const current=this.identity(payload,observation.pageKey,input.creatorId,row.creator_id);
      if(observation.identityState==='conflict'||current.state==='conflict') throw new SourceEvidenceError('页面身份仍有明确冲突；不能强制改绑，须先核对原资料。',409);
      if(observation.identityRevision!==input.expectedRevision)throw new SourceEvidenceError('页面身份版本已变化，请刷新后确认。',409);
      this.database.prepare('INSERT INTO source_evidence_identity_decisions(request_key,observation_id,creator_id,revision,reason,created_at) VALUES(?,?,?,?,?,?)').run(input.requestId,observationId,input.creatorId,input.expectedRevision+1,reason,new Date().toISOString());
      this.database.prepare('UPDATE source_evidence_pages SET creator_id=?,identity_revision=?,confirmed_observation_id=?,identity_reason=? WHERE id=?').run(input.creatorId,input.expectedRevision+1,observationId,reason,row.id);
      return this.get(observationId);
    });
  }
  assertAdmissionReference(observationId:number,creatorId:number):SourceEvidenceObservation {
    this.creator(creatorId);
    const observation=this.get(observationId);
    if(observation.identityState!=='confirmed'||observation.creatorId!==creatorId)throw new SourceEvidenceError('接纳来源引用需先确认此具体页面属于当前规范博主。',409);
    const payload=JSON.parse((this.database.prepare('SELECT payload_json FROM source_evidence_observations WHERE id=?').get(observationId) as {payload_json:string}).payload_json) as RecordInput;
    if(this.identity(payload,observation.pageKey,creatorId,creatorId).state==='conflict')throw new SourceEvidenceError('页面当前权威身份发生冲突，停止新增关联。',409);
    return observation;
  }
  linkAdmission(input:{observationId:number;creatorId:number;workId:number;localWorkId?:number|null;planId?:string|null;itemKey?:string|null;reason:string;key:string;entryKey?:string|null}):SourceEvidenceLink {
    return this.writeLink({...input,kind:'batch'});
  }
  mapEntry(input:{observationId:number;creatorId:number;workId:number;entryKey:string;sourceWorkId?:number;reason:string;key:string}):SourceEvidenceLink {
    return this.writeLink({...input,kind:'exact'});
  }
  private writeLink(input:{observationId:number;creatorId:number;workId:number;localWorkId?:number|null;planId?:string|null;itemKey?:string|null;reason:string;key:string;entryKey?:string|null;kind:'batch'|'exact';sourceWorkId?:number}):SourceEvidenceLink {
    key.parse(input.key);id.parse(input.workId);z.string().trim().min(1).max(2000).parse(input.reason);
    if(input.localWorkId!=null)id.parse(input.localWorkId);
    const normalized={...input,localWorkId:input.localWorkId??null,planId:input.planId??null,itemKey:input.itemKey??null,entryKey:input.entryKey??null,sourceWorkId:input.sourceWorkId??null,reason:safeText(input.reason)};
    const checksum=hash(normalized);
    return this.atomic(()=>{
      const observation=this.assertAdmissionReference(input.observationId,input.creatorId);
      if(input.entryKey && !observation.parsedEntries.some(entry=>entry.key===input.entryKey))throw new SourceEvidenceError('指定来源资料条目不存在。',409);
      if(!this.database.prepare('SELECT id FROM archive_catalog_works WHERE id=? AND creator_id=?').get(input.workId,input.creatorId))throw new SourceEvidenceError('Work不存在或属于其他博主。',409);
      if(input.localWorkId!=null&&!this.database.prepare('SELECT id FROM archive_catalog_local_works WHERE id=? AND work_id=?').get(input.localWorkId,input.workId))throw new SourceEvidenceError('本地副本与Work不一致。',409);
      const old=this.database.prepare('SELECT id,payload_hash FROM source_evidence_admission_links WHERE link_key=?').get(input.key) as {id:number;payload_hash:string}|undefined;
      if(old) {if(old.payload_hash!==checksum)throw new SourceEvidenceError('关联键已用于不同内容，原计划和关联不可覆盖。',409);return [...observation.links,...observation.entryMappings].find(link=>link.id===old.id)!;}
      let decisionId:number|null=null;
      if(input.kind==='exact') {
        const entry=observation.parsedEntries.find(entry=>entry.key===input.entryKey);
        if(!entry||entry.state==='conflict')throw new SourceEvidenceError('条目不存在或存在编号冲突，不能建立精确映射。',409);
        if(entry.state!=='range'&&observation.entryMappings.some(link=>link.entryKey===input.entryKey&&link.workId!==input.workId))throw new SourceEvidenceError('单套条目已有其他Work对应，不支持通用Work合并。',409);
        const orderKey=(value:string|null|undefined)=>{try{return value?parseCostuanNumbering(value)?.key??null:null;}catch{return null;}};
        const targetKey=orderKey(entry.sourceOrder);
        // SourceWork is authoritative even when the caller omits its ID.
        // Matching is scoped to this exact platform/page, not global NO/title.
        if(entry.state!=='range'&&targetKey) {
          const sources=this.database.prepare(`SELECT s.work_id,s.source_work_id,s.source_order_label FROM archive_catalog_source_works s
            JOIN archive_catalog_collections c ON c.id=s.collection_id WHERE c.source=? AND c.source_collection_id=?`)
            .all(observation.platform,observation.pageKey) as {work_id:number;source_work_id:string;source_order_label:string|null}[];
          const bindings=this.database.prepare(`SELECT b.work_id,b.source_work_id FROM archive_catalog_source_bindings b
            JOIN archive_catalog_collections c ON c.id=b.collection_id
            JOIN archive_catalog_work_decisions d ON d.id=b.decision_id AND d.state='active'
            WHERE c.source=? AND c.source_collection_id=?`).all(observation.platform,observation.pageKey) as {work_id:number;source_work_id:string}[];
          if(sources.some(source=>orderKey(source.source_order_label??source.source_work_id)===targetKey&&source.work_id!==input.workId)
            || bindings.some(source=>orderKey(source.source_work_id)===targetKey&&source.work_id!==input.workId)) {
            throw new SourceEvidenceError('此页面条目已有其他Work的权威对应，不能通过新观察绕过或合并。',409);
          }
          const previous=this.database.prepare(`SELECT l.work_id,l.entry_key,o.parsed_json FROM source_evidence_admission_links l
            JOIN source_evidence_observations o ON o.id=l.observation_id JOIN source_evidence_pages p ON p.id=o.page_id
            WHERE p.platform=? AND p.page_key=? AND l.link_kind='exact'`).all(observation.platform,observation.pageKey) as {work_id:number;entry_key:string;parsed_json:string}[];
          if(previous.some(link=>{
            const prior=(JSON.parse(link.parsed_json) as SourceEvidenceEntry[]).find(item=>item.key===link.entry_key);
            return prior?.state!=='range'&&orderKey(prior?.sourceOrder)===targetKey&&link.work_id!==input.workId;
          }))throw new SourceEvidenceError('该来源条目在先前观察中已明确关联其他Work。',409);
        }
        if(input.sourceWorkId!==undefined) {
          const source=this.database.prepare(`SELECT s.work_id,s.collection_id,s.source_work_id,s.source_order_label,c.creator_id,c.source,c.source_collection_id
            FROM archive_catalog_source_works s JOIN archive_catalog_collections c ON c.id=s.collection_id WHERE s.id=?`).get(input.sourceWorkId) as {work_id:number;collection_id:number;source_work_id:string;source_order_label:string|null;creator_id:number;source:string;source_collection_id:string}|undefined;
          if(!source||source.work_id!==input.workId||source.creator_id!==input.creatorId||source.source!==observation.platform||source.source_collection_id!==observation.pageKey)throw new SourceEvidenceError('已有SourceWork与具体页面/Work不一致，不能改绑或合并。',409);
          const sourceLabel=source.source_order_label??source.source_work_id;
          if(entry.state!=='range'&&targetKey&&orderKey(sourceLabel)!==targetKey)throw new SourceEvidenceError('具体来源编号不属于此资料条目，不能串接同页其他SourceWork。',409);
          if(entry.range) {
            const number=parseCostuanNumbering(sourceLabel);
            if(number?.order==null||number.order<entry.range.first||number.order>entry.range.last)throw new SourceEvidenceError('具体来源编号不在已确认范围条目之内。',409);
          }
          decisionId=new WorkIdentityService(this.database).bindSource({workId:input.workId,collectionId:source.collection_id,sourceWorkId:source.source_work_id,key:`source-evidence:${input.key}`,reason:normalized.reason});
        }
      }
      const linkId=Number(this.database.prepare(`INSERT INTO source_evidence_admission_links
        (link_key,observation_id,creator_id,work_id,local_work_id,plan_id,item_key,entry_key,link_kind,source_work_id,identity_decision_id,reason,payload_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.key,input.observationId,input.creatorId,input.workId,normalized.localWorkId,normalized.planId,normalized.itemKey,normalized.entryKey,input.kind,normalized.sourceWorkId,decisionId,normalized.reason,checksum,new Date().toISOString()).lastInsertRowid);
      const result=this.get(input.observationId);
      return [...result.links,...result.entryMappings].find(link=>link.id===linkId)!;
    });
  }
}
