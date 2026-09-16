// Measurement only: execute the original SQLite calls, recording their actual cost.
// Opt in with node --import; never imported by the application.
import { DatabaseSync } from 'node:sqlite';
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const statement = prepare.call(this, sql, ...args);
  if (/^PRAGMA\s+(integrity_check|foreign_key_check)\s*$/i.test(sql.trim())) {
    const all = statement.all;
    statement.all = function (...values) {
      const start = performance.now();
      try { return all.apply(this, values); }
      finally { console.log(JSON.stringify({ event: 'measured-check', sql, ms: performance.now() - start })); }
    };
  }
  return statement;
};
