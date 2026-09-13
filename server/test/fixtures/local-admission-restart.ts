import {databaseManager} from '../../src/db/database.js';
import {appConfig} from '../../src/config/env.js';
import {scannerService} from '../../src/services/scanner-service.js';
import {ArchiveCatalogService} from '../../src/services/archive-catalog-service.js';
console.log=console.error;console.info=console.error;
const [id,folder,work]=process.argv.slice(2);
if(!id||!folder||!work||process.env.NODE_ENV!=='test')throw Error('Synthetic restart fixture requires test environment and explicit scope');
try {
 const scan=await scannerService.scanCosCreators([folder],'isolated-restart',{workFolderName:work});
 if(scan?.status!=='completed')throw Error('Restart scan did not complete');
 await new ArchiveCatalogService(databaseManager.connection).reconcileLocalCreators({rootPath:appConfig.galleryRoot,creators:[{creatorId:Number(id),folderName:folder}],workFolderName:work});
 process.stdout.write(JSON.stringify(databaseManager.connection.prepare('SELECT id,work_id,post_id FROM archive_catalog_local_works ORDER BY id').all()));
}finally{databaseManager.close();}
