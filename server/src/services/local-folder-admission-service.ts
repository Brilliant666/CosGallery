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
  inputRoot:z.string().min(1),galleryRoot:z.string().min(1),creatorDirectory:leaf,items:z.array(itemSchema).min(1).max(500) }).strict();
export type AdmissionPlan=z.infer<typeof admissionPlanSchema>;
type Entry=z.infer<typeof entrySchema>;
const recoverySchema=z.object({confirmed:z.literal(true),planId:z.string().min(1),key:z.string().min(1).max(100),reason:z.string().trim().min(1),evidence:z.string().trim().min(1),
  removals:z.array(z.object({itemKey:z.string().min(1),entry:entrySchema,retainOriginal:z.literal(true).optional(),approvedAdvertisement:z.literal(true).optional()}).strict()).min(1).max(2000)}).strict();
const removalKind='admission_file_removal';
type Removal={planId:string;itemKey:string;contentHash:string;entry:Entry;reason:string;evidence:string;retainOriginal?:true;approvedAdvertisement?:true};

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
  constructor(private readonly db:DatabaseSync,private readonly galleryRoot:string){}

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
      creatorDirectory=(await assertPathInsideLocalIngestRoot(this.galleryRoot,target.creatorDirectory,{directChild:true})).relative;
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
      const saved=this.attachmentPath(plan,item,ad);await assertPathInsideLocalIngestRoot(plan.inputRoot,saved);
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

  private async detachRecoveredMedia(plan:AdmissionPlan,item:AdmissionPlan['items'][number],localId:number){
    const removals=this.removals(plan,item).filter(r=>['image','video'].includes(r.entry.kind));
    if(!removals.length)return;
    const local=this.db.prepare('SELECT post_id,work_id FROM archive_catalog_local_works WHERE id=?').get(localId) as {post_id:number|null;work_id:number}|undefined;
    if(!local||this.db.prepare("SELECT id FROM archive_catalog_local_fulfillments WHERE local_work_id=? AND state='active'").get(localId)||
      this.db.prepare(`SELECT t.id FROM archive_catalog_download_tasks t JOIN archive_catalog_source_works s ON s.id=t.source_work_id
        WHERE s.work_id=? AND t.status IN ('claimed','downloading') LIMIT 1`).get(local.work_id))throw Error('Media recovery ownership or acquisition changed; review required');
    const sourcePath=path.relative(plan.galleryRoot,item.targetPath).split(path.sep).join('/');
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

  /** Each DB checkpoint commits before/after a filesystem step, never pretending rename is part of SQLite. */
  async apply(raw:unknown,options:{stopAfterMove?:boolean}={}) {
    return runAdmissionExclusive(this.db,()=>this.applyConfirmed(raw,options));
  }

  private async applyConfirmed(raw:unknown,options:{stopAfterMove?:boolean}) {
    const plan=this.validate(raw);this.idle();
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
        else {await this.retainRecoveredOriginals(plan,item);await this.verifyTarget(plan,item);}
        if(state.state==='planned'){
          if(!sourceExists)throw Error('No recorded move intent; cannot adopt target');
          await fs.mkdir(path.dirname(target),{recursive:true});await regularDirectory(path.dirname(target));
          if((await fs.stat(source,{bigint:true})).dev!==(await fs.stat(path.dirname(target),{bigint:true})).dev)throw Error('Cross-volume admission is not supported in V1');
          let sameAsLocalId:number|undefined;
          if(item.identity.kind==='same-as')sameAsLocalId=(this.db.prepare('SELECT local_work_id FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.identity.itemKey) as {local_work_id:number}).local_work_id;
          const mapped=identity.registerLocal({creatorId:plan.creatorId,rootPath:plan.galleryRoot,creatorFolderName:plan.creatorDirectory,absolutePath:target,relativePath:path.relative(plan.galleryRoot,target),title:item.displayTitle,
            ...(item.identity.kind==='existing'?{workId:item.identity.workId,sourceWorkId:item.identity.sourceWorkId}:{}),sameAsLocalId,reason:item.reason,key:`${plan.planId}:${item.key}`,localOnly:item.localOnly,
            ...(item.acceptExistingVersion?{acceptExistingVersion:true}:{})});
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
            await assertPathInsideLocalIngestRoot(target,from);await assertPathInsideLocalIngestRoot(plan.inputRoot,to);
            if(await exists(from)){
              if(await exists(to))throw Error('Attachment target occupied');
              await fs.mkdir(path.dirname(to),{recursive:true});
              if((await fs.stat(from,{bigint:true})).dev!==(await fs.stat(path.dirname(to),{bigint:true})).dev)throw Error('Cross-volume attachment exclusion unsupported');
              await fs.rename(from,to);
            }
          }
          await this.verifyTarget(plan,item);
          await this.detachRecoveredMedia(plan,item,state.local_work_id!);
          const {scannerService}=await import('./scanner-service.js');
          const scan=await scannerService.scanCosCreators([plan.creatorDirectory],'local-folder-admission',{workFolderName:item.sourceRelativePath});
          if(scan?.status!=='completed')throw Error('Scoped media indexing did not complete');
          const post=this.db.prepare('SELECT id,folder_id FROM posts WHERE source_path=? AND is_deleted=0 AND is_trashed=0').get(path.relative(plan.galleryRoot,target).split(path.sep).join('/')) as {id:number;folder_id:number}|undefined;
          if(!post)throw Error('Scoped Post was not found; keep files and retry indexing');
          const {ManagedCreatorService}=await import('./managed-creator-service.js');new ManagedCreatorService(this.db,plan.galleryRoot).linkFolder(post.folder_id,{creatorId:plan.creatorId});
          identity.attachPost(state.local_work_id!,post.id);
          const {ArchiveCatalogService}=await import('./archive-catalog-service.js');await new ArchiveCatalogService(this.db).reconcileLocalCreators({rootPath:plan.galleryRoot,creators:[{creatorId:plan.creatorId,folderName:plan.creatorDirectory}],workFolderName:item.sourceRelativePath});
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
          this.db.prepare("UPDATE archive_local_admission_items SET state='completed',last_error=NULL WHERE plan_id=? AND item_key=?").run(plan.planId,item.key);state.state='completed';
        }
        const approvedRemovals=this.removals(plan,item);
        results.push({key:item.key,...state,approvedRemovals:approvedRemovals.filter(r=>!r.retainOriginal),retainedOriginals:approvedRemovals.filter(r=>r.retainOriginal).map(r=>({...r,preservedAt:path.join(target,RETAINED_ORIGINALS_DIRECTORY,r.entry.relativePath)})),excludedAttachments:item.approvedAds.map(ad=>({relativePath:ad,preservedAt:this.attachmentPath(plan,item,ad),status:approvedRemovals.some(r=>r.entry.relativePath===ad)?'removed_by_explicit_decision':'preserved'}))});
      } catch(e){this.db.prepare('UPDATE archive_local_admission_items SET last_error=? WHERE plan_id=? AND item_key=?').run(e instanceof Error?e.message:String(e),plan.planId,item.key);throw e;}
    }return {planId:plan.planId,completed:true,items:results};
  }
}
