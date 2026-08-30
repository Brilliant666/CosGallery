import path from 'node:path';

import { runStartupMigrations } from '../db/migration.js';
import { importHentaiclubCreatorRatings } from '../services/creator-rating-import-service.js';

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: import-hcf-tags <path-to-hcf-tags.json>');
  }

  runStartupMigrations();
  const result = await importHentaiclubCreatorRatings(path.resolve(inputPath));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
