import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { appConfig } from '../config/env.js';
import { CostuanNumberingReconciliationService } from '../services/costuan-numbering-reconciliation-service.js';

const APPLY_CONFIRMATION = 'COSTUAN_NUMBERING_RECONCILIATION_V1';

type Options = {
  apply: boolean;
  confirmation: string | null;
  creatorNames: string[];
  databasePath: string;
};

function parseOptions(argv: string[]): Options {
  let apply = false;
  let confirmation: string | null = null;
  let databasePath = appConfig.databasePath;
  const creatorNames: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--creator' || argument === '--database' || argument === '--confirm') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--creator') creatorNames.push(value.trim());
      if (argument === '--database') databasePath = value;
      if (argument === '--confirm') confirmation = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  const normalizedCreators = [...new Set(creatorNames.filter(Boolean))];
  if (normalizedCreators.length === 0) {
    throw new Error('At least one --creator is required; unscoped production reconciliation is not allowed.');
  }
  if (apply && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm ${APPLY_CONFIRMATION}`);
  }

  return {
    apply,
    confirmation,
    creatorNames: normalizedCreators,
    databasePath: path.resolve(databasePath)
  };
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const database = new DatabaseSync(options.databasePath, { readOnly: !options.apply });
  try {
    database.exec('PRAGMA foreign_keys = ON');
    const service = new CostuanNumberingReconciliationService(database);
    const result = options.apply
      ? service.apply({ creatorNames: options.creatorNames })
      : service.plan({ creatorNames: options.creatorNames });
    process.stdout.write(`${JSON.stringify({
      mode: options.apply ? 'apply' : 'dry-run',
      databasePath: options.databasePath,
      result
    }, null, 2)}\n`);
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
