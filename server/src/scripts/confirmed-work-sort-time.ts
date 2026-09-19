import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfirmedWorkSortService } from '../services/confirmed-work-sort-service.js';

// Deliberately does not import environment or DatabaseManager: this maintenance
// command cannot migrate, create a database, start workers or scan media.
const [command, databasePath, planPath, ...extra] = process.argv.slice(2);
if (command !== 'apply' || !databasePath || !planPath || !path.isAbsolute(databasePath) || !path.isAbsolute(planPath) || extra.length) {
  process.stderr.write('Usage: confirmed-work-sort-time apply <absolute-existing-database> <absolute-confirmed-plan.json>\n');
  process.exitCode = 1;
} else {
  let db: DatabaseSync | undefined;
  try {
    if (!fs.statSync(databasePath).isFile()) throw new Error('Existing database file required');
    const input: unknown = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    process.stdout.write(JSON.stringify(new ConfirmedWorkSortService(db).apply(input)) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  } finally { db?.close(); }
}
