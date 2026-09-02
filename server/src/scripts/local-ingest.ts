import { databaseManager } from '../db/database.js';
import { localIngestService } from '../services/local-ingest-service.js';
import { localIngestSettingsService } from '../services/local-ingest-settings-service.js';
import { recycleBinAdapter } from '../services/recycle-bin-adapter.js';

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [command = 'jobs', ...args] = process.argv.slice(2);
  if (command === 'configure') {
    const current = localIngestSettingsService.get();
    print(localIngestSettingsService.save({ ...current, allowlist: args }));
    return;
  }
  if (command === 'validate') {
    print(await localIngestSettingsService.validate());
    return;
  }
  if (command === 'smoke-recycle') {
    print(await recycleBinAdapter.smokeTest(localIngestSettingsService.get().processingRoot));
    return;
  }
  if (command === 'scan') {
    print(await localIngestService.scanInbox(args.length > 0 ? args : undefined));
    return;
  }
  if (command === 'run') {
    const id = Number(args[0]);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Usage: local-ingest run <job-id>');
    print(await localIngestService.runJob(id));
    return;
  }
  if (command === 'cleanup') {
    const id = Number(args[0]);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Usage: local-ingest cleanup <job-id>');
    print(await localIngestService.retryCleanup(id));
    return;
  }
  if (command === 'batch') {
    print(await localIngestService.runBatch({ allowlist: args.length > 0 ? args : undefined }));
    return;
  }
  if (command === 'jobs') {
    print(localIngestService.listJobs({ limit: 500 }));
    return;
  }
  throw new Error(`Unknown local ingest command: ${command}`);
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => databaseManager.close());
