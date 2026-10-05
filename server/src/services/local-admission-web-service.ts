import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { appConfig } from '../config/env.js';
import { databaseManager } from '../db/database.js';
import { LocalFolderAdmissionService, admissionPlanSchema, type AdmissionPlan } from './local-folder-admission-service.js';
import { localIngestSettingsService } from './local-ingest-settings-service.js';
import { assertPathInsideLocalIngestRoot, isSameOrNestedPath } from '../utils/local-ingest-paths.js';
import { LOCAL_ADMISSION_LOCK_KEY, runAdmissionCollectionExclusive } from './local-admission-lock.js';
import { isAdmissionAdvertisementCandidate, isKnownAdvertisementImage } from '../utils/local-advertisements.js';
import { recycleEmptyAdmissionParent, type AdmissionParentCleanupResult } from './local-admission-parent-cleanup.js';
import { laterAdmissionCompletions, admissionItemIdentity, assertNoLaterAdmissionCompletion, type CurrentAdmissionDisposition } from './local-admission-later-completion.js';
import { LocalAdmissionTitleCandidates, type AdmissionMatchEvidence, type AdmissionPeerCandidate } from './local-admission-title-candidates.js';
import { assertNewAdmissionOwnership, ownershipErrorPlan, ownershipErrorText } from './local-admission-plan-ownership.js';
import { decodeAdmissionIssue, admissionErrorDetail, admissionErrorMessage } from './local-admission-execution-issue.js';

const ROOT_KEY = 'local-admission.waiting-root.v1';
const reservedDirectory = (name:string) => /^\.local-(?:admission|review)-/i.test(name);
const leaf = z.string().min(1).max(255).refine(v => !/[\\/:\x00]/u.test(v) && !['.','..'].includes(v), '只能选择允许等待区中的直接子目录')
  .refine(v => !reservedDirectory(v), '系统附件或审核隔离目录不能作为作品接纳');
const positive = z.number().int().positive();
export const webPreviewSchema = z.object({ creatorId:positive, parent:leaf, directories:z.array(leaf).min(1).max(500),
  sourceEvidenceId:positive.optional(), acceptExistingVersion:z.boolean().optional() }).strict();
const actionSchema = z.object({ key:z.string().min(1), action:z.enum(['new','existing','same-as','skip','defer']),
  workId:positive.optional(), sameAsKey:z.string().optional(), primary:z.boolean().default(false), displayTitle:z.string().trim().min(1).max(1000).optional(),
  approvedAds:z.array(z.string().min(1)).max(2000).default([]), acceptSourceIds:z.array(positive).max(500).default([]), reason:z.string().trim().max(2000).optional() }).strict();
export const webExecuteSchema = z.object({ requestKey:z.string().min(1).max(150), confirmed:z.literal(true), acceptExistingVersion:z.boolean(),
  adsConfirmed:z.literal(true).optional(), advertisementDisposition:z.literal('recycle_bin').optional(), actions:z.array(actionSchema).min(1).max(500) }).strict();
export const webResumeSchema = z.object({requestKey:z.string().min(1).max(150),confirmed:z.literal(true)}).strict();
export const collectionPreviewSchema=z.object({scopes:z.array(webPreviewSchema).min(1).max(100)}).strict();
export const collectionRepreviewSchema=collectionPreviewSchema.partial().extend({refreshDirectories:z.boolean().optional()})
  .refine(value=>!(value.scopes&&value.refreshDirectories),'调整范围和重新读取目录不能同时指定');
export const collectionExecuteSchema=z.object({requestKey:z.string().min(1).max(150),confirmed:z.literal(true),
  batches:z.array(webExecuteSchema.omit({requestKey:true,confirmed:true}).extend({batchId:z.string().uuid()})).min(1).max(100)}).strict();
type Preview = Awaited<ReturnType<LocalFolderAdmissionService['preview']>>;
type PreviewItem = Preview['items'][number];
type Source = {sourceWorkId:number;title:string;sourceOrder:number|null;mediaSummary:string|null;taskIds:number[]};
export type AdmissionWorkChoice = {workId:number;title:string;catalogNo:string|null;images:number;videos:number;
  thumbnailUrl:string|null;primaryLocalWorkId:number|null;localState:string;originalDirectories:string[];sources:Source[];matchEvidence?:AdmissionMatchEvidence};
type Batch = {id:string;creator_id:number;input_root:string;source_evidence_id:number|null;state:string;created_at:string;updated_at:string;
  error:string|null;context_json:string;confirmed_json:string|null;owner_pid:number|null;owner_token:string|null};
type DirectoryRefresh = {added:{creatorId:number;parent:string;name:string}[];removed:{creatorId:number;parent:string;name:string}[];warnings:string[]};
type Context = {galleryRoot:string;creatorDirectory:string;parent:string;waitingRoot:string;workFacts:Record<string,string>;sourceFacts:Record<string,string>;previousCollectionId?:string;remainingFromCollectionId?:string;remainingSourceSignature?:string;parentCleanup?:AdmissionParentCleanupResult;
  knownSiblingDirectories?:string[];directoryRefresh?:DirectoryRefresh};
type NextAction = {nextAction:'review_files'|'resume_plan'|'prepare_preview'|'none';nextActionReason:string};
type Summary = {key:string;sourceRelativePath:string;targetPath:string;displayTitle:string;group:'A'|'B'|'C'|'D';
  summary:{images:number;videos:number;other:number;bytes:number};candidates:AdmissionWorkChoice[];conflicts:string[];
  ads:{relativePath:string;size:number;automatic?:boolean}[];advertisementRulesVersion?:number;suggestedAction?:z.input<typeof actionSchema>;
  scopeReviewRequired?:boolean;
  reviewIssues?:('title_exact'|'title_similar'|'multiple_candidates'|'existing_path'|'target_conflict'|'structure'|'read_error'|'batch_candidate')[];candidatesTruncated?:boolean;
  peerCandidates?:AdmissionPeerCandidate[];peerCandidatesTruncated?:boolean;
  structureWarnings?:string[];needsBoundaryReview?:boolean;reviewFingerprint?:string};
type PreparedPreview={id:string;scope:z.infer<typeof webPreviewSchema>;inputRoot:string;context:Context;items:{summary:Summary;preview:PreviewItem|null}[];titleCandidates:LocalAdmissionTitleCandidates};
type PreparedExecution={batch:Batch;request:z.infer<typeof webExecuteSchema>;plan:AdmissionPlan|null;saved:Record<string,unknown>[]};
type Collection={id:string;state:string;created_at:string;updated_at:string;confirmed_json:string|null;error:string|null;owner_pid:number|null;owner_token:string|null};
const advertisementRulesVersion=3;
const legacyScopeReviewReason='旧预览未记录父目录完整范围，请核对新发现目录是否属于本批作品';
function advertisementCandidates(manifest:PreviewItem['manifest']):Summary['ads'] {
  return manifest.filter(isAdmissionAdvertisementCandidate).map(e=>({relativePath:e.relativePath,size:e.size,
    ...(e.kind==='image'&&isKnownAdvertisementImage(e.relativePath)?{automatic:true}:{})}));
}
function structureWarnings(manifest:PreviewItem['manifest']):string[] {
  const media=manifest.filter(e=>['image','video'].includes(e.kind)&&!isKnownAdvertisementImage(e.relativePath));
  const branches=new Set(media.filter(e=>e.relativePath.includes('/')).map(e=>e.relativePath.split('/')[0]));
  const warnings:string[]=[];
  if(branches.size>1)warnings.push(`包含 ${branches.size} 个有媒体的一级分支，可能是多套合集；请确认作品边界后再选择整套接纳。`);
  if(media.some(e=>e.relativePath.split('/').length>2))warnings.push('存在多层媒体子目录；这里只保留结构，不会自动按子目录拆分作品。');
  const rootKinds=new Set(media.filter(e=>!e.relativePath.includes('/')).map(e=>e.kind));
  if(media.some(e=>e.relativePath.includes('/')&&rootKinds.size>0&&!rootKinds.has(e.kind)))warnings.push('图片和视频分布在不同层级，请确认是否属于同一套。');
  return warnings;
}
const now = () => new Date().toISOString();
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a:string,b:string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const message = (e:unknown) => e instanceof Error ? e.message : String(e);
export class AdmissionWebError extends Error { constructor(text:string,readonly status=409){super(text);} }
function confirmationOwnershipError(error:unknown):unknown {
  const planId=ownershipErrorPlan(message(error));
  return planId?new AdmissionWebError(`${ownershipErrorText(message(error))} 所属批次：${planId}。`):error;
}
function alive(pid:number|null) { if (!pid) return false; try {process.kill(pid,0);return true;} catch(e) {return (e as NodeJS.ErrnoException).code !== 'ESRCH';} }
async function strictDirectory(value:string) {
  if (!path.isAbsolute(value)) throw new AdmissionWebError('等待区必须是绝对路径',400);
  // Reject linked ancestors as well as a linked final component; do not treat a junction as permission.
  let cursor=path.resolve(value);
  for (;;) { const stat=await fs.lstat(cursor).catch(error=>{
      if((error as NodeJS.ErrnoException).code==='ENOENT')throw new AdmissionWebError('所需目录已不存在，请核对当前目录范围；已保存的执行记录保持。');
      throw error;
    }); if(!stat.isDirectory()||stat.isSymbolicLink()) throw new AdmissionWebError('目录链接或重解析点不能作为导入路径');
    const parent=path.dirname(cursor); if(parent===cursor)break; cursor=parent; }
  return path.resolve(value);
}

/** HTTP orchestration around the existing admission engine, not a second execution ledger. */
export class LocalAdmissionWebService {
  private readonly tasks = new Map<string,Promise<void>>();
  constructor(private readonly db:DatabaseSync=databaseManager.connection,private readonly galleryRoot=appConfig.galleryRoot,
    private readonly admission=new LocalFolderAdmissionService(db,galleryRoot)) {}
  settings() {return {waitingRoot:String(this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(ROOT_KEY)?.value ?? path.join(path.dirname(this.galleryRoot),'cos等待入库')),
    galleryRoot:this.galleryRoot,archiveInboxRoot:localIngestSettingsService.get().inboxRoot};}
  async saveSettings(value:string) {
    this.assertIdle(); const waitingRoot=await strictDirectory(value); await this.validateRoot(waitingRoot);
    this.assertIdle(); this.db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(ROOT_KEY,waitingRoot);
    return this.settings();
  }
  private creator(id:number) {const c=this.db.prepare('SELECT id,canonical_name name FROM archive_catalog_creators WHERE id=? AND is_active=1').get(id) as {id:number;name:string}|undefined;
    if(!c)throw new AdmissionWebError('规范博主不存在或已停用',404);return c;}
  private async validateRoot(root=this.settings().waitingRoot) {
    await strictDirectory(root);await strictDirectory(this.galleryRoot);
    const settings=localIngestSettingsService.get();
    for(const other of [this.galleryRoot,settings.inboxRoot,settings.processingRoot]){
      if(isSameOrNestedPath(root,other)||isSameOrNestedPath(other,root))throw new AdmissionWebError('已解压等待区必须与正式图库、压缩包等待区和处理中目录独立');
    }
    if((await fs.stat(root,{bigint:true})).dev!==(await fs.stat(this.galleryRoot,{bigint:true})).dev)throw new AdmissionWebError('本轮只支持同卷移动，请先准备到与图库同卷的等待区');
    return root;
  }
  async directories(creatorId:number,parent?:string) {
    const creator=this.creator(creatorId),root=await this.validateRoot(); if(parent)leaf.parse(parent);
    const current=parent?path.join(root,parent):root;
    await strictDirectory(current);await assertPathInsideLocalIngestRoot(root,current,{allowRoot:!parent,directChild:!!parent});
    const aliases=this.db.prepare(`SELECT id creatorId,canonical_name name FROM archive_catalog_creators WHERE is_active=1 UNION ALL
      SELECT c.id,a.alias FROM archive_catalog_creator_aliases a JOIN archive_catalog_creators c ON c.id=a.creator_id WHERE c.is_active=1`).all() as {creatorId:number;name:string}[];
    const normalize=(name:string)=>name.normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase();
    const items=[];
    for(const entry of (await fs.readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'zh-Hans-CN'))){
      if((!entry.isDirectory()&&!entry.isSymbolicLink())||reservedDirectory(entry.name))continue;
      let reason:string|undefined;
      try {await strictDirectory(path.join(current,entry.name));await assertPathInsideLocalIngestRoot(current,path.join(current,entry.name),{directChild:true});}catch(e){reason=message(e);}
      const matchedCreatorIds=[...new Set(aliases.filter(a=>normalize(a.name)===normalize(entry.name)).map(a=>a.creatorId))];
      items.push({name:entry.name,selectable:!reason,reason,matchedCreatorIds,matchesSelectedCreator:matchedCreatorIds.includes(creatorId)});
    }
    return {root,parent:parent??null,creator,items};
  }
  async workspace() {
    const root=await this.validateRoot();
    const names=this.db.prepare(`SELECT id creatorId,canonical_name creatorName,canonical_name matchedName,'canonical' matchKind
      FROM archive_catalog_creators WHERE is_active=1 UNION ALL SELECT c.id,c.canonical_name,a.alias,'alias'
      FROM archive_catalog_creator_aliases a JOIN archive_catalog_creators c ON c.id=a.creator_id WHERE c.is_active=1`).all();
    const normalize=(name:string)=>name.normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase();
    const items=[];
    for(const entry of (await fs.readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'zh-Hans-CN'))){
      if((!entry.isDirectory()&&!entry.isSymbolicLink())||reservedDirectory(entry.name))continue;
      let reason:string|undefined;
      try{
        const parentPath=path.join(root,entry.name);
        await strictDirectory(parentPath);await assertPathInsideLocalIngestRoot(root,parentPath,{directChild:true});
        // Completed imports may leave internal attachment/review containers. Do
        // not offer these parents as pending creators; never traverse or delete
        // the containers, or hide ordinary files, links and unreadable content.
        const children=await fs.readdir(parentPath,{withFileTypes:true});
        if(children.length===0||children.every(child=>child.isDirectory()&&!child.isSymbolicLink()&&reservedDirectory(child.name)))continue;
      }catch(e){reason=message(e);}
      const matchesByCreator=new Map<number,{creatorId:number;creatorName:string;matchedName:string;matchKind:'canonical'|'alias'}>();
      for(const row of names.filter(row=>normalize(String(row.matchedName))===normalize(entry.name))) {
        const creatorId=Number(row.creatorId),matchKind=String(row.matchKind) as 'canonical'|'alias';
        if(!matchesByCreator.has(creatorId)||matchKind==='canonical')matchesByCreator.set(creatorId,{
          creatorId,creatorName:String(row.creatorName),matchedName:String(row.matchedName),matchKind});
      }
      const matches=[...matchesByCreator.values()];
      items.push({name:entry.name,selectable:!reason,reason,matches});
    }
    return {...this.settings(),items};
  }
  creators(q='',page=1,pageSize=20) {
    page=Math.max(1,page);pageSize=Math.max(1,Math.min(50,pageSize));const query=q.trim().toLocaleLowerCase();
    const where=`c.is_active=1 AND (?='' OR instr(lower(c.canonical_name),?)>0 OR EXISTS
      (SELECT 1 FROM archive_catalog_creator_aliases a WHERE a.creator_id=c.id AND instr(lower(a.alias),?)>0))`;
    const args=[query,query,query],total=Number(this.db.prepare(`SELECT COUNT(*) n FROM archive_catalog_creators c WHERE ${where}`).get(...args)!.n);
    const rows=this.db.prepare(`SELECT c.id,c.canonical_name name FROM archive_catalog_creators c WHERE ${where} ORDER BY c.canonical_name,c.id LIMIT ? OFFSET ?`).all(...args,pageSize,(page-1)*pageSize);
    return {page,pageSize,total,items:rows.map(row=>({id:Number(row.id),name:String(row.name),aliases:this.db.prepare('SELECT alias FROM archive_catalog_creator_aliases WHERE creator_id=? ORDER BY alias').all(row.id).map(a=>String(a.alias))}))};
  }
  private workFact(id:number) { return hash({work:this.db.prepare('SELECT id,creator_id,display_title,primary_local_work_id,title_policy FROM archive_catalog_works WHERE id=?').get(id),
    copies:this.db.prepare(`SELECT l.id,l.work_id,l.post_id,l.is_active,l.identity_policy,l.absolute_path,p.is_deleted,p.is_trashed
      FROM archive_catalog_local_works l LEFT JOIN posts p ON p.id=l.post_id WHERE l.work_id=? ORDER BY l.id`).all(id)}); }
  private sourceFact(id:number) {return hash({source:this.db.prepare('SELECT * FROM archive_catalog_source_works WHERE id=?').get(id),
    tasks:this.db.prepare('SELECT id,status,attempt_count FROM archive_catalog_download_tasks WHERE source_work_id=? ORDER BY id').all(id)});}
  works(creatorId:number,q='',page=1,pageSize=24) {
    this.creator(creatorId);page=Math.max(1,page);pageSize=Math.min(50,Math.max(1,pageSize));
    const query=q.trim().toLocaleLowerCase(),no=/^(?:no\.?\s*)?0*(\d+)$/i.exec(query)?.[1];
    const where=`w.creator_id=? AND ( ?='' OR instr(lower(w.display_title),?)>0 OR r.no_number=? OR EXISTS
      (SELECT 1 FROM archive_catalog_local_works x WHERE x.work_id=w.id AND instr(lower(x.folder_name),?)>0))
      AND (p.id IS NULL OR (p.is_deleted=0 AND p.is_trashed=0))`;
    const args=[creatorId,query,query,no?Number(no):-1,query];
    const from=`FROM archive_catalog_works w LEFT JOIN resource_catalog_rows r ON r.work_id=w.id AND r.creator_id=w.creator_id
      LEFT JOIN archive_catalog_local_works l ON l.id=w.primary_local_work_id LEFT JOIN posts p ON p.id=l.post_id`;
    const total=Number(this.db.prepare(`SELECT COUNT(*) n ${from} WHERE ${where}`).get(...args)!.n);
    const rows=this.db.prepare(`SELECT w.id,w.display_title,w.primary_local_work_id,l.image_count,l.video_count,l.is_active,p.id post_id,
      r.no_number,r.local_state,(SELECT i.thumbnail_path FROM post_items pi JOIN images i ON i.id=pi.image_id
      WHERE pi.post_id=p.id AND i.is_deleted=0 AND i.is_trashed=0 ORDER BY pi.position LIMIT 1) thumbnail_path ${from} WHERE ${where}
      ORDER BY w.id DESC LIMIT ? OFFSET ?`).all(...args,pageSize,(page-1)*pageSize);
    const version=this.thumbnailVersion();
    return {page,pageSize,total,items:rows.map(row=>this.choice(row,version))};
  }
  private thumbnailVersion(){const scan=this.db.prepare('SELECT id FROM scan_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();return scan?String(scan.id):null;}
  private choice(row:Record<string,unknown>,version:string|null):AdmissionWorkChoice {
    const workId=Number(row.id);
    return {workId,title:String(row.display_title),catalogNo:row.no_number==null?null:String(row.no_number).padStart(3,'0'),
      images:Number(row.image_count??0),videos:Number(row.video_count??0),primaryLocalWorkId:row.primary_local_work_id==null?null:Number(row.primary_local_work_id),
      localState:row.local_state?String(row.local_state):row.post_id&&row.is_active?'indexed':'unavailable',
      // Match gallery public URL escaping/versioning without reading media or changing cache policy.
      thumbnailUrl:row.thumbnail_path?'/thumbnails/'+String(row.thumbnail_path).replaceAll('\\','/').split('/').map(encodeURIComponent).join('/')+(version?'?v='+encodeURIComponent(version):''):null,
      originalDirectories:this.db.prepare('SELECT folder_name FROM archive_catalog_local_works WHERE work_id=? ORDER BY id').all(workId).map(r=>String(r.folder_name)),
      sources:this.db.prepare('SELECT id,source_title,source_order,media_summary FROM archive_catalog_source_works WHERE work_id=? AND is_active=1 ORDER BY id').all(workId).map(s=>({
        sourceWorkId:Number(s.id),title:String(s.source_title),sourceOrder:s.source_order==null?null:Number(s.source_order),mediaSummary:s.media_summary==null?null:String(s.media_summary),
        taskIds:this.db.prepare('SELECT id FROM archive_catalog_download_tasks WHERE source_work_id=? ORDER BY id').all(s.id).map(t=>Number(t.id))}))};
  }
  private workChoice(workId:number,creatorId:number,version:string|null){
    const row=this.db.prepare(`SELECT w.id,w.display_title,w.primary_local_work_id,l.image_count,l.video_count,l.is_active,l.post_id,r.no_number,r.local_state,
      (SELECT i.thumbnail_path FROM post_items pi JOIN images i ON i.id=pi.image_id WHERE pi.post_id=p.id AND i.is_deleted=0 AND i.is_trashed=0 ORDER BY pi.position LIMIT 1) thumbnail_path
      FROM archive_catalog_works w LEFT JOIN archive_catalog_local_works l ON l.id=w.primary_local_work_id LEFT JOIN posts p ON p.id=l.post_id
      LEFT JOIN resource_catalog_rows r ON r.work_id=w.id AND r.creator_id=w.creator_id
      WHERE w.id=? AND w.creator_id=? AND (p.id IS NULL OR (p.is_deleted=0 AND p.is_trashed=0))`).get(workId,creatorId);
    return row?this.choice(row,version):null;
  }
  private async preparePreview(raw:unknown):Promise<PreparedPreview> {
    const scope=webPreviewSchema.parse(raw);this.creator(scope.creatorId);const root=await this.validateRoot();
    const inputRoot=path.join(root,scope.parent);await strictDirectory(inputRoot);await assertPathInsideLocalIngestRoot(root,inputRoot,{directChild:true});
    const siblings=await this.siblingEntries(inputRoot);
    if(new Set(scope.directories.map(d=>process.platform==='win32'?d.toLowerCase():d)).size!==scope.directories.length)throw new AdmissionWebError('选择了重复目录',400);
    const id=randomUUID(),items:{summary:Summary;preview:PreviewItem|null}[]=[];let creatorDirectory='';const version=this.thumbnailVersion();
    const titleCandidates=new LocalAdmissionTitleCandidates(this.db,scope.creatorId);
    const choiceCache=new Map<number,AdmissionWorkChoice|null>();
    const getChoice=(workId:number)=>{if(!choiceCache.has(workId))choiceCache.set(workId,this.workChoice(workId,scope.creatorId,version));return choiceCache.get(workId);};
    for(const name of scope.directories){
      try {
        const preview=await this.admission.preview({...scope,inputRoot,directories:[name]});creatorDirectory=preview.creatorDirectory;
        const item=preview.items[0]!;
        const evidence=titleCandidates.find(name);
        for(const candidate of item.review.candidates as unknown as {workId:number;title:string}[]){
          const workId=Number(candidate.workId);if(!titleCandidates.workIds.has(workId))continue;
          const previous=evidence.get(workId),source=titleCandidates.sourceEvidence(name,candidate.title);
          evidence.set(workId,{level:previous?.level==='exact'?'exact':source.level,reasons:[...new Set([...(previous?.reasons??[]),...source.reasons])]});
        }
        for(const relation of item.review.existingRelations){
          const workId=Number(relation.workId);if(!titleCandidates.workIds.has(workId))continue;
          evidence.set(workId,{level:'path',reasons:[...(evidence.get(workId)?.reasons??[]),'目标路径已有本地副本关系；不能覆盖目标']});
        }
        const matching:(AdmissionWorkChoice&{matchEvidence:AdmissionMatchEvidence})[]=[];
        for(const [workId,matchEvidence] of [...evidence].sort(([a,ea],[b,eb])=>({path:0,exact:1,similar:2}[ea.level]-{path:0,exact:1,similar:2}[eb.level])||a-b)){
          const choice=getChoice(workId);if(choice)matching.push({...choice,matchEvidence});
          if(matching.length===51)break;
        }
        const candidates=matching.slice(0,50),candidatesTruncated=matching.length>50;
        const warnings=structureWarnings(item.manifest);
        const reviewIssues:NonNullable<Summary['reviewIssues']>=[];
        if(matching.some(c=>c.matchEvidence.level==='exact'))reviewIssues.push('title_exact');
        if(matching.some(c=>c.matchEvidence.level==='similar'))reviewIssues.push('title_similar');
        if(matching.length>1)reviewIssues.push('multiple_candidates');
        if(item.review.existingRelations.length)reviewIssues.push('existing_path');
        if(item.review.conflicts.length)reviewIssues.push('target_conflict');
        if(warnings.length)reviewIssues.push('structure');
        const group:Summary['group']=warnings.length||item.review.conflicts.length||matching.length>1?'D':item.review.existingRelations.length?'C':
          candidates.length===1?(candidates[0]!.matchEvidence.level==='exact'?'B':'C'):'A';
        items.push({preview:item,summary:{key:item.key,sourceRelativePath:name,targetPath:item.targetPath,displayTitle:item.displayTitle,group,
          summary:item.review.summary,candidates,candidatesTruncated,reviewIssues,conflicts:item.review.conflicts,ads:advertisementCandidates(item.manifest),advertisementRulesVersion,
          ...(warnings.length?{structureWarnings:warnings,needsBoundaryReview:true}:{})}});
      } catch(e) {items.push({preview:null,summary:{key:randomUUID(),sourceRelativePath:name,targetPath:'',displayTitle:name,group:'D',
        summary:{images:0,videos:0,other:0,bytes:0},candidates:[],reviewIssues:['read_error'],candidatesTruncated:false,conflicts:[message(e)],ads:[]}});}
    }
    const peerCandidates=titleCandidates.peers(items.filter(item=>item.preview).map(item=>item.summary.sourceRelativePath));
    for(const item of items){
      const peers=peerCandidates.get(item.summary.sourceRelativePath);
      item.summary.peerCandidates=peers?.items??[];item.summary.peerCandidatesTruncated=peers?.truncated??false;
      if(peers?.items.length||peers?.truncated){
        item.summary.reviewIssues=[...(item.summary.reviewIssues??[]),'batch_candidate'];
        if(item.summary.group!=='D')item.summary.group='C';
      }
    }
    const context:Context={galleryRoot:this.galleryRoot,creatorDirectory,parent:scope.parent,waitingRoot:root,workFacts:{},sourceFacts:{}};
    for(const w of this.db.prepare('SELECT id FROM archive_catalog_works WHERE creator_id=?').all(scope.creatorId))context.workFacts[String(w.id)]=this.workFact(Number(w.id));
    for(const s of this.db.prepare('SELECT s.id FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id WHERE w.creator_id=?').all(scope.creatorId))context.sourceFacts[String(s.id)]=this.sourceFact(Number(s.id));
    // Keys are fresh on every draft. The review facts, including Works selected
    // through search rather than suggestions, decide whether an unsent choice
    // can safely carry forward. Invalid inventories never inherit a choice.
    for(const item of items)if(item.preview)item.summary.reviewFingerprint=hash({
      creatorId:scope.creatorId,parent:scope.parent,sourceEvidenceId:scope.sourceEvidenceId??null,inputRoot,context,
      manifest:item.preview.manifest,sourceRelativePath:item.summary.sourceRelativePath,targetPath:item.summary.targetPath,
      displayTitle:item.summary.displayTitle,group:item.summary.group,conflicts:item.summary.conflicts,
      candidates:item.summary.candidates.map(c=>({workId:c.workId,matchEvidence:c.matchEvidence})),
      reviewIssues:item.summary.reviewIssues,candidatesTruncated:item.summary.candidatesTruncated,
      ...(item.summary.peerCandidates?.length||item.summary.peerCandidatesTruncated?{peerCandidates:item.summary.peerCandidates,peerCandidatesTruncated:item.summary.peerCandidatesTruncated}:{}),
      ads:item.summary.ads,advertisementRulesVersion,structureWarnings:item.summary.structureWarnings??[]
    });
    // Operational scope metadata must not invalidate unchanged per-work review facts.
    context.knownSiblingDirectories=siblings.filter(entry=>entry.directory).map(entry=>entry.name);
    if(hash(siblings)!==hash(await this.siblingEntries(inputRoot)))throw new AdmissionWebError('核对期间父目录范围发生变化，请待整理结束后重新读取');
    return {id,scope,inputRoot,context,items,titleCandidates};
  }
  private async siblingEntries(inputRoot:string) {
    return (await fs.readdir(inputRoot,{withFileTypes:true})).filter(entry=>!reservedDirectory(entry.name))
      .map(entry=>({name:entry.name,directory:entry.isDirectory()&&!entry.isSymbolicLink(),link:entry.isSymbolicLink()}))
      .sort((a,b)=>a.name.localeCompare(b.name,'zh-Hans-CN'));
  }
  private savePreview({id,scope,inputRoot,context,items,titleCandidates}:PreparedPreview) {
      // BEGIN IMMEDIATE already encloses every caller. Refuse stale recall
      // rather than saving a false A-group after an asynchronous inventory.
      if(!titleCandidates.unchanged())throw new AdmissionWebError('核对期间博主名称、别名或已有作品目录信息发生变化，请重新核对。');
      this.db.prepare(`INSERT INTO local_admission_web_batches(id,creator_id,input_root,source_evidence_id,state,created_at,updated_at,context_json)
        VALUES(?,?,?,?,'draft',?,?,?)`).run(id,scope.creatorId,inputRoot,scope.sourceEvidenceId??null,now(),now(),JSON.stringify(context));
      for(const [position,item] of items.entries())this.db.prepare('INSERT INTO local_admission_web_items(batch_id,item_key,position,summary_json,preview_json) VALUES(?,?,?,?,?)')
        .run(id,item.summary.key,position,JSON.stringify(item.summary),item.preview?JSON.stringify(item.preview):null);
  }
  async preview(raw:unknown) {
    const prepared=await this.preparePreview(raw),id=prepared.id;
    this.db.exec('BEGIN IMMEDIATE');
    try{this.savePreview(prepared);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    return {...this.get(id),items:this.items(id).items};
  }
  private row(id:string) {const row=this.db.prepare('SELECT * FROM local_admission_web_batches WHERE id=?').get(id) as Batch|undefined;
    if(!row)throw new AdmissionWebError('导入批次不存在',404);return row;}
  private collectionId(batchId:string):string|null {return this.db.prepare('SELECT collection_id FROM local_admission_web_collection_batches WHERE batch_id=?').get(batchId)?.collection_id as string|undefined??null;}
  private assertStandalone(batchId:string) {if(this.collectionId(batchId))throw new AdmissionWebError('此批次属于集中导入，请从集中导入页面确认或继续整个集合');}
  private assertNotCompletedLater(batchId:string,keys?:string[]) {
    try{assertNoLaterAdmissionCompletion(this.db,batchId,keys);}catch(error){throw new AdmissionWebError(message(error));}
  }
  private assertCollectionScopeNotCompletedLater(id:string,scopes:{creatorId:number;parent:string;directories:string[]}[]) {
    const batches=this.db.prepare(`SELECT b.id,b.creator_id,json_extract(b.context_json,'$.parent') parent
      FROM local_admission_web_collection_batches c JOIN local_admission_web_batches b ON b.id=c.batch_id WHERE c.collection_id=?`).all(id);
    for(const batch of batches){const selected=scopes.find(scope=>scope.creatorId===batch.creator_id&&scope.parent===batch.parent);if(!selected)continue;
      const keys=this.db.prepare("SELECT item_key,json_extract(summary_json,'$.sourceRelativePath') relative FROM local_admission_web_items WHERE batch_id=?").all(batch.id)
        .filter(item=>selected.directories.some(name=>same(path.join(String(batch.parent),name),path.join(String(batch.parent),String(item.relative)))))
        .map(item=>String(item.item_key));
      this.assertNotCompletedLater(String(batch.id),keys);
    }
  }
  private effectiveState(row:Pick<Batch,'state'|'owner_pid'>){return ['queued','running'].includes(row.state)&&!alive(row.owner_pid)?'interrupted':row.state;}
  private blockingBatch(error:string|null,creatorId:number) {
    const id=ownershipErrorPlan(error);if(!id)return undefined;
    const row=this.db.prepare('SELECT id FROM local_admission_web_batches WHERE id=? AND creator_id=?').get(id,creatorId);
    return row?{batchId:id,collectionId:this.collectionId(id)}:undefined;
  }
  get(id:string,later=laterAdmissionCompletions(this.db,[id])) {
    // No manifest/content reads, hashing or directory traversal on progress polling.
    const row=this.db.prepare(`SELECT id,creator_id,input_root,source_evidence_id,state,created_at,updated_at,error,owner_pid,context_json FROM local_admission_web_batches WHERE id=?`).get(id) as Omit<Batch,'confirmed_json'|'owner_token'>|undefined;
    if(!row)throw new AdmissionWebError('导入批次不存在',404);
    const counts=this.db.prepare(`SELECT COUNT(*) total,SUM(action NOT IN ('skip','defer')) selected,SUM(action='skip') skipped,SUM(action='defer') deferred
      FROM local_admission_web_items WHERE batch_id=?`).get(id)!;
    const completed=Number(this.db.prepare("SELECT COUNT(*) n FROM archive_local_admission_items WHERE plan_id=? AND state='completed'").get(id)!.n);
    const executionTotals={review:0,dependency:0,unstarted:0};
    if(row.state!=='draft')for(const item of this.db.prepare(`SELECT i.state,i.last_error FROM local_admission_web_items x
      LEFT JOIN archive_local_admission_items i ON i.plan_id=x.batch_id AND i.item_key=x.item_key
      WHERE x.batch_id=? AND x.action NOT IN ('skip','defer')`).all(id)){
      if(item.state==='completed')continue;
      const issue=decodeAdmissionIssue(item.last_error);
      if(issue?.kind==='review')executionTotals.review++;
      else if(issue?.kind==='dependency')executionTotals.dependency++;
      else if(!issue&&(item.state==null||item.state==='planned'))executionTotals.unstarted++;
    }
    const reconciled=Number(counts.selected)>0&&completed===Number(counts.selected);
    const dispositions=this.db.prepare('SELECT item_key,action FROM local_admission_web_items WHERE batch_id=?').all(id)
      .filter(item=>item.action!=='skip').map(item=>later.get(admissionItemIdentity(id,String(item.item_key))));
    const completedLater=dispositions.filter(item=>item?.status==='completed_later').length;
    const unresolved=dispositions.filter(item=>item?.status==='unresolved').length;
    const cleanup=(JSON.parse(row.context_json) as Context).parentCleanup;
    const cleanupMessage=cleanup?({recycled:'空博主目录已放入回收站',not_empty:'父目录仍有内容，已保留',not_applicable:'父目录已不存在，无需清理',failed:'空目录清理未完成，已入库作品不受影响'}[cleanup.status]
      +(cleanup.message?`：${cleanup.message}`:'')+(cleanup.retainedPath?`；保留位置：${cleanup.retainedPath}`:'')):undefined;
    return {id,planId:id,collectionId:this.collectionId(id),creatorId:row.creator_id,creatorName:String(this.db.prepare('SELECT canonical_name FROM archive_catalog_creators WHERE id=?').get(row.creator_id)?.canonical_name??''),
      inputRoot:row.input_root,sourceEvidenceId:row.source_evidence_id,state:reconciled?'completed':this.effectiveState(row),createdAt:row.created_at,updatedAt:row.updated_at,error:reconciled?null:ownershipErrorText(row.error),errorMessage:reconciled?null:admissionErrorMessage(ownershipErrorText(row.error)),
      ...(!reconciled?{blockingBatch:this.blockingBatch(row.error,row.creator_id)}:{}),
      ...(cleanup?{parentCleanup:{...cleanup,message:cleanupMessage!}}:{}),
      currentTotals:{completedLater,pending:Math.max(0,Number(counts.total)-Number(counts.skipped??0)-completed-completedLater),unresolved},
      totals:{total:Number(counts.total),selected:Number(counts.selected??0),completed,skipped:Number(counts.skipped??0),deferred:Number(counts.deferred??0),...executionTotals}};
  }
  list(creatorId?:number,page=1) {const where=creatorId?'WHERE creator_id=?':'';const args=creatorId?[creatorId]:[];
    const total=Number(this.db.prepare(`SELECT COUNT(*) n FROM local_admission_web_batches ${where}`).get(...args)!.n);
    const ids=this.db.prepare(`SELECT id FROM local_admission_web_batches ${where} ORDER BY created_at DESC,id DESC LIMIT 30 OFFSET ?`).all(...args,(page-1)*30).map(row=>String(row.id));
    const later=laterAdmissionCompletions(this.db,ids);
    return {page,pageSize:30,total,items:ids.map(id=>this.get(id,later))};}
  private scopeReviewPaths(batchId:string):Set<string> {
    const batch=this.db.prepare(`SELECT creator_id,json_extract(context_json,'$.parent') parent FROM local_admission_web_batches WHERE id=?`).get(batchId)!;
    // Historical system defaults were stored as ordinary suggested deferrals. Only
    // the exact server-generated reason AND the persisted discovery report identify
    // those entries; a user's reason or an unrelated deferred work is not enough.
    const report=this.db.prepare(`SELECT json_extract(b.context_json,'$.directoryRefresh') report
      FROM local_admission_web_collection_batches c JOIN local_admission_web_batches b ON b.id=c.batch_id
      WHERE c.collection_id=(SELECT collection_id FROM local_admission_web_collection_batches WHERE batch_id=?)
        AND json_extract(b.context_json,'$.directoryRefresh') IS NOT NULL LIMIT 1`).get(batchId);
    const discoveries=report?(JSON.parse(String(report.report)) as DirectoryRefresh).added:[];
    const legacyPaths=new Set(discoveries.filter(entry=>entry.creatorId===batch.creator_id&&entry.parent===batch.parent).map(entry=>entry.name));
    return new Set(this.db.prepare(`SELECT json_extract(summary_json,'$.sourceRelativePath') relative,
      json_extract(summary_json,'$.scopeReviewRequired') required,json_extract(summary_json,'$.suggestedAction.action') action,
      json_extract(summary_json,'$.suggestedAction.reason') reason FROM local_admission_web_items WHERE batch_id=?`).all(batchId)
      .filter(row=>row.required===1||(row.action==='defer'&&row.reason===legacyScopeReviewReason&&legacyPaths.has(String(row.relative))))
      .map(row=>String(row.relative)));
  }
  items(id:string,page=1,pageSize=24) {
    const later=laterAdmissionCompletions(this.db,[id]);
    const batch=this.get(id,later);page=Math.max(1,page);pageSize=Math.min(100,Math.max(1,pageSize));
    const scopeReview=batch.state==='draft'?this.scopeReviewPaths(id):new Set<string>();
    let blocked:string|null=null;
    try{this.assertIdle();this.creator(batch.creatorId);this.assertCreatorIdle(batch.creatorId);}catch(error){blocked=message(error);}
    const rows=this.db.prepare(`SELECT x.item_key,x.summary_json,x.action,i.state,i.last_error,i.work_id,i.local_work_id,l.id existing_local_id,l.post_id,
      EXISTS(SELECT 1 FROM archive_catalog_local_fulfillments f WHERE f.local_work_id=l.id AND f.state='active') fulfilled,
      EXISTS(SELECT 1 FROM archive_local_admission_plans p,json_each(p.payload_json,'$.items') item
        WHERE p.plan_id=x.batch_id AND json_extract(p.payload_json,'$.creatorId')=? AND json_extract(item.value,'$.key')=x.item_key) saved_plan_item,
      EXISTS(SELECT 1 FROM local_admission_web_batches b,json_each(b.confirmed_json,'$.items') item
        WHERE b.id=x.batch_id AND json_extract(b.confirmed_json,'$.creatorId')=? AND json_extract(item.value,'$.key')=x.item_key) confirmed_plan_item,
      CASE WHEN ?='draft' AND COALESCE(json_extract(x.summary_json,'$.advertisementRulesVersion'),0)<>? THEN x.preview_json ELSE NULL END legacy_preview_json
      FROM local_admission_web_items x LEFT JOIN archive_local_admission_items i ON i.plan_id=x.batch_id AND i.item_key=x.item_key
      LEFT JOIN archive_catalog_local_works l ON l.id=i.local_work_id AND l.work_id=i.work_id WHERE x.batch_id=? ORDER BY x.position LIMIT ? OFFSET ?`).all(batch.creatorId,batch.creatorId,batch.state,advertisementRulesVersion,id,pageSize,(page-1)*pageSize);
    return {page,pageSize,total:batch.totals.total,items:rows.map(r=>{
      const summary=JSON.parse(String(r.summary_json)) as Summary;
      if(scopeReview.has(summary.sourceRelativePath))summary.scopeReviewRequired=true;else delete summary.scopeReviewRequired;
      // Old unsubmitted drafts use their saved inventory; no disk reads or changes
      // to the manifest, choices, confirmed payload or execution checkpoints.
      if(r.legacy_preview_json){summary.ads=advertisementCandidates((JSON.parse(String(r.legacy_preview_json)) as PreviewItem).manifest);summary.advertisementRulesVersion=advertisementRulesVersion;}
      const state=r.state??(batch.state==='draft'?'preview':['skip','defer'].includes(String(r.action))?r.action:'not_started');
      const currentDisposition=later.get(admissionItemIdentity(id,String(r.item_key)));
      const issue=decodeAdmissionIssue(r.last_error);
      const detail=admissionErrorDetail(r.last_error==null?null:String(r.last_error));
      return {...summary,action:String(r.action),state,executionState:r.state??null,...this.itemNextAction(batch,r,blocked),
        ...(issue?{executionIssue:issue}:{}),errorMessage:issue?.message??admissionErrorMessage(ownershipErrorText(detail)),
        ...(currentDisposition?{currentDisposition}:{}),
        ...(currentDisposition?.status==='completed_later'?{nextAction:'none' as const,nextActionReason:'历史批次未完成；本项已在后续批次完成，请查看后续结果。'}:{}),
        ...(currentDisposition?.status!=='completed_later'&&ownershipErrorPlan(detail)?{nextAction:'none' as const,nextActionReason:'请查看上方提示中的所属批次；这不是文件损坏审核，不要移动或删除文件。'}:{}),
        lastError:ownershipErrorText(detail),workId:r.work_id??null,localWorkId:r.local_work_id??null,postId:r.post_id??null};})};
  }
  private itemNextAction(batch:ReturnType<LocalAdmissionWebService['get']>,item:Record<string,unknown>,blocked:string|null):NextAction {
    const none=(nextActionReason:string):NextAction=>({nextAction:'none',nextActionReason});
    if(item.state==='completed')return none('此项目已完成，无需重复处理。');
    if(blocked)return none(blocked);
    if(batch.state==='draft')return none('尚未确认，请在预览中核对选择。');
    if(item.action==='skip')return none('此项目已明确跳过。');
    const issue=decodeAdmissionIssue(item.last_error);
    if(issue?.kind==='dependency')return none(issue.message);
    const activeReview=this.db.prepare(`SELECT owner_pid FROM local_review_web_sessions
      WHERE target_key=? AND status IN ('preparing','submitted','running')`).all(`admission:${batch.id}:${String(item.item_key)}`);
    if(activeReview.some(row=>alive(Number(row.owner_pid))))return none('原项目的文件审核仍在执行，请等待完成。');
    if(item.state==null){
      if(item.confirmed_plan_item)return {nextAction:'resume_plan',nextActionReason:'本项属于原确认计划但尚未执行，请核对暂停原因后继续原计划。'};
      if(!batch.collectionId)return {nextAction:'prepare_preview',nextActionReason:'此项目没有执行记录，可为尚未执行的目录准备新预览。'};
      return none(item.action==='defer'?'此项目已暂缓，原集中确认未包含执行计划。':'尚未建立执行记录；请核对集中导入的原范围与失败原因。');
    }
    if(!item.saved_plan_item||!item.confirmed_plan_item)return none('原计划或项目记录不完整，不能推断恢复方式。');
    if(item.state!=='planned'&&(!item.existing_local_id||!item.work_id))return none('原项目的本地作品关联不完整，不能推断恢复方式。');
    if(issue?.kind!=='system'&&item.state==='files_verified'&&item.existing_local_id&&item.work_id&&item.post_id==null&&!item.fulfilled)
      return {nextAction:'review_files',nextActionReason:issue?.kind==='review'?'文件移动已核验且尚未关联图集，可进入原项目的文件审核。':'文件已移动但索引未完成，可检查原项文件；具体失败原因仍待核对。'};
    if(['planned','move_intent','files_verified','indexed'].includes(String(item.state))&&batch.state!=='completed')
      return {nextAction:'resume_plan',nextActionReason:batch.collectionId?'可继续原集中确认计划，已完成项目会沿用原执行记录。':'可从现有执行记录继续原确认计划。'};
    return none('当前记录不支持网页文件审核或自动推断下一步。');
  }
  async repreview(id:string,keys?:string[]) {
    this.assertStandalone(id);
    const batch=this.row(id);if(['running','queued'].includes(this.effectiveState(batch)))throw new AdmissionWebError('执行中不能重新预览');
    const context=JSON.parse(batch.context_json) as Context;
    const items=this.db.prepare(`SELECT x.item_key,x.summary_json,x.action,i.state FROM local_admission_web_items x LEFT JOIN archive_local_admission_items i
      ON i.plan_id=x.batch_id AND i.item_key=x.item_key WHERE x.batch_id=? ORDER BY position`).all(id);
    const selected=items.filter(r=>keys?keys.includes(String(r.item_key)):r.action==='defer');
    this.assertNotCompletedLater(id,selected.map(row=>String(row.item_key)));
    if(!selected.length||selected.some(r=>r.state))throw new AdmissionWebError('已开始移动的作品只能继续原计划；请选择尚未执行的项目重新预览');
    if(keys&&selected.length!==new Set(keys).size)throw new AdmissionWebError('选择项不属于本批次');
    const next=await this.preview({creatorId:batch.creator_id,parent:context.parent,directories:selected.map(r=>(JSON.parse(String(r.summary_json)) as Summary).sourceRelativePath),
      ...(batch.source_evidence_id?{sourceEvidenceId:batch.source_evidence_id}:{})});
    const previous=batch.confirmed_json?admissionPlanSchema.safeParse(JSON.parse(batch.confirmed_json)):null;
    if(previous?.success){
      const nextContext=JSON.parse(this.row(next.id).context_json) as Context;
      const nextItems=this.db.prepare('SELECT item_key,preview_json,summary_json FROM local_admission_web_items WHERE batch_id=?').all(next.id);
      const matching=new Map<string,{item:PreviewItem;summary:Summary}>();
      for(const row of nextItems)if(row.preview_json){const item=JSON.parse(String(row.preview_json)) as PreviewItem;
        const old=previous.data.items.find(i=>i.sourceRelativePath===item.sourceRelativePath);
        if(old&&!item.review.conflicts.length&&hash(old.manifest)===hash(item.manifest))matching.set(old.key,{item,summary:JSON.parse(String(row.summary_json)) as Summary});}
      const eligible=(old:AdmissionPlan['items'][number]):boolean=>{
        if(!matching.has(old.key))return false;
        if(old.identity.kind==='existing'&&(!old.identity.workId||context.workFacts[String(old.identity.workId)]!==nextContext.workFacts[String(old.identity.workId)]))return false;
        if(old.acceptVersions.some(a=>context.sourceFacts[String(a.sourceWorkId)]!==nextContext.sourceFacts[String(a.sourceWorkId)]))return false;
        const identity=old.identity;
        return identity.kind!=='same-as'||eligible(previous.data.items.find(i=>i.key===identity.itemKey)!);
      };
      for(const old of previous.data.items)if(eligible(old)){
        const {item,summary}=matching.get(old.key)!;const identity=old.identity;
        if(identity.kind==='existing'){
          const candidate=this.workChoice(identity.workId!,batch.creator_id,this.thumbnailVersion());
          if(!candidate)continue;
          if(!summary.candidates.some(c=>c.workId===candidate.workId))summary.candidates.push(candidate);
        }
        summary.suggestedAction={key:item.key,action:identity.kind,displayTitle:old.displayTitle,primary:old.primary,approvedAds:old.approvedAds,
          acceptSourceIds:old.acceptVersions.map(a=>a.sourceWorkId),reason:old.reason,
          ...(identity.kind==='existing'?{workId:identity.workId}:identity.kind==='same-as'?{sameAsKey:matching.get(identity.itemKey)!.item.key}:{})};
        this.db.prepare('UPDATE local_admission_web_items SET summary_json=? WHERE batch_id=? AND item_key=?').run(JSON.stringify(summary),next.id,item.key);
      }
    }
    return {...this.get(next.id),items:this.items(next.id).items};
  }
  private collectionRow(id:string) {
    const row=this.db.prepare(`SELECT id,state,created_at,updated_at,error,owner_pid,owner_token,confirmed_json IS NOT NULL has_confirmation
      FROM local_admission_web_collections WHERE id=?`).get(id) as (Omit<Collection,'confirmed_json'>&{has_confirmation:number})|undefined;
    if(!row)throw new AdmissionWebError('集中导入不存在',404);return row;
  }
  collection(id:string,completedLater?:Map<string,CurrentAdmissionDisposition>) {
    const row=this.collectionRow(id);
    const children=this.db.prepare(`SELECT b.id,json_extract(b.context_json,'$.parent') parent FROM local_admission_web_collection_batches c
      JOIN local_admission_web_batches b ON b.id=c.batch_id WHERE c.collection_id=? ORDER BY c.position`).all(id);
    const later=completedLater??laterAdmissionCompletions(this.db,children.map(child=>String(child.id)));
    const batches=children.map(child=>({...this.get(String(child.id),later),parent:String(child.parent)}));
    const currentTotals={completedLater:0,pending:0,unresolved:0};
    for(const child of batches)for(const key of ['completedLater','pending','unresolved'] as const)currentTotals[key]+=child.currentTotals[key];
    const totals={creators:batches.length,total:0,selected:0,completed:0,skipped:0,deferred:0,review:0,dependency:0,unstarted:0,failedCreators:0};
    for(const child of batches){for(const key of ['total','selected','completed','skipped','deferred','review','dependency','unstarted'] as const)totals[key]+=child.totals[key];
      if(['needs_review','failed','interrupted'].includes(child.state))totals.failedCreators++;}
    const state=row.has_confirmation&&batches.length&&batches.every(b=>b.state==='completed')?'completed':this.effectiveState(row);
    const previous=this.db.prepare(`SELECT json_extract(b.context_json,'$.previousCollectionId') previous_id
      FROM local_admission_web_collection_batches c JOIN local_admission_web_batches b ON b.id=c.batch_id
      WHERE c.collection_id=? AND json_extract(b.context_json,'$.previousCollectionId') IS NOT NULL LIMIT 1`).get(id);
    const next=this.db.prepare(`SELECT DISTINCT c.collection_id FROM local_admission_web_collection_batches c
      JOIN local_admission_web_batches b ON b.id=c.batch_id WHERE json_extract(b.context_json,'$.previousCollectionId')=? ORDER BY c.collection_id`).all(id);
    const refresh=this.db.prepare(`SELECT json_extract(b.context_json,'$.directoryRefresh') report
      FROM local_admission_web_collection_batches c JOIN local_admission_web_batches b ON b.id=c.batch_id
      WHERE c.collection_id=? AND json_extract(b.context_json,'$.directoryRefresh') IS NOT NULL LIMIT 1`).get(id);
    return {id,state,createdAt:row.created_at,updatedAt:row.updated_at,error:state==='completed'?null:row.error,errorMessage:state==='completed'?null:admissionErrorMessage(row.error),totals,currentTotals,batches,remainingCount:row.has_confirmation?this.remainingItems(id,later).length:0,
      ...(refresh?{directoryRefresh:JSON.parse(String(refresh.report)) as DirectoryRefresh}:{}),
      previousCollectionId:previous?String(previous.previous_id):null,nextCollectionIds:next.map(child=>String(child.collection_id))};
  }
  collections(page=1) {
    page=Math.max(1,page);const pageSize=20,total=Number(this.db.prepare('SELECT COUNT(*) n FROM local_admission_web_collections').get()!.n);
    const ids=this.db.prepare('SELECT id FROM local_admission_web_collections ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(pageSize,(page-1)*pageSize).map(row=>String(row.id));
    const batchIds=this.db.prepare('SELECT batch_id FROM local_admission_web_collection_batches WHERE collection_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)).map(row=>String(row.batch_id));
    const later=laterAdmissionCompletions(this.db,batchIds);
    return {page,pageSize,total,items:ids.map(id=>this.collection(id,later))};
  }
  collectionScope(id:string) {
    this.collectionRow(id);
    // Saved scope only: reopening the range picker never inventories the disk
    // and does not silently include newly added or renamed directories.
    const children=this.db.prepare(`SELECT b.id,b.creator_id,b.source_evidence_id,json_extract(b.context_json,'$.parent') parent
      FROM local_admission_web_collection_batches c JOIN local_admission_web_batches b ON b.id=c.batch_id
      WHERE c.collection_id=? ORDER BY c.position`).all(id);
    return {scopes:children.map(child=>({creatorId:Number(child.creator_id),parent:String(child.parent),
      directories:this.db.prepare('SELECT summary_json FROM local_admission_web_items WHERE batch_id=? ORDER BY position').all(child.id)
        .map(item=>(JSON.parse(String(item.summary_json)) as Summary).sourceRelativePath),
      acceptExistingVersion:true,...(child.source_evidence_id==null?{}:{sourceEvidenceId:Number(child.source_evidence_id)})}))};
  }
  private assertDraftCollection(id:string) {
    const record=this.collectionRow(id);
    if(record.state!=='draft'||record.has_confirmation||record.owner_pid!==null||record.owner_token!==null)
      throw new AdmissionWebError('集中导入已有确认或正在执行，不能重新预览；请继续原集合');
    const changed=this.db.prepare(`SELECT b.id FROM local_admission_web_collection_batches c JOIN local_admission_web_batches b ON b.id=c.batch_id
      WHERE c.collection_id=? AND (b.state<>'draft' OR b.confirmed_json IS NOT NULL OR b.owner_pid IS NOT NULL OR b.owner_token IS NOT NULL) LIMIT 1`).get(id);
    if(changed)throw new AdmissionWebError('集中导入子批次已有确认或正在执行，不能重新预览；请继续原集合');
  }
  private async prepareCollectionPreview(raw:unknown) {
    const {scopes}=collectionPreviewSchema.parse(raw);
    if(new Set(scopes.map(s=>s.creatorId)).size!==scopes.length)throw new AdmissionWebError('同一规范博主本次只能选择一个父目录；多个别名目录请分别预览，不能静默合并或漏项',400);
    if(new Set(scopes.map(s=>process.platform==='win32'?s.parent.toLowerCase():s.parent)).size!==scopes.length)throw new AdmissionWebError('同一父目录不能重复分配给多位博主',400);
    const prepared:PreparedPreview[]=[];
    for(const scope of scopes)prepared.push(await this.preparePreview(scope));
    return prepared;
  }
  private publishCollectionPreview(prepared:PreparedPreview[],previousId?:string,remainingSignature?:string,requireIdle=false) {
    const id=randomUUID(),stamp=now();this.db.exec('BEGIN IMMEDIATE');
    try{
      if(requireIdle){this.assertIdle();for(const child of prepared)this.assertCreatorIdle(child.scope.creatorId);}
      // Another request may confirm while the selected manifests are read.
      // Recheck under the same transaction that publishes the new draft.
      if(previousId){
        this.assertCollectionScopeNotCompletedLater(previousId,prepared.map(child=>child.scope));
        if(remainingSignature===undefined)this.assertDraftCollection(previousId);
        else {
          this.assertRemainingIdle(previousId);
          const existing=this.remainingDraft(previousId);
          if(existing){this.db.exec('COMMIT');return this.collection(existing);}
          if(hash(this.remainingItems(previousId))!==remainingSignature)throw new AdmissionWebError('剩余范围已变化，请刷新后重新核对');
        }
      }
      this.db.prepare("INSERT INTO local_admission_web_collections(id,state,created_at,updated_at) VALUES(?,'draft',?,?)").run(id,stamp,stamp);
      for(const [position,child] of prepared.entries()){
        // Draft lineage is published with its children; original confirmations stay immutable.
        this.savePreview(previousId?{...child,context:{...child.context,previousCollectionId:previousId}}:child);
        this.db.prepare('INSERT INTO local_admission_web_collection_batches VALUES(?,?,?)').run(id,child.id,position);
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.collection(id);
  }
  async previewCollection(raw:unknown) {
    return this.publishCollectionPreview(await this.prepareCollectionPreview(raw));
  }
  async repreviewCollection(id:string,raw:unknown={}) {
    const request=collectionRepreviewSchema.parse(raw);this.assertDraftCollection(id);
    if(!request.refreshDirectories)this.assertCollectionScopeNotCompletedLater(id,request.scopes??this.collectionScope(id).scopes);
    const prepared=request.refreshDirectories?await this.refreshCollectionDirectories(id):await this.prepareCollectionPreview(request.scopes?{scopes:request.scopes}:this.collectionScope(id));
    const lineage=this.db.prepare(`SELECT json_extract(b.context_json,'$.remainingFromCollectionId') origin,json_extract(b.context_json,'$.remainingSourceSignature') signature FROM local_admission_web_collection_batches c
      JOIN local_admission_web_batches b ON b.id=c.batch_id WHERE c.collection_id=? AND json_extract(b.context_json,'$.remainingFromCollectionId') IS NOT NULL LIMIT 1`).get(id);
    if(lineage)for(const child of prepared){child.context.remainingFromCollectionId=String(lineage.origin);child.context.remainingSourceSignature=String(lineage.signature);}
    return this.publishCollectionPreview(prepared,id,undefined,request.refreshDirectories===true);
  }
  private async refreshCollectionDirectories(id:string):Promise<PreparedPreview[]> {
    this.assertIdle();
    const report:DirectoryRefresh={added:[],removed:[],warnings:[]};
    const prepared:PreparedPreview[]=[];
    const empty:PreparedPreview[]=[];
    const observations:{inputRoot:string;entries:Awaited<ReturnType<LocalAdmissionWebService['refreshEntries']>>}[]=[];
    const normalize=(name:string)=>process.platform==='win32'?name.toLowerCase():name;
    for(const scope of this.collectionScope(id).scopes){
      this.assertCreatorIdle(scope.creatorId);
      const old=this.db.prepare(`SELECT b.id,b.input_root,b.context_json FROM local_admission_web_collection_batches c
        JOIN local_admission_web_batches b ON b.id=c.batch_id WHERE c.collection_id=? AND b.creator_id=?`).get(id,scope.creatorId)!;
      const context=JSON.parse(String(old.context_json)) as Context;
      const unresolvedScope=this.scopeReviewPaths(String(old.id));
      const inputRoot=path.join(this.settings().waitingRoot,scope.parent);
      if(!same(inputRoot,String(old.input_root))||!same(this.settings().waitingRoot,context.waitingRoot))
        throw new AdmissionWebError('等待区设置已改变，请从选择范围核对原目录，不能自动改用新位置');
      const later=laterAdmissionCompletions(this.db,[String(old.id)]);
      const covered=new Set(this.db.prepare("SELECT item_key,json_extract(summary_json,'$.sourceRelativePath') relative FROM local_admission_web_items WHERE batch_id=?").all(old.id)
        .filter(row=>later.get(admissionItemIdentity(String(old.id),String(row.item_key)))?.status==='completed_later').map(row=>normalize(String(row.relative))));
      if(scope.directories.length&&scope.directories.every(name=>covered.has(normalize(name)))){
        report.warnings.push(`${scope.parent}：原范围已在后续批次完成，未重新读取或加入本次核对。`);continue;
      }
      const observed=await this.refreshEntries(inputRoot);observations.push({inputRoot,entries:observed});
      const entries=observed??[],byName=new Map(entries.map(entry=>[normalize(entry.name),entry]));
      if(observed===null)report.warnings.push(`${scope.parent}：等待区父目录已不存在，原预览保留；本次没有移动或删除文件。`);
      const selected=new Set(scope.directories.map(normalize));
      const known=new Set(context.knownSiblingDirectories?.map(normalize)??[]);
      const retained=scope.directories.filter(name=>byName.has(normalize(name))&&!covered.has(normalize(name)));
      const reserved=new Set<string>();
      for(const row of this.db.prepare(`SELECT json_extract(i.summary_json,'$.sourceRelativePath') relative
        FROM local_admission_web_batches b JOIN local_admission_web_items i ON i.batch_id=b.id
        WHERE b.confirmed_json IS NOT NULL AND i.action<>'defer' AND lower(b.input_root)=lower(?)`).all(inputRoot))reserved.add(normalize(String(row.relative)));
      for(const row of this.db.prepare(`SELECT json_extract(j.value,'$.sourceRelativePath') relative FROM archive_local_admission_plans p,json_each(p.payload_json,'$.items') j
        WHERE NOT EXISTS(SELECT 1 FROM local_admission_web_batches b WHERE b.id=p.plan_id)
          AND lower(json_extract(p.payload_json,'$.inputRoot'))=lower(?)`).all(inputRoot))reserved.add(normalize(String(row.relative)));
      const discovered=entries.filter(entry=>entry.directory&&!selected.has(normalize(entry.name))&&!known.has(normalize(entry.name)));
      const added=discovered.filter(entry=>!reserved.has(normalize(entry.name)));
      if(discovered.length!==added.length)report.warnings.push(`${scope.parent}：已由其他确认计划占用或已跳过的目录未自动加入，请从原记录处理。`);
      for(const name of scope.directories)if(!byName.has(normalize(name)))report.removed.push({creatorId:scope.creatorId,parent:scope.parent,name});
      for(const entry of added)report.added.push({creatorId:scope.creatorId,parent:scope.parent,name:entry.name});
      if(entries.some(entry=>entry.link&&!selected.has(normalize(entry.name))))report.warnings.push(`${scope.parent}：目录链接未加入核对范围。`);
      if(added.length&&!context.knownSiblingDirectories)report.warnings.push(`${scope.parent}：旧预览未记录完整父目录范围，新发现的 ${added.length} 个目录先暂缓，请核对是否属于本批拆分后的作品。`);
      if(!retained.length&&!added.length){
        // Keep a zero-item child so the persisted empty preview retains lineage
        // and the removal report without rewriting the historical draft.
        empty.push({id:randomUUID(),scope:{...scope,directories:[]},inputRoot,
          context:{...context,workFacts:{},sourceFacts:{},knownSiblingDirectories:entries.filter(entry=>entry.directory).map(entry=>entry.name)},
          items:[],titleCandidates:new LocalAdmissionTitleCandidates(this.db,scope.creatorId)});
        continue;
      }
      const child=await this.preparePreview({...scope,directories:[...retained,...added.map(entry=>entry.name)]});
      if(hash(entries)!==hash(await this.siblingEntries(inputRoot)))throw new AdmissionWebError('重新读取期间目录范围发生变化，请待整理结束后重试；原草稿保持');
      for(const item of child.items)if(unresolvedScope.has(item.summary.sourceRelativePath)||!context.knownSiblingDirectories&&added.some(entry=>entry.name===item.summary.sourceRelativePath)){
        item.summary.scopeReviewRequired=true;
        item.summary.suggestedAction={key:item.summary.key,action:'defer',reason:legacyScopeReviewReason};
      }
      prepared.push(child);
    }
    if(!prepared.length)prepared.push(...empty);
    if(!prepared.length)throw new AdmissionWebError('本批博主下没有可核对的作品目录，原草稿保留；请先完成目录整理或调整导入范围');
    for(const observation of observations)if(hash(observation.entries)!==hash(await this.refreshEntries(observation.inputRoot)))
      throw new AdmissionWebError('重新读取期间目录范围发生变化，请待整理结束后重试；原草稿保持');
    this.assertIdle();for(const child of prepared)this.assertCreatorIdle(child.scope.creatorId);
    prepared[0]!.context.directoryRefresh=report;
    return prepared;
  }
  private async refreshEntries(inputRoot:string) {
    const root=await this.validateRoot();
    if(!same(path.dirname(inputRoot),root))throw new AdmissionWebError('等待区范围已改变，请重新选择目录');
    try{await fs.lstat(inputRoot);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      // A missing child is a scope change, not proof that a disconnected root
      // or inaccessible drive is an empty waiting area.
      await this.validateRoot();return null;
    }
    await strictDirectory(inputRoot);await assertPathInsideLocalIngestRoot(root,inputRoot,{directChild:true});
    return this.siblingEntries(inputRoot);
  }
  private remainingItems(id:string,completedLater?:Map<string,CurrentAdmissionDisposition>) {
    // DB-only projection: progress reads never re-inventory files or parse full manifests.
    const ids=this.db.prepare('SELECT batch_id FROM local_admission_web_collection_batches WHERE collection_id=?').all(id).map(row=>String(row.batch_id));
    const later=completedLater??laterAdmissionCompletions(this.db,ids),partiallyCovered=[...later].some(([key,value])=>value.status==='completed_later'&&ids.includes(JSON.parse(key)[0]));
    const rows=this.db.prepare(`SELECT b.id batch_id,b.creator_id,b.input_root,b.source_evidence_id,json_extract(b.context_json,'$.parent') parent,i.item_key,
      json_extract(i.summary_json,'$.sourceRelativePath') relative,json_extract(i.summary_json,'$.targetPath') target
      FROM local_admission_web_collection_batches c JOIN local_admission_web_batches b ON b.id=c.batch_id
      JOIN local_admission_web_items i ON i.batch_id=b.id
      WHERE c.collection_id=? AND i.action<>'skip'
        AND (i.action='defer' AND NOT EXISTS(SELECT 1 FROM archive_local_admission_items a WHERE a.plan_id=b.id AND a.item_key=i.item_key)
          OR ? AND EXISTS(SELECT 1 FROM archive_local_admission_items a WHERE a.plan_id=b.id AND a.item_key=i.item_key
            AND a.state='planned' AND a.work_id IS NULL AND a.local_work_id IS NULL))
      ORDER BY c.position,i.position`).all(id,partiallyCovered?1:0);
    if(!rows.length)return [];
    const reserved=new Set<string>();
    const key=(root:string,relative:string)=>{const resolved=path.resolve(root,relative);return process.platform==='win32'?resolved.toLowerCase():resolved;};
    // Retain the original "target already registered" safeguard, but scope it to
    // these exact destinations instead of reading every later LocalWork.
    const laterLocalTargets=new Set(this.db.prepare(`SELECT l.absolute_path FROM archive_catalog_local_works l
      WHERE l.absolute_path IN (SELECT value FROM json_each(?)) AND l.is_active=1 AND l.work_id IS NOT NULL
        AND julianday(l.created_at)>julianday((SELECT created_at FROM local_admission_web_collections WHERE id=?))`)
      .all(JSON.stringify(rows.map(row=>String(row.target??''))),id).map(row=>key(String(row.absolute_path),'.')));
    for(const root of new Set(rows.map(row=>String(row.input_root)))){
      for(const other of this.db.prepare(`SELECT b.input_root,json_extract(i.summary_json,'$.sourceRelativePath') relative
        FROM local_admission_web_batches b JOIN local_admission_web_items i ON i.batch_id=b.id
        WHERE b.confirmed_json IS NOT NULL AND i.action<>'defer' AND lower(b.input_root)=lower(?)
          AND NOT EXISTS(SELECT 1 FROM local_admission_web_collection_batches c WHERE c.collection_id=? AND c.batch_id=b.id)`).all(root,id))reserved.add(key(String(other.input_root),String(other.relative)));
      // CLI plans may exist without any web batch. Only project exact paths from the saved plan.
      for(const other of this.db.prepare(`SELECT json_extract(p.payload_json,'$.inputRoot') input_root,json_extract(j.value,'$.sourceRelativePath') relative
        FROM archive_local_admission_plans p,json_each(p.payload_json,'$.items') j
        WHERE NOT EXISTS(SELECT 1 FROM local_admission_web_batches b WHERE b.id=p.plan_id)
          AND lower(json_extract(p.payload_json,'$.inputRoot'))=lower(?)`).all(root))reserved.add(key(String(other.input_root),String(other.relative)));
    }
    return rows.map(row=>({batchId:String(row.batch_id),creatorId:Number(row.creator_id),inputRoot:String(row.input_root),sourceEvidenceId:row.source_evidence_id==null?undefined:Number(row.source_evidence_id),
      context:{parent:String(row.parent)},summary:{key:String(row.item_key),sourceRelativePath:String(row.relative),targetPath:String(row.target??'')}}))
      .filter(row=>!reserved.has(key(row.inputRoot,row.summary.sourceRelativePath))&&later.get(admissionItemIdentity(row.batchId,row.summary.key))?.status!=='completed_later'
        &&(!row.summary.targetPath||!laterLocalTargets.has(key(row.summary.targetPath,'.'))));
  }
  private assertRemainingIdle(id:string) {
    const row=this.collectionRow(id);
    if(!row.has_confirmation)throw new AdmissionWebError('未确认批次请在原集中核对页面继续');
    if(alive(row.owner_pid))throw new AdmissionWebError('集中导入仍有活动执行所有者');
    for(const child of this.db.prepare(`SELECT b.owner_pid FROM local_admission_web_collection_batches c JOIN local_admission_web_batches b ON b.id=c.batch_id WHERE c.collection_id=?`).all(id))
      if(alive(Number(child.owner_pid)))throw new AdmissionWebError('子批次仍有活动执行所有者');
    this.assertIdle();
  }
  private remainingDraft(id:string):string|null {
    const signature=this.remainingSignature(id);
    const candidates=this.db.prepare(`SELECT DISTINCT c.id,c.created_at FROM local_admission_web_collections c
      JOIN local_admission_web_collection_batches cb ON cb.collection_id=c.id JOIN local_admission_web_batches b ON b.id=cb.batch_id
      WHERE c.state='draft' AND c.confirmed_json IS NULL AND c.owner_pid IS NULL
        AND json_extract(b.context_json,'$.remainingFromCollectionId')=? AND json_extract(b.context_json,'$.remainingSourceSignature')=?
        AND NOT EXISTS(SELECT 1 FROM local_admission_web_batches next WHERE json_extract(next.context_json,'$.previousCollectionId')=c.id)
      ORDER BY c.created_at DESC,c.id DESC`).all(id,signature);
    for(const candidate of candidates){try{this.assertDraftCollection(String(candidate.id));return String(candidate.id);}catch{/* a child has already been confirmed */}}
    return null;
  }
  private remainingSignature(id:string) {return hash(this.remainingItems(id).map(row=>[row.batchId,row.summary.key,row.inputRoot,row.summary.sourceRelativePath]));}
  async remainingCollection(id:string) {
    this.assertRemainingIdle(id);
    const remaining=this.remainingItems(id);if(!remaining.length)throw new AdmissionWebError('没有尚未执行的暂缓项；已开始项请继续原确认计划');
    const sourceSignature=hash(remaining.map(row=>[row.batchId,row.summary.key,row.inputRoot,row.summary.sourceRelativePath]));
    const existing=this.remainingDraft(id);if(existing)return this.collection(existing);
    const scopes=new Map<string,z.infer<typeof webPreviewSchema>>();
    for(const item of remaining){
      this.assertCreatorIdle(item.creatorId);
      if(!same(path.join(this.settings().waitingRoot,item.context.parent),item.inputRoot))throw new AdmissionWebError('等待区设置已改变，请从选择范围核对原目录，不能自动改用新位置');
      if(!scopes.has(item.batchId))scopes.set(item.batchId,{creatorId:item.creatorId,parent:item.context.parent,directories:[],sourceEvidenceId:item.sourceEvidenceId,acceptExistingVersion:true});
      scopes.get(item.batchId)!.directories.push(item.summary.sourceRelativePath);
    }
    const prepared=await this.prepareCollectionPreview({scopes:[...scopes.values()]});
    const confirmation=JSON.parse(String(this.db.prepare('SELECT confirmed_json FROM local_admission_web_collections WHERE id=?').get(id)!.confirmed_json)) as z.infer<typeof collectionExecuteSchema>;
    for(const child of prepared){
      child.context.remainingFromCollectionId=id;
      child.context.remainingSourceSignature=sourceSignature;
      const origin=remaining.find(row=>row.creatorId===child.scope.creatorId)!;
      // Keep the original exclusion boundary, including legacy drafts with no inventory.
      const originalContext=JSON.parse(this.row(origin.batchId).context_json) as Context;
      child.context.knownSiblingDirectories=originalContext.knownSiblingDirectories;
      for(const item of child.items){
        const old=remaining.find(row=>row.creatorId===child.scope.creatorId&&row.summary.sourceRelativePath===item.summary.sourceRelativePath);
        const decision=confirmation.batches?.find(batch=>batch.batchId===old?.batchId)?.actions.find(action=>action.key===old?.summary.key);
        if(decision?.reason)item.summary.suggestedAction={key:item.summary.key,action:'defer',reason:decision.reason};
      }
    }
    return this.publishCollectionPreview(prepared,id,hash(remaining));
  }
  private async cleanupParent(batchId:string,assertIdle:()=>void) {
    const batch=this.row(batchId),context=JSON.parse(batch.context_json) as Context;
    if(this.get(batchId).state!=='completed'||this.get(batchId).totals.completed===0)return;
    const result=await recycleEmptyAdmissionParent({waitingRoot:context.waitingRoot,parentPath:batch.input_root,assertIdle});
    // Cleanup has a separate outcome, never rewrites the confirmed plan or a completed item.
    if(result.status==='not_applicable'&&context.parentCleanup?.status==='recycled')return;
    this.db.prepare('UPDATE local_admission_web_batches SET context_json=? WHERE id=?').run(JSON.stringify({...context,parentCleanup:result}),batchId);
  }
  private async finalizeParent(batchId:string,assertIdle:()=>void) {
    try{await this.cleanupParent(batchId,assertIdle);}
    catch(error){console.error('[local-admission-web] empty parent cleanup record failed; admission remains completed:',message(error));}
  }
  async cleanupEmptyParents(id:string) {
    this.assertRemainingIdle(id);
    await runAdmissionCollectionExclusive(this.db,async()=>{
      for(const child of this.db.prepare('SELECT batch_id FROM local_admission_web_collection_batches WHERE collection_id=? ORDER BY position').all(id))
        await this.cleanupParent(String(child.batch_id),()=>{this.assertIdle(undefined,undefined,true);this.assertCreatorIdle(this.row(String(child.batch_id)).creator_id);});
    });
    return this.collection(id);
  }
  private collectionRequest(key:string,id:string,kind:string,payload:unknown) {
    const row=this.db.prepare('SELECT * FROM local_admission_web_collection_requests WHERE request_key=?').get(key);
    if(!row)return false;
    if(row.collection_id!==id||row.kind!==kind||row.payload_hash!==hash(payload))throw new AdmissionWebError('集中请求键已用于另一份确认，请重试原请求');
    return true;
  }
  async executeCollection(id:string,raw:unknown) {
    const request=collectionExecuteSchema.parse(raw);if(this.collectionRequest(request.requestKey,id,'execute',request))return this.collection(id);
    const record=this.collectionRow(id);if(record.state!=='draft'||record.has_confirmation)throw new AdmissionWebError('集中确认已保存，请继续原集合');
    this.assertIdle();
    const children=this.db.prepare('SELECT batch_id FROM local_admission_web_collection_batches WHERE collection_id=? ORDER BY position').all(id);
    if(!children.length||!this.db.prepare(`SELECT 1 FROM local_admission_web_items i JOIN local_admission_web_collection_batches c ON c.batch_id=i.batch_id WHERE c.collection_id=? LIMIT 1`).get(id))
      throw new AdmissionWebError('已无待入库目录，无需提交；原预览与历史记录保留。');
    const requested=new Map(request.batches.map(child=>[child.batchId,child]));
    if(requested.size!==request.batches.length||requested.size!==children.length||children.some(row=>!requested.has(String(row.batch_id))))throw new AdmissionWebError('集中确认必须覆盖本集合所有博主批次',400);
    const prepared:PreparedExecution[]=[],targets=new Set<string>();
    try{for(const row of children){
      const child=requested.get(String(row.batch_id))!,{batchId,...options}=child;
      const input=webExecuteSchema.parse({...options,requestKey:`collection:${id}:execute:${batchId}`,confirmed:true});
      const next=await this.prepareExecution(batchId,input);
      if(next.plan){
        for(const item of next.plan.items){const target=process.platform==='win32'?path.resolve(item.targetPath).toLowerCase():path.resolve(item.targetPath);
          if(targets.has(target))throw new AdmissionWebError('不同博主批次指向同一目标目录，请重新核对');targets.add(target);}
        await this.admission.verifyUnstarted(next.plan);
      }
      prepared.push(next);
    }}catch(e){if(this.collectionRequest(request.requestKey,id,'execute',request))return this.collection(id);
      throw confirmationOwnershipError(e);}
    // Filesystem reads above do not hold a SQLite read snapshot. Commit all children
    // under one fresh write transaction; no child can run before the last validates.
    if(this.collectionRequest(request.requestKey,id,'execute',request))return this.collection(id);
    const token=randomUUID();this.db.exec('BEGIN IMMEDIATE');
    try{
      this.assertIdle();for(const child of prepared)this.assertPreparedCurrent(child);
      const changed=this.db.prepare("UPDATE local_admission_web_collections SET state='queued',confirmed_json=?,owner_pid=?,owner_token=?,updated_at=?,error=NULL WHERE id=? AND state='draft' AND confirmed_json IS NULL")
        .run(JSON.stringify(request),process.pid,token,now(),id);
      if(changed.changes!==1)throw new AdmissionWebError('集中批次已被另一请求确认');
      for(const child of prepared)this.saveExecution(child,token);
      this.db.prepare('INSERT INTO local_admission_web_collection_requests VALUES(?,?,?,?,?)').run(request.requestKey,id,'execute',hash(request),now());
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.scheduleCollection(id,token);return this.collection(id);
  }
  resumeCollection(id:string,raw:unknown) {
    const request=webResumeSchema.parse(raw);if(this.collectionRequest(request.requestKey,id,'resume',request))return this.collection(id);
    const row=this.collectionRow(id);if(!row.has_confirmation)throw new AdmissionWebError('请先集中确认');
    if(this.collection(id).state==='completed')return this.collection(id);
    if(['queued','running'].includes(this.effectiveState(row)))throw new AdmissionWebError('集中队列仍在执行');
    this.assertIdle(undefined,id);const token=randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const current=this.collectionRow(id);if(['queued','running'].includes(this.effectiveState(current)))throw new AdmissionWebError('集中队列已被另一请求继续');
      this.assertIdle(undefined,id);
      this.db.prepare("UPDATE local_admission_web_collections SET state='queued',owner_pid=?,owner_token=?,updated_at=?,error=NULL WHERE id=?").run(process.pid,token,now(),id);
      for(const row of this.db.prepare('SELECT batch_id FROM local_admission_web_collection_batches WHERE collection_id=? ORDER BY position').all(id)){
        const batchId=String(row.batch_id);if(this.get(batchId).state==='completed')continue;
        this.assertNotCompletedLater(batchId);
        const child=this.row(batchId);if(!child.confirmed_json)throw new AdmissionWebError('子批确认记录缺失，不能推断执行');
        admissionPlanSchema.parse(JSON.parse(child.confirmed_json));
        this.db.prepare("UPDATE local_admission_web_batches SET state='queued',owner_pid=?,owner_token=?,updated_at=?,error=NULL WHERE id=?").run(process.pid,token,now(),batchId);
      }
      this.db.prepare('INSERT INTO local_admission_web_collection_requests VALUES(?,?,?,?,?)').run(request.requestKey,id,'resume',hash(request),now());
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.scheduleCollection(id,token);return this.collection(id);
  }
  private scheduleCollection(id:string,token:string) {
    const key=`collection:${id}`;
    const task=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
      try{
        await runAdmissionCollectionExclusive(this.db,async()=>{
          const changed=this.db.prepare("UPDATE local_admission_web_collections SET state='running',updated_at=? WHERE id=? AND owner_token=?").run(now(),id,token);
          if(changed.changes!==1)throw new AdmissionWebError('集中执行所有者已改变');
          const children=this.db.prepare('SELECT batch_id FROM local_admission_web_collection_batches WHERE collection_id=? ORDER BY position').all(id);
          for(const row of children){
            const childId=String(row.batch_id);if(this.get(childId).state==='completed')continue;
            const child=this.row(childId);if(child.owner_token!==token)throw new AdmissionWebError('子批执行所有者已改变');
            this.db.prepare("UPDATE local_admission_web_batches SET state='running',updated_at=? WHERE id=? AND owner_token=?").run(now(),childId,token);
            try{
              const plan=admissionPlanSchema.parse(JSON.parse(child.confirmed_json!));
              await strictDirectory(plan.inputRoot);await strictDirectory(plan.galleryRoot);this.creator(plan.creatorId);this.assertCreatorIdle(plan.creatorId);
              const result=await this.admission.apply(plan,{continueReviewable:true});
              this.db.prepare('UPDATE local_admission_web_batches SET state=?,error=?,updated_at=? WHERE id=? AND owner_token=?')
                .run(result.completed?'completed':'needs_review',result.completed?null:'部分图集需要核对；其余独立图集已按原计划执行',now(),childId,token);
              if(result.completed)await this.finalizeParent(childId,()=>{this.assertIdle(undefined,id,true);this.assertCreatorIdle(plan.creatorId);});
            }catch(e){
              const checkpoint=this.db.prepare('SELECT state FROM archive_local_admission_items WHERE plan_id=? AND last_error IS NOT NULL ORDER BY rowid LIMIT 1').get(childId);
              this.db.prepare('UPDATE local_admission_web_batches SET state=?,error=?,updated_at=? WHERE id=? AND owner_token=?')
                .run(checkpoint?.state==='indexed'?'failed':'needs_review',message(e),now(),childId,token);
              // Only explicitly diagnosed content problems return normally. Any
              // thrown storage, identity or unknown failure pauses later creators.
              throw e;
            }finally{this.db.prepare('UPDATE local_admission_web_batches SET owner_pid=NULL,owner_token=NULL WHERE id=? AND owner_token=?').run(childId,token);}
          }
          const complete=this.collection(id).batches.every(child=>child.state==='completed');
          this.db.prepare('UPDATE local_admission_web_collections SET state=?,error=?,updated_at=? WHERE id=? AND owner_token=?')
            .run(complete?'completed':'partial',complete?null:'独立图集已执行完毕；待核对和依赖等待项保留在原计划中',now(),id,token);
        });
      }catch(e){this.db.prepare("UPDATE local_admission_web_collections SET state='partial',error=?,updated_at=? WHERE id=? AND owner_token=?").run(message(e),now(),id,token);}
      finally{
        this.db.prepare('UPDATE local_admission_web_batches SET owner_pid=NULL,owner_token=NULL WHERE owner_token=? AND id IN (SELECT batch_id FROM local_admission_web_collection_batches WHERE collection_id=?)').run(token,id);
        this.db.prepare('UPDATE local_admission_web_collections SET owner_pid=NULL,owner_token=NULL WHERE id=? AND owner_token=?').run(id,token);this.tasks.delete(key);
      }
    });
    this.tasks.set(key,task);void task.catch(error=>console.error('[local-admission-web] collection dispatch record failed:',message(error)));
  }
  private assertIdle(exceptId?:string,exceptCollection?:string,insideOwnedLock=false) {
    for(const row of this.db.prepare("SELECT id,owner_pid FROM local_admission_web_collections WHERE state IN ('queued','running')").all()){
      if(row.id!==exceptCollection&&alive(Number(row.owner_pid)))throw new AdmissionWebError('已有集中导入正在执行，请等待完成');}
    const operation=this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY);
    if(operation&&!insideOwnedLock){
      let owner:{pid:number;token:string;kind:string};
      try{owner=JSON.parse(String(operation.value));}catch{throw new AdmissionWebError('现有执行所有者信息无法核对，请先处理原任务');}
      if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||!owner.token||!owner.kind)throw new AdmissionWebError('现有执行所有者信息无法核对，请先处理原任务');
      if(alive(owner.pid))throw new AdmissionWebError('接纳、扫描或 Stage3 正在执行，请等待完成');
    }
    for(const row of this.db.prepare("SELECT id,state,owner_pid FROM local_admission_web_batches WHERE state IN ('queued','running')").all()){
      if(row.id!==exceptId&&this.collectionId(String(row.id))!==exceptCollection&&alive(Number(row.owner_pid)))throw new AdmissionWebError('已有导入批次正在执行');}
    if(this.db.prepare("SELECT id FROM scan_runs WHERE status='running' LIMIT 1").get()||this.db.prepare("SELECT id FROM local_ingest_jobs WHERE status IN ('running','reconciling') AND claim_token IS NOT NULL LIMIT 1").get())throw new AdmissionWebError('扫描或 Stage3 正在执行');
  }
  private request(key:string,id:string,kind:string,payload:unknown) {
    const row=this.db.prepare('SELECT * FROM local_admission_web_requests WHERE request_key=?').get(key);
    if(!row)return false;
    if(row.batch_id!==id||row.kind!==kind||row.payload_hash!==hash(payload))throw new AdmissionWebError('请求键已经用于另一份确认，请保留原请求或重新确认');
    return true;
  }
  private async prepareExecution(id:string,request:z.infer<typeof webExecuteSchema>):Promise<PreparedExecution> {
    const batch=this.row(id);if(batch.confirmed_json||batch.state!=='draft')throw new AdmissionWebError('本批次已有不可变确认计划，请继续原计划');
    const context=JSON.parse(batch.context_json) as Context;
    if(!same(context.waitingRoot,this.settings().waitingRoot)||!same(context.galleryRoot,this.galleryRoot))throw new AdmissionWebError('配置已改变，请重新预览');
    const saved=this.db.prepare('SELECT item_key,preview_json,summary_json FROM local_admission_web_items WHERE batch_id=? ORDER BY position').all(id);
    const actions=new Map(request.actions.map(a=>[a.key,a]));
    if(actions.size!==request.actions.length||actions.size!==saved.length||saved.some(s=>!actions.has(String(s.item_key))))throw new AdmissionWebError('确认必须覆盖本批准确项目；未处理项请选择跳过或暂缓',400);
    const items:AdmissionPlan['items']=[];
    const selected=saved.filter(s=>!['skip','defer'].includes(actions.get(String(s.item_key))!.action));
    this.assertNotCompletedLater(id,selected.map(row=>String(row.item_key)));
    await this.validateRoot();await strictDirectory(batch.input_root);this.creator(batch.creator_id);
    const visited=new Set<string>();const visiting=new Set<string>();
    const add=(key:string)=>{
      if(visited.has(key))return;if(visiting.has(key))throw new AdmissionWebError('同套引用不能形成循环');visiting.add(key);
      const row=selected.find(s=>s.item_key===key),action=actions.get(key)!;
      if(!row?.preview_json)throw new AdmissionWebError('此项目没有有效预览，请暂缓后重新查看');
      const preview=JSON.parse(String(row.preview_json)) as PreviewItem;
      if(preview.review.conflicts.length)throw new AdmissionWebError(`${preview.sourceRelativePath}：目标已有内容，不能覆盖或混合`);
      let identity:AdmissionPlan['items'][number]['identity']={kind:'new'},title=action.displayTitle??preview.displayTitle;
      if(action.action==='existing'){
        if(!action.workId||context.workFacts[String(action.workId)]!==this.workFact(action.workId))throw new AdmissionWebError(`${preview.sourceRelativePath}：选择的作品身份已变化或不在预览范围，请重新预览`);
        const work=this.db.prepare(`SELECT w.display_title FROM archive_catalog_works w LEFT JOIN archive_catalog_local_works l ON l.id=w.primary_local_work_id
          LEFT JOIN posts p ON p.id=l.post_id WHERE w.id=? AND w.creator_id=? AND (p.id IS NULL OR (p.is_deleted=0 AND p.is_trashed=0))`).get(action.workId,batch.creator_id);
        if(!work)throw new AdmissionWebError('作品不属于当前博主');identity={kind:'existing',workId:action.workId};title=String(work.display_title);
      } else if(action.action==='same-as'){
        if(!action.sameAsKey||!actions.has(action.sameAsKey))throw new AdmissionWebError('请选择本批具体同套作品');add(action.sameAsKey);
        title=items.find(i=>i.key===action.sameAsKey)!.displayTitle;identity={kind:'same-as',itemKey:action.sameAsKey};
      }
      if(action.approvedAds.length&&!request.adsConfirmed)throw new AdmissionWebError('广告处置必须单独确认具体清单');
      const allowedAds=new Set(advertisementCandidates(preview.manifest).map(e=>e.relativePath));
      if(new Set(action.approvedAds).size!==action.approvedAds.length||action.approvedAds.some(ad=>!allowedAds.has(ad)))throw new AdmissionWebError('广告选择必须是本项预览中的具体候选文件');
      if(!preview.manifest.some(e=>['image','video'].includes(e.kind)&&!action.approvedAds.includes(e.relativePath)))throw new AdmissionWebError('移出广告后没有可展示媒体，请暂缓此目录');
      const reason=`用户在网页确认页选择：${{new:'新独立作品',existing:'复用所选作品','same-as':'与本批所选目录同套',skip:'跳过',defer:'暂缓'}[action.action]}${action.reason?'；'+action.reason:''}`;
      const acceptVersions=action.acceptSourceIds.map(sourceWorkId=>{
        if(!request.acceptExistingVersion||identity.kind!=='existing'||!identity.workId)throw new AdmissionWebError('精确来源版本接受必须明确复用对应作品并接受本地版本');
        const source=this.db.prepare('SELECT work_id,is_active FROM archive_catalog_source_works WHERE id=?').get(sourceWorkId);
        if(!source||source.work_id!==identity.workId||!source.is_active||context.sourceFacts[String(sourceWorkId)]!==this.sourceFact(sourceWorkId))throw new AdmissionWebError('来源或任务范围已变化，请重新核对');
        const tasks=this.db.prepare('SELECT id,status FROM archive_catalog_download_tasks WHERE source_work_id=? ORDER BY id').all(sourceWorkId);
        if(tasks.some(t=>['claimed','downloading'].includes(String(t.status))))throw new AdmissionWebError('该来源有活动任务，不能抢占或满足');
        return {sourceWorkId,taskIds:tasks.map(t=>Number(t.id)),reason:'用户在网页确认该具体来源与所选作品对应，并接受现有本地版本'};
      });
      const {review,...base}=preview;
      items.push({...base,identity,displayTitle:title,reason,localOnly:false,acceptExistingVersion:request.acceptExistingVersion,primary:action.primary,approvedAds:action.approvedAds,acceptVersions});
      visiting.delete(key);visited.add(key);
    };
    for(const row of selected)add(String(row.item_key));
    const group=(item:AdmissionPlan['items'][number]):string=>{const identity=item.identity;return identity.kind==='existing'?`work:${identity.workId}`:identity.kind==='same-as'?group(items.find(i=>i.key===identity.itemKey)!):item.key;};
    const primaries=new Set<string>();for(const item of items)if(item.primary){const g=group(item);if(primaries.has(g))throw new AdmissionWebError('同一作品只能选择一份主副本');primaries.add(g);}
    const plan=items.length?admissionPlanSchema.parse({version:1,planId:id,confirmed:true,creatorId:batch.creator_id,inputRoot:batch.input_root,galleryRoot:this.galleryRoot,creatorDirectory:context.creatorDirectory,
      ...(batch.source_evidence_id?{sourceEvidenceId:batch.source_evidence_id}:{}),...(request.advertisementDisposition?{advertisementDisposition:request.advertisementDisposition}:{}),items}):null;
    return {batch,request,plan,saved};
  }
  private assertPreparedCurrent(prepared:PreparedExecution) {
    const {batch,plan}=prepared,current=this.row(batch.id),context=JSON.parse(batch.context_json) as Context;
    if(current.confirmed_json||current.state!=='draft')throw new AdmissionWebError('该批次已被另一请求确认');
    if(!same(context.waitingRoot,this.settings().waitingRoot)||!same(context.galleryRoot,this.galleryRoot))throw new AdmissionWebError('配置已改变，请重新预览');
    this.creator(batch.creator_id);this.assertCreatorIdle(batch.creator_id);
    this.assertNotCompletedLater(batch.id,plan?.items.map(item=>item.key)??[]);
    if(plan){try{assertNewAdmissionOwnership(this.db,plan);}catch(error){throw confirmationOwnershipError(error);}}
    for(const item of plan?.items??[]) {
      if(item.identity.kind==='existing'&&context.workFacts[String(item.identity.workId)]!==this.workFact(item.identity.workId!))throw new AdmissionWebError('准备期间作品身份已变化，请重新预览');
      if(item.acceptVersions.some(a=>context.sourceFacts[String(a.sourceWorkId)]!==this.sourceFact(a.sourceWorkId)))throw new AdmissionWebError('准备期间来源或任务已变化，请重新预览');
    }
  }
  private saveExecution({batch,request,plan,saved}:PreparedExecution,token:string) {
      const id=batch.id,items=plan?.items??[];
      const changed=this.db.prepare("UPDATE local_admission_web_batches SET confirmed_json=?,state=?,owner_pid=?,owner_token=?,updated_at=?,error=NULL WHERE id=? AND state='draft' AND confirmed_json IS NULL")
        .run(JSON.stringify(plan??{skippedAll:true}),plan?'queued':'completed',plan?process.pid:null,plan?token:null,now(),id);
      if(changed.changes!==1)throw new AdmissionWebError('该批次已被另一请求确认');
      for(const a of request.actions){
        const summary=JSON.parse(String(saved.find(s=>s.item_key===a.key)!.summary_json)) as Summary;
        const confirmed=items.find(i=>i.key===a.key);
        if(confirmed){summary.displayTitle=confirmed.displayTitle;summary.ads=advertisementCandidates(confirmed.manifest);summary.advertisementRulesVersion=advertisementRulesVersion;}
        this.db.prepare('UPDATE local_admission_web_items SET action=?,summary_json=? WHERE batch_id=? AND item_key=?').run(a.action,JSON.stringify(summary),id,a.key);
      }
      this.db.prepare('INSERT INTO local_admission_web_requests VALUES(?,?,?,?,?)').run(request.requestKey,id,'execute',hash(request),now());
  }
  async execute(id:string,raw:unknown) {
    this.assertStandalone(id);
    const request=webExecuteSchema.parse(raw);if(this.request(request.requestKey,id,'execute',request))return this.get(id);
    this.assertIdle();const prepared=await this.prepareExecution(id,request);
    if(this.request(request.requestKey,id,'execute',request))return this.get(id);
    const token=randomUUID(),plan=prepared.plan;this.db.exec('BEGIN IMMEDIATE');
    try{this.assertIdle();this.assertPreparedCurrent(prepared);this.saveExecution(prepared,token);this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
    if(plan)this.schedule(id,token,plan);
    return this.get(id);
  }
  resume(id:string,raw:unknown) {
    this.assertStandalone(id);
    const request=webResumeSchema.parse(raw);if(this.request(request.requestKey,id,'resume',request))return this.get(id);
    const row=this.row(id);if(!row.confirmed_json)throw new AdmissionWebError('尚未确认，请先预览并确认');
    if(row.state==='completed')return this.get(id);
    if(['running','queued'].includes(this.effectiveState(row)))throw new AdmissionWebError('原任务仍在执行，不重复提交');
    this.assertIdle(id);const plan=admissionPlanSchema.parse(JSON.parse(row.confirmed_json));const token=randomUUID();
    this.db.exec('BEGIN IMMEDIATE');try{
      this.assertIdle(id);
      this.assertNotCompletedLater(id,plan.items.map(item=>item.key));
      this.db.prepare("UPDATE local_admission_web_batches SET state='queued',owner_pid=?,owner_token=?,updated_at=?,error=NULL WHERE id=?").run(process.pid,token,now(),id);
      this.db.prepare('INSERT INTO local_admission_web_requests VALUES(?,?,?,?,?)').run(request.requestKey,id,'resume',hash(request),now());
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.schedule(id,token,plan);return this.get(id);
  }
  private schedule(id:string,token:string,plan:AdmissionPlan) {
    // Dispatch is ephemeral, but the immutable payload, receipt and existing checkpoints are durable.
    // A dead-process receipt is shown as interrupted; opening a page never automatically replays it.
    const task=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
      this.db.prepare("UPDATE local_admission_web_batches SET state='running',updated_at=? WHERE id=? AND owner_token=?").run(now(),id,token);
      try {await strictDirectory(plan.inputRoot);await strictDirectory(plan.galleryRoot);this.assertCreatorIdle(plan.creatorId);
        const result=await this.admission.apply(plan,{continueReviewable:true});this.db.prepare('UPDATE local_admission_web_batches SET state=?,error=?,updated_at=? WHERE id=? AND owner_token=?')
          .run(result.completed?'completed':'needs_review',result.completed?null:'部分图集需要核对；其余独立图集已按原计划执行',now(),id,token);
        try{if(result.completed){this.assertIdle(id);await runAdmissionCollectionExclusive(this.db,()=>this.finalizeParent(id,()=>{this.assertIdle(id,undefined,true);this.assertCreatorIdle(plan.creatorId);}));}}
        catch(error){console.error('[local-admission-web] empty parent finalization deferred; admission remains completed:',message(error));}}
      catch(e){
        const checkpoint=this.db.prepare("SELECT state FROM archive_local_admission_items WHERE plan_id=? AND last_error IS NOT NULL ORDER BY rowid LIMIT 1").get(id);
        // File/preview uncertainty needs review; a post-index failure can continue
        // the original plan without asking the user to reapprove media exceptions.
        const state=checkpoint?.state==='indexed'?'failed':'needs_review';
        this.db.prepare('UPDATE local_admission_web_batches SET state=?,error=?,updated_at=? WHERE id=? AND owner_token=?').run(state,message(e),now(),id,token);
      }
      finally {this.db.prepare('UPDATE local_admission_web_batches SET owner_pid=NULL,owner_token=NULL WHERE id=? AND owner_token=?').run(id,token);this.tasks.delete(id);}
    });
    this.tasks.set(id,task);void task.catch(error=>console.error('[local-admission-web] dispatch record failed:',message(error)));
  }
  async waitForIdle() {await Promise.all([...this.tasks.values()]);}
  private assertCreatorIdle(creatorId:number) {
    if(this.db.prepare(`SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id
      JOIN archive_catalog_works w ON w.id=s.work_id WHERE w.creator_id=? AND t.status IN ('claimed','downloading') LIMIT 1`).get(creatorId))throw new AdmissionWebError('当前博主有活动领取或下载任务，请等待完成');
  }
}
