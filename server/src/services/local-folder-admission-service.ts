import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assertPathInsideLocalIngestRoot, isSameOrNestedPath } from '../utils/local-ingest-paths.js';
import { LocalIngestDestinationService } from './local-ingest-destination-service.js';
import { WorkIdentityService } from './work-identity-service.js';
import { runAdmissionExclusive } from './local-admission-lock.js';

const leaf = z.string().min(1).refine(v => !/[\\/:\x00]/.test(v) && v!=='.' && v!=='..', 'A direct child directory name is required');
const entrySchema = z.object({ relativePath:z.string().min(1), kind:z.enum(['directory','image','video','other']), size:z.number().int().nonnegative(), dev:z.string(), ino:z.string(), mtimeNs:z.string() }).strict();
const itemSchema = z.object({ key:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), sourceRelativePath:leaf, targetPath:z.string().min(1), displayTitle:z.string().trim().min(1),
  manifest:z.array(entrySchema).min(1), identity:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('new')}),z.object({kind:z.literal('existing'),workId:z.number().int().positive().optional(),sourceWorkId:z.number().int().positive().optional()}),
    z.object({kind:z.literal('same-as'),itemKey:z.string().min(1)})
  ]), reason:z.string().trim().min(1), localOnly:z.boolean().default(true), excludeSourceIds:z.array(z.number().int().positive()).default([]),
  primary:z.boolean().default(false), approvedAds:z.array(z.string().min(1)).default([]),
  acceptVersions:z.array(z.object({sourceWorkId:z.number().int().positive(),taskIds:z.array(z.number().int().positive()),reason:z.string().trim().min(1)}).strict()).default([])
});
export const admissionPlanSchema=z.object({ version:z.literal(1),planId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),confirmed:z.literal(true),creatorId:z.number().int().positive(),
  inputRoot:z.string().min(1),galleryRoot:z.string().min(1),creatorDirectory:leaf,items:z.array(itemSchema).min(1).max(500) }).strict();
export type AdmissionPlan=z.infer<typeof admissionPlanSchema>;
type Entry=z.infer<typeof entrySchema>;

function cmp(v:string){return process.platform==='win32'?v.toLowerCase():v;}
function json(v:unknown){return JSON.stringify(v);}
function hash(v:unknown){return createHash('sha256').update(json(v)).digest('hex');}
async function exists(v:string){try{await fs.lstat(v);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function regularDirectory(v:string){const s=await fs.lstat(v);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Directory/link is not safe');}

/** Display-only extraction. Never changes path or assigns source identity. */
export function extractAdmissionTitle(name:string,creatorNames:string[]):string {
  let title=name;
  for(const prefix of [...creatorNames].sort((a,b)=>b.length-a.length)) {
    if(title.startsWith(prefix) && /^\s/.test(title.slice(prefix.length))){title=title.slice(prefix.length).trim();break;}
  }
  title=title.replace(/^(?:NO\.?|VOL\.?)\s*\d+\s+/iu,'');
  title=title.replace(/\s*\[(?=[^\]]*\d)(?:\d+(?:\.\d+)?\s*(?:P|V|KB|MB|GB|TB|K|M|G|T)[\s+-]*)+\]\s*$/iu,'').trim();
  return title||name;
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

  async preview(input:{creatorId:number;inputRoot:string;directories:string[]}) {
    if(!Number.isSafeInteger(input.creatorId)||input.creatorId<=0||!Array.isArray(input.directories)||!input.directories.length)throw Error('Explicit creator and non-empty directory scope required');
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
      items.push({key:randomUUID(),sourceRelativePath:name,targetPath,displayTitle,manifest,identity:{kind:'new'},reason:'',localOnly:true,excludeSourceIds:[],primary:false,approvedAds:[],
        review:{candidates,existingRelations,conflicts:await exists(targetPath)?['target exists']:[],summary:{images:manifest.filter(x=>x.kind==='image').length,videos:manifest.filter(x=>x.kind==='video').length,other:manifest.filter(x=>x.kind==='other').length,bytes:manifest.reduce((n,x)=>n+x.size,0)}}});
    }
    return {version:1,planId:randomUUID(),confirmed:false,creatorId:input.creatorId,inputRoot:path.resolve(input.inputRoot),galleryRoot:path.resolve(this.galleryRoot),creatorDirectory,items};
  }

  private validate(raw:unknown):AdmissionPlan {
    const plan=admissionPlanSchema.parse(raw);
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
        if(!entry||entry.kind!=='other'||!['.txt','.url'].includes(path.extname(ad).toLowerCase()))throw Error('Advertisement exclusion must be an explicit existing TXT/URL entry');
      }
    }return plan;
  }

  private idle(){
    if(this.db.prepare("SELECT id FROM scan_runs WHERE status='running' LIMIT 1").get())throw Error('Gallery scan is active; retry after completion');
    if(this.db.prepare("SELECT id FROM local_ingest_jobs WHERE status IN ('running','reconciling') AND claim_token IS NOT NULL LIMIT 1").get())throw Error('Ingest execution is active');
  }

  private attachmentPath(plan:AdmissionPlan,item:AdmissionPlan['items'][number],relative:string){
    return path.join(plan.inputRoot,'.local-admission-attachments',plan.planId,item.key,relative);
  }

  private async verifyTarget(plan:AdmissionPlan,item:AdmissionPlan['items'][number]){
    const observed=await inventoryAdmissionDirectory(item.targetPath);
    for(const ad of item.approvedAds){
      const saved=this.attachmentPath(plan,item,ad);await assertPathInsideLocalIngestRoot(plan.inputRoot,saved);
      if(!await exists(saved))continue;
      if(observed.some(e=>e.relativePath===ad))throw Error('Attachment exists in both locations; review required');
      const stat=await fs.lstat(saved,{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink())throw Error('Saved attachment is not a regular file');
      observed.push({relativePath:ad,kind:'other',size:Number(stat.size),dev:String(stat.dev),ino:String(stat.ino),mtimeNs:String(stat.mtimeNs)});
    }
    const sorted=(entries:Entry[])=>[...entries].sort((a,b)=>a.relativePath.localeCompare(b.relativePath,'en'));
    if(hash(sorted(observed))!==hash(sorted(item.manifest)))throw Error('Target or saved attachments changed; review required');
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
    if(prior&&prior.payload_json!==payload)throw Error('Plan ID content changed; new confirmation required');
    if(!prior){
      const destination=await new LocalIngestDestinationService(this.db,plan.galleryRoot).resolveNewTarget(plan.creatorId,plan.items[0].sourceRelativePath);
      const expected=(await assertPathInsideLocalIngestRoot(plan.galleryRoot,destination.creatorDirectory,{directChild:true})).relative;
      if(cmp(expected)!==cmp(plan.creatorDirectory))throw Error('Destination is no longer the selected legal creator directory');
      // Validate every untouched source/target before the first move.
      for(const item of plan.items){if(await exists(item.targetPath))throw Error('Target exists; never overwrite');
        if(hash(await inventoryAdmissionDirectory(path.join(plan.inputRoot,item.sourceRelativePath)))!==hash(item.manifest))throw Error('Source changed since preview');}
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
        else await this.verifyTarget(plan,item);
        if(state.state==='planned'){
          if(!sourceExists)throw Error('No recorded move intent; cannot adopt target');
          await fs.mkdir(path.dirname(target),{recursive:true});await regularDirectory(path.dirname(target));
          if((await fs.stat(source,{bigint:true})).dev!==(await fs.stat(path.dirname(target),{bigint:true})).dev)throw Error('Cross-volume admission is not supported in V1');
          let sameAsLocalId:number|undefined;
          if(item.identity.kind==='same-as')sameAsLocalId=(this.db.prepare('SELECT local_work_id FROM archive_local_admission_items WHERE plan_id=? AND item_key=?').get(plan.planId,item.identity.itemKey) as {local_work_id:number}).local_work_id;
          const mapped=identity.registerLocal({creatorId:plan.creatorId,rootPath:plan.galleryRoot,creatorFolderName:plan.creatorDirectory,absolutePath:target,relativePath:path.relative(plan.galleryRoot,target),title:item.displayTitle,
            ...(item.identity.kind==='existing'?{workId:item.identity.workId,sourceWorkId:item.identity.sourceWorkId}:{}),sameAsLocalId,reason:item.reason,key:`${plan.planId}:${item.key}`,localOnly:item.localOnly});
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
          // Reversible exclusion, never deletion: retain only explicitly approved TXT/URL
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
          this.db.prepare("UPDATE archive_local_admission_items SET state='completed',last_error=NULL WHERE plan_id=? AND item_key=?").run(plan.planId,item.key);state.state='completed';
        }
        results.push({key:item.key,...state,excludedAttachments:item.approvedAds.map(ad=>({relativePath:ad,preservedAt:this.attachmentPath(plan,item,ad)}))});
      } catch(e){this.db.prepare('UPDATE archive_local_admission_items SET last_error=? WHERE plan_id=? AND item_key=?').run(e instanceof Error?e.message:String(e),plan.planId,item.key);throw e;}
    }return {planId:plan.planId,completed:true,items:results};
  }
}
