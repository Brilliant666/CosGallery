import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assertPathInsideLocalIngestRoot, isSameOrNestedPath } from '../utils/local-ingest-paths.js';
import { LocalIngestDestinationService } from './local-ingest-destination-service.js';
import { WorkIdentityService } from './work-identity-service.js';
import { SourceEvidenceService } from './source-evidence-service.js';
import { runAdmissionExclusive } from './local-admission-lock.js';
import { extractWorkDisplayTitle } from '../utils/work-title.js';
import { RETAINED_ORIGINALS_DIRECTORY } from '../constants/retained-originals.js';
import { isAdmissionAdvertisementCandidate, isKnownAdvertisementImage } from '../utils/local-advertisements.js';
import { recycleBinAdapter, type RecycleBinAdapter } from './recycle-bin-adapter.js';
import { assertNoLaterAdmissionCompletion } from './local-admission-later-completion.js';

const leaf = z.string().min(1).refine(v => !/[\\/:\x00]/.test(v) && v!=='.' && v!=='..', 'A direct child directory name is required');
const entrySchema = z.object({ relativePath:z.string().min(1), kind:z.enum(['directory','image','video','other']), size:z.number().int().nonnegative(), dev:z.string(), ino:z.string(), mtimeNs:z.string() }).strict();
const itemSchema = z.object({ key:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), sourceRelativePath:leaf, targetPath:z.string().min(1), displayTitle:z.string().trim().min(1),
  manifest:z.array(entrySchema).min(1), identity:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('new')}),z.object({kind:z.literal('existing'),workId:z.number().int().positive().optional(),sourceWorkId:z.number().int().positive().optional()}),
    z.object({kind:z.literal('same-as'),itemKey:z.string().min(1)})
  ]), reason:z.string().trim().min(1), localOnly:z.boolean().default(true), excludeSourceIds:z.array(z.number().int().positive()).default([]),
  acceptExistingVersion:z.boolean().default(false), primary:z.boolean().default(false), approvedAds:z.array(z.string().min(1)).default([]),
  acceptVersions:z.array(z.object({sourceWorkId:z.number().int().positive(),taskIds:z.array(z.number().int().positive()),reason:z.string().trim().min(1)}).strict()).default([])
});
export const admissionPlanSchema=z.object({ version:z.literal(1),planId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),confirmed:z.literal(true),creatorId:z.number().int().positive(),
  sourceEvidenceId:z.number().int().positive().optional(),
  advertisementDisposition:z.literal('recycle_bin').optional(),
  inputRoot:z.string().min(1),galleryRoot:z.string().min(1),creatorDirectory:leaf,items:z.array(itemSchema).min(1).max(500) }).strict();
export type AdmissionPlan=z.infer<typeof admissionPlanSchema>;
type Entry=z.infer<typeof entrySchema>;
const recoverySchema=z.object({confirmed:z.literal(true),planId:z.string().min(1),key:z.string().min(1).max(100),reason:z.string().trim().min(1),evidence:z.string().trim().min(1),
  removals:z.array(z.object({itemKey:z.string().min(1),entry:entrySchema,retainOriginal:z.literal(true).optional(),approvedAdvertisement:z.literal(true).optional()}).strict()).min(1).max(2000)}).strict();
const removalKind='admission_file_removal';
type Removal={planId:string;itemKey:string;contentHash:string;entry:Entry;reason:string;evidence:string;retainOriginal?:true;approvedAdvertisement?:true};
const advertisementRecycleKind='admission_advertisement_recycle';
const advertisementRecycleSchema=z.object({confirmed:z.literal(true),planId:z.string().min(1),key:z.string().trim().min(1).max(100),reason:z.string().trim().min(1).max(2000),
  files:z.array(z.object({itemKey:z.string().min(1),entry:entrySchema}).strict()).min(1).max(2000)}).strict();
type AdvertisementRecycle={removal:Removal;sourcePath:string;requestKey:string;phase:'intent'|'recycled'};
type AdvertisementRecycleRow={decision_key:string;payload_json:string;state:string};

function cmp(v:string){return process.platform==='win32'?v.toLowerCase():v;}
function json(v:unknown){return JSON.stringify(v);}
function hash(v:unknown){return createHash('sha256').update(json(v)).digest('hex');}
async function exists(v:string){try{await fs.lstat(v);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function regularDirectory(v:string){const s=await fs.lstat(v);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Directory/link is not safe');}

/** Display-only extraction. Never changes path or assigns source identity. */
export function extractAdmissionTitle(name:string,creatorNames:string[]):string {
  return extractWorkDisplayTitle(name,creatorNames);
}

/** Metadata inventory only; no media decoding, file hashing or URL access. */
export async function inventoryAdmissionDirectory(root:string):Promise<Entry[]> {
  await regularDirectory(root);const rows:Entry[]=[];
  async function walk(dir:string){
    for(const ent of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
      const absolute=path.join(dir,ent.name);await assertPathInsideLocalIngestRoot(root,absolute);
      const s=await fs.lstat(absolute,{bigint:true});if(s.isSymbolicLink())throw Error('Linked entries are not supported');
      if(!s.isDirectory()&&!s.isFile())throw Error('Non-regular entry is not supported');
      const ext=path.extname(ent.name).toLowerCase();
      const kind=s.isDirectory()?'directory':/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(ext)?'image':/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(ext)?'video':'other';
      rows.push({relativePath:path.relative(root,absolute).split(path.sep).join('/'),kind,size:s.isDirectory()?0:Number(s.size),dev:String(s.dev),ino:String(s.ino),mtimeNs:s.isDirectory()?'0':String(s.mtimeNs)});
      if(s.isDirectory())await walk(absolute);
    }
  }
  await walk(root);if(!rows.some(r=>r.kind==='image'||r.kind==='video'))throw Error('No supported media found; nothing admitted');return rows;
}

type ItemState={state:string;local_work_id:number|null;work_id:number|null;manifest_json:string};
export class LocalFolderAdmissionService {
  private readonly recycler:Pick<RecycleBinAdapter,'recycle'>;
  constructor(private readonly db:DatabaseSync,private readonly galleryRoot:string,options:{recycler?:Pick<RecycleBinAdapter,'recycle'>}={}){
    this.recycler=options.recycler??recycleBinAdapter;
  }

  async preview(input:{creatorId:number;inputRoot:string;directories:string[];sourceEvidenceId?:number;acceptExistingVersion?:boolean}) {
    if(!Number.isSafeInteger(input.creatorId)||input.creatorId<=0||!Array.isArray(input.directories)||!input.directories.length)throw Error('Explicit creator and non-empty directory scope required');
    if(input.acceptExistingVersion!==undefined&&typeof input.acceptExistingVersion!=='boolean')throw Error('acceptExistingVersion must be an explicit boolean');
    if(input.sourceEvidenceId!==undefined)new SourceEvidenceService(this.db).assertAdmissionReference(input.sourceEvidenceId,input.creatorId);
    if(new Set(input.directories.map(cmp)).size!==input.directories.length)throw Error('Duplicate scope');
    if(!path.isAbsolute(input.inputRoot))throw Error('inputRoot must be absolute');
    await regularDirectory(input.inputRoot);
    if(isSameOrNestedPath(this.galleryRoot,input.inputRoot)||isSameOrNestedPath(input.inputRoot,this.galleryRoot))throw Error('Input and gallery roots must not overlap');
    const creator=this.db.prepare('SELECT canonical_name FROM archive_catalog_creators WHERE id=? AND is_active=1').get(input.creatorId) as {canonical_name:string}|undefined;
    if(!creator)throw Error('Enabled canonical creator not found');
    const aliases=this.db.prepare('SELECT alias FROM archive_catalog_creator_aliases WHERE creator_id=?').all(input.creatorId) as {alias:string}[];
    const destination=new LocalIngestDestinationService(this.db,this.galleryRoot);
    const items=[];let creatorDirectory='';
    for(const name of input.directories){
      leaf.parse(name);const source=path.join(input.inputRoot,name);
      await assertPathInsideLocalIngestRoot(input.inputRoot,source,{directChild:true});
      const target=await destination.resolveNewTarget(input.creatorId,name);
      // Destination helper sanitizes titles for archived jobs; legacy admission must preserve the exact basename.
      const checkedCreator=await assertPathInsideLocalIngestRoot(this.galleryRoot,target.creatorDirectory,{directChild:true});
      // `relative` is a comparison key (lowercase on Windows), not a persisted directory spelling.
      creatorDirectory=path.relative(checkedCreator.root,checkedCreator.candidate);
      const targetPath=path.join(this.galleryRoot,creatorDirectory,name);
      await assertPathInsideLocalIngestRoot(this.galleryRoot,targetPath);
      leaf.parse(creatorDirectory);
      const manifest=await inventoryAdmissionDirectory(source);
      const displayTitle=extractAdmissionTitle(name,[creator.canonical_name,...aliases.map(x=>x.alias)]);
      const candidates=this.db.prepare(`SELECT s.id sourceWorkId,s.work_id workId,s.source_order sourceOrder,s.source_title title,s.media_summary mediaSummary,w.display_title canonicalTitle
        FROM archive_catalog_source_works s JOIN archive_catalog_collections c ON c.id=s.collection_id JOIN archive_catalog_works w ON w.id=s.work_id WHERE c.creator_id=? AND s.is_active=1`).all(input.creatorId)
        .filter((r)=>String(r.title).includes(displayTitle)||displayTitle.includes(String(r.title)))
        .map(r=>({...r,tasks:this.db.prepare('SELECT id,status,attempt_count FROM archive_catalog_download_tasks WHERE source_work_id=? ORDER BY id').all(r.sourceWorkId)}));
      const existingRelations=this.db.prepare(`SELECT l.id localWorkId,l.work_id workId,l.post_id postId,l.identity_policy identityPolicy,w.display_title canonicalTitle
        FROM archive_catalog_local_works l LEFT JOIN archive_catalog_works w ON w.id=l.work_id WHERE l.absolute_path=?`).all(targetPath);
      items.push({key:randomUUID(),sourceRelativePath:name,targetPath,displayTitle,manifest,identity:{kind:'new'},reason:'',localOnly:false,acceptExistingVersion:input.acceptExistingVersion??false,excludeSourceIds:[],primary:false,
        approvedAds:manifest.filter(e=>e.kind==='image'&&isKnownAdvertisementImage(e.relativePath)).map(e=>e.relativePath),
        review:{candidates,existingRelations,conflicts:await exists(targetPath)?['target exists']:[],summary:{images:manifest.filter(x=>x.kind==='image').length,videos:manifest.filter(x=>x.kind==='video').length,other:manifest.filter(x=>x.kind==='other').length,bytes:manifest.reduce((n,x)=>n+x.size,0)}}});
    }
    return {version:1,planId:randomUUID(),confirmed:false,creatorId:input.creatorId,...(input.sourceEvidenceId!==undefined?{sourceEvidenceId:input.sourceEvidenceId}:{}),inputRoot:path.resolve(input.inputRoot),galleryRoot:path.resolve(this.galleryRoot),creatorDirectory,items};
  }

  private validate(raw:unknown):AdmissionPlan {
    const plan=admissionPlanSchema.parse(raw);
    if(plan.sourceEvidenceId!==undefined)new SourceEvidenceService(this.db).assertAdmissionReference(plan.sourceEvidenceId,plan.creatorId);
    if(cmp(path.resolve(plan.galleryRoot))!==cmp(path.resolve(this.galleryRoot)))throw Error('Plan gallery differs from configured gallery');
    if(!path.isAbsolute(plan.inputRoot)||!path.isAbsolute(plan.galleryRoot))throw Error('Absolute roots required');
    if(isSameOrNestedPath(plan.inputRoot,plan.galleryRoot)||isSameOrNestedPath(plan.galleryRoot,plan.inputRoot))throw Error('Roots overlap');
    const keys=new Set<string>(),targets=new Set<string>();
    for(const item of plan.items){
      if(keys.has(item.key)||targets.has(cmp(item.targetPath)))throw Error('Duplicate item or target');
      if(item.identity.kind==='existing'&&!item.identity.workId&&!item.identity.sourceWorkId)throw Error('Existing identity requires a Work or SourceWork ID');
      if(item.identity.kind==='existing'){
        const existing=this.db.prepare(`SELECT w.id,w.creator_id,w.display_title FROM archive_catalog_works w WHERE w.id=? OR w.id=(SELECT work_id FROM archive_catalog_source_works WHERE id=?)`).all(item.identity.workId??null,item.identity.sourceWorkId??null) as {id:number;creator_id:number;display_title:string}[];
        if(existing.length!==1||existing[0].creator_id!==plan.creatorId)throw Error('Existing Work/source identity conflict');
        if(item.displayTitle!==existing[0].display_title)throw Error(`Existing Work keeps its canonical title; confirm displayTitle as: ${existing[0].display_title}`);
      }
      if(item.identity.kind==='same-as'&&!keys.has(item.identity.itemKey))throw Error('same-as must reference an earlier explicitly confirmed item');
      if(item.identity.kind==='same-as'){
        const referencedKey=item.identity.itemKey;
        if(item.displayTitle!==plan.items.find(i=>i.key===referencedKey)?.displayTitle)throw Error('Same-work copy must confirm the referenced canonical displayTitle; original directory remains unchanged');
      }
      keys.add(item.key);targets.add(cmp(item.targetPath));
      const expected=path.join(plan.galleryRoot,plan.creatorDirectory,item.sourceRelativePath);
      if(cmp(path.resolve(item.targetPath))!==cmp(expected))throw Error('Target must preserve original directory name');
      for(const ad of item.approvedAds){
        const entry=item.manifest.find(e=>e.relativePath===ad);
        if(!entry||!isAdmissionAdvertisementCandidate(entry))throw Error('Advertisement exclusion must be an explicit existing TXT/URL or known advertisement image entry');
      }
      if(new Set(item.approvedAds).size!==item.approvedAds.length)throw Error('Duplicate advertisement approval');
      if(!item.manifest.some(e=>['image','video'].includes(e.kind)&&!item.approvedAds.includes(e.relativePath)))throw Error('No supported media remains after advertisement exclusion');
    }return plan;
  }

  private idle(){
    if(this.db.prepare("SELECT id FROM scan_runs WHERE status='running' LIMIT 1").get())throw Error('Gallery scan is active; retry after completion');
    if(this.db.prepare("SELECT id FROM local_ingest_jobs WHERE status IN ('running','reconciling') AND claim_token IS NOT NULL LIMIT 1").get())throw Error('Ingest execution is active');
  }

  private attachmentPath(plan:AdmissionPlan,item:AdmissionPlan['items'][number],relative:string){
    return path.join(plan.inputRoot,'.local-admission-attachments',plan.planId,item.key,relative);
  }

  private async assertAdvertisementPath(plan:AdmissionPlan,candidate:string){
    await assertPathInsideLocalIngestRoot(plan.inputRoot,candidate);
    const root=path.resolve(plan.inputRoot),relative=path.relative(root,path.resolve(candidate));
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Advertisement path is outside its exact input root');
    const components=[root,...relative.split(path.sep)];let current='';
    for(const [index,component] of components.entries()){
      current=index===0?component:path.join(current,component);
      try{
        const stat=await fs.lstat(current);
        if(stat.isSymbolicLink()||index<components.length-1&&!stat.isDirectory())throw Error('Linked advertisement path is not supported');
      }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
    }
  }

  private advertisementRecycleKey(plan:AdmissionPlan,item:AdmissionPlan['items'][number],entry:Entry){
    return `admission-ad-recycle:${plan.planId}:${hash([item.key,entry.relativePath])}`;
  }

  private assertAdvertisementRecycleIdle(itemState:ItemState){
    this.idle();
    if(!itemState?.work_id||!itemState.local_work_id||!['indexed','completed'].includes(itemState.state))throw Error('Advertisement recycling requires indexed or completed admission');
    if(this.db.prepare(`SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id
      WHERE s.work_id=? AND t.status IN ('claimed','downloading') LIMIT 1`).get(itemState.work_id))throw Error('Related acquisition is active');
  }

  private advertisementRecycleJournal(plan:AdmissionPlan,item:AdmissionPlan['items'][number]){
    const state=this.db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.key) as ItemState;
    if(!state?.local_work_id)return [];
    const contentHash=String(this.db.prepare('SELECT content_hash FROM archive_local_admission_plans WHERE plan_id=?').get(plan.planId)!.content_hash);
    return (this.db.prepare('SELECT decision_key,payload_json,state FROM archive_catalog_work_decisions WHERE kind=? AND local_work_id=?').all(advertisementRecycleKind,state.local_work_id) as AdvertisementRecycleRow[]).map(row=>{
      const journal=JSON.parse(row.payload_json) as AdvertisementRecycle,removal=journal.removal;
      if(!removal||removal.planId!==plan.planId||removal.itemKey!==item.key||removal.contentHash!==contentHash||!removal.reason||!removal.evidence||
        removal.retainOriginal||removal.approvedAdvertisement||!item.approvedAds.includes(removal.entry.relativePath)||!item.manifest.some(e=>json(e)===json(removal.entry))||
        row.decision_key!==this.advertisementRecycleKey(plan,item,removal.entry)||journal.sourcePath!==this.attachmentPath(plan,item,removal.entry.relativePath)||
        !journal.requestKey||!['intent','recycled'].includes(journal.phase)||row.state!=='active')throw Error('Advertisement recycle journal changed or was revoked; review required');
      if(journal.requestKey===`plan:${plan.planId}`){
        if(plan.advertisementDisposition!=='recycle_bin')throw Error('Saved plan did not authorize advertisement recycling');
      }else{
        const receipt=this.db.prepare('SELECT kind,payload_json,state FROM archive_catalog_work_decisions WHERE decision_key=?').get(`admission-ad-recycle-request:${journal.requestKey}`);
        if(!receipt||receipt.kind!=='admission_advertisement_recycle_request'||receipt.state!=='active')throw Error('Advertisement recycling request changed or was revoked');
        const request=advertisementRecycleSchema.parse(JSON.parse(String(receipt.payload_json)));
        if(request.planId!==plan.planId||request.key!==journal.requestKey||request.reason!==removal.reason||!request.files.some(file=>file.itemKey===item.key&&json(file.entry)===json(removal.entry)))throw Error('Advertisement recycle intent differs from its explicit request');
      }
      return {row,journal};
    });
  }

  /** Filesystem success and its result may be separated by a process/SQLite failure. */
  private finishAdvertisementRecycle(row:AdvertisementRecycleRow,journal:AdvertisementRecycle){
    const key=`${row.decision_key}:removal`,payload=json(journal.removal);
    // Reserve the writer before SELECT so a catalog publisher cannot force a
    // deferred read-to-write upgrade to fail immediately despite busy_timeout.
    const ownWriteTransaction=!this.db.isTransaction;
    this.db.exec(ownWriteTransaction?'BEGIN IMMEDIATE':'SAVEPOINT admission_ad_recycle');
    try{
      const prior=this.db.prepare('SELECT kind,payload_json,state FROM archive_catalog_work_decisions WHERE decision_key=?').get(key) as {kind:string;payload_json:string;state:string}|undefined;
      if(prior&&(prior.kind!==removalKind||prior.payload_json!==payload||prior.state!=='active'))throw Error('Advertisement removal decision changed or was revoked; review required');
      const owner=this.db.prepare('SELECT work_id,local_work_id FROM archive_catalog_work_decisions WHERE decision_key=? AND state=\'active\'').get(row.decision_key);
      if(!owner)throw Error('Advertisement recycle intent is not active');
      this.db.prepare(`INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,reason,payload_json)
        VALUES(?,?,?,?,?,?) ON CONFLICT(decision_key) DO NOTHING`).run(key,removalKind,owner.work_id,owner.local_work_id,journal.removal.reason,payload);
      this.db.prepare('UPDATE archive_catalog_work_decisions SET payload_json=? WHERE decision_key=?').run(json({...journal,phase:'recycled'}),row.decision_key);
      this.db.exec(ownWriteTransaction?'COMMIT':'RELEASE admission_ad_recycle');
    }catch(error){this.db.exec(ownWriteTransaction?'ROLLBACK':'ROLLBACK TO admission_ad_recycle; RELEASE admission_ad_recycle');throw error;}
  }

  /** A missing file is accepted only with a previously persisted exact recycle intent. */
  private async reconcileAdvertisementRecycling(plan:AdmissionPlan,item:AdmissionPlan['items'][number]){
    const missing=[];
    for(const {row,journal} of this.advertisementRecycleJournal(plan,item)){
      await this.assertAdvertisementPath(plan,journal.sourcePath);
      const present=await exists(journal.sourcePath);
      if(journal.phase==='recycled'&&present)throw Error('Recycled advertisement is present again; review required');
      if(journal.phase==='intent'&&!present)missing.push({row,journal});
    }
    if(!missing.length)return;
    await this.verifyTarget(plan,item,missing.map(value=>value.journal.removal));
    const state=this.db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.key) as ItemState;
    this.assertAdvertisementRecycleIdle(state);
    for(const {row,journal} of missing)this.finishAdvertisementRecycle(row,journal);
  }

  private async verifyAdvertisementFile(plan:AdmissionPlan,item:AdmissionPlan['items'][number],entry:Entry){
    const saved=this.attachmentPath(plan,item,entry.relativePath);
    await this.assertAdvertisementPath(plan,saved);
    const stat=await fs.lstat(saved,{bigint:true});
    if(!stat.isFile()||stat.isSymbolicLink()||json({...entry,size:Number(stat.size),dev:String(stat.dev),ino:String(stat.ino),mtimeNs:String(stat.mtimeNs)})!==json(entry))throw Error('Advertisement changed since confirmation; review required');
    return saved;
  }

  /** Only known empty attachment ancestors are removed; foreign files are never traversed. */
  private async pruneAdvertisementContainers(plan:AdmissionPlan,item:AdmissionPlan['items'][number],entries:Entry[]){
    const root=path.join(plan.inputRoot,'.local-admission-attachments'),directories=new Set<string>();
    for(const entry of entries){
      for(let dir=path.dirname(this.attachmentPath(plan,item,entry.relativePath));isSameOrNestedPath(root,dir);dir=path.dirname(dir)){
        directories.add(dir);if(dir===root)break;
      }
    }
    for(const dir of [...directories].sort((a,b)=>b.length-a.length)){
      await this.assertAdvertisementPath(plan,dir);
      try{await regularDirectory(dir);await fs.rmdir(dir);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    }
  }

  private async recycleItemAdvertisements(plan:AdmissionPlan,item:AdmissionPlan['items'][number],entries:Entry[],requestKey:string,reason:string){
    await this.reconcileAdvertisementRecycling(plan,item);
    await this.verifyTarget(plan,item);
    if(this.db.isTransaction)throw Error('Advertisement recycling requires committed intent outside a caller transaction');
    const state=this.db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.key) as ItemState;
    this.assertAdvertisementRecycleIdle(state);
    const removed=new Set(this.removals(plan,item).map(value=>value.entry.relativePath));
    // Preflight the complete exact selection before creating any new intent or recycling.
    for(const entry of entries)if(!removed.has(entry.relativePath))await this.verifyAdvertisementFile(plan,item,entry);
    for(const entry of entries){
      const key=this.advertisementRecycleKey(plan,item,entry);
      let recorded=this.advertisementRecycleJournal(plan,item).find(value=>value.row.decision_key===key);
      if(recorded&&recorded.journal.requestKey!==requestKey)throw Error('Reuse the original advertisement recycling request');
      if(removed.has(entry.relativePath))continue;
      const saved=await this.verifyAdvertisementFile(plan,item,entry);
      this.assertAdvertisementRecycleIdle(state);
      if(!recorded){
        const contentHash=String(this.db.prepare('SELECT content_hash FROM archive_local_admission_plans WHERE plan_id=?').get(plan.planId)!.content_hash);
        const journal:AdvertisementRecycle={requestKey,sourcePath:saved,phase:'intent',removal:{planId:plan.planId,itemKey:item.key,contentHash,entry,reason,
          evidence:'Explicit Windows Recycle Bin request; absence is recorded only after durable exact-file recycle intent.'}};
        this.db.prepare('INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,reason,payload_json) VALUES(?,?,?,?,?,?)')
          .run(key,advertisementRecycleKind,state.work_id,state.local_work_id,reason,json(journal));
        recorded={row:{decision_key:key,payload_json:json(journal),state:'active'},journal};
      }
      await this.verifyAdvertisementFile(plan,item,entry);this.assertAdvertisementRecycleIdle(state);
      const result=await this.recycler.recycle(saved);
      if(!result.recycled||await exists(saved))throw Error('Advertisement recycling did not remove the original path; retry the saved request');
      this.finishAdvertisementRecycle(recorded.row,recorded.journal);
    }
    await this.verifyTarget(plan,item);
    await this.pruneAdvertisementContainers(plan,item,entries);
  }

  async previewAdvertisementRecycling(raw:unknown){
    const request=z.object({planId:z.string().min(1),itemKeys:z.array(z.string().min(1)).min(1).max(500)}).strict().parse(raw);
    this.idle();
    const saved=this.db.prepare('SELECT payload_json FROM archive_local_admission_plans WHERE plan_id=?').get(request.planId);
    if(!saved)throw Error('Existing admission plan required');
    const plan=this.validate(JSON.parse(String(saved.payload_json))),files:Array<{itemKey:string;entry:Entry}>=[];
    if(new Set(request.itemKeys).size!==request.itemKeys.length)throw Error('Duplicate advertisement item scope');
    for(const itemKey of request.itemKeys){
      const item=plan.items.find(value=>value.key===itemKey);
      if(!item)throw Error('Item is not in the saved admission plan');
      const state=this.db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,itemKey) as ItemState;
      this.assertAdvertisementRecycleIdle(state);await this.verifyTarget(plan,item);
      if(this.advertisementRecycleJournal(plan,item).some(value=>value.journal.phase==='intent'))throw Error('Pending advertisement recycle intent exists; reuse the original request or admission resume');
      const removed=new Set(this.removals(plan,item).map(value=>value.entry.relativePath));
      for(const relative of item.approvedAds)if(!removed.has(relative)){const entry=item.manifest.find(value=>value.relativePath===relative)!;await this.verifyAdvertisementFile(plan,item,entry);files.push({itemKey,entry});}
    }
    return {confirmed:false,planId:plan.planId,key:randomUUID(),reason:'',files};
  }

  /** Explicit historical cleanup never edits or silently upgrades the immutable plan. */
  async recycleAdvertisements(raw:unknown){
    if(this.db.isTransaction)throw Error('Advertisement recycling requires committed intent outside a caller transaction');
    return runAdmissionExclusive(this.db,async()=>{
      const request=advertisementRecycleSchema.parse(raw);this.idle();
      const saved=this.db.prepare('SELECT payload_json FROM archive_local_admission_plans WHERE plan_id=?').get(request.planId);
      if(!saved)throw Error('Existing admission plan required');
      const plan=this.validate(JSON.parse(String(saved.payload_json))),selected=new Map<string,Entry[]>(),seen=new Set<string>();
      const requestDecisionKey=`admission-ad-recycle-request:${request.key}`;
      const oldRequest=this.db.prepare('SELECT kind,payload_json,state FROM archive_catalog_work_decisions WHERE decision_key=?').get(requestDecisionKey);
      if(oldRequest&&(oldRequest.kind!=='admission_advertisement_recycle_request'||oldRequest.payload_json!==json(request)||oldRequest.state!=='active'))throw Error('Advertisement recycling request changed or was revoked');
      for(const file of request.files){
        const item=plan.items.find(value=>value.key===file.itemKey),identifier=json([file.itemKey,file.entry.relativePath]);
        if(!item||!item.approvedAds.includes(file.entry.relativePath)||!item.manifest.some(entry=>json(entry)===json(file.entry)))throw Error('Recycling requires an exact original approved advertisement');
        if(seen.has(identifier))throw Error('Duplicate advertisement recycling selection');seen.add(identifier);
        selected.set(item.key,[...(selected.get(item.key)??[]),file.entry]);
      }
      // Verify every selected item before any new destructive file operation.
      for(const itemKey of selected.keys()){
        const item=plan.items.find(value=>value.key===itemKey)!;
        const state=this.db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,itemKey) as ItemState;
        const source=path.join(plan.inputRoot,item.sourceRelativePath);await assertPathInsideLocalIngestRoot(plan.inputRoot,source,{directChild:true});
        if(await exists(source))throw Error('Source still exists; advertisement recycling requires a completed move');
        this.assertAdvertisementRecycleIdle(state);
        const removed=new Set(this.removals(plan,item).map(value=>value.entry.relativePath));
        for(const entry of selected.get(itemKey)!){
          const recorded=this.advertisementRecycleJournal(plan,item).find(value=>value.row.decision_key===this.advertisementRecycleKey(plan,item,entry));
          if(recorded&&recorded.journal.requestKey!==request.key)throw Error('Reuse the original advertisement recycling request');
          if(!recorded&&removed.has(entry.relativePath))throw Error('Advertisement was already removed by a separate explicit decision; exclude it from this recycling request');
        }
        await this.reconcileAdvertisementRecycling(plan,item);await this.verifyTarget(plan,item);
      }
      this.idle();
      if(!oldRequest)this.db.prepare('INSERT INTO archive_catalog_work_decisions(decision_key,kind,reason,payload_json) VALUES(?,?,?,?)')
        .run(requestDecisionKey,'admission_advertisement_recycle_request',request.reason,json(request));
      for(const [itemKey,entries] of selected)await this.recycleItemAdvertisements(plan,plan.items.find(value=>value.key===itemKey)!,entries,request.key,request.reason);
      return {planId:plan.planId,recycledFiles:request.files,resumed:false};
    });
  }

  private removals(plan:AdmissionPlan,item:AdmissionPlan['items'][number]):Removal[]{
    const rows=this.db.prepare(`SELECT payload_json FROM archive_catalog_work_decisions WHERE kind=? AND state='active'
      AND local_work_id=(SELECT local_work_id FROM archive_local_admission_items WHERE plan_id=? AND item_key=?)`).all(removalKind,plan.planId,item.key) as {payload_json:string}[];
    const saved=this.db.prepare('SELECT content_hash FROM archive_local_admission_plans WHERE plan_id=?').get(plan.planId) as {content_hash:string}|undefined;
    return rows.map(row=>{
      const r=JSON.parse(row.payload_json) as Removal;
      if(r.planId!==plan.planId||r.itemKey!==item.key||r.contentHash!==saved?.content_hash||!r.reason||!r.evidence||
        !item.manifest.some(e=>json(e)===json(r.entry)))throw Error('Recovery evidence does not match immutable plan');
      return r;
    });
  }

  /** Record explicit, already-performed removals. Never deletes files or rewrites a plan. */
  async recover(raw:unknown,beforeVerify?:()=>Promise<void>){
    return runAdmissionExclusive(this.db,async()=>{
      this.idle();const request=recoverySchema.parse(raw);
      const saved=this.db.prepare('SELECT payload_json,content_hash FROM archive_local_admission_plans WHERE plan_id=?').get(request.planId) as {payload_json:string;content_hash:string}|undefined;
      if(!saved)throw Error('Existing admission plan required');
      const plan=this.validate(JSON.parse(saved.payload_json));
      const pending:{key:string;payload:Removal;workId:number;localId:number}[]=[],seen=new Set<string>();
      for(const [index,removal] of request.removals.entries()){
        const item=plan.items.find(i=>i.key===removal.itemKey);
        if(!item||!item.manifest.some(e=>json(e)===json(removal.entry)))throw Error('Removal must exactly match original manifest entry');
        const identifier=item.key+'\0'+removal.entry.relativePath;if(seen.has(identifier))throw Error('Duplicate removal');seen.add(identifier);
        const state=this.db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.key) as ItemState|undefined;
        if(!state?.work_id||!state.local_work_id||!['files_verified','indexed','completed'].includes(state.state))throw Error('Removal requires an already verified move');
        if(removal.retainOriginal&&(!['image','video'].includes(removal.entry.kind)||item.manifest.some(e=>e.relativePath.split('/')[0]===RETAINED_ORIGINALS_DIRECTORY)))throw Error('Retention requires explicit media and an unused reserved originals directory');
        if(removal.approvedAdvertisement&&(removal.retainOriginal||removal.entry.kind!=='other'||!['.txt','.url'].includes(path.extname(removal.entry.relativePath).toLowerCase())||state.state!=='files_verified'))throw Error('New advertisement approval is limited to exact TXT/URL entries in unfinished indexing');
        const payload:Removal={planId:plan.planId,itemKey:item.key,contentHash:saved.content_hash,entry:removal.entry,reason:request.reason,evidence:request.evidence,...(removal.retainOriginal?{retainOriginal:true as const}:{}),...(removal.approvedAdvertisement?{approvedAdvertisement:true as const}:{})};
        const key=`admission-removal:${request.key}:${index}`;
        const old=this.db.prepare('SELECT kind,payload_json,state FROM archive_catalog_work_decisions WHERE decision_key=?').get(key) as {kind:string;payload_json:string;state:string}|undefined;
        if(old&&(old.kind!==removalKind||old.payload_json!==json(payload)||old.state!=='active'))throw Error('Recovery key differs or was revoked; explicit new decision required');
        if(!old&&this.removals(plan,item).some(r=>r.entry.relativePath===removal.entry.relativePath))throw Error('File already has an active removal decision; reuse the original request');
        if(this.db.prepare(`SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id
          WHERE s.work_id=? AND t.status IN ('claimed','downloading') LIMIT 1`).get(state.work_id))throw Error('Related acquisition is active');
        const ad=item.approvedAds.includes(removal.entry.relativePath);
        if(!ad&&!old){
          if(!['image','video'].includes(removal.entry.kind)&&!removal.approvedAdvertisement)throw Error('Only original approved advertisements, explicitly reviewed TXT/URL advertisements or explicitly failed media may be removed');
          const local=this.db.prepare('SELECT post_id FROM archive_catalog_local_works WHERE id=?').get(state.local_work_id) as {post_id:number|null};
          if(state.state!=='files_verified'||local.post_id!==null||this.db.prepare("SELECT id FROM archive_catalog_local_fulfillments WHERE local_work_id=? AND state='active'").get(state.local_work_id))throw Error('Media recovery is limited to unfinished, unfulfilled indexing');
        }
        pending.push({key,payload,workId:state.work_id,localId:state.local_work_id});
      }
      // Web callers may perform exact journaled moves only after all plan/claim guards.
      // The callback is internal code, never request-provided; original CLI behavior is unchanged.
      await beforeVerify?.();
      // Validate ALL affected items before writing any decision. No broad ignore flag.
      for(const key of new Set(pending.map(r=>r.payload.itemKey))){
        const item=plan.items.find(i=>i.key===key)!;
        await assertPathInsideLocalIngestRoot(plan.inputRoot,path.join(plan.inputRoot,item.sourceRelativePath),{directChild:true});
        if(await exists(path.join(plan.inputRoot,item.sourceRelativePath)))throw Error('Source still exists; recovery cannot authorize a move');
        await this.verifyTarget(plan,item,pending.filter(r=>r.payload.itemKey===key).map(r=>r.payload),true);
      }
      this.db.exec('SAVEPOINT admission_recovery');
      try{
        // File verification yields to other connections. Recheck at the decision
        // transaction boundary so a newly acquired claim cannot be overlooked.
        this.idle();
        for(const workId of new Set(pending.map(r=>r.workId))){
          if(this.db.prepare(`SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id
            WHERE s.work_id=? AND t.status IN ('claimed','downloading') LIMIT 1`).get(workId))throw Error('Related acquisition is active');
        }
        const ids=pending.map(r=>{
          this.db.prepare(`INSERT INTO archive_catalog_work_decisions(decision_key,kind,work_id,local_work_id,reason,payload_json)
            VALUES(?,?,?,?,?,?) ON CONFLICT(decision_key) DO NOTHING`).run(r.key,removalKind,r.workId,r.localId,r.payload.reason,json(r.payload));
          return this.db.prepare('SELECT id FROM archive_catalog_work_decisions WHERE decision_key=?').get(r.key)!.id;
        });
        this.db.exec('RELEASE admission_recovery');
        return {planId:plan.planId,decisionIds:ids,recordedRemovals:pending.map(r=>r.payload),resumed:false};
      }catch(e){this.db.exec('ROLLBACK TO admission_recovery; RELEASE admission_recovery');throw e;}
    });
  }

  private async verifyTarget(plan:AdmissionPlan,item:AdmissionPlan['items'][number],additional:Removal[]=[],allowPendingRetention=false){
    await assertPathInsideLocalIngestRoot(plan.galleryRoot,item.targetPath);
    const observed=await inventoryAdmissionDirectory(item.targetPath);
    for(const ad of item.approvedAds){
      const saved=this.attachmentPath(plan,item,ad);await this.assertAdvertisementPath(plan,saved);
      if(!await exists(saved))continue;
      if(observed.some(e=>e.relativePath===ad))throw Error('Attachment exists in both locations; review required');
      const stat=await fs.lstat(saved,{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink())throw Error('Saved attachment is not a regular file');
      observed.push({relativePath:ad,kind:item.manifest.find(e=>e.relativePath===ad)!.kind,size:Number(stat.size),dev:String(stat.dev),ino:String(stat.ino),mtimeNs:String(stat.mtimeNs)});
    }
    const decisions=[...this.removals(plan,item),...additional];
    const retained=new Map(decisions.filter(r=>r.retainOriginal).map(r=>[r.entry.relativePath,r]));
    const generatedDirs=new Set<string>();
    for(const relative of retained.keys()){
      const destination=RETAINED_ORIGINALS_DIRECTORY+'/'+relative;
      for(let parent=path.posix.dirname(destination);parent!=='.';parent=path.posix.dirname(parent))generatedDirs.add(parent);
      const from=observed.find(e=>e.relativePath===relative),to=observed.find(e=>e.relativePath===destination);
      if(from&&to||!to&&(!allowPendingRetention||!from))throw Error('Retained original missing or present in both locations');
      if(to)to.relativePath=relative;
    }
    for(let n=observed.length-1;n>=0;n--)if(observed[n].kind==='directory'&&generatedDirs.has(observed[n].relativePath))observed.splice(n,1);
    const removed=new Set(decisions.filter(r=>!r.retainOriginal).map(r=>r.entry.relativePath));
    if(!item.manifest.some(e=>['image','video'].includes(e.kind)&&!item.approvedAds.includes(e.relativePath)&&!removed.has(e.relativePath)&&!retained.has(e.relativePath)))throw Error('No supported media remains for display');
    // A returned/replaced file is not ignored. Explicit removal describes absence only.
    if(observed.some(e=>removed.has(e.relativePath)))throw Error('Approved removed file is present again; review required');
    const sorted=(entries:Entry[])=>[...entries].sort((a,b)=>a.relativePath.localeCompare(b.relativePath,'en'));
    if(hash(sorted(observed))!==hash(sorted(item.manifest.filter(e=>!removed.has(e.relativePath)))))throw Error('Target or saved attachments changed; review required');
  }

  /** The durable decision precedes rename. Replay verifies either side, never overwrites. */
  private async retainRecoveredOriginals(plan:AdmissionPlan,item:AdmissionPlan['items'][number]){
    const retained=this.removals(plan,item).filter(r=>r.retainOriginal);
    if(!retained.length)return;
    await this.verifyTarget(plan,item,[],true);
    if(!(await Promise.all(retained.map(r=>exists(path.join(item.targetPath,r.entry.relativePath))))).some(Boolean))return;
    const state=this.db.prepare('SELECT work_id,local_work_id FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.key)!;
    if(this.db.prepare("SELECT id FROM archive_catalog_local_fulfillments WHERE local_work_id=? AND state='active'").get(state.local_work_id)||
      this.db.prepare("SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id WHERE s.work_id=? AND t.status IN ('claimed','downloading') LIMIT 1").get(state.work_id))throw Error('Retention acquisition changed; review required');
    for(const r of retained){
      const from=path.join(item.targetPath,r.entry.relativePath),to=path.join(item.targetPath,RETAINED_ORIGINALS_DIRECTORY,r.entry.relativePath);
      await assertPathInsideLocalIngestRoot(item.targetPath,from);await assertPathInsideLocalIngestRoot(item.targetPath,to);
      if(await exists(from)){
        if(await exists(to))throw Error('Retained original target occupied');
        await fs.mkdir(path.dirname(to),{recursive:true});
        await assertPathInsideLocalIngestRoot(item.targetPath,to);
        if((await fs.stat(from,{bigint:true})).dev!==(await fs.stat(path.dirname(to),{bigint:true})).dev)throw Error('Retention must remain on the same volume');
        await fs.rename(from,to);
      }
    }
    await this.verifyTarget(plan,item);
  }

  private async directorySpelling(parent:string,name:string){
    const matches=(await fs.readdir(parent,{withFileTypes:true})).filter(entry=>cmp(entry.name)===cmp(name));
    if(matches.length!==1||!matches[0]!.isDirectory()||matches[0]!.isSymbolicLink())throw Error('Confirmed indexing directory is missing or ambiguous; keep files for review');
    return matches[0]!.name;
  }

  /** Resolve only the two confirmed directory components; never infer identity from a case-folded DB query. */
  private async indexedScope(plan:AdmissionPlan,item:AdmissionPlan['items'][number]){
    let parent=plan.galleryRoot;const names:string[]=[];
    for(const name of [plan.creatorDirectory,item.sourceRelativePath]){
      const actual=await this.directorySpelling(parent,name);parent=path.join(parent,actual);
      await assertPathInsideLocalIngestRoot(plan.galleryRoot,parent);await regularDirectory(parent);
      names.push(actual);
    }
    return {creatorDirectory:names[0]!,workFolderName:names[1]!,sourcePath:names.join('/')};
  }

  /** Repair only this unfinished checkpoint's legacy case-only registration, never merge Works or rewrite decisions. */
  private alignIndexedRegistration(plan:AdmissionPlan,item:AdmissionPlan['items'][number],localId:number,scope:{creatorDirectory:string;workFolderName:string}){
    const actual=path.resolve(plan.galleryRoot,scope.creatorDirectory,scope.workFolderName);
    const own=!this.db.isTransaction;this.db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT admission_case');
    try {
      const local=this.db.prepare(`SELECT l.*,f.root_path,f.relative_path creator_path,f.creator_id,f.gallery_folder_id,f.match_method parent_method,f.is_active parent_active,f.match_status parent_status
        FROM archive_catalog_local_works l JOIN archive_catalog_local_creator_folders f ON f.id=l.local_creator_folder_id WHERE l.id=?`).get(localId)!;
      if(!local||local.is_active!==1||local.parent_active!==1||local.parent_status!=='matched'||local.creator_id!==plan.creatorId||cmp(path.resolve(String(local.absolute_path)))!==cmp(actual))throw Error('Indexed directory ownership changed; review required');
      if(path.resolve(String(local.absolute_path))!==actual||local.creator_path!==scope.creatorDirectory){
        const decision=this.db.prepare("SELECT work_id,local_work_id,payload_json FROM archive_catalog_work_decisions WHERE decision_key=? AND state='active' AND kind='same_work'").get(`${plan.planId}:${item.key}`);
        const recorded=decision?JSON.parse(String(decision.payload_json)):null;
        if(process.platform!=='win32'||local.post_id!==null||local.relative_path!==scope.workFolderName||local.gallery_folder_id!==null||local.parent_method!=='manual-admission'
          ||decision?.local_work_id!==localId||decision.work_id!==local.work_id||recorded?.creatorId!==plan.creatorId||recorded?.absolutePath!==local.absolute_path
          ||recorded?.absolutePath!==item.targetPath||recorded?.rootPath!==plan.galleryRoot||recorded?.creatorFolderName!==plan.creatorDirectory
          ||recorded?.relativePath!==path.relative(plan.galleryRoot,item.targetPath)||cmp(path.resolve(String(local.root_path)))!==cmp(path.resolve(plan.galleryRoot))
          ||cmp(String(local.creator_path))!==cmp(scope.creatorDirectory))throw Error('Legacy directory spelling needs explicit review');
        // Do not adopt or retire a parent used by another local copy.
        if(this.db.prepare('SELECT id FROM archive_catalog_local_works WHERE local_creator_folder_id=? AND id<>? LIMIT 1').get(local.local_creator_folder_id,localId))throw Error('Legacy directory has other copies; review required');
        const parent=this.db.prepare('SELECT id,creator_id,is_active,match_status,absolute_path FROM archive_catalog_local_creator_folders WHERE root_path=? AND relative_path=?').get(path.resolve(plan.galleryRoot),scope.creatorDirectory);
        if(parent){
          if(parent.creator_id!==plan.creatorId||parent.is_active!==1||parent.match_status!=='matched'||cmp(path.resolve(String(parent.absolute_path)))!==cmp(path.dirname(actual))||this.db.prepare('SELECT id FROM archive_catalog_local_works WHERE local_creator_folder_id=? AND relative_path=?').get(parent.id,scope.workFolderName))throw Error('Canonical directory identity conflicts; review required');
          this.db.prepare('UPDATE archive_catalog_local_works SET local_creator_folder_id=?,absolute_path=? WHERE id=?').run(parent.id,actual,localId);
          this.db.prepare('UPDATE archive_catalog_local_creator_folders SET is_active=0 WHERE id=?').run(local.local_creator_folder_id);
        }else{
          this.db.prepare('UPDATE archive_catalog_local_creator_folders SET relative_path=?,folder_name=?,absolute_path=? WHERE id=?').run(scope.creatorDirectory,scope.creatorDirectory,path.dirname(actual),local.local_creator_folder_id);
          this.db.prepare('UPDATE archive_catalog_local_works SET absolute_path=? WHERE id=?').run(actual,localId);
        }
      }
      this.db.exec(own?'COMMIT':'RELEASE admission_case');
    }catch(error){this.db.exec(own?'ROLLBACK':'ROLLBACK TO admission_case; RELEASE admission_case');throw error;}
  }

  private async detachRecoveredMedia(plan:AdmissionPlan,item:AdmissionPlan['items'][number],localId:number,sourcePath:string){
    const removals=this.removals(plan,item).filter(r=>['image','video'].includes(r.entry.kind));
    if(!removals.length)return;
    const local=this.db.prepare('SELECT post_id,work_id FROM archive_catalog_local_works WHERE id=?').get(localId) as {post_id:number|null;work_id:number}|undefined;
    if(!local||this.db.prepare("SELECT id FROM archive_catalog_local_fulfillments WHERE local_work_id=? AND state='active'").get(localId)||
      this.db.prepare(`SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id
        WHERE s.work_id=? AND t.status IN ('claimed','downloading') LIMIT 1`).get(local.work_id))throw Error('Media recovery ownership or acquisition changed; review required');
    const post=this.db.prepare('SELECT id FROM posts WHERE source_path=? AND is_deleted=0 AND is_trashed=0').get(sourcePath) as {id:number}|undefined;
    if(local.post_id!==null&&local.post_id!==post?.id)throw Error('Recovery LocalWork Post changed; review required');
    if(!post)return;
    if(this.db.prepare('SELECT id FROM archive_catalog_local_works WHERE post_id=? AND id<>?').get(post.id,localId))throw Error('Recovery Post belongs to another LocalWork');
    const removedPaths=new Set(removals.map(r=>sourcePath+'/'+r.entry.relativePath));
    const members=this.db.prepare(`SELECT p.image_id,p.position,i.relative_path FROM post_items p JOIN images i ON i.id=p.image_id
      WHERE p.post_id=? ORDER BY p.position`).all(post.id) as {image_id:number;position:number;relative_path:string}[];
    const kept=members.filter(m=>!removedPaths.has(m.relative_path));
    if(kept.length===members.length)return;
    // Only the audited absent media is detached. No ID deletion or arbitrary topology repair.
    // The normal scoped scanner must still finish and mark absent Image rows inactive.
    const {postRepository}=await import('../db/repositories.js');
    postRepository.setPostItems(post.id,kept.map((m,n)=>({imageId:m.image_id,position:n+1})));
  }

  /** Read-only preparation for an all-child confirmation; apply repeats these guards under its execution lock. */
  async verifyUnstarted(raw:unknown):Promise<void> {
    const plan=this.validate(raw);this.idle();
    await regularDirectory(plan.inputRoot);await regularDirectory(plan.galleryRoot);
    for(const item of plan.items){
      const source=path.join(plan.inputRoot,item.sourceRelativePath);
      await assertPathInsideLocalIngestRoot(plan.inputRoot,source,{directChild:true});
      await assertPathInsideLocalIngestRoot(plan.galleryRoot,item.targetPath);
      if(await exists(item.targetPath))throw Error(`${item.sourceRelativePath}: Target exists; never overwrite`);
      if(hash(await inventoryAdmissionDirectory(source))!==hash(item.manifest))throw Error(`${item.sourceRelativePath}: Source changed since preview`);
    }
  }

  /** Each DB checkpoint commits before/after a filesystem step, never pretending rename is part of SQLite. */
  async apply(raw:unknown,options:{stopAfterMove?:boolean}={}) {
    return runAdmissionExclusive(this.db,()=>this.applyConfirmed(raw,options));
  }

  private async applyConfirmed(raw:unknown,options:{stopAfterMove?:boolean}) {
    const plan=this.validate(raw);this.idle();
    assertNoLaterAdmissionCompletion(this.db,plan.planId,plan.items.map(item=>item.key));
    const {databaseManager}=await import('../db/database.js');const {appConfig}=await import('../config/env.js');
    if(this.db!==databaseManager.connection||cmp(path.resolve(this.galleryRoot))!==cmp(path.resolve(appConfig.galleryRoot)))throw Error('Admission database/gallery must match the scoped scanner configuration');
    await regularDirectory(plan.inputRoot);await regularDirectory(plan.galleryRoot);
    const identity=new WorkIdentityService(this.db);
    const payload=json(plan);const prior=this.db.prepare('SELECT payload_json FROM archive_local_admission_plans WHERE plan_id=?').get(plan.planId) as {payload_json:string}|undefined;
    // Older checkpoints lack the new optional policy field. Compare normalized plans,
    // while retaining their original persisted payload and hash unchanged.
    if(prior&&json(admissionPlanSchema.parse(JSON.parse(prior.payload_json)))!==payload)throw Error('Plan ID content changed; new confirmation required');
    if(!prior){
      const destination=await new LocalIngestDestinationService(this.db,plan.galleryRoot).resolveNewTarget(plan.creatorId,plan.items[0].sourceRelativePath);
      const expected=(await assertPathInsideLocalIngestRoot(plan.galleryRoot,destination.creatorDirectory,{directChild:true})).relative;
      if(cmp(expected)!==cmp(plan.creatorDirectory))throw Error('Destination is no longer the selected legal creator directory');
      // Validate every untouched source/target before the first move.
      for(const item of plan.items){if(await exists(item.targetPath))throw Error(`${item.sourceRelativePath}: Target exists; never overwrite`);
        if(hash(await inventoryAdmissionDirectory(path.join(plan.inputRoot,item.sourceRelativePath)))!==hash(item.manifest))throw Error(`${item.sourceRelativePath}: Source changed since preview`);}
      this.db.exec('SAVEPOINT admission_plan');
      try {
        this.db.prepare('INSERT INTO archive_local_admission_plans(plan_id,payload_json,content_hash) VALUES(?,?,?)').run(plan.planId,payload,hash(plan));
        for(const item of plan.items)this.db.prepare("INSERT INTO archive_local_admission_items(plan_id,item_key,state,manifest_json) VALUES(?,?,'planned',?)").run(plan.planId,item.key,json(item.manifest));
        this.db.exec('RELEASE admission_plan');
      } catch(error) {this.db.exec('ROLLBACK TO admission_plan; RELEASE admission_plan');throw error;}
    }
    const results=[];
    for(const item of plan.items){
      let state=this.db.prepare('SELECT * FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.key) as ItemState;
      if(!state)throw Error('Plan checkpoint missing; cannot infer progress');
      try {
        const source=path.join(plan.inputRoot,item.sourceRelativePath),target=item.targetPath;
        await assertPathInsideLocalIngestRoot(plan.inputRoot,source,{directChild:true});
        await assertPathInsideLocalIngestRoot(plan.galleryRoot,target);
        const sourceExists=await exists(source),targetExists=await exists(target);
        if(sourceExists===targetExists)throw Error('Both source and target exist or both are absent; review required');
        if(sourceExists){if(hash(await inventoryAdmissionDirectory(source))!==hash(item.manifest))throw Error('Directory changed since confirmation; review required');}
        else {await this.reconcileAdvertisementRecycling(plan,item);await this.retainRecoveredOriginals(plan,item);await this.verifyTarget(plan,item);}
        if(state.state==='planned'){
          if(!sourceExists)throw Error('No recorded move intent; cannot adopt target');
          await fs.mkdir(path.dirname(target),{recursive:true});await regularDirectory(path.dirname(target));
          if((await fs.stat(source,{bigint:true})).dev!==(await fs.stat(path.dirname(target),{bigint:true})).dev)throw Error('Cross-volume admission is not supported in V1');
          let sameAsLocalId:number|undefined;
          if(item.identity.kind==='same-as')sameAsLocalId=(this.db.prepare('SELECT local_work_id FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.identity.itemKey) as {local_work_id:number}).local_work_id;
          const actualCreator=await this.directorySpelling(plan.galleryRoot,plan.creatorDirectory);
          const actualTarget=path.join(plan.galleryRoot,actualCreator,item.sourceRelativePath);
          const registration={creatorId:plan.creatorId,rootPath:plan.galleryRoot,creatorFolderName:actualCreator,absolutePath:actualTarget,relativePath:path.relative(plan.galleryRoot,actualTarget),title:item.displayTitle,
            ...(item.identity.kind==='existing'?{workId:item.identity.workId,sourceWorkId:item.identity.sourceWorkId}:{}),sameAsLocalId,reason:item.reason,key:`${plan.planId}:${item.key}`,localOnly:item.localOnly,
            ...(item.acceptExistingVersion?{acceptExistingVersion:true}:{})};
          const previous=this.db.prepare('SELECT payload_json FROM archive_catalog_work_decisions WHERE decision_key=?').get(registration.key);
          const legacy={...registration,creatorFolderName:plan.creatorDirectory,absolutePath:target,relativePath:path.relative(plan.galleryRoot,target)};
          // Registration may have committed before the checkpoint: validate either exact historical input, never silently rewrite it.
          const mapped=identity.registerLocal(previous?.payload_json===json(legacy)?legacy:registration);
          this.db.prepare("UPDATE archive_local_admission_items SET state='move_intent',work_id=?,local_work_id=? WHERE plan_id=? AND item_key=?").run(mapped.workId,mapped.localWorkId,plan.planId,item.key);
          state={...state,state:'move_intent',work_id:mapped.workId,local_work_id:mapped.localWorkId};
        }
        if(state.state==='move_intent'){
          if(sourceExists){if(await exists(target))throw Error('Target occupied');await fs.rename(source,target);}
          if(options.stopAfterMove)throw Error('Simulated interruption after move');
          if(hash(await inventoryAdmissionDirectory(target))!==hash(item.manifest))throw Error('Moved directory manifest differs');
          this.db.prepare("UPDATE archive_local_admission_items SET state='files_verified' WHERE plan_id=? AND item_key=?").run(plan.planId,item.key);state.state='files_verified';
        }
        if(state.state==='files_verified'){
          // Reversible exclusion, never deletion: retain only explicitly approved candidates
          // outside the gallery, with the same plan and relative names for safe replay.
          for(const ad of item.approvedAds){
            const from=path.join(target,ad),to=this.attachmentPath(plan,item,ad);
            await assertPathInsideLocalIngestRoot(target,from);await this.assertAdvertisementPath(plan,to);
            if(await exists(from)){
              if(await exists(to))throw Error('Attachment target occupied');
              await fs.mkdir(path.dirname(to),{recursive:true});
              await this.assertAdvertisementPath(plan,to);
              if((await fs.stat(from,{bigint:true})).dev!==(await fs.stat(path.dirname(to),{bigint:true})).dev)throw Error('Cross-volume attachment exclusion unsupported');
              await fs.rename(from,to);
            }
          }
          await this.verifyTarget(plan,item);
          const scope=await this.indexedScope(plan,item);
          this.alignIndexedRegistration(plan,item,state.local_work_id!,scope);
          await this.detachRecoveredMedia(plan,item,state.local_work_id!,scope.sourcePath);
          const {scannerService}=await import('./scanner-service.js');
          const scan=await scannerService.scanCosCreators([scope.creatorDirectory],'local-folder-admission',{workFolderName:scope.workFolderName});
          if(scan?.status!=='completed')throw Error('Scoped media indexing did not complete');
          const post=this.db.prepare('SELECT id,folder_id FROM posts WHERE source_path=? AND is_deleted=0 AND is_trashed=0').get(scope.sourcePath) as {id:number;folder_id:number}|undefined;
          if(!post)throw Error('Scoped Post was not found; keep files and retry indexing');
          const {ManagedCreatorService}=await import('./managed-creator-service.js');new ManagedCreatorService(this.db,plan.galleryRoot).linkFolder(post.folder_id,{creatorId:plan.creatorId});
          identity.attachPost(state.local_work_id!,post.id);
          const {ArchiveCatalogService}=await import('./archive-catalog-service.js');await new ArchiveCatalogService(this.db).reconcileLocalCreators({rootPath:plan.galleryRoot,creators:[{creatorId:plan.creatorId,folderName:scope.creatorDirectory}],workFolderName:scope.workFolderName});
          this.db.prepare("UPDATE archive_local_admission_items SET state='indexed' WHERE plan_id=? AND item_key=?").run(plan.planId,item.key);state.state='indexed';
        }
        if(state.state==='indexed'){
          for(const id of item.excludeSourceIds)identity.excludeSource(state.local_work_id!,id,item.reason,`${plan.planId}:${item.key}:exclude:${id}`);
          if(item.primary)identity.choosePrimary(state.local_work_id!,item.reason);
          const {ArchiveLocalFulfillmentService}=await import('./archive-local-fulfillment-service.js');
          for(const acceptance of item.acceptVersions)new ArchiveLocalFulfillmentService(this.db).accept({decisionKey:`${plan.planId}:${item.key}:accept:${acceptance.sourceWorkId}`,localWorkId:state.local_work_id!,...acceptance});
          // Provenance is not a source binding or a fulfillment. If this step fails,
          // leave the indexed checkpoint intact; replay links it without moving again.
          if(plan.sourceEvidenceId!==undefined)new SourceEvidenceService(this.db).linkAdmission({
            observationId:plan.sourceEvidenceId,creatorId:plan.creatorId,workId:state.work_id!,localWorkId:state.local_work_id!,
            planId:plan.planId,itemKey:item.key,reason:item.reason,key:`admission-evidence:${plan.planId}:${item.key}`
          });
          if(plan.advertisementDisposition==='recycle_bin'&&item.approvedAds.length)await this.recycleItemAdvertisements(plan,item,
            item.approvedAds.map(ad=>item.manifest.find(entry=>entry.relativePath===ad)!),`plan:${plan.planId}`,item.reason);
          this.db.prepare("UPDATE archive_local_admission_items SET state='completed',last_error=NULL WHERE plan_id=? AND item_key=?").run(plan.planId,item.key);state.state='completed';
        }
        const approvedRemovals=this.removals(plan,item);
        results.push({key:item.key,...state,approvedRemovals:approvedRemovals.filter(r=>!r.retainOriginal),retainedOriginals:approvedRemovals.filter(r=>r.retainOriginal).map(r=>({...r,preservedAt:path.join(target,RETAINED_ORIGINALS_DIRECTORY,r.entry.relativePath)})),excludedAttachments:item.approvedAds.map(ad=>({relativePath:ad,preservedAt:this.attachmentPath(plan,item,ad),status:approvedRemovals.some(r=>r.entry.relativePath===ad)?'removed_by_explicit_decision':'preserved'}))});
      } catch(e){this.db.prepare('UPDATE archive_local_admission_items SET last_error=? WHERE plan_id=? AND item_key=?').run(e instanceof Error?e.message:String(e),plan.planId,item.key);throw e;}
    }return {planId:plan.planId,completed:true,items:results};
  }
}
