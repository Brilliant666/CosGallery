import { main as migrate } from './migrate.js';

await migrate();
const { scannerService } = await import('../services/scanner-service.js');
const result = await scannerService.scanAll('script');
console.log(JSON.stringify(result, null, 2));
