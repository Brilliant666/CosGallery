import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout } from 'node:timers/promises';
import { ResourceCatalogReadModel } from './resource-catalog-read-model.js';

// Never imports application database initialization, migrations, scanners or media services.
const db = new DatabaseSync(String(workerData.databasePath));
db.exec('PRAGMA busy_timeout=5000');
const model = new ResourceCatalogReadModel(db);
let stopping = false;
parentPort?.on('message', message => { if (message === 'stop') stopping = true; });
try {
  while (!stopping) {
    const pending = model.pending(1);
    if (!pending.length) { await setTimeout(1000); continue; }
    try {
      const started = performance.now();
      const published = model.rebuildCreator(pending[0]!);
      parentPort?.postMessage({ type: 'published', creatorId: pending[0], published,
        durationMs: Math.round(performance.now() - started) });
    } catch {
      // No paths, raw SQL, media names or credentials in background diagnostics.
      parentPort?.postMessage({ type: 'failure', creatorId: pending[0] });
    }
    await setTimeout(25);
  }
} finally { db.close(); parentPort?.close(); }
