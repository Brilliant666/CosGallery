import type { DatabaseSync } from 'node:sqlite';

/** Cache a fixed, unparameterized fact projection, never an authorized response.
 * data_version observes commits from CLI/worker/other connections; total_changes
 * observes this connection's writes; schema_version observes DDL. Transactions
 * bypass and discard the entry so a rolled-back projection cannot escape.
 * No TTL or scan-id assumption: any database change conservatively invalidates.
 */
export function createUnchangedReadCache<T>() {
  const entries = new WeakMap<DatabaseSync, { version: string; value: T }>();
  const version = (db: DatabaseSync): string => JSON.stringify(db.prepare(`
    SELECT total_changes() AS changes, data_version, schema_version
    FROM pragma_data_version, pragma_schema_version
  `).get());
  return (db: DatabaseSync, read: () => T): T => {
    // Older runtimes without this introspection safely do not cache.
    if ((db as DatabaseSync & { isTransaction?: boolean }).isTransaction !== false) {
      entries.delete(db);
      return read();
    }
    const before = version(db);
    const cached = entries.get(db);
    if (cached?.version === before) return structuredClone(cached.value);
    const value = read();
    if (before === version(db)) entries.set(db, { version: before, value: structuredClone(value) });
    else entries.delete(db);
    return value;
  };
}
