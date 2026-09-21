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
import { LOCAL_ADMISSION_LOCK_KEY } from './local-admission-lock.js';
import { isAdmissionAdvertisementCandidate, isKnownAdvertisementImage } from '../utils/local-advertisements.js';

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
  adsConfirmed:z.literal(true).optional(), actions:z.array(actionSchema).min(1).max(500) }).strict();
export const webResumeSchema = z.object({requestKey:z.string().min(1).max(150),confirmed:z.literal(true)}).strict();
type Preview = Awaited<ReturnType<LocalFolderAdmissionService['preview']>>;
type PreviewItem = Preview['items'][number];
type Source = {sourceWorkId:number;title:string;sourceOrder:number|null;mediaSummary:string|null;taskIds:number[]};
export type AdmissionWorkChoice = {workId:number;title:string;catalogNo:string|null;images:number;videos:number;
  thumbnailUrl:string|null;primaryLocalWorkId:number|null;localState:string;originalDirectories:string[];sources:Source[]};
type Batch = {id:string;creator_id:number;input_root:string;source_evidence_id:number|null;state:string;created_at:string;updated_at:string;
  error:string|null;context_json:string;confirmed_json:string|null;owner_pid:number|null;owner_token:string|null};
type Context = {galleryRoot:string;creatorDirectory:string;parent:string;waitingRoot:string;workFacts:Record<string,string>;sourceFacts:Record<string,string>};
type Summary = {key:string;sourceRelativePath:string;targetPath:string;displayTitle:string;group:'A'|'B'|'C'|'D';
  summary:{images:number;videos:number;other:number;bytes:number};candidates:AdmissionWorkChoice[];conflicts:string[];
  ads:{relativePath:string;size:number;automatic?:boolean}[];advertisementRulesVersion?:number;suggestedAction?:z.input<typeof actionSchema>};
const advertisementRulesVersion=1;
function advertisementCandidates(manifest:PreviewItem['manifest']):Summary['ads'] {
  return manifest.filter(isAdmissionAdvertisementCandidate).map(e=>({relativePath:e.relativePath,size:e.size,
    ...(e.kind==='image'&&isKnownAdvertisementImage(e.relativePath)?{automatic:true}:{})}));
}
const now = () => new Date().toISOString();
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a:string,b:string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const message = (e:unknown) => e instanceof Error ? e.message : String(e);
export class AdmissionWebError extends Error { constructor(text:string,readonly status=409){super(text);} }
function alive(pid:number|null) { if (!pid) return false; try {process.kill(pid,0);return true;} catch(e) {return (e as NodeJS.ErrnoException).code !== 'ESRCH';} }
async function strictDirectory(value:string) {
  if (!path.isAbsolute(value)) throw new AdmissionWebError('等待区必须是绝对路径',400);
  // Reject linked ancestors as well as a linked final component; do not treat a junction as permission.
  let cursor=path.resolve(value);
  for (;;) { const stat=await fs.lstat(cursor); if(!stat.isDirectory()||stat.isSymbolicLink()) throw new AdmissionWebError('目录链接或重解析点不能作为导入路径');
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
  async preview(raw:unknown) {
    const scope=webPreviewSchema.parse(raw);this.creator(scope.creatorId);const root=await this.validateRoot();
    const inputRoot=path.join(root,scope.parent);await strictDirectory(inputRoot);await assertPathInsideLocalIngestRoot(root,inputRoot,{directChild:true});
    if(new Set(scope.directories.map(d=>process.platform==='win32'?d.toLowerCase():d)).size!==scope.directories.length)throw new AdmissionWebError('选择了重复目录',400);
    const id=randomUUID(),items:{summary:Summary;preview:PreviewItem|null}[]=[];let creatorDirectory='';const version=this.thumbnailVersion();
    for(const name of scope.directories){
      try {
        const preview=await this.admission.preview({...scope,inputRoot,directories:[name]});creatorDirectory=preview.creatorDirectory;
        const item=preview.items[0]!;
        const workIds=new Set([...(item.review.candidates as unknown as {workId:number}[]).map(c=>Number(c.workId)),...item.review.existingRelations.map(c=>Number(c.workId))].filter(Boolean));
        // Include source-free same-title Works as suggestions too; never implicitly merge.
        for(const w of this.db.prepare('SELECT id FROM archive_catalog_works WHERE creator_id=? AND display_title=?').all(scope.creatorId,item.displayTitle))workIds.add(Number(w.id));
        const candidates=[...workIds].slice(0,50).flatMap(workId=>{const choice=this.workChoice(workId,scope.creatorId,version);return choice?[choice]:[];});
        const group:Summary['group']=item.review.existingRelations.length?'C':item.review.conflicts.length?'D':candidates.length===1?'B':candidates.length>1?'D':'A';
        items.push({preview:item,summary:{key:item.key,sourceRelativePath:name,targetPath:item.targetPath,displayTitle:item.displayTitle,group,
          summary:item.review.summary,candidates,conflicts:item.review.conflicts,ads:advertisementCandidates(item.manifest),advertisementRulesVersion}});
      } catch(e) {items.push({preview:null,summary:{key:randomUUID(),sourceRelativePath:name,targetPath:'',displayTitle:name,group:'D',
        summary:{images:0,videos:0,other:0,bytes:0},candidates:[],conflicts:[message(e)],ads:[]}});}
    }
    const context:Context={galleryRoot:this.galleryRoot,creatorDirectory,parent:scope.parent,waitingRoot:root,workFacts:{},sourceFacts:{}};
    for(const w of this.db.prepare('SELECT id FROM archive_catalog_works WHERE creator_id=?').all(scope.creatorId))context.workFacts[String(w.id)]=this.workFact(Number(w.id));
    for(const s of this.db.prepare('SELECT s.id FROM archive_catalog_source_works s JOIN archive_catalog_works w ON w.id=s.work_id WHERE w.creator_id=?').all(scope.creatorId))context.sourceFacts[String(s.id)]=this.sourceFact(Number(s.id));
    this.db.exec('SAVEPOINT admission_web_preview');
    try {
      this.db.prepare(`INSERT INTO local_admission_web_batches(id,creator_id,input_root,source_evidence_id,state,created_at,updated_at,context_json)
        VALUES(?,?,?,?,'draft',?,?,?)`).run(id,scope.creatorId,inputRoot,scope.sourceEvidenceId??null,now(),now(),JSON.stringify(context));
      for(const [position,item] of items.entries())this.db.prepare('INSERT INTO local_admission_web_items(batch_id,item_key,position,summary_json,preview_json) VALUES(?,?,?,?,?)')
        .run(id,item.summary.key,position,JSON.stringify(item.summary),item.preview?JSON.stringify(item.preview):null);
      this.db.exec('RELEASE admission_web_preview');
    }catch(e){this.db.exec('ROLLBACK TO admission_web_preview; RELEASE admission_web_preview');throw e;}
    return {...this.get(id),items:this.items(id).items};
  }
  private row(id:string) {const row=this.db.prepare('SELECT * FROM local_admission_web_batches WHERE id=?').get(id) as Batch|undefined;
    if(!row)throw new AdmissionWebError('导入批次不存在',404);return row;}
  private effectiveState(row:Pick<Batch,'state'|'owner_pid'>){return ['queued','running'].includes(row.state)&&!alive(row.owner_pid)?'interrupted':row.state;}
  get(id:string) {
    // No manifest/content reads, hashing or directory traversal on progress polling.
    const row=this.db.prepare(`SELECT id,creator_id,input_root,source_evidence_id,state,created_at,updated_at,error,owner_pid FROM local_admission_web_batches WHERE id=?`).get(id) as Omit<Batch,'context_json'|'confirmed_json'|'owner_token'>|undefined;
    if(!row)throw new AdmissionWebError('导入批次不存在',404);
    const counts=this.db.prepare(`SELECT COUNT(*) total,SUM(action NOT IN ('skip','defer')) selected,SUM(action='skip') skipped,SUM(action='defer') deferred
      FROM local_admission_web_items WHERE batch_id=?`).get(id)!;
    const completed=Number(this.db.prepare("SELECT COUNT(*) n FROM archive_local_admission_items WHERE plan_id=? AND state='completed'").get(id)!.n);
    const reconciled=Number(counts.selected)>0&&completed===Number(counts.selected);
    return {id,planId:id,creatorId:row.creator_id,creatorName:String(this.db.prepare('SELECT canonical_name FROM archive_catalog_creators WHERE id=?').get(row.creator_id)?.canonical_name??''),
      inputRoot:row.input_root,sourceEvidenceId:row.source_evidence_id,state:reconciled?'completed':this.effectiveState(row),createdAt:row.created_at,updatedAt:row.updated_at,error:reconciled?null:row.error,
      totals:{total:Number(counts.total),selected:Number(counts.selected??0),completed,skipped:Number(counts.skipped??0),deferred:Number(counts.deferred??0)}};
  }
  list(creatorId?:number,page=1) {const where=creatorId?'WHERE creator_id=?':'';const args=creatorId?[creatorId]:[];
    const total=Number(this.db.prepare(`SELECT COUNT(*) n FROM local_admission_web_batches ${where}`).get(...args)!.n);
    return {page,pageSize:30,total,items:this.db.prepare(`SELECT id FROM local_admission_web_batches ${where} ORDER BY created_at DESC,id DESC LIMIT 30 OFFSET ?`).all(...args,(page-1)*30).map(r=>this.get(String(r.id)))};}
  items(id:string,page=1,pageSize=24) {
    const batch=this.get(id);page=Math.max(1,page);pageSize=Math.min(100,Math.max(1,pageSize));
    const rows=this.db.prepare(`SELECT x.item_key,x.summary_json,x.action,i.state,i.last_error,i.work_id,i.local_work_id,l.post_id,
      CASE WHEN ?='draft' AND COALESCE(json_extract(x.summary_json,'$.advertisementRulesVersion'),0)<>? THEN x.preview_json ELSE NULL END legacy_preview_json
      FROM local_admission_web_items x LEFT JOIN archive_local_admission_items i ON i.plan_id=x.batch_id AND i.item_key=x.item_key
      LEFT JOIN archive_catalog_local_works l ON l.id=i.local_work_id WHERE x.batch_id=? ORDER BY x.position LIMIT ? OFFSET ?`).all(batch.state,advertisementRulesVersion,id,pageSize,(page-1)*pageSize);
    return {page,pageSize,total:batch.totals.total,items:rows.map(r=>{
      const summary=JSON.parse(String(r.summary_json)) as Summary;
      // Old unsubmitted drafts use their saved inventory; no disk reads or changes
      // to the manifest, choices, confirmed payload or execution checkpoints.
      if(r.legacy_preview_json){summary.ads=advertisementCandidates((JSON.parse(String(r.legacy_preview_json)) as PreviewItem).manifest);summary.advertisementRulesVersion=advertisementRulesVersion;}
      return {...summary,action:String(r.action),state:r.state??(batch.state==='draft'?'preview':r.action),lastError:r.last_error??null,workId:r.work_id??null,localWorkId:r.local_work_id??null,postId:r.post_id??null};})};
  }
  async repreview(id:string,keys?:string[]) {
    const batch=this.row(id);if(['running','queued'].includes(this.effectiveState(batch)))throw new AdmissionWebError('执行中不能重新预览');
    const context=JSON.parse(batch.context_json) as Context;
    const items=this.db.prepare(`SELECT x.item_key,x.summary_json,x.action,i.state FROM local_admission_web_items x LEFT JOIN archive_local_admission_items i
      ON i.plan_id=x.batch_id AND i.item_key=x.item_key WHERE x.batch_id=? ORDER BY position`).all(id);
    const selected=items.filter(r=>keys?keys.includes(String(r.item_key)):r.action==='defer');
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
  private assertIdle(exceptId?:string) {
    const operation=this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY);
    if(operation){
      let owner:{pid:number;token:string;kind:string};
      try{owner=JSON.parse(String(operation.value));}catch{throw new AdmissionWebError('现有执行所有者信息无法核对，请先处理原任务');}
      if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||!owner.token||!owner.kind)throw new AdmissionWebError('现有执行所有者信息无法核对，请先处理原任务');
      if(alive(owner.pid))throw new AdmissionWebError('接纳、扫描或 Stage3 正在执行，请等待完成');
    }
    for(const row of this.db.prepare("SELECT id,state,owner_pid FROM local_admission_web_batches WHERE state IN ('queued','running')").all()){
      if(row.id!==exceptId&&alive(Number(row.owner_pid)))throw new AdmissionWebError('已有导入批次正在执行');}
    if(this.db.prepare("SELECT id FROM scan_runs WHERE status='running' LIMIT 1").get()||this.db.prepare("SELECT id FROM local_ingest_jobs WHERE status IN ('running','reconciling') AND claim_token IS NOT NULL LIMIT 1").get())throw new AdmissionWebError('扫描或 Stage3 正在执行');
  }
  private request(key:string,id:string,kind:string,payload:unknown) {
    const row=this.db.prepare('SELECT * FROM local_admission_web_requests WHERE request_key=?').get(key);
    if(!row)return false;
    if(row.batch_id!==id||row.kind!==kind||row.payload_hash!==hash(payload))throw new AdmissionWebError('请求键已经用于另一份确认，请保留原请求或重新确认');
    return true;
  }
  async execute(id:string,raw:unknown) {
    const request=webExecuteSchema.parse(raw);if(this.request(request.requestKey,id,'execute',request))return this.get(id);
    const batch=this.row(id);if(batch.confirmed_json||batch.state!=='draft')throw new AdmissionWebError('本批次已有不可变确认计划，请继续原计划');
    this.assertIdle();const context=JSON.parse(batch.context_json) as Context;
    if(!same(context.waitingRoot,this.settings().waitingRoot)||!same(context.galleryRoot,this.galleryRoot))throw new AdmissionWebError('配置已改变，请重新预览');
    await this.validateRoot();await strictDirectory(batch.input_root);this.creator(batch.creator_id);
    const saved=this.db.prepare('SELECT item_key,preview_json,summary_json FROM local_admission_web_items WHERE batch_id=? ORDER BY position').all(id);
    const actions=new Map(request.actions.map(a=>[a.key,a]));
    if(actions.size!==request.actions.length||actions.size!==saved.length||saved.some(s=>!actions.has(String(s.item_key))))throw new AdmissionWebError('确认必须覆盖本批准确项目；未处理项请选择跳过或暂缓',400);
    const items:AdmissionPlan['items']=[];
    const selected=saved.filter(s=>!['skip','defer'].includes(actions.get(String(s.item_key))!.action));
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
      if(action.approvedAds.length&&!request.adsConfirmed)throw new AdmissionWebError('广告可恢复移出必须单独确认具体清单');
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
      ...(batch.source_evidence_id?{sourceEvidenceId:batch.source_evidence_id}:{}),items}):null;
    if(this.request(request.requestKey,id,'execute',request))return this.get(id);
    this.assertCreatorIdle(batch.creator_id);this.assertIdle();const token=randomUUID();this.db.exec('SAVEPOINT web_submit');
    try{
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
      this.db.exec('RELEASE web_submit');
    }catch(e){this.db.exec('ROLLBACK TO web_submit; RELEASE web_submit');throw e;}
    if(plan)this.schedule(id,token,plan);
    return this.get(id);
  }
  resume(id:string,raw:unknown) {
    const request=webResumeSchema.parse(raw);if(this.request(request.requestKey,id,'resume',request))return this.get(id);
    const row=this.row(id);if(!row.confirmed_json)throw new AdmissionWebError('尚未确认，请先预览并确认');
    if(row.state==='completed')return this.get(id);
    if(['running','queued'].includes(this.effectiveState(row)))throw new AdmissionWebError('原任务仍在执行，不重复提交');
    this.assertIdle(id);const plan=admissionPlanSchema.parse(JSON.parse(row.confirmed_json));const token=randomUUID();
    this.db.exec('SAVEPOINT web_resume');try{
      this.db.prepare("UPDATE local_admission_web_batches SET state='queued',owner_pid=?,owner_token=?,updated_at=?,error=NULL WHERE id=?").run(process.pid,token,now(),id);
      this.db.prepare('INSERT INTO local_admission_web_requests VALUES(?,?,?,?,?)').run(request.requestKey,id,'resume',hash(request),now());
      this.db.exec('RELEASE web_resume');
    }catch(e){this.db.exec('ROLLBACK TO web_resume; RELEASE web_resume');throw e;}
    this.schedule(id,token,plan);return this.get(id);
  }
  private schedule(id:string,token:string,plan:AdmissionPlan) {
    // Dispatch is ephemeral, but the immutable payload, receipt and existing checkpoints are durable.
    // A dead-process receipt is shown as interrupted; opening a page never automatically replays it.
    const task=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
      this.db.prepare("UPDATE local_admission_web_batches SET state='running',updated_at=? WHERE id=? AND owner_token=?").run(now(),id,token);
      try {await strictDirectory(plan.inputRoot);await strictDirectory(plan.galleryRoot);this.assertCreatorIdle(plan.creatorId);
        await this.admission.apply(plan);this.db.prepare("UPDATE local_admission_web_batches SET state='completed',error=NULL,updated_at=? WHERE id=? AND owner_token=?").run(now(),id,token);}
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
