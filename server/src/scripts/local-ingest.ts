import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalIngestManualPlacementInput } from '../services/local-ingest-service.js';
let closeDatabase = () => {};

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function manualPlacementItems(value: unknown): LocalIngestManualPlacementInput[] {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { items?: unknown }).items
    : value;
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new Error('Manual-placement plan must contain a non-empty items array');
  }
  if (candidate.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Every manual-placement plan item must be an object');
  }
  return candidate as LocalIngestManualPlacementInput[];
}

async function main(): Promise<void> {
  const [command = 'jobs', ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    process.stdout.write('Stage3 local ingest (Node24)\npreview-review <absolute-request.json> (read-only; confirmed:false)\nresume-review <absolute-confirmed-plan.json> (original job only; no re-extraction)\nOther existing commands: jobs, scan, run, batch, cleanup, adopt-manual, retain-originals, configure, validate.\nReview commands require explicit DATA_ROOT, DB_DIR, GALLERY_ROOT, THUMBNAILS_DIR, PREVIEWS_DIR.\n');
    return;
  }
  if (command === 'preview-review' || command === 'resume-review') {
    if (args.length !== 1 || !path.isAbsolute(args[0])) throw new Error(`Usage: local-ingest ${command} <absolute-plan.json>`);
    for (const key of ['DATA_ROOT', 'DB_DIR', 'GALLERY_ROOT', 'THUMBNAILS_DIR', 'PREVIEWS_DIR']) {
      if (!process.env[key] || !path.isAbsolute(process.env[key]!)) throw new Error(`Explicit absolute ${key} is required`);
    }
    const input = JSON.parse(await fs.readFile(args[0], 'utf8'));
    if (command === 'preview-review') {
      const { DatabaseSync } = await import('node:sqlite');
      const { appConfig } = await import('../config/env.js');
      const { LocalIngestService } = await import('../services/local-ingest-service.js');
      const { LocalIngestSettingsService } = await import('../services/local-ingest-settings-service.js');
      const db = new DatabaseSync(appConfig.databasePath, { readOnly: true });
      closeDatabase = () => db.close();
      const settings = new LocalIngestSettingsService(appConfig.galleryRoot, {
        get: key => (db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as {value:string}|undefined)?.value ?? null,
        setMany: () => { throw new Error('Preview settings are read-only'); }
      });
      print(await new LocalIngestService(db, settings).previewReview(input));
      return;
    }
  }
  const { databaseManager } = await import('../db/database.js');
  const { localIngestService } = await import('../services/local-ingest-service.js');
  const { localIngestSettingsService } = await import('../services/local-ingest-settings-service.js');
  const { recycleBinAdapter } = await import('../services/recycle-bin-adapter.js');
  closeDatabase = () => databaseManager.close();
  if (command === 'resume-review') {
    const result = await localIngestService.resumeReview(JSON.parse(await fs.readFile(args[0], 'utf8')));
    print(result);
    if (result.status !== 'ingested') process.exitCode = 1;
    return;
  }
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
  if (command === 'adopt-manual' || command === 'retain-originals') {
    if (args.length !== 1) throw new Error(`Usage: local-ingest ${command} <absolute-plan.json>`);
    const planPath = path.resolve(args[0]);
    if (!path.isAbsolute(args[0])) {
      throw new Error('The manual-placement plan path must be absolute');
    }
    const items = manualPlacementItems(JSON.parse(await fs.readFile(planPath, 'utf8')));
    const jobs = [];
    for (const item of items) {
      const job = command === 'retain-originals'
        ? await localIngestService.retainOriginals(item)
        : await localIngestService.adoptManualPlacement(item);
      jobs.push(job);
      if (job.status !== 'ingested' || job.phase !== 'done') {
        print({ planPath, completed: false, jobs });
        throw new Error(`Manual-placement adoption stopped at job ${job.id}: ${job.errorCode ?? `${job.status}/${job.phase}`}`);
      }
    }
    print({ planPath, completed: true, jobs });
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
  .finally(() => closeDatabase());
