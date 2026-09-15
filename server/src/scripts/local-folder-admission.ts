import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const help=`Local folder admission (Node 24)
  local-folder-admission preview <absolute-scope.json>
  local-folder-admission apply <absolute-confirmed-plan.json>
  local-folder-admission resume <absolute-confirmed-plan.json>
  local-folder-admission recover <absolute-confirmed-removals.json>
  local-folder-admission decide <absolute-decision.json>
Scope: {creatorId,inputRoot,directories:["original directory name"]}
Decisions: bind-source | exclude-source | accept-version | primary | revoke.
All commands require explicit DATA_ROOT, DB_DIR, GALLERY_ROOT, THUMBNAILS_DIR,
PREVIEWS_DIR. Preview opens the existing database read-only and prints JSON.
Apply/resume never start queues; only the selected directories are indexed.
See docs/local-folder-admission.md. Default is help, never apply.`;

async function main(){
  const [command='help',filename,...extra]=process.argv.slice(2);
  if(command==='help'||command==='--help'){process.stdout.write(help+'\n');return;}
  // Reserve stdout for a single machine-readable result, including real scanner runs.
  console.log=console.error;console.info=console.error;
  if(!['preview','apply','resume','recover','decide'].includes(command)||!filename||!path.isAbsolute(filename)||extra.length)throw Error(help);
  for(const key of ['DATA_ROOT','DB_DIR','GALLERY_ROOT','THUMBNAILS_DIR','PREVIEWS_DIR'])if(!process.env[key]||!path.isAbsolute(process.env[key]!))throw Error(`Explicit absolute ${key} is required`);
  const input=JSON.parse(await fs.readFile(filename,'utf8'));
  const {appConfig}=await import('../config/env.js');
  process.stderr.write(`STORAGE ${JSON.stringify({dataRoot:appConfig.dataRoot,dbDir:appConfig.dbDir,galleryRoot:appConfig.galleryRoot,thumbnailsDir:appConfig.thumbnailsDir,previewsDir:appConfig.previewsDir})}\n`);
  const {LocalFolderAdmissionService}=await import('../services/local-folder-admission-service.js');
  const {databaseManager}=await import('../db/database.js');
  const db=command==='preview'?new DatabaseSync(appConfig.databasePath,{readOnly:true}):databaseManager.connection;
  try {
    let result:unknown;
    const service=new LocalFolderAdmissionService(db,appConfig.galleryRoot);
    if(command==='preview')result=await service.preview(input);
    else if(command==='recover')result=await service.recover(input);
    else if(command==='apply'||command==='resume')result=await service.apply(input);
    else {
      if(input.confirmed!==true)throw Error('Decision requires confirmed:true');
      const {WorkIdentityService}=await import('../services/work-identity-service.js');
      const identity=new WorkIdentityService(db);
      const {z}=await import('zod');const id=z.number().int().positive();const reason=z.string().trim().min(1);
      switch(input.kind){
        case 'bind-source':result={decisionId:identity.bindSource(z.object({workId:id,collectionId:id,sourceWorkId:reason,reason,key:reason}).parse(input))};break;
        case 'exclude-source':{const d=z.object({localWorkId:id,sourceWorkId:id,reason,key:reason}).parse(input);result={decisionId:identity.excludeSource(d.localWorkId,d.sourceWorkId,d.reason,d.key)};break;}
        case 'primary':{const d=z.object({localWorkId:id,reason}).parse(input);identity.choosePrimary(d.localWorkId,d.reason);result={completed:true};break;}
        case 'revoke':{const d=z.object({decisionId:id,reason}).parse(input);identity.revoke(d.decisionId,d.reason);result={completed:true};break;}
        case 'accept-version':{const {ArchiveLocalFulfillmentService}=await import('../services/archive-local-fulfillment-service.js');result=new ArchiveLocalFulfillmentService(db).accept(z.object({decisionKey:reason,sourceWorkId:id,localWorkId:id,taskIds:z.array(id),reason}).parse(input));break;}
        default:throw Error('Unknown explicit decision kind');
      }
    }
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } finally {if(command==='preview')db.close();else databaseManager.close();}
}
void main().catch(error=>{process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;});
