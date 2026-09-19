import { Worker } from 'node:worker_threads';
import { storageService } from './storage-service.js';
import { log } from './log-service.js';

let worker: Worker | undefined;
let stopping = false;
let restart: ReturnType<typeof setTimeout> | undefined;
export function startResourceCatalogUpdater(): void {
  if (worker || stopping) return;
  const databasePath = storageService.getDatabasePath();
  if (databasePath === ':memory:') return;
  const source = import.meta.url.endsWith('.ts');
  worker = new Worker(new URL(`./resource-catalog-worker.${source ? 'ts' : 'js'}`, import.meta.url), {
    workerData: { databasePath }, execArgv: source ? ['--import', 'tsx'] : [],
  });
  worker.on('message', (message: { type: string; creatorId: number }) => {
    if (message.type === 'failure') log.info('Resource catalog derived update failed; previous version retained', `creatorId=${message.creatorId}`);
  });
  worker.on('error', () => log.info('Resource catalog updater stopped unexpectedly; pending generations retained'));
  worker.on('exit', () => {
    worker = undefined;
    if (!stopping) { restart = setTimeout(startResourceCatalogUpdater, 5000); restart.unref(); }
  });
}
export async function stopResourceCatalogUpdater(): Promise<void> {
  stopping = true;
  if (restart) clearTimeout(restart);
  const active = worker;
  if (!active) return;
  await new Promise<void>(resolve => {
    const deadline = setTimeout(() => { void active.terminate(); }, 6000);
    active.once('exit', () => { clearTimeout(deadline); resolve(); });
    active.postMessage('stop');
  });
}
