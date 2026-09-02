import { main as migrate } from './migrate.js';

await migrate();
const { scannerService } = await import('../services/scanner-service.js');
const creatorNames = process.argv.slice(2).filter((value) => value !== '--');
const result = creatorNames.length > 0
  ? await scannerService.scanCosCreators(creatorNames, 'script')
  : await scannerService.scanAll('script');
console.log(JSON.stringify(result, null, 2));
